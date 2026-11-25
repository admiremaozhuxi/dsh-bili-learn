/**
 * Host half of the Bilibili learner bundle.
 *
 * Verified against the live Bilibili API on 2026-11-18:
 *  - `view` is the endpoint that returns -412 without cookies, so this plugin never
 *    calls it. `search/type` already returns `aid`, and `player/pagelist` returns
 *    `cid`, which is everything the rest of the chain needs.
 *  - `search/type` with `order=click` sorts by play count: "high-view videos first".
 *  - Subtitles AND comment pages beyond a preview require a login cookie. Without
 *    one, subtitles come back as code=0 with an empty list, and comments cap at a
 *    preview. Both are reported as traces, never as failures.
 *  - Roughly 30 rapid requests from one IP start returning 412, so every request is
 *    throttled and retried with backoff.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { gate, quietFor, recordThrottled } from './lib/throttle.js'
import { transcribeAudio } from './lib/asr.js'
import { ensureFfmpeg } from './lib/ffmpeg.js'
import { pollQrLogin, startQrLogin } from './lib/login.js'
import { readFrames } from './lib/media.js'
import { registerLearn } from './lib/tools/learn.js'
import { registerStudy } from './lib/tools/study.js'
import { registerConfig } from './lib/tools/config.js'
import { registerWatch } from './lib/tools/watch.js'
import { registerFrames } from './lib/tools/frames.js'
import { registerTranscribe } from './lib/tools/transcribe.js'
import { registerSeries } from './lib/tools/series.js'
import { registerSources } from './lib/tools/sources.js'
import {
  NUMERIC_SPECS,
  SETTING_SPECS,
  checkNumber,
  coerceScalars,
  readPlanSummary,
  scalarDefaults,
  scalarView,
} from './lib/specs.js'

const API = 'https://api.bilibili.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

const SETTINGS_FILE = path.join(homedir(), '.dsh-bili-learn', 'settings.json')

/**
 * Harvests live outside the workspace on purpose: a Host plugin's process.cwd() is
 * the profile directory, not the session workspace, so a relative path would point
 * somewhere the calling agent cannot read. Absolute paths are returned instead.
 */
const HARVEST_ROOT = path.join(homedir(), '.dsh-bili-learn', 'harvests')

// 设置的规格与派生计算已移到 lib/specs.js —— 它们是纯函数，可以脱离插件单独测。
// 见 import 处。

const DEFAULT_SETTINGS = {
  mode: 'auto',
  concurrency: 4, // 旧字段，仅作兼容读取
  endpoint: 'http://127.0.0.1:8848',
  cookie: '',
  proxies: [],
  disabledSources: [],
  customSources: [],
  ...scalarDefaults(),
}

/* ------------------------------------------------------------------ settings */

async function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(await readFile(SETTINGS_FILE, 'utf8')) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

async function saveSettings(patch) {
  const next = { ...(await loadSettings()), ...patch }
  await mkdir(path.dirname(SETTINGS_FILE), { recursive: true })
  await writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8')
  return next
}

/* ---------------------------------------------------------------------- http */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 旧实现：用全局 lastCall 做间隔。
 * 它有个隐蔽问题：多个并发调用同时读到同一个 lastCall，于是同时 sleep 同样时长、
 * 然后一起发出去 —— 表现上"有限速"，实际是并发突刺，正是招风控的形态。
 * 0.2.7 起改用 lib/throttle.js 的串行闸门（gate），这里的间隔值作为该调用的下限传进去。
 */

function headers(cookie, referer = 'https://www.bilibili.com/') {
  const h = {
    'User-Agent': UA,
    Referer: referer,
    Origin: 'https://www.bilibili.com',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  }
  if (cookie) h.Cookie = cookie
  return h
}

async function getJson(url, { cookie = '', gapMs = 1200, retries = 2, referer } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // 全局串行过闸：排队 + 自适应间隔 + 尊重安静期/冷却（冷却中 gate 会抛 risk，这里转成 -412 让上层当风控处理）
    try {
      await gate(url, gapMs)
    } catch (err) {
      if (err && err.risk) return { code: -412, message: String(err.message || 'cooling down') }
      throw err
    }
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 20000)
    let text = ''
    let status = 0
    try {
      const res = await fetch(url, { headers: headers(cookie, referer), signal: ctl.signal })
      status = res.status
      text = await res.text()
    } catch (err) {
      clearTimeout(timer)
      if (attempt === retries) return { code: -1, message: `network: ${String(err).slice(0, 120)}` }
      await sleep(2000)
      continue
    } finally {
      clearTimeout(timer)
    }
    if (status === 412 || text.trimStart().startsWith('<')) {
      // 撞墙就地收手：记账（降速 + 进入冷却/安静期），把 -412 交回上层。
      // 不再像以前那样盲目等 45 秒 / 180 秒再撞三次 —— 那种"整轮卡死三分钟"是更糟的体验，
      // 而且等待期间往往还有别的并发请求在打。
      recordThrottled('HTTP ' + status)
      return { code: -412, message: 'Bilibili risk control (' + status + ')' }
    }
    try {
      return JSON.parse(text)
    } catch {
      if (attempt === retries) return { code: -1, message: 'non-JSON response' }
      await sleep(2000)
    }
  }
  return { code: -1, message: 'retries exhausted' }
}

/* ----------------------------------------------------------------------- wbi */

let wbi = { key: '', at: 0 }

async function mixinKey(cookie, gapMs) {
  if (wbi.key && Date.now() - wbi.at < 3600_000) return wbi.key
  const d = await getJson(`${API}/x/web-interface/nav`, { cookie, gapMs })
  if (d.code !== 0 && d.code !== -101) return ''
  const img = String(d?.data?.wbi_img?.img_url || '').split('/').pop().split('.')[0]
  const sub = String(d?.data?.wbi_img?.sub_url || '').split('/').pop().split('.')[0]
  const orig = img + sub
  if (orig.length < 64) return ''
  wbi = { key: MIXIN_TAB.map((i) => orig[i]).join('').slice(0, 32), at: Date.now() }
  return wbi.key
}

