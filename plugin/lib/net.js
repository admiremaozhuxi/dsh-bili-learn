/**
 * Bilibili network layer, pure Node.
 *
 * Same shape as the Python module it replaces, for one reason: requiring Python
 * was the single biggest obstacle for a fresh user. Everything here runs on the
 * Node that already ships with DSH.
 *
 * Racing order, decided by measurement:
 *   1. self-hosted server, if configured — fastest and moves quota off this IP
 *   2. the two official paths in parallel — whichever answers first wins
 *   3. nothing else; third-party sites cannot be called over plain HTTP
 */
import { createHash } from 'node:crypto'
// 0.2.5：与 dsh-bili-search 共享的风控节流（静默期 / 自适应间隔 / 冷却）
import { gate, looksBlocked, recordOk, recordThrottled } from './throttle.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export const API = 'https://api.bilibili.com'

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

let wbi = { key: '', at: 0 }

function headers(referer, cookie) {
  const h = {
    'User-Agent': UA,
    Origin: 'https://www.bilibili.com',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  }
  if (referer) h.Referer = referer
  if (cookie) h.Cookie = cookie
  return h
}

export async function getJson(url, { referer, cookie, timeout = 12000 } = {}) {
  // 先过共享节流门：串行 + 间隔 + 尊重静默期/冷却。
  // 只有 B 站 API 走这里；媒体 CDN 下载走别的路径，不会被拖慢。
  await gate(url)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  try {
    const res = await fetch(url, { headers: headers(referer, cookie), signal: ctl.signal })
    const text = await res.text()
    if (text.trimStart().startsWith('<')) {
      // 拦截页：记账并且把两个插件一起按住，别继续刷
      recordThrottled('返回拦截页 HTTP ' + res.status)
      return { _html: true, status: res.status, _risk: true }
    }
    try {
      const json = JSON.parse(text)
      if (json && json.code === -412) recordThrottled('-412 request was banned')
      else if (json && json.code === 0) recordOk()
      return json
    } catch {
      if (looksBlocked(text)) recordThrottled('非 JSON 的拦截内容')
      return { _raw: text.slice(0, 120) }
    }
  } catch (err) {
    return { _err: String(err).slice(0, 120) }
  } finally {
    clearTimeout(timer)
  }
}

export async function mixinKey(cookie = '', timeout = 10000) {
  if (wbi.key && Date.now() - wbi.at < 3600_000) return wbi.key
  const d = await getJson(`${API}/x/web-interface/nav`, { cookie, timeout })
  if (d.code !== 0 && d.code !== -101) return ''
  const img = String(d?.data?.wbi_img?.img_url || '').split('/').pop().split('.')[0]
  const sub = String(d?.data?.wbi_img?.sub_url || '').split('/').pop().split('.')[0]
  const orig = img + sub
  if (orig.length < 64) return ''
  wbi = { key: MIXIN_TAB.map((i) => orig[i]).join('').slice(0, 32), at: Date.now() }
  return wbi.key
}

export function signed(base, params, key) {
  const p = { ...params, wts: Math.floor(Date.now() / 1000) }
  const q = Object.keys(p)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]))}`)
    .join('&')
  const w = createHash('md5').update(q + key).digest('hex')
  return `${base}?${q}&w_rid=${w}`
}

function shape(d, source) {
  if (!d || d.code !== 0) return null
  const data = d.data || {}
  const dash = data.dash || {}
  const audio = dash.audio || []
  const video = dash.video || []
  if (!audio.length && !video.length) {
    const durl = data.durl || []
    if (!durl.length) return null
    return {
      source,
      audio: [],
      video: durl.map((x) => ({ id: 0, bandwidth: x.size || 0, baseUrl: x.url, backupUrl: x.backup_url || [] })),
      quality: data.quality,
    }
  }
  const norm = (x) => ({
    id: x.id,
    width: x.width,
    height: x.height,
    bandwidth: x.bandwidth,
    baseUrl: x.baseUrl || x.base_url,
    backupUrl: x.backupUrl || x.backup_url || [],
  })
  return { source, audio: audio.map(norm), video: video.map(norm), quality: data.quality }
}

async function trySelf(endpoint, bvid, cid, timeout) {
  if (!endpoint) return null
  const d = await getJson(`${endpoint.replace(/\/$/, '')}/playurl?bvid=${bvid}&cid=${cid}`, { timeout })
  if (d.code !== 0) return null
  const audio = d.audio || []
  const video = d.video || []
  if (!audio.length && !video.length) return null
  return {
    source: 'self',
    audio: audio.map((a) => ({ id: a.id, bandwidth: a.bandwidth, baseUrl: a.url, backupUrl: [] })),
    video: video.map((v) => ({ id: v.id, height: v.quality, bandwidth: v.bandwidth, baseUrl: v.url, backupUrl: [] })),
    quality: d.quality,
  }
}

async function tryWbi(bvid, cid, cookie, timeout) {
  const key = await mixinKey(cookie, timeout)
  const referer = `https://www.bilibili.com/video/${bvid}`
  const url = key
    ? signed(`${API}/x/player/wbi/playurl`, { bvid, cid, qn: 16, fnval: 16 }, key)
    : `${API}/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=16&fnval=16`
  return shape(await getJson(url, { referer, cookie, timeout }), 'direct-wbi')
}

