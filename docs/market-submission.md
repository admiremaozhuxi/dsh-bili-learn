# 上架 DSH 插件市场

本目录的文件用于把 `dsh-bili-learn` 登记到 DSH 插件市场。

- `market-entry.json` —— 市场 index 里的一条记录，格式按 DSH STORE（`dsh-store.cn/plugin-market.json`）的 `format: 1` 规范。

## 关键点

- **`repository.directory` / `source.path` 都是 `plugin`** —— 本仓库的插件在子目录里，市场用这两个字段定位。已上架的 `dsh-movein-permissions` 是同样的结构，可作为参照。
- **`source.commit` 必须是固定的 SHA，不能写 `main`**。市场的审核逻辑是「审核固定源码」，写分支名会导致审核内容和实际内容不一致。更新版本时改这个 SHA 并递增 `version`。
- 当前固定 SHA：`daef492bc2f5e339d21e3ab45f789fc1e5f04127`（版本 `0.1.0`）

## 已配置的市场（本机 DSH 已接入）

| 市场 index | 维护方 |
|---|---|
| `https://dsh-store.cn/plugin-market.json` | AI-Scarlett / DSH-Store |
| `https://dsh.store/plugin-market.json` | dsh.store |
| `https://ai-scarlett.github.io/DSH-Store/marketplace/plugin-market.json` | AI-Scarlett |
| `https://brokep.github.io/grok-bots-for-deepseek-harness/index.json` | brokep |
| `https://plugins.bitey.ai/market.json` | Bitey |

## 提交方式

市场 index 是静态 JSON，由维护者手工合并。向对应的 GitHub 仓库提 **New issue** 或 **Pull request**，附上 `market-entry.json` 的内容。

最活跃的是 DSH STORE：https://github.com/AI-Scarlett/DSH-Store

## 提 issue / PR 的正文（可直接用）

```markdown
### 申请收录插件：dsh-bili-learn

**名称**：dsh-bili-learn
**版本**：0.1.0
**仓库**：https://github.com/admiremaozhuxi/dsh-bili-learn
**插件目录**：`plugin`（子目录，与已收录的 dsh-movein-permissions 结构相同）
**固定 commit**：`daef492bc2f5e339d21e3ab45f789fc1e5f04127`

**一句话**：让 AI 真正读懂 B 站视频——字幕、评论、画面、口播一次拿全。

**它解决什么**：
B 站视频里的知识，AI 读不到。字幕只覆盖约 11% 的视频，而演示、代码、PPT 全在画面里，
评论接口未登录只给 3 条预览。用户只能自己看完再复述给 AI。

**主要能力**：
- 按播放量搜索并批量采集字幕与高赞评论，落成本地 markdown
- 画面理解：抽帧 + 视觉模型，读出屏幕上的代码、PPT、界面状态
- 语音转文字：没字幕的视频用音频转写，不需要登录
- 多集课程：列全部分P、指定第几集抓取
- 并行研读：同时读多个视频，每个视频按内容长度分配若干子 agent，
  短片读完后空闲 agent 转去帮长片，总并发有上限

**安装依赖**：无额外依赖。不需要 Python，不需要预装 ffmpeg
（首次「看画面」时自动下载，走国内镜像约 5 秒），不需要开开发者工具取 cookie（面板扫码登录）。

**License**：MIT

**自检**：`dsh.bundle.patch` = `./cordis.patch.yml`；`files` 含 `lib`；client 端已声明 `dsh.client`。

**market-entry 内容**：

（粘贴 market-entry.json）
```

## 更新版本时

1. 改 `plugin/package.json` 的 `version`
2. 提交并记录新的 SHA：`git rev-parse HEAD`
3. 同步改 `market-entry.json` 的 `version`、`source.commit`、`publishTimestamp`
4. 向已收录的市场提更新

## 另一个渠道：GitHub topic

插件生态的发现工具按 **`dsh-plugin`** 这个 topic 扫描全 GitHub。本仓库已加上
`dsh-plugin` 与 `dsh-bundle`，无需额外操作即可被检索到。
