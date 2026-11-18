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

import { transcribeAudio } from './lib/asr.js'
import { ensureFfmpeg } from './lib/ffmpeg.js'
import { pollQrLogin, startQrLogin } from './lib/login.js'
import { readFrames } from './lib/media.js'

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

/**
 * 所有「标量设置」的唯一来源。
 *
 * 以前每加一个设置项要改十处：默认值、view 返回、POST 校验、bili_config 的
 * 参数/schema/render/execute/返回、采集读取、面板 state/加载/保存/UI。
 * 漏一处就是一个静默 bug——前端拿不到、或者写进去不生效。
 *
 * 现在默认值和校验都从这里派生，加一项只改这里一行。
 * bili_config 的参数描述仍手写：那是给模型读的措辞，不适合从规格生成。
 */
const SETTING_SPECS = {
  videoConcurrency: { kind: 'int', lo: 1, hi: 12, dflt: 3 },
  agentsPerVideoMin: { kind: 'int', lo: 1, hi: 8, dflt: 2 },
  agentsPerVideoMax: { kind: 'int', lo: 1, hi: 8, dflt: 4 },
  maxTotalAgents: { kind: 'int', lo: 1, hi: 24, dflt: 12 },
  maxAttempts: { kind: 'int', lo: 1, hi: 60, dflt: 30 },
  transcribeCap: { kind: 'int', lo: 0, hi: 10, dflt: 3 },
  framesCap: { kind: 'int', lo: 0, hi: 10, dflt: 2 },
  framesPerVideo: { kind: 'int', lo: 1, hi: 8, dflt: 3 },
  gapMs: { kind: 'int', lo: 300, hi: 5000, dflt: 1200 },
  fillByTranscribe: { kind: 'bool', dflt: false },
  fillByFrames: { kind: 'bool', dflt: false },
}

/** 默认值：从规格派生，避免两张表各写一遍而对不上。 */
function scalarDefaults() {
  const out = {}
  for (const [k, sp] of Object.entries(SETTING_SPECS)) out[k] = sp.dflt
  return out
}

/** 面板要看的标量：同样派生，漏字段会导致前端拿不到值。 */
function scalarView(s) {
  const out = {}
  for (const [k, sp] of Object.entries(SETTING_SPECS)) {
    out[k] = sp.kind === 'bool' ? Boolean(s[k]) : Number(s[k] ?? sp.dflt)
  }
  return out
}

/**
 * 按规格校验一批写入。返回能用的 patch 和被拒的字段名。
 * 被拒的字段不写进去，也不会把整批都丢掉。
 */
function coerceScalars(raw) {
  const patch = {}
  const rejected = []
  for (const [k, sp] of Object.entries(SETTING_SPECS)) {
    if (!(k in raw)) continue
    const v = raw[k]
    if (sp.kind === 'bool') {
      if (typeof v === 'boolean') patch[k] = v
      else rejected.push(k)
      continue
    }
    const n = Number(v)
    if (Number.isFinite(n) && n >= sp.lo && n <= sp.hi) patch[k] = Math.round(n)
    else rejected.push(k)
  }
  return { patch, rejected }
}

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