async function tryPlain(bvid, cid, cookie, timeout) {
  const referer = `https://www.bilibili.com/video/${bvid}`
  return shape(
    await getJson(`${API}/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=16&fnval=16`, { referer, cookie, timeout }),
    'direct',
  )
}

/** 按优先级取 dash：自建 → 两条直连并行。返回 {dash, trail}。 */
export async function resolvePlayurl(bvid, cid, settings = {}, timeout = 5000) {
  const mode = String(settings.mode || 'auto').toLowerCase()
  const endpoint = String(settings.endpoint || '').trim()
  const cookie = String(settings.cookie || '').trim()
  const trail = []

  if (mode === 'default') {
    trail.push('mode=default，不发起请求')
    return { dash: null, trail }
  }

  if ((mode === 'auto' || mode === 'self') && endpoint) {
    const t0 = Date.now()
    const got = await trySelf(endpoint, bvid, cid, Math.min(timeout, 4000))
    if (got) {
      trail.push(`self ok ${Date.now() - t0}ms`)
      return { dash: got, trail }
    }
    trail.push(`self fail ${Date.now() - t0}ms`)
    if (mode === 'self') return { dash: null, trail }
  }

  const t0 = Date.now()
  // Promise.any 的语义正是「谁先成功用谁」：失败的那条被忽略，
  // 两条都失败才抛 AggregateError。
  const attempts = [
    tryWbi(bvid, cid, cookie, timeout).then((r) => {
      if (!r) throw new Error('wbi empty')
      return { name: 'wbi', r }
    }),
    tryPlain(bvid, cid, cookie, timeout).then((r) => {
      if (!r) throw new Error('plain empty')
      return { name: 'plain', r }
    }),
  ]
  try {
    const win = await Promise.any(attempts)
    trail.push(`${win.name} ok ${Date.now() - t0}ms`)
    return { dash: win.r, trail }
  } catch {
    trail.push('both direct failed')
    return { dash: null, trail }
  }
}

export function pickStream(dash, kind = 'video', lowest = true) {
  if (!dash) return null
  const items = (dash[kind] || []).filter((x) => x.baseUrl)
  if (!items.length) return null
  items.sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0))
  return lowest ? items[0] : items[items.length - 1]
}

export function candidateUrls(stream) {
  if (!stream) return []
  const out = [stream.baseUrl, ...(stream.backupUrl || [])]
  return out.filter(Boolean)
}

/** 依次试候选地址（主 + 备用 CDN），第一个成功的返回。 */
export async function fetchBytes(urls, { timeout = 120000, limit = 0 } = {}) {
  let last = ''
  for (const u of urls) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeout)
    try {
      const res = await fetch(u, {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
        signal: ctl.signal,
      })
      if (!res.ok) {
        last = `HTTP ${res.status}`
        continue
      }
      const buf = Buffer.from(await res.arrayBuffer())
      return { data: limit ? buf.subarray(0, limit) : buf, url: u }
    } catch (err) {
      last = String(err).slice(0, 80)
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(last || 'all candidate urls failed')
}
