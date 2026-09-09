# Gateway 源码契约核对

核对日期：2026-09-09。只读检查同级 `../codex-gateway` 的公开源码和 Compose 模板；未读取秘密文件、数据库或 OAuth 卷，也未发出真实生成请求。检出的 HEAD 为 `103a9f5f3fca6d9924855e14e80d92356ae3c96d`；下列已核对文件的 Git 状态无修改。链接是工作区中的实际源码位置，克隆到其他位置时请按相对仓库位置查找。

## 路由、认证与请求

| 核对项 | 实际源码行为 | 网站实现 |
| --- | --- | --- |
| 路由 | `GET /v1/models`、`GET /v1/responses`、`POST /v1/responses`、`POST /v1/responses/compact` 注册于 [server.go](/home/wsw/proj/codex-gateway/internal/server/server.go:132)。代理另外检查方法与固定路径白名单，[client.go](/home/wsw/proj/codex-gateway/internal/proxy/client.go:424)。没有公开 Chat Completions、Files 或 Embeddings 路由。 | 只调用模型查询和 Responses POST。 |
| WebSocket | Responses GET 在 API Key 验证之后返回 426 `responses_websocket_unsupported`，[api.go](/home/wsw/proj/codex-gateway/internal/server/api.go:24)。 | 使用 HTTPS/SSE，不探测 WebSocket。 |
| API Key | 解析 Bearer，查 Key，核对摘要、状态、过期时间及用户/设备状态，[middleware.go](/home/wsw/proj/codex-gateway/internal/server/middleware.go:161)。 | 每次使用当前用户 Key；不使用管理台 Cookie。网站格式检查不能代替 Gateway 认证。 |
| 模型权限 | GET 查询计算有效模型集合；POST 验证 Key 模型白名单、价格表和用户模型权限，[api.go](/home/wsw/proj/codex-gateway/internal/server/api.go:54)、[准入](/home/wsw/proj/codex-gateway/internal/server/api.go:152)。 | 每次聊天先查模型，然后与网站审核能力表取交集。内部 `codex-auto-review` 不开放。 |
| 正文大小 | 默认 64 MiB，[config.go](/home/wsw/proj/codex-gateway/internal/config/config.go:19)；部署可用 `GATEWAY_BODY_LIMIT_BYTES` 缩小，[配置读取](/home/wsw/proj/codex-gateway/internal/config/config.go:144)。实际部署值本次未核对。 | 实际入站和重建后的 JSON 各自限制 4 MiB。 |
| 请求暂存 | POST 获取最多 4 个暂存许可，将完整受限正文写入 0600 临时文件，再扫描路由字段；关闭时删除文件并释放许可，[model.go](/home/wsw/proj/codex-gateway/internal/server/model.go:69)、[清理](/home/wsw/proj/codex-gateway/internal/server/model.go:48)。Compose 将 `/tmp` 设为 320 MiB tmpfs，[docker-compose.yml](/home/wsw/proj/codex-gateway/docker-compose.yml:102)。 | 不声称“正文从不经过服务器”，网站也不接收原始 PDF/DOCX。 |
| 转发 | Gateway 使用固定 base URL，清空 query/fragment，复制白名单头，改用其内部上游凭据，[client.go](/home/wsw/proj/codex-gateway/internal/proxy/client.go:354)。响应头等待 90 秒，禁止重定向，[传输配置](/home/wsw/proj/codex-gateway/internal/proxy/client.go:112)。 | 网站只发必要头；网站使用设置中已验证的公网 HTTPS Gateway 地址，未指定时使用部署默认值，保留 `redirect: manual`。网站响应头等待上限 100 秒。 |

## 错误映射

Gateway 的错误结构为 `{error:{message,type,code,request_id}}`，错误 JSON 使用 `no-store`；请求 ID 头为 `X-Gateway-Request-ID`，[httpx.go](/home/wsw/proj/codex-gateway/internal/httpx/httpx.go:15)。网站只保留格式有效的请求 ID，向浏览器重新生成固定中文错误信息。

| Gateway 状态 / 安全码 | 源码 | 网站映射 |
| --- | --- | --- |
| 401 `invalid_api_key` | [middleware.go](/home/wsw/proj/codex-gateway/internal/server/middleware.go:210) | 401 `unauthorized` |
| 403 `key_disabled` / `user_disabled` / `device_disabled` | [middleware.go](/home/wsw/proj/codex-gateway/internal/server/middleware.go:188) | 403 `forbidden` |
| 403 `model_not_allowed` | [api.go](/home/wsw/proj/codex-gateway/internal/server/api.go:288) | 原安全码 |
| 429 `insufficient_quota` | [api.go](/home/wsw/proj/codex-gateway/internal/server/api.go:296) | 原安全码；不自动重试 |
| 429 `quota_<dimension>_exceeded` / `invalid_key_rate_limited` / `upstream_rate_limited` | [配额](/home/wsw/proj/codex-gateway/internal/server/api.go:178)、[无效 Key](/home/wsw/proj/codex-gateway/internal/server/middleware.go:210)、[上游限流](/home/wsw/proj/codex-gateway/internal/proxy/client.go:667) | 429 `rate_limited` |
| 503 `request_spool_busy` | [api.go](/home/wsw/proj/codex-gateway/internal/server/api.go:69) | 原安全码 |
| 503 `upstream_reauthentication_required` | [client.go](/home/wsw/proj/codex-gateway/internal/proxy/client.go:667) | 原安全码，提示管理员处理 |
| 504 `upstream_timeout` | [client.go](/home/wsw/proj/codex-gateway/internal/proxy/client.go:742) | 504 `upstream_timeout` |
| 其他未识别的上游错误 | 同上 | 按状态映射通用安全错误，不显示原始 message、堆栈或响应体 |

