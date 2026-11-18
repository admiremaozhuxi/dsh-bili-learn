# B站第二数据源（polylens）

把 [polylens-bilibili-mcp](https://pypi.org/project/polylens-bilibili-mcp/) 接进 DSH，作为主插件之外的**第二数据源**。

> **现状（2026-11 实测，版本 0.13.0）**：取数工具跑不起来。`get_video_info` 在数据已经取到的情况下卡在 jq 环节，连 `jq="."`（恒等表达式、不做任何处理）都触发「jq 执行超过 2 秒，已终止」；`get_subtitles` 直接请求超时。只有 `get_version` 和 `get_login_status` 能正常响应。
>
> **它的两项独有能力已经吸收进主插件**：评论翻页（`commentPages`）和二级评论（`replyLimit`）。所以这个 bundle 现在**不是必需的**。留着是因为它的设计值得参照，将来上游修好之后接回来也很便宜。

## 它设计上值得学的三点

| 设计 | 好在哪 |
|---|---|
| jq 前置裁剪 | 在返回前就裁掉字段，省 context——思路对，只是实现卡在自己的超时上 |
| 评论游标续取 | 能一直翻页，不占 session（已吸收进 `bili_watch`） |
| 限速与缓存 | 每分钟 30 页、被拦停用 15 分钟、结果按整次调用缓存 |

## 接法

配置式 bundle，不含任何 Host/Client 代码，只往 Loader 插一行 `@deepseek-ai/dsh-mcp-client`：

```yaml
serverName: bilibili
transport: stdio
command: uvx
args: [polylens-bilibili-mcp]
```

工具在 DSH 里以 `mcp__bilibili__<tool>` 出现。

## 登录

除登录相关工具外，全部工具都要求登录态。方法：调 `mcp__bilibili__start_qr_login` 取二维码，用 B 站 App 扫码，再调 `complete_qr_login`。凭据存在 `~/.cache/polylens-bilibili/cookie`。

**注意**：主插件的扫码登录是独立的，两者不共享凭据。主插件把 cookie 存在 `~/.dsh-bili-learn/settings.json`，所以只用主插件就够。

## 想用它就先做这两个测试

```
mcp__bilibili__get_version       → 应返回版本号
mcp__bilibili__get_video_info    → 传 jq="." 和任意 BV，看是否超时
```

第二个超时就是上面说的问题，不是配置错误。可以到上游提 issue，说明「数据已取到、卡在 jq 环节、恒等表达式也超时，建议调高超时或分批处理」。

## 依赖

要求 Python ≥ 3.13，由 `uvx` 自动管理，不要改用系统 Python。首次启动要下运行时，会慢一些。
