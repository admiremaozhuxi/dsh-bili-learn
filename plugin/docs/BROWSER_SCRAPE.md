# 用浏览器走第三方站（实测可用）

给**没有自建服务器**的用户用的兜底路径。这条路的价值不是 API，是那些站有自己的出口 IP。

## 实测结论（2026-11-18）

| 项 | 数据 |
|---|---|
| 站点 | v2ob.com |
| 全流程耗时 | 约 12 秒（页面 2s + 填写点击 1s + 等结果 8s） |
| 验证码 | **无** |
| 产出 | 有效 MP4，5.6 MB，画质 192p |
| 直链可用性 | HTTP 206，`content-type: video/mp4`，文件头 `ftypisom` |

同一条视频走官方接口拿的是 8 条视频轨（最高 640×360）；走 v2ob 只给一条 192p。**所以它是兜底，不是主力。**

## 完整步骤（可直接照做）

```
1. browser_navigate  https://v2ob.com/
2. 确认页面正常
   browser_eval → document.title 含 "V2OB"
3. 填入视频地址
   browser_type  selector: input[name="url"]
                 text: https://www.bilibili.com/video/BVxxxx
4. 点解析
   browser_eval:
     [...document.querySelectorAll('button')]
       .find(b => b.innerText.includes('获取下载链接')).click()
5. 等 8 秒
   browser_wait  ms: 8000
6. 读直链
   browser_eval:
     [...document.querySelectorAll('video, source')]
       .map(e => e.src || e.getAttribute('src'))
       .filter(s => s && s.includes('bilivideo'))
7. 拿到 https://xxx.bilivideo.com/...mp4 即为成功
```

## 判断成功的标志

结果里出现 `video` 元素的 `src` 含 `bilivideo`，并且 URL 里能看到目标 `cid`（例如 `.../29176303056/...`）。仅看页面文字不够——很多站会显示"解析中"却什么都不给。

## 换其他站时怎么找元素

每个站的选择器不同，通用套路：

```
1. browser_navigate 打开站点
2. browser_eval 列出所有可见输入框与按钮：
     [...document.querySelectorAll('input,textarea')].map(e=>({tag:e.tagName,name:e.name,ph:e.placeholder}))
     [...document.querySelectorAll('button,a')].map(e=>e.innerText.trim()).filter(Boolean)
3. 找到「粘贴链接」的输入框和「解析 / 开始 / 下载」按钮
4. 依次填、点、等、读 video[src]
```

已登记站点的实测打开速度（快的先试）：

| 站点 | 打开 | 备注 |
|---|---|---|
| vtool.pro | 1.0s | 最轻，但实测会被自动化检测弹开（跳到 about:blank） |
| v2ob.com | 1.2s | **已验证可走通** |
| iiilab | 4.8s | 功能全 |
| videofk | 4.3s | 慢 |
| zhouql.vip | 0.2s | 极简，未验证 |

## 局限（必须知道）

1. **画质低**。v2ob 给 192p。拿去抽帧看 PPT/代码够用，拿去收藏不够。
2. **慢**。约 12 秒一条，是官方接口的 20 倍以上。
3. **要浏览器**。需要子 agent 有 `browser_*` 工具；没有的话由主 agent 自己走。
4. **站会变**。选择器失效是常态，所以要会上面「通用套路」自己去页面上找。

## 什么时候用

- 官方接口连续返回 412，且没有自建服务器
- 只要**看画面**（抽帧），不在乎画质
- 少量几条，不是批量

批量还是应该走 `bili_learn` 的接口路径——快、稳、字段全。
