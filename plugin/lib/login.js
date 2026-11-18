/**
 * Bilibili QR login, pure Node.
 *
 * This replaces the "press F12 and copy SESSDATA out of the cookie panel"
 * instruction, which is where a non-technical user gives up. Two calls: ask for a
 * key, then poll it while the user scans with the phone app.
 */
import QRCode from 'qrcode'

import { getJson } from './net.js'

const PASSPORT = 'https://passport.bilibili.com/x/passport-login/web'

/** 返回 { key, url, img }。img 是 PNG data URL，比内联 SVG 在各种渲染环境下都稳。 */
export async function startQrLogin() {
  const d = await getJson(`${PASSPORT}/qrcode/generate`, { timeout: 15000 })
  if (d.code !== 0 || !d?.data?.url) {
    throw new Error(`生成二维码失败：${d.message || d.code || '未知'}（可能被风控）`)
  }
  const img = await QRCode.toDataURL(d.data.url, {
    margin: 1,
    width: 220,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000ff', light: '#ffffffff' },
  })
  return { key: d.data.qrcode_key, url: d.data.url, img }
}

/**
 * 轮询扫码状态。
 * 状态码（B 站约定）：0 成功 · 86101 未扫码 · 86090 已扫待确认 · 86038 已过期
 * 成功时把 Set-Cookie 里的关键项拼成 Cookie 头。
 */
export async function pollQrLogin(key) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 15000)
  try {
    const res = await fetch(`${PASSPORT}/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://www.bilibili.com/',
      },
      signal: ctl.signal,
    })
    const text = await res.text()
    let d
    try {
      d = JSON.parse(text)
    } catch {
      return { state: 'error', message: '返回不是 JSON，可能被风控' }
    }
    const code = d?.data?.code
    if (code === 86101) return { state: 'waiting', message: '还没扫码' }
    if (code === 86090) return { state: 'scanned', message: '已扫码，请在手机上点确认' }
    if (code === 86038) return { state: 'expired', message: '二维码已过期，重新生成一张' }
    if (code !== 0) return { state: 'error', message: d?.data?.message || `未知状态 ${code}` }

    // 成功：cookie 在 Set-Cookie 头里
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    const jar = {}
    for (const line of raw) {
      const first = String(line).split(';')[0]
      const eq = first.indexOf('=')
      if (eq > 0) jar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim()
    }
    const keep = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4']
    const cookie = keep.filter((k) => jar[k]).map((k) => `${k}=${jar[k]}`).join('; ')
    if (!jar.SESSDATA) {
      return { state: 'error', message: `登录成功但没拿到 SESSDATA（收到 ${Object.keys(jar).length} 个 cookie）` }
    }
    return { state: 'success', cookie, name: jar.DedeUserID ? `uid ${jar.DedeUserID}` : '' }
  } finally {
    clearTimeout(timer)
  }
}
