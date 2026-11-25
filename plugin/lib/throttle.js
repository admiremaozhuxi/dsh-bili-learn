/**
 * 跨插件的 B 站请求节流（0.2.5）。
 *
 * 为什么共享到 ~/.bili-filter：dsh-bili-search 打的是同一批 B 站接口，两边各算各的预算、
 * 却共用同一个出口 IP。2026-11-25 实测过一次事故：探针并发探测 11 个端点之后紧接着检索，
 * 第一页就被判拦截页，整轮作废并锁 10 分钟。
 *
 * 所以这层不改「各自怎么算预算」，只加两件两边都能认的事：
 *   1) 静默期（silent.json）—— 谁刚打完 B 站，就写一段时间让别人先等；
 *   2) 自适应间隔（adaptive.json）—— 撞一次翻倍、连续成功回落。
 * 文件格式与 dsh-bili-search 保持一致，两个插件互认、互不覆盖对方的字段。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

// 默认与 dsh-bili-search 共用 ~/.bili-filter；测试用 BILI_LEARN_STATE_DIR 指到临时目录，
// 免得一跑测试就把用户真实的静默期/学习值冲掉。
const DIR = process.env.BILI_LEARN_STATE_DIR || path.join(homedir(), '.bili-filter')
const SILENT_FILE = path.join(DIR, 'silent.json')
const ADAPTIVE_FILE = path.join(DIR, 'adaptive.json')
const COOLDOWN_FILE = path.join(DIR, 'state.json')

const GAP_MIN = 250
const GAP_MAX = 3000
const BASE_GAP = Number(process.env.BILI_LEARN_BASE_GAP_MS) || 300

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(file, value) {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 写一段静默期，让同一台机器上的其它 B 站工具先等一等 */
export function markSilence(ms, reason = 'bili-learn 刚打过 B 站') {
  const until = Date.now() + Math.max(0, Number(ms) || 0)
  writeJson(SILENT_FILE, { until, reason, at: new Date().toISOString() })
  return until
}

export function silenceRemainMs() {
  const s = readJson(SILENT_FILE)
  const remain = Number(s && s.until) - Date.now()
  return remain > 0 ? remain : 0
}

export function cooldownRemainMs() {
  const s = readJson(COOLDOWN_FILE)
  const remain = Number(s && s.until) - Date.now()
  return remain > 0 ? remain : 0
}

/** 实际生效的请求间隔：基础值与自己学到的值里更慢的那个 */
export function effectiveGapMs() {
  const s = readJson(ADAPTIVE_FILE) || {}
  const learned = Math.max(0, Math.min(GAP_MAX, Number(s.gapMs) || 0))
  return Math.max(GAP_MIN, Math.min(GAP_MAX, Math.max(BASE_GAP, learned)))
}

/** 成功一次：连续 3 次就慢慢放快 */
export function noteOk() {
  if (process.env.BILI_LEARN_NO_ADAPTIVE === '1') return
  const s = readJson(ADAPTIVE_FILE) || {}
  const gap = Number(s.gapMs) || 0
  const streak = (Number(s.okStreak) || 0) + 1
  if (streak >= 3 && gap > 0) {
    let next = Math.max(0, Math.round(gap * 0.8) - 20)
    if (next < GAP_MIN) next = 0
    writeJson(ADAPTIVE_FILE, { ...s, gapMs: next, okStreak: 0, at: new Date().toISOString() })
  } else if (streak !== Number(s.okStreak)) {
    writeJson(ADAPTIVE_FILE, { ...s, okStreak: streak, at: new Date().toISOString() })
  }
}

/** 撞一次风控：学习间隔翻倍，并顺手写 2 分钟静默期把双方都按住 */
export function noteRisk(reason = '命中风控') {
  markSilence(120_000, 'bili-learn: ' + reason)
  if (process.env.BILI_LEARN_NO_ADAPTIVE === '1') return
  const s = readJson(ADAPTIVE_FILE) || {}
  const base = Math.max(BASE_GAP, Number(s.gapMs) || 0)
  const next = Math.min(GAP_MAX, Math.max(600, Math.round(base * 2)))
  writeJson(ADAPTIVE_FILE, { ...s, gapMs: next, okStreak: 0, at: new Date().toISOString() })
}

/**
 * 每个 API 请求前过这道门，三条规矩：
 *  - 全局串行：所有请求排队过闸（并行发是上次撞墙的主因之一），相邻请求至少隔 effectiveGapMs；
 *  - 处于静默期 → 先等（单次最多 10 秒，剩下的留给下一轮）；
 *  - 处于风控冷却 → 直接抛错（带 risk 标记），别硬撞。
 */
let chain = Promise.resolve()

async function pass(label) {
  const cool = cooldownRemainMs()
  if (cool > 0) {
    const mins = Math.ceil(cool / 60000)
    const error = new Error(
      'B 站风控冷却中（约再等 ' + mins + ' 分钟）' + (label ? '：' + label : '') + '；这是刚有工具撞墙留下的冷却，别硬刷。',
    )
    error.risk = true
    throw error
  }
  const quiet = silenceRemainMs()
  if (quiet > 0) await sleep(Math.min(quiet, 10_000))
  await sleep(effectiveGapMs())
}

export function gate(label = '') {
  const next = chain.then(
    () => pass(label),
    () => pass(label),
  )
  chain = next.catch(() => {})
  return next
}

/** B 站的回包是不是拦截页 / -412 */
export function looksBlocked(text) {
  return /request was banned|出错啦|访问频繁/.test(String(text || ''))
}
