# B站第二数据源（polylens）

把 [polylens-bilibili-mcp](https://pypi.org/project/polylens-bilibili-mcp/) 接进 DSH，作为自建采集器之外的**第二数据源**。

## 为什么需要它

自建采集器（`@local/dsh-bili-learn`）是主力，快、可控、结果落成本地文件。但它有两个已知缺口：

| 缺口 | 说明 |
|---|---|
| 评论截断 | 无登录态时 B 站只返回 3 条预览评论 |
| 无分页 | 单次只取一页评论 |

polylens 补的正是这些：评论支持**游标续取**、可按热度或时间排序、还有二级评论、分 P 清单、UP 主资料、弹幕数。

## 接法

配置式 bundle，不含任何 Host/Client 代码，只往 Loader 插一行 `@deepseek-ai/dsh-mcp-client`：

```yaml
serverName: bilibili
transport: stdio
command: uvx
args: [polylens-bilibili-mcp]
```

工具在 DSH 里以 `mcp__bilibili__<tool>` 出现，例如 `mcp__bilibili__get_subtitles`。

## 必须先登录

除登录相关工具外，全部工具都要求登录态，且每次调用前会联网核验。方法：让 DSH 调用 `mcp__bilibili__start_qr_login` 取二维码，用 B 站 App 扫码，再调用 `complete_qr_login`。

凭据保存在 `~/.cache/polylens-bilibili/cookie`。

## 它自带的限速

评论每分钟最多 30 页；被平台拦截后评论工具停用约 15 分钟，其他工具不受影响；结果按整次调用缓存。

## 注意

- 首次启动 `uvx` 需要下载 Python 3.13 运行时与依赖，会慢一些，之后有缓存。
- 它要求 Python ≥ 3.13，本机系统的 3.12 不够，由 `uvx` 自己管理，不要改用系统 Python。
