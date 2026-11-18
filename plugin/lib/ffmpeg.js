/**
 * Locate or obtain an ffmpeg binary without asking the user to install anything.
 *
 * Order of preference:
 *   1. FFMPEG_BIN environment variable
 *   2. a copy we downloaded earlier into ~/.dsh-bili-learn/bin
 *   3. ffmpeg already on PATH
 *   4. download it
 *
 * The download is a `.gz` of a static build, so Node's own zlib can unpack it —
 * no archive library, no build script, and nothing to approve at install time.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

const BIN_DIR = path.join(homedir(), '.dsh-bili-learn', 'bin')
const WIN = process.platform === 'win32'
const EXE = WIN ? 'ffmpeg.exe' : 'ffmpeg'
const LOCAL = path.join(BIN_DIR, EXE)

// ffmpeg-static 的发布标签与命名规则，实测有效
const RELEASE = 'b6.1.1'
const EXE_BASE = 'ffmpeg'

/**
 * 下载源按实测速度排序（2026-11，同一台机器）：
 *   npmmirror  7.0 MB/s   —— 29MB 约 4 秒
 *   GitHub 直连 0.28 MB/s —— 约 100 秒
 *   GitHub 代理 0.05 MB/s —— 直接放弃
 * 所以镜像优先，GitHub 只作兜底。
 */
const MIRRORS = [
  (tag) => `https://registry.npmmirror.com/-/binary/ffmpeg-static/${RELEASE}/ffmpeg-${tag}.gz`,
  (tag) =>
    `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}/ffmpeg-${tag}.gz`,
]

function platformTag() {
  const p = process.platform === 'win32' ? 'win32' : process.platform
  const a = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `${p}-${a}`
}

function runnable(p) {
  if (!p || !existsSync(p)) return false
  try {
    const out = execFileSync(p, ['-version'], { timeout: 15000, encoding: 'utf8' })
    return /ffmpeg version/i.test(out)
  } catch {
    return false
  }
}

/** 不下载，只找现成的。返回路径或空串。 */
export function findFfmpeg() {
  const fromEnv = process.env.FFMPEG_BIN || ''
  if (fromEnv && runnable(fromEnv)) return fromEnv
  if (runnable(LOCAL)) return LOCAL

  // 装过 Python 的 imageio-ffmpeg 的用户：二进制就在那儿，白捡
  const pyHint = process.env.DSH_BILI_FFMPEG || ''
  if (pyHint && runnable(pyHint)) return pyHint
  try {
    const base = path.join(homedir(), 'AppData', 'Local', 'Programs', 'Python')
    const dirs = existsSync(base) ? readdirSync(base) : []
    for (const d of dirs) {
      const bin = path.join(
        base,
        d,
        'Lib',
        'site-packages',
        'imageio_ffmpeg',
        'binaries',
        `ffmpeg-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-v7.1.exe`,
      )
      if (runnable(bin)) return bin
    }
  } catch {
    /* 没有就算了 */
  }

  try {
    const p = execFileSync(WIN ? 'where' : 'which', ['ffmpeg'], { timeout: 8000, encoding: 'utf8' })
      .split(/\r?\n/)[0]
      .trim()
    if (p && runnable(p)) return p
  } catch {
    /* PATH 里没有 */
  }
  return ''
}

/**
 * 拿到一个可用的 ffmpeg。没有就下载，约 80MB。
 * onProgress 收 { phase, loaded, total }。
 */
export async function ensureFfmpeg(onProgress = () => {}) {
  const found = findFfmpeg()
  if (found) return { path: found, downloaded: false }

  mkdirSync(BIN_DIR, { recursive: true })
  const tag = platformTag()
  const tmp = `${LOCAL}.part`

  let gz = null
  const errors = []
  for (const make of MIRRORS) {
    const url = make(tag)
    onProgress({ phase: 'download-start', url })
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 180000)
    try {
      const res = await fetch(url, { signal: ctl.signal, redirect: 'follow' })
      if (!res.ok) {
        errors.push(`${new URL(url).host} HTTP ${res.status}`)
        continue
      }
      gz = Buffer.from(await res.arrayBuffer())
      onProgress({ phase: 'download-done', loaded: gz.length, total: gz.length, url })
      break
    } catch (err) {
      errors.push(`${new URL(url).host} ${String(err).slice(0, 60)}`)
    } finally {
      clearTimeout(timer)
    }
  }
  if (!gz) {
    throw new Error(`下载 ffmpeg 失败：${errors.join('；')}`)
  }

  let raw
  try {
    raw = gunzipSync(gz)
  } catch (err) {
    throw new Error(`ffmpeg 包解压失败：${String(err).slice(0, 120)}`)
  }
  writeFileSync(tmp, raw)

  if (!WIN) chmodSync(tmp, 0o755)
  renameSync(tmp, LOCAL)

  if (!runnable(LOCAL)) {
    throw new Error(`下载完成但无法执行：${LOCAL}（${statSync(LOCAL).size} 字节）`)
  }
  onProgress({ phase: 'done', path: LOCAL })
  return { path: LOCAL, downloaded: true }
}
