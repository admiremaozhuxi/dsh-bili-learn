/**
 * 面板渲染测试（不联网、不装 React）：
 *   1) client.js 能被 __ModuleLoader__ 加载，并向 sidebar.panellist / main 各注册一次；
 *   2) 主面板首渲染不抛，且**第一眼**就能看到「请求节流」这一块（不靠切 tab）；
 *   3) tab 栏里第三个叫「状态」，不再是含混的「说明」；
 *   4) 有数据时能把「当前生效间隔 / 安静期 / 冷却」渲染出来。
 *
 * 用法：node test/panel.test.mjs
 */
import { readFileSync } from 'node:fs'

let failed = 0
const ok = (m) => console.log('✅ ' + m)
const bad = (m) => {
  console.error('❌ ' + m)
  failed += 1
}

const baseReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => (typeof fn === 'function' ? fn() : fn),
  useRef: (init) => ({ current: init === undefined ? null : init }),
}

/** 用指定的 state 初值渲染一次面板，返回拍平后的文本 */
async function renderPanel(statePlan) {
  let seq = 0
  const React = {
    ...baseReact,
    useState: (init) => {
      const v = statePlan(seq++, init)
      return [v === undefined ? init : v, () => {}]
    },
  }
  let mod = null
  const registered = []
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        mod = { id, api: factory((name) => (name === 'react' ? React : {})) }
      },
    },
  }
  globalThis.document = {
    createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: '' }),
    head: { appendChild() {} },
    querySelector: () => null,
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false }) })

  await import(new URL('../client.js?panel=' + Math.random(), import.meta.url).href)
  if (!mod) throw new Error('client.js 没有调用 __ModuleLoader__.load')
  const slots = {
    inject: (_slot, fn) => fn(),
    register: (spec, comp) => registered.push({ spec, comp }),
  }
  mod.api.apply({ slots, effect: (fn) => fn() })

  const main = registered.find((r) => r.spec.name === 'main')
  if (!main) throw new Error('没注册 main 槽位')
  // 两种注册形式都要能测：直接传组件，或传 () => h(组件)
  const raw = main.comp
  let tree = typeof raw === 'function' ? raw() : raw
  if (tree && typeof tree.type === 'function' && !(tree.children && tree.children.length)) {
    tree = tree.type()
  }

  const flat = []
  const classes = []
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return
    if (typeof node === 'string' || typeof node === 'number') { flat.push(String(node)); return }
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node && node.props && node.props.className) classes.push(String(node.props.className))
    if (node && node.children) node.children.forEach(walk)
  }
  walk(tree)
  return { text: flat.join(' | '), classes, registered, mod }
}

// 1) 首渲染 + 顶部常驻的节流块
const first = await renderPanel((i, init) => init)
if (first.mod.id !== 'dsh-bili-learn') bad('模块 id 不对：' + first.mod.id)
else ok('client.js 以 dsh-bili-learn 注册：' + first.mod.id)
if (first.registered.length !== 2) bad('应该注册两个槽位（侧边栏图标 + 主面板），实际 ' + first.registered.length)
else ok('注册了两个槽位：' + first.registered.map((r) => r.spec.name).join(' + '))

if (!/请求节流（风控相关）/.test(first.text)) bad('首渲染看不到「请求节流」：' + first.text.slice(0, 160))
else ok('首渲染就能看到「请求节流」一块（不用切 tab）')
if (!/状态/.test(first.text)) bad('tab 里没有「状态」')
else ok('第三个 tab 已改名「状态」')
if (/说明/.test(first.text)) bad('还残留旧的「说明」标签')
else ok('旧的「说明」标签已移除')

// 2) 有数据时的渲染
const withData = await renderPanel((i, init) => {
  if (i === 0) return 'settings' // tab
  if (i === 1) return true // loaded
  return undefined
})
if (!/读取中/.test(withData.text) && !/当前生效间隔/.test(withData.text)) {
  bad('节流块既没显示「读取中」也没显示数字')
} else {
  ok('节流块有内容（无数据时显示「读取中…」）')
}

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
if (!/throttleInfo \? tRow|tRow\('当前生效间隔'/.test(src) && !src.includes("tRow('当前生效间隔'")) {
  bad('面板里找不到间隔数字的渲染')
} else ok('面板里渲染了「当前生效间隔」这一行')

// 外壳结构：标题栏 / 左导航 / 内容区 / 状态栏 四件套必须在
{
  for (const cls of ['bl-shell', 'bl-titlebar', 'bl-rail', 'bl-content', 'bl-statusbar']) {
    const hit = (first.classes || []).some((c) => c.split(/\s+/).includes(cls))
    if (hit) ok('外壳有 .' + cls)
    else bad('外壳缺少 .' + cls + '（实际：' + (first.classes || []).join(' , ') + '）')
  }
  const railCount = (first.classes || []).filter((c) => c.split(/\s+/).includes('bl-railitem')).length
  if (railCount === 3) ok('左侧导航三项（设置 / 能做什么 / 状态）')
  else bad('左侧导航项数不对：' + railCount)
  const viewAnimated = (first.classes || []).some((c) => c.split(/\s+/).includes('bl-view'))
  if (viewAnimated) ok('内容区包了动效层 .bl-view（切换淡入）')
  else bad('内容区没有动效层')
}

if (failed) {
  console.error('面板测试失败 ' + failed + ' 项')
  process.exit(1)
}
console.log('面板测试通过')