function signed(base, params, key) {
  const p = { ...params, wts: Math.floor(Date.now() / 1000) }
  const q = Object.keys(p)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]))}`)
    .join('&')
  const w = createHash('md5').update(q + key).digest('hex')
  return `${base}?${q}&w_rid=${w}`
}

/* ------------------------------------------------------------------ text out */

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '')
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Strip tags AND decode the entities Bilibili embeds in titles, such as &amp; */
const clean = (s) =>
  stripTags(s)
    .replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
      if (g[0] === '#') {
        const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
      return ENTITY[g.toLowerCase()] ?? m
    })
    .trim()

/* ---------------------------------------------------------------- harvesting */

async function searchVideos(keyword, opts) {
  const { cookie, gapMs, order = 'click', page = 1 } = opts
  const key = await mixinKey(cookie, gapMs)
  const params = { search_type: 'video', keyword, order, page, page_size: 20 }
  const url = key
    ? signed(`${API}/x/web-interface/wbi/search/type`, params, key)
    : `${API}/x/web-interface/search/type?${new URLSearchParams(params)}`
  const d = await getJson(url, { cookie, gapMs })
  if (d.code !== 0) return { error: d.message || `code ${d.code}`, items: [] }
  return {
    items: (d?.data?.result || []).map((v) => ({
      bvid: v.bvid,
      aid: v.aid || Number(String(v.arcurl || '').match(/av(\d+)/)?.[1] || 0) || null,
      title: clean(v.title),
      author: v.author,
      play: v.play,
      duration: v.duration,
      pubdate: v.pubdate,
      desc: clean(v.description).slice(0, 200),
    })),
  }
}

async function getCid(bvid, opts) {
  const d = await getJson(`${API}/x/player/pagelist?bvid=${bvid}`, opts)
  if (d.code !== 0) return null
  const first = (d.data || [])[0]
  return first ? { cid: first.cid, parts: (d.data || []).length, duration: Number(first.duration) || 0 } : null
}

/**
 * 全部 分P 清单。网课、系列课往往几十上百个 P，只取第一个等于什么都没读到。
 *
 * 单 P 的弹幕数拿不到：x/v2/dm/web/view 返回 protobuf/XML（非 JSON），
 * x/player/dm 直接 404。所以用「标题 + 时长 + 首帧图」判断重点章节，
 * 整视频的总弹幕数从 view 的 stat 拿。
 */
async function getParts(bvid, opts) {
  const d = await getJson(`${API}/x/player/pagelist?bvid=${bvid}`, opts)
  if (d.code !== 0) {
    const why =
      d.code === -404
        ? '视频不存在或已删除'
        : d.code === -400
          ? 'BV 号格式不对'
          : d.code === -412 || d._html
            ? '被风控拦了，等几分钟再试'
            : `接口返回 ${d.code}${d.message ? '：' + d.message : ''}`
    return { parts: null, error: why }
  }
  return {
    parts: (d.data || []).map((p) => ({
      page: Number(p.page) || 0,
      cid: p.cid,
      title: String(p.part || '').trim(),
      duration: Number(p.duration) || 0,
      cover: p.first_frame || '',
    })),
    error: '',
  }
}

/** UP 主资料：粉丝数只能从 relation/stat 拿，acc/info 已经不返回 fans。 */
async function getUpStat(mid, opts) {
  if (!mid) return null
  const d = await getJson(`${API}/x/relation/stat?vmid=${mid}`, opts)
  if (d.code !== 0) return null
  return { follower: Number(d?.data?.follower) || 0, following: Number(d?.data?.following) || 0 }
}

/**
 * 取一条视频的完整元信息（含 aid）。
 * 先说结论：登录后 wbi/view 可用，能拿 aid。
 *
 * 评论接口只认 aid，而 pagelist 不带 aid。无 cookie 时 view 会被 412 挡回，
 * 但实测登录后 wbi/view 正常返回，所以这里按「有 cookie 才试」的策略走，
 * 失败不影响其他字段。
 */
async function getViewMeta(bvid, opts) {
  const cookie = (opts && opts.cookie) || ''
  const gapMs = (opts && opts.gapMs) || 600
  if (!cookie) return null
  try {
    const key = await mixinKey(cookie, gapMs)
    const url = key
      ? signed(`${API}/x/web-interface/wbi/view`, { bvid }, key)
      : `${API}/x/web-interface/view?bvid=${bvid}`
    const d = await getJson(url, { cookie, referer: `https://www.bilibili.com/video/${bvid}` })
    if (d.code !== 0) return null
    const v = d.data || {}
    return {
      aid: v.aid,
      cid: v.cid,
      duration: Number(v.duration) || 0,
      title: v.title,
      desc: v.desc,
      owner: v?.owner?.name,
      ownerMid: v?.owner?.mid,
      stat: v.stat,
    }
  } catch {
    return null
  }
}

async function getSubtitles(bvid, cid, opts) {
  const { cookie, gapMs } = opts
  const key = await mixinKey(cookie, gapMs)
  const url = key
    ? signed(`${API}/x/player/wbi/v2`, { bvid, cid }, key)
    : `${API}/x/player/v2?bvid=${bvid}&cid=${cid}`
  const d = await getJson(url, { cookie, gapMs, referer: `https://www.bilibili.com/video/${bvid}` })
  if (d.code !== 0) return { lines: [], trace: `api_code_${d.code}` }
  const st = d?.data?.subtitle || {}
  const subs = st.subtitles || []
  if (!subs.length) {
    return { lines: [], trace: `empty(allow_submit=${st.allow_submit})${cookie ? '' : ' no-cookie'}` }
  }
  const out = []
  // 一个视频常有多条字幕轨（中/英/日…）。全部拼进来会让行数虚高几倍——
  // 实测一条 3 分钟视频因此被算成 450 行，而真正的中文只有 98 行，
  // 下游 agentsFor 按行数分配子 agent，会据此严重误判内容量。只取一条。
  const pick =
    subs.find((s) => /^zh[-_]?(cn|hans)?$/i.test(String(s.lan || ''))) ||
    subs.find((s) => /^zh/i.test(String(s.lan || ''))) ||
    subs.find((s) => /^ai-zh/i.test(String(s.lan || ''))) ||
    subs[0]
  const chosen = pick ? { lan: pick.lan, url: pick.subtitle_url } : null
  if (chosen) {
    let u = chosen.url || ''
    if (u.startsWith('//')) u = `https:${u}`
    if (u) {
      const r = await getJson(u, { gapMs: 400 })
      for (const x of Array.isArray(r?.body) ? r.body : []) {
        out.push({ from: x.from, to: x.to, text: x.content })
      }
    }
  }
  return {
    lines: out,
    trace: out.length ? `ok[${chosen?.lan || '?'}]${subs.length > 1 ? ` 1/${subs.length}轨` : ''}` : 'empty_body',
  }
}

/**
 * 评论。登录后每页 20 条，可以翻页。
 *
 * 这两条能力是从 polylens 那边学来的：它会游标续取、能取二级评论，
 * 我原来只取第一页。现在按页取，页与页之间仍走 gapMs，避免一次打太多。
 */
