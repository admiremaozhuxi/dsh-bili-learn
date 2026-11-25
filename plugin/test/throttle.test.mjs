/**
 * 节流层离线测试（不联网、不打 B 站）。
 *
 * 覆盖：
 *   1) 安静期写入 / 读取 / 过期；
 *   2) 冷却期内 gate 直接抛 risk 错误（宁可不发也不硬撞）；
 *   3) 安静期内 gate 会等，但单次最多 10 秒；
 *   4) gate 是全局串行的：并发发起 N 次，实际排队过闸；
 *   5) 撞一次间隔翻倍、连续顺利 3 次回落；
 *   6) 拦截页 / -412 认得出来，正常回包不误判；
 *   7) 可选的中立安静期文件只读不写。
 *
 * 用法：node test/throttle.test.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const DIR = mkdtempSync(path.join(tmpdir(), 'bili-learn-throttle-'))
const QUIET = path.join(DIR, 'neighbour-quiet.json')
process.env.BILI_LEARN_HOME = DIR
process.env.BILI_QUIET_FILE = QUIET
process.env.BILI_LEARN_BASE_GAP_MS = '40'

const t = await import('../lib/throttle.js')

let failed = 0
const ok = (m) => console.log('✅ ' + m)
const bad = (m) => {
  console.error('❌ ' + m)
  failed += 1
}

// 1) 安静期
if (t.quietRemainMs() !== 0) bad('初始安静期应为 0')
else ok('初始安静期为 0')
t.quietFor(60000, '测试')
if (t.quietRemainMs() <= 0) bad('quietFor 之后应处于安静期')
else ok('安静期写入生效：' + Math.ceil(t.quietRemainMs() / 1000) + ' 秒')

// 2) 冷却期内 gate 抛错
writeFileSync(path.join(DIR, 'throttle.json'), JSON.stringify({ cooldownUntil: Date.now() + 120000, cooldownReason: '测试' }), 'utf8')
let threw = null
try {
  await t.gate('冷却测试')
} catch (err) {
  threw = err
}
if (!threw || !threw.risk) bad('冷却期内 gate 没有抛出带 risk 标记的错误')
else ok('冷却期内 gate 拒绝发请求：' + threw.message.slice(0, 34))
writeFileSync(path.join(DIR, 'throttle.json'), JSON.stringify({ cooldownUntil: 0, quietUntil: 0 }), 'utf8')

// 3) 安静期内会等
t.quietFor(400, '短安静')
const t0 = Date.now()
await t.gate('安静等待')
const waited = Date.now() - t0
if (waited < 300) bad('安静期内没有等待，实际 ' + waited + 'ms')
else ok('安静期内 gate 等了 ' + waited + 'ms 才放行')
t.quietFor(0, '')

// 4) 全局串行
const start = Date.now()
await Promise.all([t.gate(), t.gate(), t.gate(), t.gate(), t.gate()])
const total = Date.now() - start
if (total < 150) bad('并发 gate 没有串行排队，总耗时只有 ' + total + 'ms')
else ok('5 个并发请求被串行排队，总耗时 ' + total + 'ms')

// 5) 自适应
const before = t.gapMs()
t.recordThrottled('测试风控')
const afterRisk = t.gapMs()
if (afterRisk <= before) bad('撞风控后间隔没抬起来：' + before + ' → ' + afterRisk)
else ok('撞一次风控：' + before + 'ms → ' + afterRisk + 'ms')
t.quietFor(0, '')
writeFileSync(path.join(DIR, 'throttle.json'), JSON.stringify({ cooldownUntil: 0, quietUntil: 0, gapMs: afterRisk, okStreak: 0 }), 'utf8')
for (let i = 0; i < 3; i += 1) t.recordOk()
const afterOk = t.gapMs()
if (afterOk >= afterRisk) bad('连续顺利 3 次后间隔没回落：' + afterOk)
else ok('连续顺利 3 次：' + afterRisk + 'ms → ' + afterOk + 'ms')

// 6) 拦截页识别
if (!t.looksBlocked('<html><title>出错啦! - bilibili.com</title></html>')) bad('没认出 HTML 拦截页')
else ok('认得出 HTML 拦截页')
if (!t.looksBlocked('{"code":-412,"message":"request was banned"}')) bad('没认出 -412')
else ok('认得出 -412')
if (t.looksBlocked('{"code":0,"data":{}}')) bad('正常回包被误判成风控')
else ok('正常回包不会误判')

// 7) 中立安静期文件：只读不写
writeFileSync(QUIET, JSON.stringify({ until: Date.now() + 500, reason: '邻居声明的' }), 'utf8')
const before7 = readFileSync(QUIET, 'utf8')
const s7 = Date.now()
await t.gate('邻居安静期')
const waited7 = Date.now() - s7
if (waited7 < 400) bad('没有尊重邻居声明的安静期，只等了 ' + waited7 + 'ms')
else ok('尊重邻居声明的安静期（等了 ' + waited7 + 'ms）')
if (readFileSync(QUIET, 'utf8') !== before7) bad('擅自改写了中立安静期文件')
else ok('中立安静期文件只读不写（内容未变）')

// 8) 接线检查：工具们真正走的 index.js getJson 必须挂在这道闸门上
{
  const { readFileSync: rf } = await import('node:fs')
  const indexPath = new URL('../index.js', import.meta.url)
  const src = rf(indexPath, 'utf8')
  if (!/await gate\(url, gapMs\)/.test(src)) bad('index.js 的 getJson 没有接闸门（gate）')
  else ok('index.js 的 getJson 接在闸门上（工具主请求路径受控）')
  if (/await throttle\(gapMs\)/.test(src)) bad('index.js 还在用旧的 lastCall 限速（那是假串行）')
  else ok('index.js 已不再使用旧的 lastCall 限速')
  if (!/recordThrottled\(/.test(src)) bad('index.js 撞墙后没有记账（不会降速）')
  else ok('index.js 撞墙后会记账（降速 + 冷却）')
}

// 收尾
rmSync(DIR, { recursive: true, force: true })
if (failed) {
  console.error('节流层测试失败 ' + failed + ' 项')
  process.exit(1)
}
console.log('节流层测试通过')
