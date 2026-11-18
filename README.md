# dsh-bili-learn

把 Bilibili 当成一个**研究资料库**而不是视频站：按播放量搜索 → 抓字幕与高赞评论 → 写成本地 markdown → 交给子 agent 并行研读 → 再动手施工。

一个 DeepSeek Harness 插件 + 一个小型采集器 + 一个自建解析服务。

---

## 它解决什么问题

普通搜索给你链接和标题，但视频的正文藏在**字幕**里。这套东西把正文取出来、落成本地文件，让 agent 能真正「读完再干活」。

典型对话：

> 学习B站上前端的做法，帮我去做一个前端

agent 会调用 `bili_learn` 或 `bili_study`，按播放量抓一批高相关视频，写成 markdown，然后读取这些文件（或派子 agent 并行读）再动手。

---

## 三个组件

| 目录 | 是什么 | 依赖 |
|---|---|---|
| `plugin/` | DSH 插件：`bili_learn` / `bili_study` / `bili_watch` / `bili_config` 四个工具 + 左侧栏面板 | DSH |
| `tools/` | 独立的 Python 采集器 `harvest.py` 与自建解析服务 `parse_svc.py` | Python 3.10+ |
| `mcp/polylens/` | 配置式 bundle，把 [polylens-bilibili-mcp](https://pypi.org/project/polylens-bilibili-mcp/) 接成第二数据源 | `uv` / `uvx` |

---

## 实测结论（2026-11，在真实 API 上验证）

这部分是这个项目的价值所在 —— 网上流传的说法有几条是错的。

| 结论 | 证据 |
|---|---|
| **元数据不要逐条查** | `ranking/v2` 一次返回 100 条，自带 `bvid / cid / aid / title / desc / duration / owner / stat`。实测 3 次调用拿到 292 条 |
| **`view` 接口无 cookie 会 -412** | 返回 HTTP 412 / `{"code":-412}`。所以本项目**全程不用 `view`**：`search/type` 自带 `aid`，`player/pagelist` 自带 `cid` |
| **字幕必须登录** | `player/v2` 无 cookie 实测 **0/16**；签名版 `player/wbi/v2` 也是 **0/3**，且 `allow_submit=false`。不是接口选错，不是签名算错 |
| **评论无 cookie 会截断** | 请求 `ps=20`，实际只回 3 条预览 |
| **直链不需要 cookie** | `/x/player/wbi/playurl` 返回 `code=0, dash=true`。实测下载 3 MB/s，HTTP 206，有效 fMP4 |
| **风控计数单位是 IP** | 同一 IP 连续约 30 次请求开始 412。所以「开 8 个 agent 并行」= 8 倍速送进冷却 |

最后一条推导出整个架构：**取数串行限速，阅读并行 fan-out**。

---

## 安装

### 插件

```bash
git clone https://github.com/admiremaozhuxi/dsh-bili-learn.git
```

然后在 DSH 里：**Plugins → Add plugin**，选择 `plugin/` 目录。

或命令行方式（把路径换成你的）：

```bash
dsh plugin --profile desktop add /absolute/path/to/dsh-bili-learn/plugin
```

装好后左侧栏会出现「B站学习器」图标。

### 采集器（可选，独立使用）

```bash
cd tools
python3 harvest.py --mode meta --source ranking --pages 6   # 只抓元数据，几乎不耗配额
python3 harvest.py --mode full --source popular --pages 2 --limit 50   # 元数据+字幕+评论
```

产物在 `~/.dsh-bili-learn/harvests/<时间>-<主题>/`。

### 自建解析服务（可选）

```bash
python3 parse_svc.py --port 8848 --gap 1.5
curl "http://127.0.0.1:8848/playurl?bvid=BV1xx&cid=123"
```

把一台服务器变成解析源：`/playurl` 返回音频轨与视频轨直链，`/subtitle` 返回字幕轨。

### 第二数据源（可选）

`mcp/polylens/` 是配置式 bundle，往 Loader 插一行 MCP 客户端即可，无需任何代码。安装前把 `cordis.patch.yml` 里的 `command` 改成你机器上 `uvx` 的路径（或直接保留 `uvx` 并确保它在 PATH）。

它补的是自建采集器的缺口：评论**游标续取**、二级评论、分 P 清单、UP 主资料、弹幕数。

---

## 取数方式

在面板里或对话中调整（`bili_config`）：

| 模式 | 行为 |
|---|---|
| `default` | 什么都不做，调用会被明确拒绝并说明原因 |
| `direct` | 本机直连 B 站官方 API |
| `self` | 直链与字幕走自建服务，把风控挪到服务器 IP |
| `proxy` | 第三方解析站（当前为占位：实测这类站点只给视频文件、不给字幕） |
| `auto` | 探测自建服务，不通就回落直连（**推荐**） |

`concurrency` 只控制同时派多少**子 agent 去读本地文件**；取数本身始终串行限速。

---

## 关于字幕

这是唯一的硬约束：**字幕需要登录态**。

两条路：

1. **配 `SESSDATA`** —— 在对话里说「给 B站学习器配置 SESSDATA」，或直接写 `~/.dsh-bili-learn/settings.json`
2. **音频转写** —— 用 `/playurl` 拿音频直链，走云端 ASR。注意本项目的默认 `gapMs=1200` 是为了不触发风控，转写吞吐受此限制

浏览器的字幕类扩展能取到字幕，是因为它们在 B 站页面内带着你的登录态发请求 —— 这也从侧面印证了上面的结论。

---

## 已知限制

- 字幕与完整评论区都需要 `SESSDATA`
- 同一 IP 约 30 次请求触发 412，冷却后恢复
- 第三方解析站实测响应 12 秒以上超时，不适合做高频源
- `proxy` 模式尚未实现真正的站点池轮询

---

## License

MIT