async function getComments(aid, opts, { limit = 20, maxPages = 1 } = {}) {
  if (!aid) return { items: [], trace: 'no_aid', pages: 0 }
  // 实测（2026-11-18）：x/v2/reply 的 ps 超过 20 直接返回 -400。
  // 想要更多条靠翻页（下面的 pn 循环），不是靠放大 ps。
  const per = Math.min(Math.max(limit, 1), 20)
  const out = []
  let pages = 0
  for (let pn = 1; pn <= Math.max(1, maxPages); pn += 1) {
    const url = `${API}/x/v2/reply?type=1&oid=${aid}&ps=${per}&pn=${pn}&sort=2`
    const d = await getJson(url, opts)
    if (d.code !== 0) {
      if (!out.length) return { items: [], trace: `api_code_${d.code}`, pages }
      break
    }
    const reps = d?.data?.replies || []
    if (!reps.length) break
    pages += 1
    for (const r of reps) {
      out.push({
        rpid: r.rpid,
        like: r.like,
        user: r?.member?.uname,
        ctime: r.ctime,
        text: String(r?.content?.message || '').slice(0, 400),
        replyCount: Number(r.rcount) || 0,
      })
      if (out.length >= limit) break
    }
    if (out.length >= limit) break
  }
  return { items: out.slice(0, limit), trace: out.length ? 'ok' : 'empty', pages }
}

/** 某条主评论下的二级评论 —— polylens 有、我原来没有的能力。 */
async function getCommentReplies(aid, root, opts, { limit = 8 } = {}) {
  if (!aid || !root) return { items: [], trace: 'bad_args' }
  const url =
    `${API}/x/v2/reply/reply?type=1&oid=${aid}&root=${root}` +
    // 同主评论接口：ps 上限实测是 20，超过返回 -400
    `&ps=${Math.min(Math.max(limit, 1), 20)}&pn=1`
  const d = await getJson(url, opts)
  if (d.code !== 0) return { items: [], trace: `api_code_${d.code}` }
  const reps = (d?.data?.replies) || []
  return {
    items: reps.slice(0, limit).map((r) => ({
      like: r.like,
      user: r?.member?.uname,
      text: String(r?.content?.message || '').slice(0, 300),
    })),
    trace: reps.length ? 'ok' : 'empty',
  }
}

async function selfHealth(endpoint) {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 8000)
    const r = await fetch(`${endpoint.replace(/\/$/, '')}/health`, { signal: ctl.signal })
    clearTimeout(timer)
    return r.ok ? await r.json() : { ok: false, http: r.status }
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 120) }
  }
}

/* ------------------------------------------------------------------- on disk */

const slugify = (s) =>
  String(s || 'topic')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'topic'

function toMarkdown(v) {
  const out = [
    `# ${v.title}`,
    '',
    `- BV: \`${v.bvid}\``,
    `- UP: ${v.author}`,
    `- 播放: ${v.play}`,
    `- 时长: ${v.duration}`,
    `- 链接: https://www.bilibili.com/video/${v.bvid}`,
    '',
  ]
  if (v.desc) out.push('## 简介', v.desc, '')
  out.push(`## 字幕（${v.subtitleTrace}）`)
  if (v.subtitles.length) {
    for (const l of v.subtitles) out.push(`[${Math.round(Number(l.from) || 0)}s] ${l.text}`)
  } else {
    out.push('_未获取到字幕轨。_')
  }
  out.push('', `## 高赞评论（${v.commentTrace}）`)
  if (v.comments.length) {
    for (const c of v.comments) {
      out.push(`- (${c.like} 赞) ${c.user}: ${c.text}`)
      for (const r of c.replies || []) {
        out.push(`    └ (${r.like} 赞) ${r.user}: ${r.text}`)
      }
    }
  } else {
    out.push('_无评论_')
  }
  return out.join('\n')
}

/**
 * Shared pipeline: search -> rank by play -> subtitles/comments -> markdown.
 * Returns an absolute directory so callers never have to guess where files went.
 */
