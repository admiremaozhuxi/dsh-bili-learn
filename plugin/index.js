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
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

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

const DEFAULT_SETTINGS = {
  mode: 'auto',
  concurrency: 4,
  endpoint: 'http://127.0.0.1:8848',
  cookie: '',
  proxies: [],
  gapMs: 1200,
  // 画面路径：python 解释器与抽帧脚本的位置，留空则用默认推断
  pythonPath: '',
  framesScript: '',
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
  return first ? { cid: first.cid, parts: (d.data || []).length } : null
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
  for (const s of subs) {
    let u = s.subtitle_url || ''
    if (u.startsWith('//')) u = `https:${u}`
    if (!u) continue
    const r = await getJson(u, { gapMs: 400 })
    for (const x of Array.isArray(r?.body) ? r.body : []) {
      out.push({ from: x.from, to: x.to, text: x.content })
    }
  }
  return { lines: out, trace: out.length ? 'ok' : 'empty_body' }
}

async function getComments(aid, opts, limit = 20) {
  if (!aid) return { items: [], trace: 'no_aid' }
  const url = `${API}/x/v2/reply?type=1&oid=${aid}&ps=${Math.min(limit, 49)}&sort=2`
  const d = await getJson(url, opts)
  if (d.code !== 0) return { items: [], trace: `api_code_${d.code}` }
  const reps = d?.data?.replies || []
  return {
    items: reps.slice(0, limit).map((r) => ({
      like: r.like,
      user: r?.member?.uname,
      text: String(r?.content?.message || '').slice(0, 400),
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
    for (const c of v.comments) out.push(`- (${c.like} 赞) ${c.user}: ${c.text}`)
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
    return { ok: false, note: '取数方式设为「默认（什么都不做）」，请先切换为 auto 或 direct。', videos: [], count: 0 }
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

  const ranked = [...seen.values()]
    .sort((a, b) => (Number(b.play) || 0) - (Number(a.play) || 0))
    .slice(0, maxVideos)

  if (!ranked.length) {
    return { ok: false, mode: effective, note: `搜索无结果。${errors.join('; ')}`, videos: [], count: 0 }
  }

  const dir = path.join(
    HARVEST_ROOT,
    `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${slugify(args.topic)}`,
  )
  await mkdir(dir, { recursive: true })

  const withComments = args.withComments !== false
  const results = []
  for (const v of ranked) {
    const page = await getCid(v.bvid, opts)
    let subs = { lines: [], trace: 'no_cid' }
    let comments = { items: [], trace: 'skipped' }
    if (page?.cid) {
      subs = await getSubtitles(v.bvid, page.cid, opts)
      if (withComments) comments = await getComments(v.aid, opts, 20)
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
    JSON.stringify({ topic: args.topic, mode: effective, at: new Date().toISOString(), videos: results }, null, 2),
    'utf8',
  )

  if (results.every((r) => r.subtitleLines === 0) && !settings.cookie) {
    notes.push('未配置 SESSDATA，字幕全为空——这是 B 站的行为，不是失败。要正文请在面板配置凭证，或改用音频转写。')
  }

  return { ok: true, mode: effective, dir, count: results.length, videos: results, note: notes.join(' ') }
}

/* --------------------------------------------------------------------- tools */

const textBlock = (text) => [{ type: 'text', text }]

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
        'returns, read those files in parallel — one subagent per file, up to the configured ' +
        'concurrency — merge what they learned, then do the actual task. ' +
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
        'One-shot study pipeline: harvest a topic from Bilibili, then dispatch one subagent per video ' +
        'to read and condense it, and merge their findings into a single brief. Use it when the user ' +
        'says to learn something from Bilibili AND then do work, so the reading happens without ' +
        'extra turns. If subagent dispatch is unavailable it still returns the harvested files plus ' +
        'an explicit instruction, so nothing is lost.',
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
            note: { type: 'string' },
            brief: { type: 'string' },
          },
        },
        render(args, value) {
          if (!value?.ok) return textBlock(`bili_study 失败：${value?.note || '未知原因'}`)
          const head = value.degraded
            ? `已采集 ${value.count} 条，但子 agent 派发不可用（降级模式）。`
            : `已采集 ${value.count} 条，并派发 ${value.dispatched} 个子 agent 并行研读。`
          return textBlock(`${head}\n目录：${value.dir}\n\n${value.brief || ''}${value.note ? '\n\n' + value.note : ''}`)
        },
      },
      async execute(args, exec) {
        const settings = await loadSettings()
        const r = await harvest({ ...args, withComments: true }, settings)
        if (!r.ok) return r

        const focus = String(args.focus || '核心观点、可复用的具体做法与步骤、踩坑与注意事项、与本主题最相关的结论').trim()
        const limit = Math.min(Math.max(Number(settings.concurrency) || 4, 1), 12)
        const targets = r.videos.slice(0, Math.max(limit, 1))

        // Dispatch one reader per video. Any failure degrades instead of aborting.
        const dispatched = []
        let degraded = false
        let degradeReason = ''
        if (!exec?.agent) {
          degraded = true
          degradeReason = '当前调用没有 agent 上下文，无法派发子 agent。'
        } else {
          for (const v of targets) {
            const prompt =
              `阅读文件：${v.file}\n\n` +
              `这是一个 B 站视频的完整记录（标题、简介、字幕、高赞评论）。主题：${args.topic}。\n\n` +
              `请只做提炼，不要复述原文：\n1) 核心观点\n2) 可复用的具体做法 / 步骤 / 命令 / 参数\n` +
              `3) 踩坑与注意事项\n4) 最值得转述的 3 条结论\n\n重点：${focus}。\n` +
              `输出 markdown，400 字以内。信息不足就直说，不要编。`
            try {
              const batch = await ctx.tools.execute({
                calls: [
                  {
                    type: 'tool-call',
                    id: `bili-study-${v.bvid}`,
                    name: 'subagent',
                    arguments: JSON.stringify({
                      description: `研读 ${v.bvid}`,
                      prompt,
                    }),
                  },
                ],
                signal: exec.signal,
                agent: exec.agent,
              })
              const first = batch?.results?.[0]
              const text = resultText(first)
              if (first?.isError || !text.trim()) {
                degraded = true
                degradeReason = '子 agent 返回空结果或被拒绝。'
                continue
              }
              dispatched.push({ bvid: v.bvid, title: v.title, read: text })
            } catch (err) {
              degraded = true
              degradeReason = `子 agent 派发失败：${String(err).slice(0, 160)}`
              break
            }
          }
        }

        const parts = []
        for (const d of dispatched) {
          parts.push(`## ${d.title}（${d.bvid}）`, '', d.read.trim(), '')
        }
        const brief = parts.length
          ? parts.join('\n')
          : ''

        const note = degraded
          ? `${degradeReason} 文件已全部落盘在 ${r.dir}，请直接派子 agent 读取，每个文件一个。`
          : r.note

        return {
          ok: true,
          dir: r.dir,
          count: r.count,
          dispatched: dispatched.length,
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
        'Read or change the Bilibili learner settings: fetch mode, concurrency, self-hosted endpoint, ' +
        'login cookie, and third-party pool. Call with no arguments to read the current settings.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['default', 'direct', 'self', 'proxy', 'auto'],
            description: 'Fetch strategy.',
          },
          concurrency: { type: 'integer', description: 'How many videos subagents may study at once. 1-12.' },
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
            concurrency: { type: 'integer' },
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
              `并行度：${value.concurrency}`,
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
        if (args.concurrency) patch.concurrency = Math.min(Math.max(Number(args.concurrency), 1), 12)
        if (typeof args.endpoint === 'string') patch.endpoint = args.endpoint
        if (typeof args.cookie === 'string') patch.cookie = args.cookie
        if (Array.isArray(args.proxies)) patch.proxies = args.proxies
        const s = Object.keys(patch).length ? await saveSettings(patch) : await loadSettings()
        return {
          mode: s.mode,
          concurrency: s.concurrency,
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
          aid: {
            type: 'string',
            description:
              'Optional numeric aid (the av number). Comments need it; a BV id alone cannot resolve ' +
              'comments without the view endpoint, which is risk-blocked.',
          },
          withComments: { type: 'boolean', description: 'Include top comments. Default true.' },
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
        const page = await getCid(bvid, opts)
        if (!page?.cid) {
          return { ok: false, bvid, subtitleTrace: 'pagelist failed', subtitleLines: 0, comments: 0 }
        }
        const subs = await getSubtitles(bvid, page.cid, opts)
        const comments =
          args.withComments === false || !args.aid
            ? { items: [], trace: args.withComments === false ? 'skipped' : 'no_aid' }
            : await getComments(args.aid, opts)
        await mkdir(HARVEST_ROOT, { recursive: true })
        const file = path.join(HARVEST_ROOT, `${bvid}.md`)
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
        const script =
          s.framesScript || path.join(homedir(), '.dsh-bili-learn', 'tools', 'video_frames.py')
        const python = s.pythonPath || (process.platform === 'win32' ? 'python' : 'python3')
        const n = Math.min(Math.max(Number(args.maxFrames) || 8, 1), 16)
        const argv = [script, '--bvid', bvid, '--max-frames', String(n)]
        if (args.interval) argv.push('--interval', String(Math.max(1, Number(args.interval))))
        if (args.prompt) argv.push('--prompt', String(args.prompt))

        try {
          const { stdout, stderr } = await run(python, argv, {
            timeout: 600000,
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
          })
          const frames = (stdout.match(/^### \[/gm) || []).length
          return {
            ok: true,
            bvid,
            frames,
            markdown: String(stdout).trim(),
            log: String(stderr || '')
              .split('\n')
              .filter((l) => l.startsWith('[i]') || l.startsWith('[✓]'))
              .slice(-6)
              .join('\n'),
          }
        } catch (err) {
          const out = String(err?.stdout || '').trim()
          return {
            ok: false,
            bvid,
            frames: 0,
            markdown: out,
            note:
              `抽帧脚本执行失败：${String(err?.message || err).slice(0, 200)}。` +
              `脚本路径 ${script}，解释器 ${python}。` +
              '需要 Python 侧装有 imageio-ffmpeg 与 Pillow，且脚本已复制到该路径。',
          }
        }
      },
    }),
  )
}

export const inject = ['tools']

export function apply(ctx) {
  registerTools(ctx)
}