let lastCall = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function throttle(gapMs) {
  const dt = Date.now() - lastCall
  if (dt < gapMs) await sleep(gapMs - dt)
  lastCall = Date.now()
}

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
    await throttle(gapMs)
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
      if (attempt === retries) return { code: -412, message: 'Bilibili risk control (412)' }
      await sleep(attempt === 0 ? 45000 : 180000)
      continue
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
  const per = Math.min(Math.max(limit, 1), 49)
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
    `&ps=${Math.min(Math.max(limit, 1), 49)}&pn=1`
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
  /* --------------------------------------------------------------- learn */
  ctx.effect(() =>
    ctx.tools.register({
      name: 'bili_learn',
      description:
        'Study a topic from Bilibili before doing the work. Searches videos sorted by play count, ' +
        'harvests subtitles and top comments, and writes one readable markdown file per video. ' +
        'Returns a compact index with absolute file paths. Call it when the user asks to learn how ' +
        'something is done from Bilibili, or wants Bilibili used as a research source. After it ' +
        'returns, read those files in parallel — each video gets several subagents proportional to its length, ' +
        'and the total number running at once is capped — merge what they learned, then do the actual task. ' +
        'Subtitles and comment pages beyond a preview need a login cookie.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'What to learn, in the user\'s words. First search keyword.' },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'Extra search phrases, each a full variant of the intent. Max 4.',
          },
          maxVideos: { type: 'integer', description: 'Videos to harvest in full. Default 8, max 20.' },
          maxAttempts: {
            type: 'integer',
            description:
              '最多尝试多少个视频。遇到没有字幕的会跳过并继续找下一个，这个值防止一路试到搜索结果的尽头。' +
              '默认取面板设置（30），必须不小于 maxVideos，上限 60。',
          },
          withComments: { type: 'boolean', description: 'Also fetch top comments. Default true.' },
        },
        required: ['topic'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            dir: { type: 'string' },
            count: { type: 'integer' },
            tried: { type: 'integer' },
            skipped: { type: 'array', items: { type: 'object' } },
            transcribed: { type: 'array', items: { type: 'string' } },
            framed: { type: 'array', items: { type: 'string' } },
            mode: { type: 'string' },
            note: { type: 'string' },
            videos: { type: 'array', items: { type: 'object' } },
          },
        },
        render(args, value) {
          if (!value || value.ok !== true) return textBlock(`bili_learn 失败：${value?.note || '未知原因'}`)
          const lines = [`已采集 ${value.count} 条（取数方式：${value.mode}）`, `落盘目录：${value.dir}`, '']
          for (const v of value.videos || []) {
            lines.push(`- ${v.title} ｜ ${v.play} 播放 ｜ ${v.author} ｜ 字幕 ${v.subtitleLines} 行（${v.subtitleTrace}）｜ 评论 ${v.comments} 条`)
          }
          lines.push('', '建议派子 agent 各读一个文件（并发按面板配置），再合并结论。')
          if (value.note) lines.push('', value.note)
          return textBlock(lines.join('\n'))
        },
      },
      async execute(args) {
        const settings = await loadSettings()
        const r = await harvest(args, settings)
        if (!r.ok) return r
        return {
          ok: true,
          mode: r.mode,
          dir: r.dir,
          count: r.count,
          videos: r.videos,
          note: `${r.note} 每个文件都是独立正文，可并行阅读。`.trim(),
        }
      },
    }),
  )

  /* --------------------------------------------------------------- study */
  ctx.effect(() =>
    ctx.tools.register({
      name: 'bili_study',
      description:
        'One-shot study pipeline: harvest a topic from Bilibili, then dispatch subagents to read and ' +
        'condense the videos and merge their findings into a single brief. Use it when the user says to ' +
        'learn something from Bilibili AND then do work, so the reading starts without extra turns. ' +
        'NOTE: DSH subagents start immediately and report back asynchronously, so their text usually is ' +
        'not in this call\'s return value. `pending` counts the subagents still running; their results ' +
        'arrive as completion notices afterwards. Every harvest file is also on disk under `dir`, so you ' +
        'can always read them yourself instead of waiting.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'What to learn. Used as the first search keyword.' },
          keywords: { type: 'array', items: { type: 'string' }, description: 'Extra search variants. Max 4.' },
          maxVideos: { type: 'integer', description: 'Videos to study. Default 6, max 20.' },
          focus: {
            type: 'string',
            description:
              'What the reader should extract, e.g. "可落地的工程步骤与踩坑". Becomes the per-video instruction.',
          },
        },
        required: ['topic'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            dir: { type: 'string' },
            count: { type: 'integer' },
            dispatched: { type: 'integer' },
            degraded: { type: 'boolean' },
            pending: { type: 'integer' },
            note: { type: 'string' },
            brief: { type: 'string' },
          },
        },
        render(args, value) {
          if (!value?.ok) return textBlock(`bili_study 失败：${value?.note || '未知原因'}`)
          let head
          if (value.degraded && !value.dispatched) {
            head = `已采集 ${value.count} 条，但子 agent 派发不可用（降级模式）。`
          } else if (value.pending) {
            head =
              `已采集 ${value.count} 条 · ${value.pending} 个子 agent 已启动（结果异步送达）` +
              (value.dispatched ? ` · ${value.dispatched} 个已合并` : '')
          } else {
            head = `已采集 ${value.count} 条，并合并了 ${value.dispatched} 个子 agent 的研读结果。`
          }
          return textBlock(`${head}\n目录：${value.dir}\n\n${value.brief || ''}${value.note ? '\n\n' + value.note : ''}`)
        },
      },
      async execute(args, exec) {
        const settings = await loadSettings()
        const r = await harvest({ ...args, withComments: true }, settings)
        if (!r.ok) return r

        const focus = String(args.focus || '核心观点、可复用的具体做法与步骤、踩坑与注意事项、与本主题最相关的结论').trim()

        const clampN = (v, lo, hi, dflt) => {
          const n = Number(v)
          return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : dflt
        }
        const videosAtOnce = clampN(settings.videoConcurrency ?? settings.concurrency, 1, 12, 3)
        const aMin = clampN(settings.agentsPerVideoMin, 1, 8, 2)
        const aMax = Math.max(aMin, clampN(settings.agentsPerVideoMax, 1, 8, 4))
        const pool = clampN(settings.maxTotalAgents, 1, 24, 12)

        const targets = r.videos.slice(0, videosAtOnce)

        // 每个视频按内容量分配若干子 agent，各自读一段。
        // 全部段落进同一个队列，由固定大小的池消费 —— 短片读完它的段落，
        // 那些 worker 立刻接手长片剩下的段落，所以单个视频可以超过 aMax，
        // 但同时在跑的子 agent 数始终不超过 pool。
        const tasks = []
        for (const v of targets) {
          const k = agentsFor(v, aMin, aMax)
          let text = ''
          try {
            text = await readFile(v.file, 'utf8')
          } catch {
            text = ''
          }
          const segs = text ? splitSegments(text, k) : [null]
          segs.forEach((seg, i) => {
            tasks.push({ v, seg, idx: i + 1, total: segs.length })
          })
        }

        const collected = []
        const activationRuns = [] // 已启动但结果要异步回来的
        let degraded = false
        let degradeReason = ''
        if (!exec?.agent) {
          degraded = true
          degradeReason = '当前调用没有 agent 上下文，无法派发子 agent。'
        } else {
          let cursor = 0
          const runners = Array.from({ length: Math.max(1, Math.min(pool, tasks.length)) }, async () => {
            for (;;) {
              const mine = cursor
              cursor += 1
              if (mine >= tasks.length) return
              const t = tasks[mine]
              const segNote =
                t.total > 1
                  ? `\n\n注意：这是同一个视频的第 ${t.idx}/${t.total} 段，只提炼这一段里出现的内容，不要补别的段。`
                  : ''
              const prompt =
                `阅读文件：${t.v.file}\n\n` +
                `这是一个 B 站视频的记录（标题、简介、字幕、高赞评论）。主题：${args.topic}。${segNote}\n\n` +
                `请只做提炼，不要复述原文：\n1) 核心观点\n2) 可复用的具体做法 / 步骤 / 命令 / 参数\n` +
                `3) 踩坑与注意事项\n4) 最值得转述的结论\n\n重点：${focus}。\n` +
                `输出 markdown，400 字以内。信息不足就直说，不要编。`
              try {
                const batch = await ctx.tools.execute({
                  calls: [
                    {
                      type: 'tool-call',
                      id: `bili-study-${t.v.bvid}-${t.idx}`,
                      name: 'subagent',
                      arguments: JSON.stringify({
                        description: `研读 ${t.v.bvid}${t.total > 1 ? ` 第${t.idx}段` : ''}`,
                        prompt,
                      }),
                    },
                  ],
                  signal: exec.signal,
                  agent: exec.agent,
                })
                // ctx.tools.execute 的每一项是 { callId, result }，真正的工具
                // 返回值在 result 里。不解包的话下面所有判断都作用在外层对象上，
                // 最终落到 JSON.stringify，把整个响应当成正文塞进简报。
                const raw = batch?.results?.[0]
                const payload = raw?.result !== undefined ? raw.result : raw
                // DSH 的 subagent 是「启动即返回、结果异步送达」，拿到的往往是
                // activation 而不是正文，识别出来单独计数。
                const isActivation =
                  payload?.value?.kind === 'activation' ||
                  payload?.meta?.kind === 'activation' ||
                  /^started subagent/.test(String(payload?.value?.name || ''))
                if (isActivation) {
                  activationRuns.push(t.v.bvid)
                  continue
                }
                const text = resultText(payload)
                if (payload?.isError || !text.trim()) {
                  degraded = true
                  degradeReason = '有子 agent 返回空结果或被拒绝。'
                  continue
                }
                collected.push({ bvid: t.v.bvid, title: t.v.title, idx: t.idx, read: text })
              } catch (err) {
                degraded = true
                degradeReason = `子 agent 派发失败：${String(err).slice(0, 160)}`
              }
            }
          })
          await Promise.all(runners)
        }

        // 合并：同一个视频的多个段落按顺序拼回去
        const grouped = new Map()
        for (const c of collected.sort((a, b) => a.idx - b.idx)) {
          if (!grouped.has(c.bvid)) grouped.set(c.bvid, { title: c.title, segs: [] })
          grouped.get(c.bvid).segs.push(c.read.trim())
        }
        const dispatched = [...grouped.entries()].map(([bvid, o]) => ({
          bvid,
          title: o.title,
          read: o.segs.join('\n\n'),
          segments: o.segs.length,
        }))

        const parts = []
        for (const d of dispatched) {
          parts.push(
            `## ${d.title}（${d.bvid}）${d.segments > 1 ? ` · ${d.segments} 段` : ''}`,
            '',
            d.read.trim(),
            '',
          )
        }
        const brief = parts.length
          ? parts.join('\n')
          : ''

        // 子 agent 是异步的：派出去之后结果要等通知，这里不可能同步拿到正文。
        // 所以分三种情况说明白，而不是假装已经合并完成。
        let note
        if (activationRuns.length && !dispatched.length) {
          note =
            `已派出 ${activationRuns.length} 个子 agent 研读，但它们的结果要异步回来，` +
            `不会出现在本次返回里。文件都在 ${r.dir}。` +
            `可等它们各自回报后再合并；或直接读取这些文件自己总结。`
        } else if (degraded) {
          note = `${degradeReason} 文件已全部落盘在 ${r.dir}，请直接派子 agent 读取，每个文件一个。`
        } else if (activationRuns.length) {
          note =
            `${dispatched.length} 个视频的研读结果已合并；另有 ${activationRuns.length} 个子 agent ` +
            `仍在后台跑，结果会另行送达。`
        } else {
          note = r.note
        }

        return {
          ok: true,
          dir: r.dir,
          count: r.count,
          dispatched: dispatched.length,
          pending: activationRuns.length,
          degraded,
          brief,
          note,
        }
      },
    }),
  )

  /* -------------------------------------------------------------- config */
  ctx.effect(() =>
    ctx.tools.register({
      name: 'bili_config',
      description:
        'Read or change the Bilibili learner settings: fetch mode, how many videos to read at once, how many ' +
        'subagents each video gets, the total subagent cap, self-hosted endpoint, login cookie, and third-party ' +
        'pool. Call with no arguments to read the current settings.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['default', 'direct', 'self', 'proxy', 'auto'],
            description: 'Fetch strategy.',
          },
          videoConcurrency: {
            type: 'integer',
            description: '同时阅读几个视频。1-12，建议 3 以上以免只看一个来源而片面。',
          },
          agentsPerVideoMin: {
            type: 'integer',
            description: '每个视频至少分配几个子 agent。1-8。',
          },
          agentsPerVideoMax: {
            type: 'integer',
            description:
              '每个视频正常情况下分配几个子 agent（内容长时会超过它，靠别人的空闲 worker 补）。1-8。',
          },
          maxTotalAgents: {
            type: 'integer',
            description: '子 agent 总数硬上限。同时在跑的数量不超过它。1-24。',
          },
          maxAttempts: {
            type: 'integer',
            description: '采集时最多尝试几个视频。没字幕的会跳过继续找，这是硬上限。1-60。',
          },
          fillByTranscribe: {
            type: 'boolean',
            description: '没字幕轨时是否改用音频转写补正文。慢，默认 false。',
          },
          transcribeCap: {
            type: 'integer',
            description: '开启转写后一次最多补几条。0-10。',
          },
          fillByFrames: {
            type: 'boolean',
            description: '没字幕轨时是否抽帧看画面。比转写贵得多（每帧一次视觉调用），默认 false。',
          },
          framesCap: {
            type: 'integer',
            description: '抽帧最多补几条视频。0-10。',
          },
          framesPerVideo: {
            type: 'integer',
            description: '每条视频抽几帧。1-8。',
          },
          fillByFrames: {
            type: 'boolean',
            description: '没字幕轨时是否抽帧看画面。比转写贵得多（每帧一次视觉调用），默认 false。',
          },
          framesCap: {
            type: 'integer',
            description: '抽帧最多补几条视频。0-10。',
          },
          framesPerVideo: {
            type: 'integer',
            description: '每条视频抽几帧。1-8。',
          },
          endpoint: { type: 'string', description: 'Self-hosted parse service base URL.' },
          cookie: { type: 'string', description: 'Bilibili login cookie, normally the SESSDATA pair.' },
          proxies: { type: 'array', items: { type: 'string' }, description: 'Third-party parser base URLs.' },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            mode: { type: 'string' },
            videoConcurrency: { type: 'integer' },
            agentsPerVideoMin: { type: 'integer' },
            agentsPerVideoMax: { type: 'integer' },
            maxTotalAgents: { type: 'integer' },
            maxAttempts: { type: 'integer' },
            fillByTranscribe: { type: 'boolean' },
            transcribeCap: { type: 'integer' },
            fillByFrames: { type: 'boolean' },
            framesCap: { type: 'integer' },
            framesPerVideo: { type: 'integer' },
            endpoint: { type: 'string' },
            cookieSet: { type: 'boolean' },
            proxies: { type: 'array', items: { type: 'string' } },
            file: { type: 'string' },
          },
        },
        render(args, value) {
          return textBlock(
            [
              `取数方式：${value.mode}`,
              `同时阅读视频数：${value.videoConcurrency}`,
              `每个视频分配 AI：${value.agentsPerVideoMin}-${value.agentsPerVideoMax} 个（长的会超过，靠空闲的补）`,
              `AI 总数上限：${value.maxTotalAgents}`,
              `最多尝试视频数：${value.maxAttempts}`,
              `没字幕时转写补齐：${value.fillByTranscribe ? `开（最多 ${value.transcribeCap} 条）` : '关'}`,
              `没字幕时抽帧看画面：${value.fillByFrames ? `开（最多 ${value.framesCap} 条，每条约 ${value.framesPerVideo} 帧）` : '关'}`,
              `自建服务器：${value.endpoint}`,
              `登录凭证：${value.cookieSet ? '已配置' : '未配置（字幕为空）'}`,
              `第三方池：${(value.proxies || []).length ? value.proxies.join(', ') : '（空）'}`,
              `配置文件：${value.file}`,
            ].join('\n'),
          )
        },
      },
      async execute(args) {
        const patch = {}
        if (args.mode) patch.mode = args.mode
        if (args.videoConcurrency) {
          patch.videoConcurrency = Math.min(Math.max(Number(args.videoConcurrency), 1), 12)
        }
        if (args.agentsPerVideoMin) {
          patch.agentsPerVideoMin = Math.min(Math.max(Number(args.agentsPerVideoMin), 1), 8)
        }
        if (args.agentsPerVideoMax) {
          patch.agentsPerVideoMax = Math.min(Math.max(Number(args.agentsPerVideoMax), 1), 8)
        }
        if (args.maxTotalAgents) {
          patch.maxTotalAgents = Math.min(Math.max(Number(args.maxTotalAgents), 1), 24)
        }
        if (args.maxAttempts) {
          patch.maxAttempts = Math.min(Math.max(Number(args.maxAttempts), 1), 60)
        }
        if (typeof args.fillByTranscribe === 'boolean') {
          patch.fillByTranscribe = args.fillByTranscribe
        }
        if (args.transcribeCap !== undefined) {
          patch.transcribeCap = Math.min(Math.max(Number(args.transcribeCap), 0), 10)
        }
        if (typeof args.fillByFrames === 'boolean') patch.fillByFrames = args.fillByFrames
        if (args.framesCap !== undefined) {
          patch.framesCap = Math.min(Math.max(Number(args.framesCap), 0), 10)
        }
        if (args.framesPerVideo !== undefined) {
          patch.framesPerVideo = Math.min(Math.max(Number(args.framesPerVideo), 1), 8)
        }
        if (patch.agentsPerVideoMin && patch.agentsPerVideoMax && patch.agentsPerVideoMin > patch.agentsPerVideoMax) {
          const lo = patch.agentsPerVideoMin
          patch.agentsPerVideoMin = patch.agentsPerVideoMax
          patch.agentsPerVideoMax = lo
        }
        if (typeof args.endpoint === 'string') patch.endpoint = args.endpoint
        if (typeof args.cookie === 'string') patch.cookie = args.cookie
        if (Array.isArray(args.proxies)) patch.proxies = args.proxies
        const s = Object.keys(patch).length ? await saveSettings(patch) : await loadSettings()
        return {
          mode: s.mode,
          videoConcurrency: s.videoConcurrency ?? s.concurrency ?? 3,
          agentsPerVideoMin: s.agentsPerVideoMin ?? 2,
          agentsPerVideoMax: s.agentsPerVideoMax ?? 4,
          maxTotalAgents: s.maxTotalAgents ?? 12,
          maxAttempts: s.maxAttempts ?? 30,
    fillByTranscribe: Boolean(s.fillByTranscribe),
    transcribeCap: s.transcribeCap ?? 3,
    fillByFrames: Boolean(s.fillByFrames),
    framesCap: s.framesCap ?? 2,
    framesPerVideo: s.framesPerVideo ?? 3,
          endpoint: s.endpoint,
          cookieSet: Boolean(s.cookie),
          proxies: s.proxies || [],
          file: SETTINGS_FILE,
        }
      },
    }),
  )

  /* --------------------------------------------------------------- watch */
  ctx.effect(() =>
    ctx.tools.register({
      name: 'bili_watch',
      description:
        'Fetch subtitles and top comments for a single Bilibili video by BV id, without searching. ' +
        'Use it when the user names a specific video. Returns the text inline and writes a markdown file.',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV id, e.g. BV15es76gEgL.' },
          p: {
            type: 'integer',
            description:
              '第几 P（分P 序号）。多集课程里指定这一集，默认 1。分P 清单用 bili_series 查。',
          },
          aid: {
            type: 'string',
            description:
              'Optional numeric aid (the av number). Comments need it; a BV id alone cannot resolve ' +
              'comments without the view endpoint, which is risk-blocked.',
          },
          withComments: { type: 'boolean', description: 'Include top comments. Default true.' },
          commentLimit: {
            type: 'integer',
            description: '最多取多少条主评论。默认 20，上限 100。需要登录才能超过 3 条。',
          },
          commentPages: {
            type: 'integer',
            description: '翻几页评论（每页约 20 条）。默认 1，上限 5。页与页之间会自动限速。',
          },
          replyLimit: {
            type: 'integer',
            description: '给前几条「有回复的」主评论再取二级评论。默认 3，传 0 表示不取。',
          },
        },
        required: ['bvid'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            bvid: { type: 'string' },
            subtitleLines: { type: 'integer' },
            subtitleTrace: { type: 'string' },
            comments: { type: 'integer' },
            file: { type: 'string' },
            preview: { type: 'string' },
          },
        },
        render(args, value) {
          if (!value?.ok) return textBlock(`bili_watch 失败：${value?.subtitleTrace || '未知原因'}`)
          return textBlock(
            `${value.bvid}：字幕 ${value.subtitleLines} 行（${value.subtitleTrace}），评论 ${value.comments} 条\n` +
              `已写入 ${value.file}\n\n${value.preview || ''}`,
          )
        },
      },
      async execute(args) {
        const settings = await loadSettings()
        const opts = { cookie: settings.cookie || '', gapMs: Math.max(300, Number(settings.gapMs) || 1200) }
        const bvid = String(args.bvid || '').trim()
        if (!/^BV[0-9A-Za-z]+$/.test(bvid)) {
          return { ok: false, bvid, subtitleTrace: 'invalid bvid', subtitleLines: 0, comments: 0 }
        }
        // 分P：一集课程就是多个 P，只取第一个等于读错了集
        const wantPage = Math.max(1, Number(args.p) || 1)
        const grabbed = await getParts(bvid, opts)
        if (!grabbed.parts || !grabbed.parts.length) {
          return {
            ok: false,
            bvid,
            subtitleTrace: grabbed.error || '取不到分P清单',
            subtitleLines: 0,
            comments: 0,
          }
        }
        const target = grabbed.parts.find((x) => x.page === wantPage) || grabbed.parts[0]

        // 评论要 aid；整条视频共用同一个 aid，与第几 P 无关
        const meta = await getViewMeta(bvid, opts)
        const subs = await getSubtitles(bvid, target.cid, opts)
        const aid = meta?.aid || args.aid
        // 翻几页就该给几页的量：只说 commentPages 而没说 commentLimit 时，
        // 上限按页数放大，否则「翻 2 页」会莫名其妙只拿到 20 条。
        const cPages = Math.min(Math.max(Number(args.commentPages) || 1, 1), 5)
        const cLimit = Math.min(Math.max(Number(args.commentLimit) || cPages * 20, 1), 100)

        const comments =
          args.withComments === false
            ? { items: [], trace: 'skipped', pages: 0 }
            : aid
              ? await getComments(aid, opts, { limit: cLimit, maxPages: cPages })
              : { items: [], trace: 'no_aid（登录后可得）', pages: 0 }

        // 二级评论：只对前几条有回复的主评论取，避免请求爆炸
        if (aid && comments.items.length && Number(args.replyLimit) !== 0) {
          const want = Math.min(Math.max(Number(args.replyLimit) || 3, 0), 8)
          let fetched = 0
          for (const c of comments.items) {
            if (fetched >= want) break
            if (!c.replyCount) continue
            const r = await getCommentReplies(aid, c.rpid, opts, { limit: 6 })
            if (r.items.length) {
              c.replies = r.items
              fetched += 1
            }
          }
        }
        await mkdir(HARVEST_ROOT, { recursive: true })
        // 分P 必须进文件名，否则连抓几集只会留下最后一集
        const suffix = wantPage > 1 ? `-P${wantPage}` : ''
        const file = path.join(HARVEST_ROOT, `${bvid}${suffix}.md`)
        await writeFile(
          file,
          toMarkdown({
            bvid,
            title: bvid,
            author: '-',
            play: 0,
            duration: 0,
            desc: '',
            subtitles: subs.lines,
            subtitleTrace: subs.trace,
            comments: comments.items,
            commentTrace: comments.trace,
          }),
          'utf8',
        )
        return {
          ok: true,
          bvid,
          subtitleLines: subs.lines.length,
          subtitleTrace: subs.trace,
          comments: comments.items.length,
          file,
          preview: subs.lines.slice(0, 12).map((l) => l.text).join('\n'),
        }
      },
    }),
  )

  /* --------------------------------------------------------------- frames */
  ctx.effect(() =>
    ctx.tools.register({
      name: 'bili_frames',
      description:
        'Look at what is actually on screen in a Bilibili video. Downloads the lowest-bitrate video ' +
        'track, extracts frames, and has a vision model describe each one with a timestamp. ' +
        'Subtitles only carry what the uploader said; this carries what was shown: slides, code on ' +
        'screen, UI states, gameplay, physical demonstrations. Use it when the request depends on ' +
        'visual content that a transcript cannot describe. Each frame costs one vision call, so keep ' +
        'maxFrames small and raise it only when the first pass misses something.',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV id, e.g. BV1fAZtYoEnW.' },
          maxFrames: {
            type: 'integer',
            description: 'How many distinct frames to look at. Default 8, maximum 16. One vision call per frame.',
          },
          interval: {
            type: 'integer',
            description: 'Seconds between sampled frames. Omit to derive it from duration and maxFrames.',
          },
          prompt: {
            type: 'string',
            description:
              'What the vision model should pull out, e.g. "只读屏幕上的代码和终端输出". Defaults to a general scene description.',
          },
        },
        required: ['bvid'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            bvid: { type: 'string' },
            frames: { type: 'integer' },
            markdown: { type: 'string' },
            log: { type: 'string' },
            note: { type: 'string' },
          },
        },
        render(args, value) {
          if (!value?.ok) return textBlock(`bili_frames 失败：${value?.note || '未知原因'}`)
          return textBlock(
            `${value.bvid}：看了 ${value.frames} 帧\n\n${value.markdown}${value.log ? `\n\n---\n${value.log}` : ''}`,
          )
        },
      },
      async execute(args) {
        const s = await loadSettings()
        const bvid = String(args.bvid || '').trim()
        if (!/^BV[0-9A-Za-z]+$/.test(bvid)) {
          return { ok: false, bvid, note: 'invalid bvid', frames: 0, markdown: '' }
        }
        const meta = await getCid(bvid, { cookie: s.cookie || '', gapMs: 400 })
        if (!meta?.cid) {
          return { ok: false, bvid, note: '取不到 cid，可能视频不存在或接口被拦', frames: 0, markdown: '' }
        }
        let ff
        try {
          ff = await ensureFfmpeg()
        } catch (err) {
          return {
            ok: false,
            bvid,
            frames: 0,
            markdown: '',
            note: `需要 ffmpeg 但没准备好：${String(err).slice(0, 200)}`,
          }
        }
        const r = await readFrames(bvid, meta.cid, meta.duration, s, {
          maxFrames: args.maxFrames,
          interval: args.interval,
          prompt: args.prompt,
          ffmpegPath: ff.path,
        })
        return { ...r, bvid, ffmpeg: ff.path, ffmpegDownloaded: ff.downloaded }
      },
    }),
  )

  /* ---------------------------------------------------------- transcribe */
  ctx.effect(() =>
    ctx.tools.register({
      name: 'bili_transcribe',
      description:
        'Turn the spoken audio of a video into text, without a login. Use it when the subtitle is missing — ' +
        'only about one video in nine has one — and you need what was actually said. Downloads the audio ' +
        'track and sends it to a speech-to-text endpoint. Costs roughly the audio duration in wall time, ' +
        'so it suits a few key videos rather than a bulk harvest.',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV id, e.g. BV1fAZtYoEnW.' },
        },
        required: ['bvid'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            bvid: { type: 'string' },
            chars: { type: 'integer' },
            seconds: { type: 'integer' },
            text: { type: 'string' },
            file: { type: 'string' },
            log: { type: 'string' },
            note: { type: 'string' },
          },
        },
        render(args, value) {
          if (!value?.ok) return textBlock(`转写失败：${value?.note || '未知原因'}`)
          return textBlock(
            `${value.bvid}：${value.chars} 字 / ${value.seconds}s\n已写入 ${value.file}\n\n${String(value.text || '').slice(0, 1200)}`,
          )
        },
      },
      async execute(args) {
        const s = await loadSettings()
        const bvid = String(args.bvid || '').trim()
        if (!/^BV[0-9A-Za-z]+$/.test(bvid)) {
          return { ok: false, bvid, note: 'invalid bvid', chars: 0, text: '' }
        }
        const meta = await getCid(bvid, { cookie: s.cookie || '', gapMs: 400 })
        if (!meta?.cid) return { ok: false, bvid, note: '取不到 cid', chars: 0, text: '' }

        const r = await transcribeAudio(bvid, meta.cid, s)
        if (!r.ok) return { ok: false, bvid, chars: 0, text: '', log: r.log, note: r.note }

        const dir = path.join(HARVEST_ROOT, `${bvid}-转写`)
        await mkdir(dir, { recursive: true })
        const file = path.join(dir, `${bvid}.md`)
        await writeFile(
          file,
          `# ${bvid}（音频转写）\n\n- 链接: https://www.bilibili.com/video/${bvid}\n- 来源: 音频转写\n\n${r.text}\n`,
          'utf8',
        )
        return {
          ok: true,
          bvid,
          chars: r.text.length,
          seconds: r.seconds,
          text: r.text,
          file,
          log: r.log,
        }
      },
    }),
  )

  /* --------------------------------------------------------------- series */
  ctx.effect(() =>
    ctx.tools.register({
      name: 'bili_series',
      description:
        'List every part of a multi-part video. Courses and tutorial series often have dozens to hundreds of ' +
        'parts — without this you only ever read part one. Returns each part with its page number, cid, title ' +
        'and duration, plus the uploader profile and the whole-video stats. Optionally probes the first few ' +
        'parts for subtitles, since the subtitle endpoint is per-part. Use it before studying a course so you ' +
        'can pick which parts are worth the tokens instead of fetching everything.',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV id of any part of the series.' },
          probeSubtitles: {
            type: 'integer',
            description:
              'Check the first N parts for a subtitle track. Default 0 (list only). Each part costs one request.',
          },
        },
        required: ['bvid'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            bvid: { type: 'string' },
            title: { type: 'string' },
            owner: { type: 'object' },
            stat: { type: 'object' },
            partCount: { type: 'integer' },
            totalDuration: { type: 'integer' },
            subtitled: { type: 'integer' },
            parts: { type: 'array', items: { type: 'object' } },
            note: { type: 'string' },
          },
        },
        render(args, value) {
          if (!value?.ok) return textBlock(`bili_series 失败：${value?.note || '未知原因'}`)
          const o = value.owner || {}
          const st = value.stat || {}
          const lines = [
            `${value.title}  ·  ${value.partCount} 个分P  ·  总时长 ${Math.round((value.totalDuration || 0) / 60)} 分钟`,
            `UP：${o.name || '-'}（粉丝 ${(o.follower || 0).toLocaleString()}）`,
            `播放 ${(st.view || 0).toLocaleString()} · 弹幕 ${(st.danmaku || 0).toLocaleString()} · 评论 ${(st.reply || 0).toLocaleString()}`,
            '',
          ]
          for (const p of (value.parts || []).slice(0, 40)) {
            const mm = Math.floor((p.duration || 0) / 60)
            const ss = String((p.duration || 0) % 60).padStart(2, '0')
            const flag = p.hasSubtitle === true ? ' [字幕]' : p.hasSubtitle === false ? ' [无字幕]' : ''
            lines.push(`P${p.page}  ${mm}:${ss}${flag}  ${p.title}`)
          }
          if ((value.parts || []).length > 40) lines.push(`…还有 ${value.parts.length - 40} 个分P`)
          if (value.note) lines.push('', value.note)
          return textBlock(lines.join('\n'))
        },
      },
      async execute(args) {
        const s = await loadSettings()
        const opts = { cookie: s.cookie || '', gapMs: Math.max(300, Number(s.gapMs) || 1200) }
        const bvid = String(args.bvid || '').trim()
        if (!/^BV[0-9A-Za-z]+$/.test(bvid)) {
          return { ok: false, bvid, note: 'invalid bvid', parts: [], partCount: 0 }
        }

        const grabbed = await getParts(bvid, opts)
        if (!grabbed.parts || !grabbed.parts.length) {
          return {
            ok: false,
            bvid,
            note: grabbed.error || '取不到分P清单',
            parts: [],
            partCount: 0,
          }
        }
        const parts = grabbed.parts

        const meta = await getViewMeta(bvid, opts)
        const owner = { name: meta?.owner || '', mid: meta?.ownerMid || 0, follower: 0 }
        if (owner.mid) {
          const upStat = await getUpStat(owner.mid, opts)
          if (upStat) owner.follower = upStat.follower
        }

        // 可选：探测前 N 个 P 有没有字幕
        const probe = Math.min(Math.max(Number(args.probeSubtitles) || 0, 0), 20)
        let subtitled = 0
        if (probe > 0) {
          for (const p of parts.slice(0, probe)) {
            const r = await getSubtitles(bvid, p.cid, opts)
            p.hasSubtitle = r.lines.length > 0
            if (p.hasSubtitle) subtitled += 1
          }
        }

        const totalDuration = parts.reduce((n, p) => n + (p.duration || 0), 0)
        const stat = meta?.stat || {}
        return {
          ok: true,
          bvid,
          title: meta?.title || '',
          owner,
          stat: {
            view: stat.view || 0,
            danmaku: stat.danmaku || 0,
            reply: stat.reply || 0,
            like: stat.like || 0,
            favorite: stat.favorite || 0,
          },
          partCount: parts.length,
          totalDuration,
          subtitled,
          parts,
          note:
            probe > 0
              ? `已探测前 ${probe} 个分P，其中 ${subtitled} 个有字幕。用 bili_watch 加 p 参数抓具体某一集。`
              : '只列清单，未探测字幕。要看某集内容，用 bili_watch 加 p 参数；想知道哪些集有字幕，传 probeSubtitles。',
        }
      },
    }),
  )

  /* -------------------------------------------------------------- sources */
  ctx.effect(() =>
    ctx.tools.register({
      name: 'bili_sources',
      description:
        'Report which fetch sources are reachable right now: the official API paths, an optional self-hosted ' +
        'server, and human-facing parser sites. The sites matter even though they cannot be called over plain ' +
        'HTTP — each carries its own egress IP, so a subagent driving a browser through one spreads load away ' +
        'from this machine. Call this before a large harvest to pick a plan, or after repeated 412s to find a ' +
        'route that still answers. Pass refresh to re-probe instead of reading the cache.',
      parameters: {
        type: 'object',
        properties: {
          refresh: { type: 'boolean', description: 'Re-probe every source now instead of using the cache.' },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            at: { type: 'string' },
            api: { type: 'array', items: { type: 'object' } },
            web: { type: 'array', items: { type: 'object' } },
            advice: { type: 'string' },
          },
        },
        render(args, value) {
          if (!value?.ok) return textBlock('源状态读取失败')
          const line = (r) =>
            `${r.ok ? '在线' : '不可用'}  ${String(r.ms).padStart(5)}ms  ${r.name}${r.note ? ' — ' + r.note : ''}`
          const parts = ['接口类（可自动竞速）', ...value.api.map((r) => '  ' + line(r))]
          parts.push('', '网页类（有独立出口 IP，需子 agent 用浏览器操作）')
          parts.push(...value.web.map((r) => '  ' + line(r)))
          if (value.advice) parts.push('', value.advice)
          return textBlock(parts.join('\n'))
        },
      },
      async execute(args) {
        if (args.refresh || !sourceState.at) await probeAll()
        const list = effectiveSources(await loadSettings())
        const pick = (kind) =>
          sourceState.items
            .map((r) => ({ ...r, kind: (list.find((s) => s.id === r.id) || {}).kind }))
            .filter((r) => r.kind === kind)
            .map((r) => ({ id: r.id, name: r.name, ok: r.ok, ms: r.ms, note: r.note }))
        const api = pick('api').concat(pick('self'))
        const web = pick('web')
        const liveWeb = web.filter((r) => r.ok).map((r) => r.name) // 已是字符串数组
        const apiOk = api.some((r) => r.ok)
        const advice = apiOk
          ? `接口类可用，正常采集即可。${liveWeb.length ? `另有 ${liveWeb.length} 个网页源在线；需要分摊风险时可派子 agent 走 ${liveWeb[0]}。` : ''}`
          : `接口类全部不可用。派子 agent 用浏览器打开 ${liveWeb[0] || '任一网页源'} 解析，实测约 12 秒一条、无需验证码；完整步骤见插件 docs/BROWSER_SCRAPE.md。`
        return { ok: true, at: new Date(sourceState.at).toISOString(), api, web, advice }
      },
    }),
  )
}

