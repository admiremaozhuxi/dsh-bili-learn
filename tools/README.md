# bili-harvest —— B站批量阅读采集器

一套跑在**自有服务器**上的 B 站视频批量采集与解析方案。目标不是下载视频，而是**把视频变成可读的文字**。

---

## 一、三个已实测的事实（2026-11-18 在真实服务器上验证）

这三条是整个方案的地基，和网上流传的说法不一样，务必记住：

| 事实 | 验证方式 | 结论 |
|---|---|---|
| **元数据不需要单条查** | `ranking/v2` 一次返回 100 条，含 `bvid/cid/aid/title/desc/duration/owner/stat` | 3 次调用拿到 292 条。**永远不要用 `view` 接口** |
| **`view` 接口无 cookie 会 -412** | HTTP 412 / `{"code":-412}` | 无 cookie 时它是死的，而 `ranking` 是活的 |
| **字幕必须登录** | `player/v2` 无 cookie 实测 **0/16**；`player/wbi/v2` 加签名后仍 **0/3**，且 `allow_submit=false` | 不是接口选错，不是签名算错 —— B 站就是不给。**必须配 cookie** |
| **直链不需要 cookie** | `/x/player/wbi/playurl` 返回 `code=0, dash=true` | 实测下载 3 MB/s，HTTP 206，有效 fMP4。**自建解析源成立** |

> 一句话总结：**元数据、评论、直链都能白拿；唯独字幕要登录。**

---

## 二、两个程序

### 1. `harvest.py` —— 批量采集器

串行限速 · 断点续跑 · 风控退避 · 落盘 JSONL

```bash
# 只抓元数据（最省，几乎不消耗配额）
python3 harvest.py --mode meta --source ranking --pages 6

# 全量：元数据 + 字幕 + 评论
python3 harvest.py --mode full --source popular --pages 2 --comment 20 --limit 50

# 按 BV 清单跑
python3 harvest.py --mode bv --bv-file bvs.txt --comment 20
```

产出：
- `data/meta.jsonl` —— 元数据，每行一条
- `data/items.jsonl` —— 完整记录（含 `subtitles` / `comments`）
- `data/done.txt` —— 断点，重跑自动跳过已完成

关键：字幕拿不到时**不会静默失败**，会写 `subtitle_trace`，例如：
- `empty_allow_submit_False` → 没登录，B 站不给
- `ok` → 拿到了
- `api_code_-xxx` → 接口报错

### 2. `parse_svc.py` —— 自建解析服务

把一台服务器变成解析源，HTTP 接口，自带限速、wbi 签名、结果缓存。

```bash
nohup python3 parse_svc.py --port 8848 --gap 1.5 > svc.log 2>&1 &
```

| 接口 | 说明 |
|---|---|
| `GET /health` | 存活 + 调用次数 + 风控次数 |
| `GET /playurl?bvid=BVxxx&cid=123` | 返回音频轨 + 视频轨直链（3 音频 + 4 视频） |
| `GET /subtitle?bvid=BVxxx&cid=123` | 字幕（需要 cookie） |

实测：缓存命中 **0.015 秒**，直链下载 **3 MB/s**。

---

## 三、配 cookie（唯一必须手动做的一步）

没有 cookie，字幕永远是空的。获取方法：

1. 用浏览器**登录** B 站
2. 按 `F12` 打开开发者工具
3. 找 **Application**（应用）→ 左侧 **Cookies** → `https://www.bilibili.com`
4. 找到名为 **`SESSDATA`** 的那一行，双击复制它的 **Value**
5. 在服务器上写文件：

```bash
cd /root/bili-harvest
echo 'SESSDATA=你复制的那一长串' > cookie.txt
chmod 600 cookie.txt
```

6. 验证：

```bash
curl -sS "http://127.0.0.1:8848/subtitle?bvid=BV1xx&cid=123" | head -c 300
```

看到 `"trace": "ok"` 就成功了。

> `SESSDATA` 等同于你的账号登录凭证，别把它贴到公开的地方。有效期通常几个月，失效后重新取一次即可。

---

## 四、出口 IP 的意义（重要）

配额的真正单位是 **IP**，不是线程数。

- 实测：同一 IP 连续约 **30 次**请求开始返回 412
- 所以「开 8 个 agent 并行」= 8 倍速送进冷却
- 正确做法：**每个 IP 跑一个串行采集器**，多 IP 才有意义

当前已接入的出口：

| 出口 | IP | 状态 |
|---|---|---|
| 自建服务器 | YOUR_SERVER_IP | ✅ 已部署 harvest + parse_svc |
| 本机 | 动态 | ⚠️ 可能处于风控冷却，带 cookie 才有意义 |

再增加一台机器，就多一个配额池，步骤见 `DEPLOY.md`。

---

## 五、产能参考（单 IP）

| 模式 | 每条消耗 | 说明 |
|---|---|---|
| 元数据 | **0.01 次** | 一次 100 条，几乎免费 |
| 元数据 + 评论 | 1 次 | 评论接口无 cookie 可用 |
| 元数据 + 字幕 + 评论 | 2 次 | 字幕是最大成本 |

按 `gap=1.5s`、每轮 70 次调用估算：**约 35 条完整记录/轮，每 IP 每小时 100~150 条**。

瓶颈从来不在 agent 数量，在 IP 数量。
