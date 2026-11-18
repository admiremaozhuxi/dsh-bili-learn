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

**只需要两步，不用装 Python，不用装 ffmpeg，不用开开发者工具。**

```bash
git clone https://github.com/admiremaozhuxi/dsh-bili-learn.git
```

然后在 DSH 里：**Plugins → Add plugin**，选择 `plugin/` 目录。

装好后：

1. 左侧栏出现「B站学习器」
2. 点开 →「扫码登录 B 站」→ 手机 App 扫一下
3. 直接对 DSH 说「学习B站上××，帮我做××」

首次「看画面」时，插件会自己下载一个 ffmpeg（约 28 MB，走国内镜像约 5 秒），装在 `~/.dsh-bili-learn/bin/`，之后不再下。

### 这些都不需要你做

| 以前要装 | 现在 |
|---|---|
| Python 3 + 4 个 pip 包 | ❌ 不需要，全部改写成 Node |
| ffmpeg | ❌ 不需要，插件自动准备 |
| 手动复制脚本到某个目录 | ❌ 不需要，插件自带 |
| F12 复制 SESSDATA | ❌ 不需要，面板扫码 |

### tools/ 里的 Python 是什么

给喜欢命令行的人用的可选件，功能与插件重复。**不装它们，插件功能完全一样。**


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

## 画面路径：让 AI 真正「看到」画面

字幕只覆盖 UP 主说的话。PPT、屏幕上的代码、界面变化、游戏操作、实物演示全都不在字幕里 —— 而字幕覆盖率只有约 11%。`bili_frames` 补的就是这块。

原理：`playurl` 拿**最低码率**视频轨（不需要登录）→ ffmpeg 抽帧 → 感知哈希去重 → 视觉模型逐帧描述。

实测一条 43 秒的《王者荣耀》视频（最低码率只 0.89 MB）：

```
[00:00] 屏幕上「15 vs 5」的比分，一名 11 级英雄正在攻击 8 级英雄
[00:15] 多名英雄团战，左上角是双方击杀数与游戏时间
[00:30] 蓝色龙形生物攻击防御塔，角色等级 9，塔上方显示「免疫」
```

这些信息**字幕里一个字都没有**。

借鉴的开源方案：

| 项目 | 借的点 |
|---|---|
| [bilibili-video-summary](https://github.com/bfftp0502/bilibili-video-summary) | 跳帧 OCR 做画面补充，并自动剔除 UP 主名、水印等噪声 |
| [video-frames-skill](https://github.com/mugnimaestra/video-frames-skill) | 场景变化检测抽帧、`--max-frames` 控制 token 预算 |
| [SKILL_bilibili-watch](https://github.com/VZService/SKILL_bilibili-watch) | 明确区分文本路径与画面路径，且画面路径不需要登录 |

用法（插件工具）：

```
bili_frames({ bvid: "BV1fAZtYoEnW", maxFrames: 8 })
bili_frames({ bvid: "BV1xx", prompt: "只读屏幕上的代码和终端输出" })
```

命令行同样可用：

```bash
python tools/video_frames.py --bvid BV1fAZtYoEnW --max-frames 8
python tools/video_frames.py --bvid BV1xx --prompt "只读屏幕上的代码"
```

**成本**：每帧一次视觉模型调用，默认 8 帧。先小后大 —— 第一遍漏了再提高帧数，比拼数量便宜。

**依赖**：`imageio-ffmpeg`（自带 ffmpeg 二进制，不用装系统 ffmpeg）+ `Pillow`。

---

## 关于字幕

这是唯一的硬约束：**字幕需要登录态**。实测无 cookie 时，`player/wbi/v2` 返回 `code=0` 但字幕数组为空，连 `ai_status` 字段都不返回 —— B 站把整个字幕对象阉割了，所以「拿 AI 字幕免登录」这条路不存在。

登录之后确实能拿到，但**覆盖率不高**：同一批取自 4 个分区的 9 条视频里，只有 1 条带字幕轨（`ai-zh` + `ai-en`，实测拉到 792 行正文），命中率约 **11%**。知识 / 讲解类高一些，纯展示、游戏、舞蹈类基本没有。

所以真实策略是**两条腿走路**：有字幕就直接取（快），没字幕就走下面的音频转写（慢但一定有）。

三条路，按可靠性排序：

| 方式 | 操作 | 说明 |
|---|---|---|
| **扫码登录** | 调 `start_qr_login` 取二维码，B 站 App 扫一下 | 最可靠，一次搞定，凭据落在本地 |
| **手工复制 SESSDATA** | 浏览器 F12 → Application → Cookies → `https://www.bilibili.com` → 复制 `SESSDATA` | 30 秒，写进 `~/.dsh-bili-learn/settings.json` |
| 复用浏览器 cookie | `python tools/browser_cookie.py` | 仅对旧版浏览器有效：Edge/Chrome 127+ 已改用 **v20 app-bound 加密**，需要 SYSTEM 权限解第一层密钥，用户态解不开（本脚本会给出这个提示而不是静默失败） |

### 不想登录？用音频转写

`python tools/asr_transcribe.py --bvid BVxxx` —— 这条路径**完全不需要登录**。

原理：`playurl` 拿音频直链不需要 cookie（已实测 3 MB/s），拿到音频后走 Whisper / SenseVoice 转文字。

实测：31 秒视频 → 音频 334 KB → 下载 0.3s → SenseVoice 转写 24.4s → 99 字，内容准确。

代价是**慢**：转写耗时约等于音频时长，所以它适合少量关键视频，不适合海量。
API key 从 `~/.modlens/config.json`、环境变量 `SILICONFLOW_API_KEY`，或 `settings.json` 的 `asrKey` 读取。

### 第三方方案实测

| 方案 | 结论 |
|---|---|
| 公开在线解析站 | 只返回视频/图片直链，**不给字幕**；主力站点响应 12 秒以上超时 |
| Bilibili Toolkit Free（SkillHub） | 描述全是 `input_params` / `config_options` 这类模板占位，空壳；它自己也承认「没字幕时会尝试语音识别转写」 |
| 浏览器字幕扩展（BiliBili 字幕提取器、Bilitato 等） | 确实能取到字幕，但**靠的是你浏览器里的登录态**，而且要人工在视频页点一下 —— 反过来印证了上面那条结论 |
| apify `video-subtitle-extractor` | 付费 API（约 $5 / 1000 次），原生字幕优先，没有则走 Whisper。要接商业账号 |

一句话：**字幕这关绕不过登录；不想登录，就用音频转写，代价是慢。**

---

## 已知限制

- 字幕与完整评论区都需要 `SESSDATA`
- 同一 IP 约 30 次请求触发 412，冷却后恢复
- 第三方解析站实测响应 12 秒以上超时，不适合做高频源
- `proxy` 模式尚未实现真正的站点池轮询

---

## License

MIT