/* ------------------------------------------------------------------ sources */

/**
 * Source registry.
 *
 * Three kinds, because they fail differently:
 *   api  — speaks JSON, can join the automatic race, limited by our own IP quota
 *   web  — a human-facing page; it carries its own egress IP, so it is the only
 *          way to spread risk for users who have no server of their own
 *   self — a self-hosted parser, optional and never required
 *
 * `web` sources cannot be automated over plain HTTP (measured: they answer 200
 * with no media links and require a captcha click), but a subagent driving a
 * browser can use one. That is the point of them: not an API, an exit IP.
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

/** 内置 + 用户自加 − 用户禁用。面板改动立刻反映到探测与竞速。 */
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
  const results = await Promise.all(list.map((s) => probeOne(s)))
  sourceState = {
    at: Date.now(),
    items: results.map((r) => ({ ...r, name: (list.find((s) => s.id === r.id) || {}).name || r.id })),
  }
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
/**
 * 命令层的数字参数。label 是给人看的措辞，范围统一从 SETTING_SPECS 取——
 * 否则同一个范围要在两处维护，改一处忘一处就会变成「命令说 1-12、实际校验 1-8」。
 */
const NUMERIC_SPECS = {
  videos: { field: 'videoConcurrency', label: '同时阅读视频数' },
  total: { field: 'maxTotalAgents', label: 'AI 总数上限' },
  gap: { field: 'gapMs', label: '请求间隔' },
  attempts: { field: 'maxAttempts', label: '最多尝试视频数' },
}
for (const spec of Object.values(NUMERIC_SPECS)) {
  spec.lo = SETTING_SPECS[spec.field].lo
  spec.hi = SETTING_SPECS[spec.field].hi
}

function checkNumber(raw, spec) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < spec.lo || n > spec.hi) {
    return { ok: false, message: `${spec.label}必须是 ${spec.lo} 到 ${spec.hi} 之间的整数` }
  }
  return { ok: true, value: Math.round(n) }
}

/** 阅读编排的一句话摘要，status 与 set 共用，避免两套措辞。 */
function readPlanSummary(s) {
  return (
    `取数方式 ${s.mode} · 同时读 ${s.videoConcurrency ?? s.concurrency ?? 3} 个视频` +
    ` · 每片 ${s.agentsPerVideoMin ?? 2}-${s.agentsPerVideoMax ?? 4} 个AI` +
    ` · 总数上限 ${s.maxTotalAgents ?? 12} · 间隔 ${s.gapMs}ms`
  )
}

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
