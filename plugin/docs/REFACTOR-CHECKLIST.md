# 拆模块检查清单

这份清单来自 2026-11-18 把 `index.js`（2374 行）拆成 `lib/` + `lib/tools/` 的实操，
每一条都对应一次真实的翻车。

核心教训：**语法检查看不见运行时才访问的名字**。拆完能通过 `node --check`，
不等于那个工具还能用。

---

## 拆之前

### 1. 划清边界，别用「到下一个函数为止」

我犯过的错。脚本按「从 `registerTools` 到下一个顶层 `function`」划定范围，
结果把夹在中间的 `const BUILTIN_SOURCES` 一起删了。

```bash
# 列出那个范围内所有顶层定义，确认每一行的归属
sed -n 'START,ENDp' index.js | grep -nE '^(async )?function |^const |^let |^/\*\*'
```

**任何出现在范围内的注释块、常量、文档，都要显式判断「留还是走」。**

### 2. 统计两类依赖，缺一不可

拆出去的内容会失去原文件作用域里的**两类**东西：

| 类型 | 例子 | 怎么查 |
|---|---|---|
| **项目内符号** | `harvest`、`getSubtitles`、`textBlock` | 对照原文件顶层定义，逐个确认 |
| **Node 内置** | `mkdir`、`readFile`、`path`、`homedir` | `grep -oE "\b(mkdir|writeFile|readFile|rm|path|homedir)\b"` |

我第一次只统计了第一类，漏了第二类——内置模块在原文件里是环境自带的，看着免费，
**搬到新文件就没了**，而报错要等真正调用那个工具。

### 3. 可变状态要改成对象引用

如果原文件里有 `let state = {...}` 然后函数里 `state = {...}` **重新赋值**，
把它传进模块会得到一份永远不更新的旧对象。

```js
// 会失效
let sourceState = {...}
sourceState = { at: ..., items: ... }   // 换了个新对象

// 正常
sourceState.at = ...
sourceState.items = ...
```

---

## 拆之后

### 4. 语法（必要但不充分）

```bash
for f in index.js client.js $(find lib -name '*.js'); do node --check "$f" || echo "FAIL $f"; done
```

### 5. 每个模块的 import 是否够用

```bash
# 查该模块用了哪些 node 内置（排除属性访问，如 ff.path 里的 path 不算）
grep -nE '(^|[^.\w])(mkdir|writeFile|readFile|rm|path|homedir)\s*[.(]' lib/tools/xxx.js
# 对照它的 import 行
grep '^import ' lib/tools/xxx.js
```

**注意 `[^.\w]` 这个前缀**：`ff.path`、`item.readFile` 这类属性名会被朴素的正则误判成
内置模块引用。我自己就差点被它骗过一次——`frames.js` 里的 `path` 其实是 `ff.path`。

### 6. deps 是否完整

```bash
# 原文件所有顶层定义
grep -cE '^(async )?function |^const |^let ' index.js
# 对比拆之前的历史提交，确认没有丢失定义
git show <拆分前的提交>:index.js | grep -cE '^(async )?function |^const |^let '
```

**数量对不上就一定要找出差的是哪个**，别假设「应该没事」。

### 7. Mock 注册测试

不进 DSH、不重启，用一个假 `ctx` 把所有注册函数跑一遍：

```js
const captured = []
const ctx = { effect: (fn) => fn(), tools: { register: (d) => captured.push(d) } }
const deps = new Proxy({}, { get: () => function dummy() {} })
for (const [file, fn] of MODULES) {
  const mod = await import(`./lib/tools/${file}.js`)
  mod[fn](ctx, deps)
}
// 检查每个 captured 都有 schema / render / execute
```

这能证明**注册链路完整**，但证明不了 `execute` 里的每个名字都存在。

### 8. 逐个真实调用

**只有这一步能发现运行时问题。** 按代价从低到高排：

```
config → sources → series → watch → transcribe → frames → study
```

`study` 会派子 agent，先用最小设置跑一次：

```bash
# 临时把规模压到 1 视频 / 1 agent / 关掉转写抽帧
```

---

## 已知的陷阱类型

| 现象 | 原因 | 检查点 2 |
|---|---|---|
| `X is not defined`，X 是常量 | 常量夹在删除范围里 | ✔ |
| `X is not defined`，X 是 `mkdir` 之类 | Node 内置没跟着走 | ✔ |
| 设置改了重开面板变回默认 | 读路径漏字段（`view()` 手写列表） | 用规格表派生，不手写 |
| 状态永远是旧值 | 传了引用但源对象被重新赋值 | ✔ |
| 返回一堆 JSON 而不是内容 | 工具返回值多包了一层 `{callId, result}`，没解包 | 打印真实结构再取值 |

---

## 一句话总结

**`node --check` 只保证「能解析」，不保证「能跑」。**
拆完模块，静态检查过一遍之后，**必须真的调用一次**，否则等于没验。
