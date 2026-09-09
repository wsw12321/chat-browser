# 部署、运维与回滚

目前仅完成构建、模拟联调、workerd 和配置 dry-run。此文是可执行发布步骤，不能代替正式验收记录。

## 正式配置

1. 准备 Workers Paid 账户、稳定的聊天域名和独立 Gateway HTTPS 来源。两者不能相同；不要使用临时预览域名替代正式来源，否则 IndexedDB 历史无法自动互通。
2. 修改 `wrangler.jsonc` 的 `name`、`PUBLIC_ORIGIN`、`GATEWAY_ORIGIN`，加入实际自定义域名路由，例如 `"routes": [{ "pattern": "chat.your-domain.tld", "custom_domain": true }]`。模板禁止 `workers.dev`，没有默认可访问的正式路由。
3. `MODEL_CAPABILITIES` 填写经过真实文字、图片和历史续接验收的精确模型数组。内部治理模型不允许进入列表。三个附件开关与该格式完整验收结果相符；完整 P0 最终验收要求图片、PDF、DOCX 都通过，不能通过永久关闭它们绕过门槛。
4. 不配置共享上游 API Key、OAuth Token 或管理员凭证。用户 Key 只从每次 Bearer 请求取得；不复制 Gateway Cookie。
5. 配置保留 `RATE_LIMITER`（每个 IP、60 秒 30 次）并实测其作用范围和失败行为。它是平台限流设施，不是全球额度保证。Gateway 继续决定最终权限和计费。

`compatibility_date` 固定为 `2026-08-22`，同时在单元使用的 workerd 和 Wrangler 版本中验证。开发环境显式开启 `ALLOW_LOCAL_GATEWAY` 且两端都为 loopback 时才允许 HTTP；生产不要设置此项。

`GATEWAY_ORIGIN` 作为设置页面的默认地址。用户可在「设置 → Gateway 连接」验证并切换公网 HTTPS Gateway；网站通过每次请求的 `X-Gateway-URL` 使用该地址，模型仍须与 `MODEL_CAPABILITIES` 相交。默认地址和自定义地址均不接收 URL 内的凭据、查询参数或片段，用户 Key 独立通过 Bearer 传递。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:workers
pnpm test:e2e
pnpm deploy:check
# 全部发布门槛和账户/域名准备完成后：
pnpm deploy
```

模板只包含占位配置。不要对默认模板直接执行正式发布。dry-run 不创建远程资源，也不代表账户套餐、DNS、域名路由或网关已经可用。

## 安全头与缓存

Cloudflare Static Assets 提供 `dist`；`/api/*` 先进入 Worker，其他 API 路径返回 JSON 404。主页面 CSP 禁止内联脚本、eval、原始 HTML 和外部图片自动加载；`/parsers/*` 使用独立 `connect-src 'none'` 策略。解析脚本不读取附件外链。

API、SSE、错误和模型权限查询均 `no-store`。Service Worker 只预缓存构建清单中的静态外壳；不缓存 API、Authorization 请求、文件 Blob 或聊天记录。构建版本写入 SW，更新需要用户确认；保留当前与前一份静态缓存用于已有页面的哈希资源。

更新前必须核对实际响应头，包括 Cloudflare 自定义规则是否覆盖 `_headers`。开发服务器不等于生产 CSP 环境，浏览器测试使用 Wrangler 静态资源路径。

## 日志与资源

`observability.enabled=false`；应用不打印 Key、文件名、文件哈希、消息、图片、完整事件或原始异常。Wrangler 本机开发日志不代表正式平台日志策略。上线前另查账户的 Logpush、Trace、请求回放、异常采集、Tunnel 和 Gateway 日志配置。

生产 CPU 初始配额 1000 ms。入口每 isolate 4 个受保护请求、其中 2 个请求解析许可；长流持有入口许可直至关闭。它们不能代替并发峰值内存测量和跨位置 Gateway 额度。

发布前仍需记录边界 4 MiB 请求、2 张边界图、4 路长流、慢客户端、首事件与首正文延迟、停止后 Gateway 并发释放时间。不要把本机测试时长或 Cloudflare 配额数值写成已实测的生产性能。

## 数据兼容与回滚

首次发布 Schema=1，应用契约=1，文件策略=`file-policy-v1`，解析版本单独保存在附件与确认记录中。PDF.js 补丁与完整锁文件一起发布，不能只替换其中一个文件。

回滚使用上一份完整的 Worker+静态资源构建，保持正式域名。旧应用遇到更高数据库版本时，只在必需 Store 及索引仍兼容的情况下打开只读恢复模式，允许历史查看与标准备份导出；禁止写入和隐式降级。遇到不兼容结构保留数据库并提示存储不可用，不能删除站点数据作为修复。

策略变化后已有附件需重新审查和重新确认，用户再次发送；任何生成都不自动重试。Service Worker 更新同样不能清空 IndexedDB。先保留未保存的内存回复，再刷新或回滚。