网站的错误正文读取上限为 16 KiB，Retry-After 仅保留 0–86400 的十进制秒数。Gateway 的 400 价格/层级配置错误未作为浏览器可自由调整参数开放，当前网站以通用上游错误呈现。

## SSE 上限的重要区别

`maxSSEEventBytes = 4 << 20` 确实存在于 [client.go](/home/wsw/proj/codex-gateway/internal/proxy/client.go:26)，但这是 Gateway 的 **usage/模型元数据观察缓冲上限，不是网络事件拒绝上限**。

[streamSSE](/home/wsw/proj/codex-gateway/internal/proxy/client.go:554) 先用 `ReadBytes('\n')` 取得一行并写给客户端，再累计 `data:` 内容。累计超过上限时重置观察缓冲、设置 `discardEvent` 并继续转发。一个巨大物理行也不会被 64 KiB 初始 reader 缓冲自动硬截断。因此不能从这个常量推导 Gateway 已经拒绝超大 SSE 事件，或证明其单行内存有 4 MiB 硬边界。

网站独立执行 4 MiB 原始事件、16 MiB 总流量和 512 KiB 可展示正文限制；越界主动取消上游。网站限制计入事件字段、换行和注释，比 Gateway 仅观察 data 内容更严格。Gateway 流中出错后不会附加普通 JSON，[client.go](/home/wsw/proj/codex-gateway/internal/proxy/client.go:416)；网站将未收到合法终止事件的 EOF 标记为中断。

## 取消与租约链路：源码证据及待验收部分

1. HTTP 请求 context 传入 `ForwardWithOptions`，[api.go](/home/wsw/proj/codex-gateway/internal/server/api.go:205)，再绑定到 `http.NewRequestWithContext`，[client.go](/home/wsw/proj/codex-gateway/internal/proxy/client.go:363)。代理在退出时 `defer response.Body.Close()`，写出失败会退出流循环。
2. 网关将 client disconnect 或已取消 context 记为 cancelled / 499，[api.go](/home/wsw/proj/codex-gateway/internal/server/api.go:219)。流式转发开始后不重发普通 JSON。
3. 准入建立 5 分钟租约，[api.go](/home/wsw/proj/codex-gateway/internal/server/api.go:152)；每分钟续租一次，handler 退出时关闭续租通道，[renewQuotaLease](/home/wsw/proj/codex-gateway/internal/server/api.go:431)。
4. 已进入转发的请求用独立于取消 context 的 5 秒上下文写完成元数据，再结算；这里的最多 3 次重试是 **数据库元数据写入重试，不是重新生成**，[api.go](/home/wsw/proj/codex-gateway/internal/server/api.go:243)。结算事务删除相应并发租约，[quota.go](/home/wsw/proj/codex-gateway/internal/store/quota.go:520)。转发开始前失败走独立释放路径。
5. 数据库写入或结算失败可能使即时清理失败；下一次准入删除过期租约，[quota.go](/home/wsw/proj/codex-gateway/internal/store/quota.go:221)。因此源码链路不能替代实际测量，也不能声称停止按钮返回就已经零占用、零费用。

尚需在正式 HTTPS → Cloudflare → Tunnel → Gateway → 兼容层链路观察：浏览器主动停止/关闭，Gateway context 取消时间，上游连接关闭，usage 终态及并发租约实际释放时间；数据库故障时也需验证恢复行为。本次没有访问 Gateway 管理接口或数据库执行这些检查。

## 兼容层与验收脚本

Compose 声明 CLIProxyAPI commit `c77b13694318b0897f2c74104ef48aebdf8c34d6`，[docker-compose.yml](/home/wsw/proj/codex-gateway/docker-compose.yml:163)。此次没有取得完整执行器源码或检查正在运行的镜像，因此先前关于删除 `previous_response_id` 和可能注入工具的记录仍需结合锁定构建重新复核；网站始终自行组织完整上下文，拒绝工具项，未依赖这些推断放宽边界。

`scripts/acceptance-gateway.mjs` 是操作人员显式运行的验收工具。默认只打印使用说明；提供 `--run`、明确 cases 和环境变量后才调用网站 `/api/config`、`/api/models`、`/api/chat`，不会直接访问 Gateway、WebSocket、Files 或管理接口。正文和 Key 只保留在进程内，不进入报告。PDF/DOCX 的脚本案例仅验证**规范化文字通过网站到模型**；本机解析、预览、用户确认和真实浏览器支持仍由浏览器验收覆盖。取消结果必须结合上面的 Gateway 租约观测，不能由脚本自动认定完整取消链路通过。
