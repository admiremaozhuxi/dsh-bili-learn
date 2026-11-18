# 外部解析源实测清单（2026-11-18）

本地 `curl` 实测，超时 12 秒，跟随重定向。**结论在最后一节。**

## 一、公开在线解析站

| 站点 | 首页 | 响应 | 备注 |
|---|---|---|---|
| `vtool.pro/bilibili.html` | 200 | **1.35s** | 本次实测**最快**，页面轻（14KB） |
| `v2ob.com` | 301 | 0.38s | 重定向跳转，业务正常 |
| `bilibili.iiilab.com` | 301 | 0.59s | 老牌站，跳转后正常 |
| `kedou.life` | 200 | **12s+（超时）** | 12 秒才收到 4.7KB，极慢 |
| `6li6.com/bilibili` | 200 | **12s+（超时）** | 同上，慢 |
| `greenvideo.cc` | 000 | 12s 超时 | 本机连不上（可能被墙或已迁移） |
| `www.videofk.com` | 403 | — | nginx 直接拒绝，挡非浏览器 |
| `xbeibeix.com` | 部分 | 12s 超时 | 回了 673 字节 HTML，能连但极慢 |
| `www.xiazaitool.com/blbl` | 200 | 正常 | 用户举例的站，**批量需会员** |
| `bili.1s.fan` | **DNS 失败** | — | **域名已挂**；源码仍在 GitHub |

### xiazaitool 的机制（已逆向确认）

```
端点：POST /video/parseVideoUrl
签名：params = SHA256("bf5941f27ee14d9ba9ebb72d89de5dea" + url + "bilibili")
鉴权：Header Authorization: token + withCredentials cookie
返回：{ data: { voideDeatilVoList: [{ url, title, type }] } }
```

**只返回视频/图片直链 + 标题**。全文搜过，无 `subtitle`、无 `danmaku`、无 `cid`、无 `desc`。
它把 B 站风控换成"付费配额"（`leftTimes` / 会员 / `status 407`）。

## 二、可自部署的开源项目（推荐路线）

| 项目 | 形态 | 说明 |
|---|---|---|
| `wu529778790/parse.shenzjd.com` | Node.js | 多平台，支持 Docker / Cloudflare Workers 一键部署 |
| `FrecklyComb1728/BiliParser` | 原生 Node，零依赖 | 接口 `GET /api/any?text=BVxxx&qn=80`，Vercel 可部署 |

这两个的意义：**把解析能力搬到自己的 IP 上**，不依赖别人家的站会不会挂。

## 三、API / 服务类

| 来源 | 形态 | 成本 |
|---|---|---|
| `xiaoapis.com/api/video/videoparse` | 付费 HTTP API | 约 0.01 元/次，20 QPS，免费 10 次 |
| `polylens-bilibili-mcp`（PyPI） | 本地 MCP 服务 | 免费，能取**字幕 / 评论 / 视频信息**，需扫码登录 |

`polylens-bilibili-mcp` 值得单独注意：它已经把 `get_subtitles`、`get_comments`、`get_video_info`、`search_videos` 都封装好了，且支持 HTTP + OAuth 远程接入。适合做**第二数据源交叉验证**。

---

## 四、结论（实话）

**这些公开站，对你的场景大部分没有用。** 原因：

1. **慢** —— 主力站点实测 12 秒超时才勉强回包，做批量采集完全不现实
2. **有验证码 / 会员限次** —— 免费额度就是给你手动点几下
3. **只给文件，不给文字** —— 你要的是字幕和评论，它们基本不给
4. **寿命不可控** —— `bili.1s.fan` 已经挂了，`videofk` 已经挡爬虫

所以正确的职责划分是：

| 用途 | 用什么 |
|---|---|
| 元数据 / 评论 / 字幕 | **自建采集器**（`harvest.py`，已部署在你的 ECS） |
| 视频/音频直链 | **自建解析服务**（`parse_svc.py`，已部署） |
| 低频兜底（某条视频要音频做 ASR） | 公开站，人工触发，`vtool.pro` 优先 |
| 交叉验证 / 备用数据源 | `polylens-bilibili-mcp` |

**公开站是备胎，不是主力。** 主力必须是自己能控制的机器 —— 这也是为什么"用你的小服务器作为其中之一"是对的，而且应该作为**唯一主力**。
