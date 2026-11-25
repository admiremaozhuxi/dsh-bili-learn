/**
 * 节流层离线测试（不联网、不打 B 站）：
 *   1) 静默期写入/读取/过期；
 *   2) 冷却期内 gate 直接抛 risk 错误（不硬撞）；
 *   3) 静默期内 gate 会等，但单次最多等 10 秒；
 *   4) gate 是串行的：并发发起 N 次，实际是排队过闸，相邻间隔 >= 基础间隔；
 *   5) 撞一次风控学习值翻倍、连续成功 3 次回落；
 *   6) 拦截页/ -412 能被认出来。
 *
 * 用法：node test/throttle.test.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const DIR = mkdtempSync(path.join(tmpdir(), 'bili-throttle-'))
process.env.BILI_LEARN_STATE_DIR = DIR
process.env.BILI_LEARN_BASE_GAP_MS = '40'

const t = await import('../lib/throttle.js')

let failed = 0
const ok = (m) => console.log('✅ ' + m)
const bad = (m) => {
  console.error('❌ ' + m)
  failed += 1
}

// 1) 静默期
if (t.silenceRemainMs() !== 0) bad('初始静默期应为 0')
else ok('初始静默期为 0')
t.markSilence(60000, '测试')
if (t.silenceRemainMs() <= 0) bad('markSilence 之后应处于静默期')
else ok('静默期写入生效：' + Math.ceil(t.silenceRemainMs() / 1000) + ' 秒')

// 2) 冷却期内 gate 抛错
mkdirSync(DIR, { recursive: true })
writeFileSync(path.join(DIR, 'state.json'), JSON.stringify({ until: Date.now() + 120000, reason: '测试冷却' }), 'utf8')
let threw = null
try {
  await t.gate('冷却测试')
} catch (err) {
  threw = err
}
if (!threw || !threw.risk) bad('冷却期内 gate 没有抛出带 risk 标记的错误')
else ok('冷却期内 gate 拒绝发请求：' + threw.message.slice(0, 40))
writeFileSync(path.join(DIR, 'state.json'), JSON.stringify({ until: 0 }), 'utf8')

// 3) 静默期内会等（但不超过这次的总时长）
t.markSilence(400, '短静默')
const t0 = Date.now()
await t.gate('静默等待')
const waited = Date.now() - t0
if (waited < 300) bad('静默期内没有等待，实际 ' + waited + 'ms')
else ok('静默期内 gate 等了 ' + waited + 'ms 才放行')
t.markSilence(0)

// 4) 串行：并发 5 次，总耗时应当 >= 4 × 基础间隔
const start = Date.now()
await Promise.all([t.gate(), t.gate(), t.gate(), t.gate(), t.gate()])
const total = Date.now() - start
if (total < 150) bad('并发 gate 没有串行排队，总耗时只有 ' + total + 'ms')
else ok('5 个并发请求被串行排队，总耗时 ' + total + 'ms（≈4×基础间隔）')

// 5) 自适应：撞一次翻倍、连续成功 3 次回落
const gapBefore = t.effectiveGapMs()
t.noteRisk('测试风控')
const gapAfterRisk = t.effectiveGapMs()
if (gapAfterRisk <= gapBefore) bad('撞风控后学习间隔没抬起来：' + gapBefore + ' → ' + gapAfterRisk)
else ok('撞一次风控：' + gapBefore + 'ms → ' + gapAfterRisk + 'ms')
t.markSilence(0)
for (let i = 0; i < 3; i += 1) t.noteOk()
const gapAfterOk = t.effectiveGapMs()
if (gapAfterOk >= gapAfterRisk) bad('连续成功 3 次后学习间隔没回落：' + gapAfterOk)
else ok('连续成功 3 次：' + gapAfterRisk + 'ms → ' + gapAfterOk + 'ms')

// 6) 拦截页识别
if (!t.looksBlocked('<html><title>出错啦! - bilibili.com</title></html>')) bad('没认出 HTML 拦截页')
else ok('认得出 HTML 拦截页')
if (!t.looksBlocked('{"code":-412,"message":"request was banned"}')) bad('没认出 -412')
else ok('认得出 -412 request was banned')
if (t.looksBlocked('{"code":0,"data":{}}')) bad('正常回包被误判成风控')
else ok('正常回包不会误判')

// 收尾
rmSync(DIR, { recursive: true, force: true })
if (failed) {
  console.error('节流层测试失败 ' + failed + ' 项')
  process.exit(1)
}
console.log('节流层测试通过')
