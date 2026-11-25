/**
 * 本机的 B 站请求节流（0.2.6 起独立实现，不依赖任何其它插件）。
 *
 * 背景（自己踩的坑）：2026-11-25 实测过一次事故——探针把十来个端点同时打出去，
 * 紧接着检索，第一页就被判拦截页，整轮作废并锁了十分钟。归纳出三条规律：
 *   1) 风控的计数单位是出口 IP 的请求数，不是"工具数"，同一台机器上的所有 B 站请求共享同一个额度；
 *   2) 并发发请求比总量更招风控，突刺一次比匀速打一百次更容易被拦；
 *   3) 撞一次立刻降速、连着顺利就慢慢升回去，比固定间隔更适应网络环境变化。
 *
 * 所以这一层做三件事，全部是自己的实现与自己的存储：
 *   - 串行闸门：所有 API 请求排队，相邻请求至少隔一个自适应间隔；
 *   - 自适应间隔：撞一次翻倍（有上下限），连续顺利若干次慢慢回落；
 *   - 安静期：刚打完一批请求就声明"我这段时间不打了"，避免前后脚互相叠加。
 *
 * 互通是可选的：若设置环境变量 BILI_QUIET_FILE（或默认位置存在该文件），
 * 会读取一个中立的安静期声明——这是开放的约定，不属于任何一方，也不修改它。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

// 自己的数据目录：不复用、不读写其它插件的目录
const OWN_DIR = process.env.BILI_LEARN_HOME || path.join(homedir(), '.bili-learn')
const OWN_FILE = path.join(OWN_DIR, 'throttle.json')
// 可选的跨工具安静期约定文件（只读不写；不存在就当没有）
const QUIET_HINT = process.env.BILI_QUIET_FILE || path.join(homedir(), '.dsh-bili-quiet.json')

const FLOOR_MS = 250
const CEIL_MS = 3000
const BASE_MS = Number(process.env.BILI_LEARN_BASE_GAP_MS) || 300
const BACKOFF_FACTOR = 2
const RECOVER_STREAK = 3

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readOwn() {
  try {
    const v = JSON.parse(readFileSync(OWN_FILE, 'utf8'))
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

function patchOwn(patch) {
  try {
    mkdirSync(path.dirname(OWN_FILE), { recursive: true })
    const next = { ...readOwn(), ...patch, at: new Date().toISOString() }
    writeFileSync(OWN_FILE, JSON.stringify(next, null, 2), 'utf8')
    return next
  } catch {
    return {}
  }
}

/** 声明一段时间内不要再打 B 站（安静期） */
export function quietFor(ms, reason = '刚才打过一批 B 站请求') {
  const until = Date.now() + Math.max(0, Number(ms) || 0)
  patchOwn({ quietUntil: until, quietReason: reason })
  return until
}

/** 安静期还剩多久（0 表示没有） */
export function quietRemainMs() {
  const remain = Number(readOwn().quietUntil) - Date.now()
  return remain > 0 ? remain : 0
}

/** 冷却还剩多久（0 表示没有）；冷却来自真实的 412 拦截 */
export function cooldownRemainMs() {
  const remain = Number(readOwn().cooldownUntil) - Date.now()
  return remain > 0 ? remain : 0
}

/**
 * 可选：读一眼中立的安静期声明（别的工具自愿写的，不存在就算了）。
 * 只读，绝不修改对方的文件。
 */
function neighbourQuietRemainMs() {
  try {
    const v = JSON.parse(readFileSync(QUIET_HINT, 'utf8'))
    const remain = Number(v && v.until) - Date.now()
    return remain > 0 ? remain : 0
  } catch {
    return 0
  }
}

/** 当前生效的请求间隔 */
export function gapMs() {
  const learned = Math.max(0, Math.min(CEIL_MS, Number(readOwn().gapMs) || 0))
  return Math.max(FLOOR_MS, Math.min(CEIL_MS, Math.max(BASE_MS, learned)))
}

/** 顺利拿到一次正常回包 */
export function recordOk() {
  if (process.env.BILI_LEARN_NO_ADAPTIVE === '1') return
  const s = readOwn()
  const streak = (Number(s.okStreak) || 0) + 1
  const cur = Number(s.gapMs) || 0
  if (streak >= RECOVER_STREAK && cur > 0) {
    let next = Math.max(0, Math.round(cur * 0.8) - 20)
    if (next < FLOOR_MS) next = 0
    patchOwn({ gapMs: next, okStreak: 0 })
  } else if (streak !== Number(s.okStreak)) {
    patchOwn({ okStreak: streak })
  }
}

/** 撞到拦截页或 -412：降速 + 进入安静期 */
export function recordThrottled(reason = '命中风控') {
  const cool = Number(process.env.BILI_LEARN_COOLDOWN_MS) || 120_000
  patchOwn({ cooldownUntil: Date.now() + cool, cooldownReason: reason })
  quietFor(cool, reason)
  if (process.env.BILI_LEARN_NO_ADAPTIVE === '1') return
  const s = readOwn()
  const base = Math.max(BASE_MS, Number(s.gapMs) || 0)
  const next = Math.min(CEIL_MS, Math.max(600, Math.round(base * BACKOFF_FACTOR)))
  patchOwn({ gapMs: next, okStreak: 0 })
}

/**
 * 每个 API 请求前过这道门（全局串行，不是每个调用各自 sleep）：
 *  - 冷却中 → 直接抛带 risk 标记的错误，宁可不发也不硬撞；
 *  - 安静期（自己的或邻居声明的）→ 先等，单次最多 10 秒；
 *  - 然后按当前间隔排队。
 */
let queue = Promise.resolve()

async function pass(label, minGapMs) {
  const cool = cooldownRemainMs()
  if (cool > 0) {
    const mins = Math.ceil(cool / 60000)
    const error = new Error('B 站正在冷却（约再等 ' + mins + ' 分钟）' + (label ? '：' + label : '') + '；这段时间不发请求更划算。')
    error.risk = true
    throw error
  }
  const quiet = Math.max(quietRemainMs(), neighbourQuietRemainMs())
  if (quiet > 0) await sleep(Math.min(quiet, 10_000))
  // 调用方也可以声明自己的下限（例如检索类请求按 1200ms），取两者更大值，避免叠加等待
  await sleep(Math.max(gapMs(), Number(minGapMs) || 0))
}

export function gate(label = '', minGapMs = 0) {
  const next = queue.then(() => pass(label, minGapMs), () => pass(label, minGapMs))
  queue = next.catch(() => {})
  return next
}

/** 回包像不像拦截页 */
export function looksBlocked(text) {
  return /request was banned|出错啦|访问频繁/.test(String(text || ''))
}