async function harvest(args, settings) {
  const mode = settings.mode || 'auto'
  if (mode === 'default') {
    return { ok: false, note: '取数方式设为「不取视频文件」，请先切换为 auto 或 direct。', videos: [], count: 0 }
  }

  const opts = { cookie: settings.cookie || '', gapMs: Math.max(300, Number(settings.gapMs) || 1200) }
  const maxVideos = Math.min(Math.max(Number(args.maxVideos) || 8, 1), 20)
  const notes = []
  let effective = mode

  if (mode === 'self' || mode === 'auto') {
    const h = await selfHealth(settings.endpoint)
    if (h.ok) notes.push(`自建服务器在线（${settings.endpoint}）。`)
    else {
      notes.push(`自建服务器不可达（${settings.endpoint}），已回落直连。`)
      if (mode === 'self') effective = 'direct'
    }
  }
  if (mode === 'proxy') {
    notes.push('第三方站模式仅作占位：这些站点只给视频文件、不给字幕，已回落直连。')
    effective = 'direct'
  }

  const phrases = [args.topic, ...(Array.isArray(args.keywords) ? args.keywords : [])]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, 4)

  const seen = new Map()
  const errors = []
  for (const phrase of phrases) {
    const r = await searchVideos(phrase, { ...opts, order: 'click' })
    if (r.error) errors.push(`${phrase}: ${r.error}`)
    for (const it of r.items || []) if (it.bvid && !seen.has(it.bvid)) seen.set(it.bvid, it)
  }

  // 候选池要比 maxVideos 宽，才能在遇到无字幕视频时继续往下找。
  // maxAttempts 同时是硬上限：搜到尽头就停，不会无限试下去。
  const maxAttempts = Math.min(
    Math.max(Number(args.maxAttempts) || Number(settings.maxAttempts) || 30, maxVideos),
    60,
  )

  const candidates = [...seen.values()]
    .sort((a, b) => (Number(b.play) || 0) - (Number(a.play) || 0))
    .slice(0, maxAttempts)

  if (!candidates.length) {
    return { ok: false, mode: effective, note: `搜索无结果。${errors.join('; ')}`, videos: [], count: 0 }
  }

  const dir = path.join(
    HARVEST_ROOT,
    `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${slugify(args.topic)}`,
  )
  await mkdir(dir, { recursive: true })

  const withComments = args.withComments !== false
  const results = []
  const skipped = []
  const transcribed = []
  const framed = []
  let tried = 0
  // 没字幕时改用音频转写：慢（约等于音频时长），所以默认关，且限量
  const fillByAsr = args.fillByTranscribe === true || settings.fillByTranscribe === true
  const asrCap = Math.min(Math.max(Number(settings.transcribeCap) || 3, 0), 10)
  let asrUsed = 0
  // 抽帧比转写贵：每帧一次视觉调用，还要先下视频。所以上限更小
  const fillByFrames = args.fillByFrames === true || settings.fillByFrames === true
  const framesCap = Math.min(Math.max(Number(settings.framesCap) || 2, 0), 10)
  const framesPerVideo = Math.min(Math.max(Number(settings.framesPerVideo) || 3, 1), 8)
  let framesUsed = 0

  for (const v of candidates) {
    if (results.length >= maxVideos) break
    tried += 1

    const page = await getCid(v.bvid, opts)
    let subs = { lines: [], trace: 'no_cid' }
    let comments = { items: [], trace: 'skipped' }
    if (page?.cid) {
      subs = await getSubtitles(v.bvid, page.cid, opts)
      if (withComments) comments = await getComments(v.aid, opts, { limit: 20, maxPages: 1 })
    }

    // 没有字幕轨不等于没有内容——口播可以转写，画面可以抽帧看。
    // 顺序是有意的：转写便宜（一次调用），抽帧贵（每帧一次视觉调用），
    // 所以先试转写，它拿不到东西再看画面。
    if (!subs.lines.length && fillByAsr && page?.cid && asrUsed < asrCap) {
      try {
        const tr = await transcribeAudio(v.bvid, page.cid, settings)
        if (tr.ok && String(tr.text || '').trim().length >= 30) {
          subs = {
            lines: String(tr.text)
              .split(/\n+/)
              .filter(Boolean)
              .map((t) => ({ from: 0, to: 0, text: t })),
            trace: `转写(耗时${tr.seconds}s)`,
          }
          transcribed.push(v.bvid)
          asrUsed += 1
        }
      } catch {
        /* 转写失败，继续看画面 */
      }
    }

    if (!subs.lines.length && fillByFrames && page?.cid && framesUsed < framesCap) {
      try {
        const ff = await ensureFfmpeg()
        const fr = await readFrames(v.bvid, page.cid, page.duration || 0, settings, {
          maxFrames: framesPerVideo,
          ffmpegPath: ff.path,
        })
        if (fr.ok && String(fr.markdown || '').trim().length >= 30) {
          subs = {
            lines: String(fr.markdown)
              .split(/\n+/)
              .filter(Boolean)
              .map((t) => ({ from: 0, to: 0, text: t })),
            trace: `画面(${fr.frames}帧)`,
          }
          framed.push(v.bvid)
          framesUsed += 1
        }
      } catch {
        /* 抽帧失败按无内容处理 */
      }
    }

    // 还是没有：记录下 bvid，让调用方决定要不要单独补转写或抽帧
    if (!subs.lines.length) {
      skipped.push({
        bvid: v.bvid,
        title: v.title,
        play: Number(v.play) || 0,
        reason: subs.trace,
      })
      continue
    }

    const record = {
      ...v,
      cid: page?.cid || null,
      subtitles: subs.lines,
      subtitleTrace: subs.trace,
      comments: comments.items,
      commentTrace: comments.trace,
    }
    const file = path.join(dir, `${v.bvid}.md`)
    await writeFile(file, toMarkdown(record), 'utf8')
    results.push({
      bvid: v.bvid,
      title: v.title,
      play: Number(v.play) || 0,
      author: v.author,
      subtitleLines: subs.lines.length,
      subtitleTrace: subs.trace,
      comments: comments.items.length,
      file,
    })
  }

  await writeFile(
    path.join(dir, 'index.json'),
    JSON.stringify(
      { topic: args.topic, mode: effective, at: new Date().toISOString(), tried, videos: results, skipped },
      null,
      2,
    ),
    'utf8',
  )

  // 全部被跳过：试了一圈没有一条拿到正文，这是失败而不是成功，要说清楚。
  if (!results.length) {
    const list = skipped.slice(0, 5).map((s) => s.bvid).join(', ')
    const why = skipped.length
      ? `试了 ${tried} 个视频都没拿到正文（${list}${skipped.length > 5 ? ' 等' : ''}）。` +
        (settings.cookie
          ? '它们没有字幕轨，可以对其中几条调用 bili_transcribe 转写，或用 bili_frames 看画面。'
          : '字幕需要登录态，先扫码登录；也可以对单条调用 bili_transcribe —— 转写不需要登录。')
      : `试了 ${tried} 个视频都没取到内容。`
    return {
      ok: false,
      mode: effective,
      dir,
      count: 0,
      tried,
      skipped,
      transcribed,
      framed,
      videos: [],
      note: why,
    }
  }

  if (transcribed.length) {
    notes.push(`其中 ${transcribed.length} 个没有字幕轨，已用音频转写补上。`)
  }
  if (framed.length) {
    notes.push(`另有 ${framed.length} 个是抽帧看画面拿到的，不是原字幕。`)
  }
  if (skipped.length) {
    const list = skipped.slice(0, 5).map((s) => s.bvid).join(', ')
    notes.push(
      `试了 ${tried} 个，收到 ${results.length} 个，跳过 ${skipped.length} 个没字幕的（${list}${
        skipped.length > 5 ? ' 等' : ''
      }）。要这些的内容，可以对它们调用 bili_transcribe 转写，或用 bili_frames 看画面。`,
    )
  }

  return {
    ok: true,
    mode: effective,
    dir,
    count: results.length,
    tried,
    skipped,
    transcribed,
    framed,
    videos: results,
    note: notes.join(' '),
  }
}

const textBlock = (text) => [{ type: 'text', text }]

/**
 * 把一个视频的 markdown 切成 k 段，供 k 个子 agent 分头读。
 *
 * 只切「## 字幕」之后的部分，标题和简介每个分段都保留，这样任何一段都能
 * 独立看懂这是哪个视频。字幕太短时不切（切了每段只剩两三行，没有意义）。
 */
