/**
 * bili_search 的筛选逻辑离线测试（不联网）。
 *
 * 覆盖：播放量中文单位解析、时长解析、去重、时间/播放/时长区间、排除词、同 UP 上限、
 *      条数截断、排序方向、以及 render 产出的表格文案。
 *
 * 用法：node test/search.test.mjs
 */
import { registerSearch } from '../lib/tools/search.js'

let failed = 0
const ok = (m) => console.log('✅ ' + m)
const bad = (m) => {
  console.error('❌ ' + m)
  failed += 1
}
const NOW = Math.floor(Date.now() / 1000)
const day = 86400

function makeTool(rows, seen) {
  let tool = null
  const ctx = { effect: (fn) => fn(), tools: { register: (def) => { tool = def } } }
  const deps = {
    loadSettings: async () => ({ cookie: '', gapMs: 300 }),
    textBlock: (s) => ({ kind: 'text', text: s }),
    searchVideos: async (phrase, opts) => {
      if (seen) seen.push({ phrase, order: opts.order, page: opts.page })
      if (phrase === 'boom') return { error: '风控', items: [] }
      return { items: rows }
    },
  }
  registerSearch(ctx, deps)
  return tool
}

const rows = [
  { bvid: 'BV1aa', title: '4080 多帧生成实测', author: '甲', play: '12.3万', duration: '12:34', pubdate: NOW - 2 * day, desc: '' },
  { bvid: 'BV1bb', title: '老卡也能开', author: '乙', play: '8000', duration: '3:10', pubdate: NOW - 50 * day, desc: '' },
  { bvid: 'BV1cc', title: '广告：代购显卡', author: '丙', play: '50万', duration: '1:30', pubdate: NOW - 1 * day, desc: '' },
  { bvid: 'BV1dd', title: '甲的第二条', author: '甲', play: '9000', duration: '40:00', pubdate: NOW - 5 * day, desc: '' },
  { bvid: 'BV1ee', title: '甲的第三条', author: '甲', play: '7000', duration: '8:00', pubdate: NOW - 6 * day, desc: '' },
  { bvid: 'BV1aa', title: '重复的 bvid', author: '甲', play: '1', duration: '1:00', pubdate: NOW, desc: '' },
]

const tool = makeTool(rows)
if (!tool || tool.name !== 'bili_search') bad('工具没注册成 bili_search')
else ok('注册出 bili_search 工具')

// 1) 去重 + 播放量单位解析 + 默认排序（播放降序）
const base = await tool.execute({ keyword: '显卡' })
if (base.sampled !== 5) bad('去重后应有 5 条，实际 ' + base.sampled)
else ok('重复 bvid 被去掉（6 条入池 → 5 条）')
if (base.items[0].playNum !== 500000) bad('中文单位解析失败：' + base.items[0].playNum)
else ok('播放量 "50万" 解析成 500000，且默认按播放降序')
if (base.items[0].bvid !== 'BV1cc') bad('排序不对，第一条是 ' + base.items[0].bvid)
else ok('排序正确（50 万播放排第一）')

// 2) 时间筛选
const recent = await tool.execute({ keyword: '显卡', days: 7 })
if (recent.items.some((x) => x.bvid === 'BV1bb')) bad('50 天前的没被 days=7 筛掉')
else ok('days=7 过滤掉 50 天前的旧视频')

// 3) 播放量下限
const hot = await tool.execute({ keyword: '显卡', minPlay: 10000 })
if (hot.items.some((x) => x.playNum < 10000)) bad('minPlay 没生效')
else ok('minPlay=10000 过滤掉低播放')

// 4) 时长区间
const mid = await tool.execute({ keyword: '显卡', durationMin: 5, durationMax: 20 })
if (mid.items.some((x) => x.durSec < 300 || x.durSec > 1200)) bad('时长区间没生效：' + JSON.stringify(mid.items.map((x) => x.durSec)))
else ok('时长区间 5~20 分钟生效（' + mid.items.length + ' 条）')

// 5) 排除词
const clean = await tool.execute({ keyword: '显卡', exclude: '广告 代购' })
if (clean.items.some((x) => x.bvid === 'BV1cc')) bad('排除词没生效')
else ok('排除词命中标题即淘汰')

// 6) 同 UP 上限
const capped = await tool.execute({ keyword: '显卡', upCap: 1 })
const byUp = {}
for (const x of capped.items) byUp[x.author] = (byUp[x.author] || 0) + 1
if (Object.values(byUp).some((n) => n > 1)) bad('同 UP 上限没生效：' + JSON.stringify(byUp))
else ok('upCap=1 时每个 UP 只留一条')

// 7) limit 截断
const few = await tool.execute({ keyword: '显卡', limit: 2 })
if (few.items.length !== 2) bad('limit=2 没生效，实际 ' + few.items.length)
else ok('limit=2 截断生效')

// 8) render 文案
const text = tool.output.render({}, base).text
if (!/取样 5 条/.test(text)) bad('render 没写取样数：' + text.slice(0, 80))
else ok('render 写出取样/筛选数字')
if (!/bilibili\.com\/video\/BV1cc/.test(text)) bad('render 没带链接')
else ok('render 每条带视频链接')

// 9) 搜索失败时给出原因而不是崩
const boom = await tool.execute({ keyword: 'boom' })
if (boom.ok && boom.items.length) bad('搜索报错时不该有结果')
else if (!/部分失败|风控/.test(String(boom.note || ''))) bad('搜索报错没有写进 note：' + boom.note)
else ok('搜索报错写进 note，没有崩')

// 10) 排序策略：默认不传 order（= 服务端综合排序），显式 pubdate 才传
{
  const seen = []
  const t2 = makeTool(rows, seen)
  await t2.execute({ keyword: '显卡' })
  if (seen.length && seen.every((x) => x.order === undefined)) ok('默认不传 order（走服务端综合排序）')
  else bad('默认居然传了 order：' + JSON.stringify(seen[0]))
  const seen2 = []
  const t3 = makeTool(rows, seen2)
  await t3.execute({ keyword: '显卡', order: 'pubdate' })
  if (seen2.every((x) => x.order === 'pubdate')) ok('显式 order=pubdate 会照传')
  else bad('order 参数没传下去：' + JSON.stringify(seen2[0]))
  const seen3 = []
  const t4 = makeTool(rows, seen3)
  await t4.execute({ keyword: '显卡', order: 'totalrank' })
  if (seen3.every((x) => x.order === undefined)) ok('order=totalrank 等价于不传（都走综合）')
  else bad('totalrank 没归到综合排序：' + JSON.stringify(seen3[0]))
}

// 11) 带天数筛选时多抓页（否则综合排序里"既新又热"的容易筛空）
{
  const seen = []
  const fullPage = Array.from({ length: 20 }, (_, i) => ({
    bvid: 'BVp' + i, title: '测试 ' + i, author: 'up' + (i % 3),
    play: String(1000 + i), duration: '5:00', pubdate: NOW - i * day, desc: '',
  }))
  const t5 = makeTool(fullPage, seen)
  await t5.execute({ keyword: '显卡', days: 30 })
  const pagesHit = new Set(seen.map((x) => x.page))
  if (pagesHit.size >= 3) ok('days>0 时默认抓 3 页（实际 ' + pagesHit.size + ' 页）')
  else bad('days>0 只抓了 ' + pagesHit.size + ' 页，容易筛空')
}

if (failed) {
  console.error('bili_search 测试失败 ' + failed + ' 项')
  process.exit(1)
}
console.log('bili_search 测试通过')