function splitSegments(markdown, k) {
  if (k <= 1) return [String(markdown)]
  const lines = String(markdown).split('\n')
  const headEnd = lines.findIndex((l) => /^##\s*字幕/.test(l))
  const head = headEnd >= 0 ? lines.slice(0, headEnd + 1) : []
  const body = headEnd >= 0 ? lines.slice(headEnd + 1) : lines
  if (body.length < k * 4) return [String(markdown)]
  const per = Math.ceil(body.length / k)
  const out = []
  for (let i = 0; i < k; i += 1) {
    const chunk = body.slice(i * per, (i + 1) * per)
    if (!chunk.length) break
    out.push(head.concat(chunk).join('\n'))
  }
  return out.length ? out : [String(markdown)]
}

/**
 * 这个视频切成几段（= 最多能有几个子 agent 分头读它）。
 *
 * min 是保底：短内容也至少 min 份，避免一个 agent 草草看完。
 * max 是**正常情况下的估算上限**，不是硬上限 —— 内容很长时允许按倍数放大，
 * 这样别处的 worker 空出来后才能真正过来帮忙。最终同时在跑多少，
 * 由 maxTotalAgents 这个池子大小约束。
 */
function agentsFor(video, min, max) {
  const lines = Number(video.subtitleLines) || 0
  if (!lines) return min
  const want = Math.ceil(lines / 400)
  const hardCap = Math.max(max, max * 2) // 单个视频最多到估算上限的两倍
  return Math.max(min, Math.min(want, hardCap))
}

/** Pull readable text out of whatever a delegated tool result looks like. */
function resultText(r) {
  if (!r) return ''
  if (typeof r === 'string') return r
  if (Array.isArray(r.content)) {
    const t = r.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
    if (t) return t
  }
  if (r.value !== undefined) {
    if (typeof r.value === 'string') return r.value
    if (Array.isArray(r.value?.output)) return resultText({ content: r.value.output })
    if (typeof r.value?.output === 'string') return r.value.output
    try {
      return JSON.stringify(r.value).slice(0, 800)
    } catch {
      return ''
    }
  }
  try {
    return JSON.stringify(r).slice(0, 800)
  } catch {
    return ''
  }
}

function registerTools(ctx) {
  // 8 个工具已拆到 lib/tools/*.js。这里只做两件事：把共享依赖打包，然后逐个注册。
  // 拆分的理由见 lib/tools/learn.js 头部注释；依赖显式传入，模块本身不 import 项目内部文件。
  const deps = {
    loadSettings,
    saveSettings,
    harvest,
    effectiveSources,
    probeAll,
    sourceState,
    getJson,
    getCid,
    getParts,
    getViewMeta,
    getUpStat,
    getSubtitles,
    getComments,
    getCommentReplies,
    toMarkdown,
    textBlock,
    splitSegments,
    agentsFor,
    resultText,
    transcribeAudio,
    readFrames,
    ensureFfmpeg,
    startQrLogin,
    pollQrLogin,
    SETTINGS_FILE,
    HARVEST_ROOT,
    SETTING_SPECS,
    NUMERIC_SPECS,
    DEFAULT_SETTINGS,
    checkNumber,
    readPlanSummary,
    selfHealth,
    API,
  }

  registerLearn(ctx, deps)
  registerStudy(ctx, deps)
  registerConfig(ctx, deps)
  registerWatch(ctx, deps)
  registerFrames(ctx, deps)
  registerTranscribe(ctx, deps)
  registerSeries(ctx, deps)
  registerSources(ctx, deps)
}

/**
 * 内置来源清单。
 * 这一块在 Phase 2 拆分时被误删过——它原本紧跟在工具注册块之后，
 * 而拆分脚本按「下一个顶层 function」划定范围，把它一起切走了。
 * 表现是 bili_sources 报 BUILTIN_SOURCES is not defined。
 */
const BUILTIN_SOURCES = [
  { id: 'self', kind: 'self', name: '自己的服务器', note: '最稳，把请求放在服务器上' },
  { id: 'wbi', kind: 'api', name: '直连（签名接口）', note: '官方接口，受本机 IP 配额影响' },
  { id: 'plain', kind: 'api', name: '直连（普通接口）', note: '官方接口，偶尔比签名版更快' },
  { id: 'vtool', kind: 'web', name: 'vtool.pro', url: 'https://vtool.pro/bilibili.html', note: '打开最快，约 1 秒' },
  { id: 'v2ob', kind: 'web', name: 'v2ob.com', url: 'https://v2ob.com/', note: '约 1.2 秒，已验证可走通' },
  { id: 'iiilab', kind: 'web', name: 'iiilab', url: 'https://bilibili.iiilab.com/', note: '约 4.8 秒，功能全' },
  { id: 'zhouql', kind: 'web', name: 'zhouql.vip', url: 'http://zhouql.vip/bilibili/', note: '极简，支持弹幕封面' },
  { id: 'videofk', kind: 'web', name: 'videofk.com', url: 'https://www.videofk.com/', note: '能用但慢' },
  { id: 'snapany', kind: 'web', name: 'snapany', url: 'https://snapany.com/zh/bilibili', note: '可选' },
  { id: 'xbeibeix', kind: 'web', name: 'xbeibeix', url: 'https://xbeibeix.com/api/bilibili/', note: '很慢，常超时' },
  { id: '6li6', kind: 'web', name: '6li6.com', url: 'https://6li6.com/bilibili', note: '很慢' },
]

function effectiveSources(settings) {
  const disabled = new Set((settings && settings.disabledSources) || [])
  const custom = ((settings && settings.customSources) || []).map((s) => ({
    id: s.id,
    kind: 'web',
    name: s.name || s.id,
    url: s.url,
    note: '自定义',
    custom: true,
  }))
  return [...BUILTIN_SOURCES, ...custom].filter((s) => !disabled.has(s.id))
}

const SOURCES_FILE = path.join(homedir(), '.dsh-bili-learn', 'sources.json')
let sourceState = { at: 0, items: [] }

async function probeOne(src, timeoutMs = 5000) {
  const started = Date.now()
  try {
    if (src.kind === 'self') {
      const s = await loadSettings()
      if (!s.endpoint) return { id: src.id, ok: false, ms: 0, note: '未配置' }
      const hlt = await selfHealth(s.endpoint)
      return { id: src.id, ok: Boolean(hlt.ok), ms: Date.now() - started, note: hlt.ok ? '在线' : '连不上' }
    }
    if (src.kind === 'api') {
      const s = await loadSettings()
      const nav = await getJson(`${API}/x/web-interface/nav`, { cookie: s.cookie || '', gapMs: 300 })
      const ok = nav?.code === 0 || nav?.code === -101
      return {
        id: src.id,
        ok,
        ms: Date.now() - started,
        note: ok ? `登录态 ${nav?.data?.isLogin ? '有效' : '未登录'}` : `被拦（${nav?.code ?? '?'}）`,
      }
    }
    // web 源：只看站点是否活着，以及多快。能否出直链要人点，这里不测。
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    let status = 0
    try {
      const res = await fetch(src.url, {
        method: 'GET',
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
        signal: ctl.signal,
        redirect: 'follow',
      })
      status = res.status
      await res.body?.cancel?.()
    } finally {
      clearTimeout(timer)
    }
    const ok = status >= 200 && status < 400
    return { id: src.id, ok, ms: Date.now() - started, note: ok ? '页面在线' : `HTTP ${status}` }
  } catch (err) {
    return { id: src.id, ok: false, ms: Date.now() - started, note: String(err).slice(0, 60) }
  }
}

async function probeAll() {
  const settings = await loadSettings()
  const list = effectiveSources(settings)
  // 0.2.5：这里原本是 Promise.all —— 十来个端点同时打出去，正是 2026-11-25 那次
  // 「探针跑完紧接着检索，第一页就被判拦截页」的直接原因。
  // 改成逐个探，间隔交给 lib/throttle.js 的共享节流门（串行 + 自适应间隔 + 尊重静默期）。
  const results = []
  for (const s of list) {
    try {
      results.push(await probeOne(s))
    } catch (err) {
      results.push({ id: s.id, ok: false, ms: 0, note: String(err).slice(0, 60) })
    }
  }
  // 探针刚打完一批请求：给同一台机器上的其它 B 站工具（含 dsh-bili-search）留一段静默期，
  // 谁也不要在别人刚探完的时候马上开检索。
  quietFor(90_000, 'bili_sources 探针刚跑完')
  // 改字段而不是重新赋值：sourceState 会被传进 lib/tools 的模块里，
  // 重新赋值会让那些模块手里的还是旧对象。
  sourceState.at = Date.now()
  sourceState.items = results.map((r) => ({ ...r, name: (list.find((s) => s.id === r.id) || {}).name || r.id }))
  try {
    await writeFile(SOURCES_FILE, JSON.stringify(sourceState, null, 2), 'utf8')
  } catch {
    /* 写不了就算了，内存里的还能用 */
  }
  return sourceState
}

/**
 * One operation, two callers: the panel button and the /bili command both go
 * through these handlers, so the UI never has its own copy of the logic.
 */
/**
 * 数字型设置的规格，一处定义。
 * 原本在三个地方各写一遍（独立子命令 / set 解析 / 状态摘要），改范围要改三处，
 * 而且摘要两处的措辞已经不一致了。
 */
function registerCommands(ctx) {
  ctx.effect(() =>
    ctx.commands.register({
      name: 'bili',
      description: 'B站视频小工具：查看或修改取数方式、并发、自建服务器、登录态',
      input: { hint: 'mode auto | videos 3 | agents 2-4 | total 12 | attempts 30 | endpoint URL | test | status' },
      async handler(inv) {
        const raw = String(inv.rawInput || '').trim()
        const parts = raw.split(/\s+/).filter(Boolean)
        const verb = (parts[0] || 'status').toLowerCase()
        const arg = parts.slice(1).join(' ').trim()

        try {
          if (verb === 'status' || verb === '') {
            const s = await loadSettings()
            return {
              kind: 'success',
              text:
                readPlanSummary(s) +
                `\n自建服务器 ${s.endpoint || '（未设置）'}` +
                `\n登录凭证 ${s.cookie ? '已配置' : '未配置'}` +
                `\n配置文件 ${SETTINGS_FILE}`,
            }
          }

          if (verb === 'mode') {
            const allowed = ['default', 'direct', 'self', 'proxy', 'auto']
            if (!allowed.includes(arg)) {
              return { kind: 'error', text: `取数方式必须是 ${allowed.join(' / ')}` }
            }
            await saveSettings({ mode: arg })
            return { kind: 'success', text: `取数方式已设为 ${arg}` }
          }

          if (verb === 'videos' || verb === 'concurrency') {
            const spec = NUMERIC_SPECS.videos
            const r = checkNumber(arg, spec)
            if (!r.ok) return { kind: 'error', text: r.message }
            await saveSettings({ [spec.field]: r.value })
            return { kind: 'success', text: `同时阅读 ${r.value} 个视频` }
          }

          if (verb === 'agents') {
            // agents 2-4  或  agents 2
            const mm = String(arg).match(/^(\d+)(?:[-~](\d+))?$/)
            if (!mm) {
              return { kind: 'error', text: '写法是 agents 2-4（下限-上限），或 agents 3 表示上下限相同' }
            }
            const lo = Math.round(Number(mm[1]))
            const hi = Math.round(Number(mm[2] || mm[1]))
            if (lo < 1 || hi > 8 || lo > hi) {
              return { kind: 'error', text: '区间要在 1 到 8 之间，且下限不大于上限' }
            }
            await saveSettings({ agentsPerVideoMin: lo, agentsPerVideoMax: hi })
            return {
              kind: 'success',
              text: `每个视频分配 ${lo}-${hi} 个 AI（内容长的会超过上限，靠空闲的补）`,
            }
          }

          if (verb === 'total') {
            const spec = NUMERIC_SPECS.total
            const r = checkNumber(arg, spec)
            if (!r.ok) return { kind: 'error', text: r.message }
            await saveSettings({ [spec.field]: r.value })
            return { kind: 'success', text: `AI 总数上限 ${r.value}` }
          }

          if (verb === 'attempts') {
            const spec = NUMERIC_SPECS.attempts
            const r = checkNumber(arg, spec)
            if (!r.ok) return { kind: 'error', text: r.message }
            await saveSettings({ [spec.field]: r.value })
            return { kind: 'success', text: `最多尝试 ${r.value} 个视频` }
          }

          if (verb === 'endpoint') {
            await saveSettings({ endpoint: arg })
            return {
              kind: 'success',
              text: arg ? `自建服务器已设为 ${arg}` : '已清空自建服务器地址',
            }
          }

          if (verb === 'gap') {
            const n = Number(arg)
            if (!Number.isFinite(n) || n < 300 || n > 5000) {
              return { kind: 'error', text: '间隔必须是 300 到 5000 毫秒' }
            }
            await saveSettings({ gapMs: Math.round(n) })
            return { kind: 'success', text: `请求间隔已设为 ${Math.round(n)}ms` }
          }

          if (verb === 'cookie') {
            if (!arg) {
              const s = await loadSettings()
              return {
                kind: 'success',
                text: s.cookie ? '已配置登录凭证' : '尚未配置登录凭证（字幕会为空）',
              }
            }
            await saveSettings({ cookie: arg })
            return { kind: 'success', text: `登录凭证已保存（${arg.length} 字符）` }
          }

          if (verb === 'clearcookie') {
            await saveSettings({ cookie: '' })
            return { kind: 'success', text: '登录凭证已清除' }
          }

          if (verb === 'test') {
            const s = await loadSettings()
            const lines = []
            // 自建服务
            if (s.endpoint) {
              const hlt = await selfHealth(s.endpoint)
              lines.push(hlt.ok ? `自建服务器 在线（${s.endpoint}）` : `自建服务器 不可达（${s.endpoint}）`)
            } else {
              lines.push('自建服务器 未设置')
            }
            // 登录态
            const nav = await getJson(`${API}/x/web-interface/nav`, {
              cookie: s.cookie || '',
              gapMs: 400,
            })
            const logged = Boolean(nav?.data?.isLogin)
            lines.push(logged ? `登录态 有效（${nav?.data?.uname || '已登录'}）` : '登录态 无效或未配置')
            return { kind: 'success', text: lines.join('\n') }
          }

          if (verb === 'set') {
            // 面板用这个：一次提交多项，key=value 以空格分隔
            const patch = {}
            const bad = []
            for (const token of parts.slice(1)) {
              const eq = token.indexOf('=')
              if (eq < 0) {
                bad.push(token)
                continue
              }
              const k = token.slice(0, eq).toLowerCase()
              const v = token.slice(eq + 1)
              if (k === 'mode') {
                if (['default', 'direct', 'self', 'proxy', 'auto'].includes(v)) patch.mode = v
                else bad.push(`mode=${v}`)
              } else if (k === 'videos' || k === 'concurrency') {
                const r = checkNumber(v, NUMERIC_SPECS.videos)
                if (r.ok) patch.videoConcurrency = r.value
                else bad.push(`videos=${v}`)
              } else if (k === 'agents') {
                const mm = String(v).match(/^(\d+)(?:[-~](\d+))?$/)
                if (mm) {
                  const lo = Math.round(Number(mm[1]))
                  const hi = Math.round(Number(mm[2] || mm[1]))
                  if (lo >= 1 && hi <= 8 && lo <= hi) {
                    patch.agentsPerVideoMin = lo
                    patch.agentsPerVideoMax = hi
                  } else bad.push(`agents=${v}`)
                } else bad.push(`agents=${v}`)
              } else if (k === 'total') {
                const r = checkNumber(v, NUMERIC_SPECS.total)
                if (r.ok) patch.maxTotalAgents = r.value
                else bad.push(`total=${v}`)
              } else if (k === 'attempts') {
                const r = checkNumber(v, NUMERIC_SPECS.attempts)
                if (r.ok) patch.maxAttempts = r.value
                else bad.push(`attempts=${v}`)
              } else if (k === 'gap') {
                const r = checkNumber(v, NUMERIC_SPECS.gap)
                if (r.ok) patch.gapMs = r.value
                else bad.push(`gap=${v}`)
              } else if (k === 'endpoint') {
                patch.endpoint = v
              } else {
                bad.push(token)
              }
            }
            if (bad.length) {
              return { kind: 'error', text: `无法识别的参数：${bad.join(', ')}` }
            }
            if (!Object.keys(patch).length) {
              return { kind: 'error', text: '没有可应用的参数' }
            }
            const s2 = await saveSettings(patch)
            return {
              kind: 'success',
              text: `已应用：${Object.keys(patch).join(', ')}\n当前 ${readPlanSummary(s2)}`,
            }
          }

          if (verb === 'reset') {
            await saveSettings({ ...DEFAULT_SETTINGS })
            return { kind: 'success', text: '配置已恢复默认' }
          }

          return {
            kind: 'error',
            text: `未知子命令 ${verb}。可用：status / mode / videos / agents / total / attempts / endpoint / gap / cookie / clearcookie / test / reset`,
          }
        } catch (err) {
          return { kind: 'error', text: `执行失败：${String(err).slice(0, 200)}` }
        }
      },
    }),
  )
}

/* ----------------------------------------------------------------- http api */

/**
 * The panel reads and writes settings through two same-origin routes.
 *
 * Why HTTP instead of a Remote call: a Client plugin has no write access to Host
 * files, and the `main` slot is root-scoped with no session binding, so there is
 * no agent to address a Remote command with.
 *
 * `webServer` is looked up with optional injection rather than a hard `inject`
 * entry, so a profile without the browser carrier keeps every tool working and
 * the panel reports the missing route instead of the whole plugin going dark.
 * A small diagnostic file records what happened, because "404" alone cannot tell
 * a missing service from a missing route.
 */
function registerHttpApi(ctx) {
  const writeDiag = (payload) =>
    writeFile(path.join(HARVEST_ROOT, '..', 'diag.json'), JSON.stringify(payload, null, 2), 'utf8').catch(
      () => {},
    )

  const view = (s) => ({
    mode: s.mode,
    // 标量全部从 SETTING_SPECS 派生。以前这里手写，加设置时漏了 5 个字段，
    // 表现是面板保存成功、重开却显示默认值——因为读的时候没返回。
    ...scalarView(s),
    // 旧配置只有 concurrency，没有 videoConcurrency，这里兜一下
    videoConcurrency: s.videoConcurrency ?? s.concurrency ?? 3,
    endpoint: s.endpoint || '',
    hasCookie: Boolean(s.cookie),
    settingsFile: SETTINGS_FILE,
    disabledSources: s.disabledSources || [],
    customSources: s.customSources || [],
  })

  ctx.inject(['webServer'], (c) => {
    let origin = ''
    try {
      origin = c.webServer.getOrigin()
    } catch {
      origin = '(unavailable)'
    }
    writeDiag({
      at: new Date().toISOString(),
      stage: 'injected',
      webServer: true,
      canRegister: typeof c.webServer.register === 'function',
      origin,
    })

    c.effect(() =>
      c.webServer.register({
        kind: 'exact',
        path: '/bili-learn/settings',
        // 必须用 handler 而不是 resource：resource 型路由只回 GET/HEAD，
        // 其它方法在匹配前就被 405 挡掉，POST 根本到不了这里。
        handler: async (req, res) => {
          const send = (payload, status = 200) => {
            const body = JSON.stringify(payload)
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            })
            res.end(body)
          }
          try {
            if (req.method === 'POST') {
              const chunks = []
              for await (const chunk of req) chunks.push(chunk)
              const raw = Buffer.concat(chunks).toString('utf8')
              let patch = {}
              try {
                patch = JSON.parse(raw || '{}')
              } catch {
                return send({ ok: false, error: '请求体不是合法 JSON' }, 400)
              }
              const cleanPatch = {}
              if (patch && typeof patch === 'object') {
                // 标量统一按 SETTING_SPECS 校验，范围只在规格里写一次。
                // 以前每个字段手写一段，加一个就要多抄一段，还容易把范围抄错。
                const { patch: scalars } = coerceScalars(patch)
                Object.assign(cleanPatch, scalars)

                // 区间要自洽：min 不得大于 max
                if (cleanPatch.agentsPerVideoMin !== undefined || cleanPatch.agentsPerVideoMax !== undefined) {
                  const lo = cleanPatch.agentsPerVideoMin ?? 2
                  const hi = cleanPatch.agentsPerVideoMax ?? 4
                  if (lo > hi) {
                    cleanPatch.agentsPerVideoMin = hi
                    cleanPatch.agentsPerVideoMax = lo
                  }
                }

                // 非标量：枚举、字符串、数组，各自有各自的校验
                if (
                  typeof patch.mode === 'string' &&
                  ['default', 'direct', 'self', 'proxy', 'auto'].includes(patch.mode)
                ) {
                  cleanPatch.mode = patch.mode
                }
                if (typeof patch.endpoint === 'string') cleanPatch.endpoint = patch.endpoint.trim()
                if (typeof patch.cookie === 'string') cleanPatch.cookie = patch.cookie.trim()
                if (Array.isArray(patch.disabledSources)) {
                  cleanPatch.disabledSources = patch.disabledSources
                    .filter((x) => typeof x === 'string')
                    .slice(0, 60)
                }
                if (Array.isArray(patch.customSources)) {
                  cleanPatch.customSources = patch.customSources
                    .filter((x) => x && typeof x.url === 'string' && /^https?:\/\//i.test(x.url))
                    .map((x) => ({
                      id: String(x.id || x.url).slice(0, 60),
                      name: String(x.name || '').slice(0, 40),
                      url: String(x.url).slice(0, 300),
                    }))
                    .slice(0, 30)
                }
              }
              const s = await saveSettings(cleanPatch)
              return send({ ok: true, settings: view(s) })
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405, { allow: 'GET, HEAD, POST' })
              return res.end()
            }
            const s = await loadSettings()
            return send({ ok: true, settings: view(s) })
          } catch (err) {
            return send({ ok: false, error: String(err && err.message ? err.message : err).slice(0, 300) }, 500)
          }
        },
      }),
    )

    c.effect(() =>
      c.webServer.register({
        kind: 'exact',
        path: '/bili-learn/test',
        resource: async () => {
          try {
            const s = await loadSettings()
            const out = { ok: true, self: null, login: null }
            if (s.endpoint) {
              const hlt = await selfHealth(s.endpoint)
              out.self = { ok: Boolean(hlt.ok), endpoint: s.endpoint }
            }
            const nav = await getJson(`${API}/x/web-interface/nav`, {
              cookie: s.cookie || '',
              gapMs: 400,
            })
            out.login = { ok: Boolean(nav?.data?.isLogin), name: nav?.data?.uname || '' }
            return Response.json(out)
          } catch (err) {
            return Response.json({ ok: false, error: String(err).slice(0, 200) }, { status: 500 })
          }
        },
      }),
    )

    c.effect(() =>
      c.webServer.register({
        kind: 'exact',
        path: '/bili-learn/sources',
        resource: async (request) => {
          try {
            const url = new URL(request.url, 'http://127.0.0.1')
            const refresh = url.searchParams.get('refresh') === '1'
            if (refresh) await probeAll()
            return Response.json({
              ok: true,
              at: sourceState.at,
              stale: !sourceState.at || Date.now() - sourceState.at > 10 * 60 * 1000,
              items: sourceState.items,
              all: effectiveSources(await loadSettings()).map((s) => ({
                id: s.id,
                kind: s.kind,
                name: s.name,
                note: s.note,
                url: s.url || '',
              })),
            })
          } catch (err) {
            return Response.json({ ok: false, error: String(err).slice(0, 200) }, { status: 500 })
          }
        },
      }),
    )

    c.effect(() =>
      c.webServer.register({
        kind: 'exact',
        path: '/bili-learn/qr',
        resource: async () => {
          try {
            const qr = await startQrLogin()
            return Response.json({ ok: true, key: qr.key, img: qr.img })
          } catch (err) {
            return Response.json({ ok: false, error: String(err).slice(0, 200) })
          }
        },
      }),
    )

    c.effect(() =>
      c.webServer.register({
        kind: 'exact',
        path: '/bili-learn/qr/poll',
        resource: async (request) => {
          try {
            const u = new URL(request.url, 'http://127.0.0.1')
            const key = u.searchParams.get('key') || ''
            if (!key) return Response.json({ ok: false, error: '缺少 key' }, { status: 400 })
            const r = await pollQrLogin(key)
            if (r.state === 'success') {
              await saveSettings({ cookie: r.cookie })
              return Response.json({ ok: true, state: 'success', message: '登录成功，已保存' })
            }
            return Response.json({ ok: true, state: r.state, message: r.message })
          } catch (err) {
            return Response.json({ ok: false, error: String(err).slice(0, 200) })
          }
        },
      }),
    )

    writeDiag({
      at: new Date().toISOString(),
      stage: 'registered',
      webServer: true,
      origin,
      routes: [
        '/bili-learn/settings',
        '/bili-learn/test',
        '/bili-learn/sources',
        '/bili-learn/qr',
        '/bili-learn/qr/poll',
      ],
      settingsRoute: 'handler (accepts POST)',
    })

    // 自证：面板点「保存」走的就是这条 POST。resource 型路由只认 GET/HEAD，
    // 所以这里实测一次，结果落盘，出问题时不用猜。
    const timer = setTimeout(async () => {
      const out = { at: new Date().toISOString(), origin }
      try {
        const before = await loadSettings()
        const res = await fetch(`${origin}/bili-learn/settings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ videoConcurrency: before.videoConcurrency ?? 3 }),
        })
        const body = await res.json().catch(() => ({}))
        out.postStatus = res.status
        out.postOk = Boolean(body.ok)
        out.postError = body.error || ''
      } catch (err) {
        out.postStatus = 0
        out.postOk = false
        out.postError = String(err).slice(0, 200)
      }
      writeFile(path.join(HARVEST_ROOT, '..', 'selftest.json'), JSON.stringify(out, null, 2), 'utf8').catch(
        () => {},
      )
    }, 8000)
    c.effect(() => () => clearTimeout(timer))
  })
}

export const inject = ['tools', 'commands']

export function apply(ctx) {
  registerTools(ctx)
  registerCommands(ctx)
  registerHttpApi(ctx)

  // 启动后延迟自检一遍源，别拖慢插件激活；失败也不影响任何工具
  ctx.effect(() => {
    const timer = setTimeout(() => {
      probeAll().catch(() => {})
    }, 6000)
    return () => clearTimeout(timer)
  })
}
