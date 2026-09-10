# 部署、运维与回滚

2026-09-09 已通过 Wrangler 部署至 `https://chat.water555.com`，使用 Workers Free，默认 Gateway 为 `https://codex.water555.com`。部署记录见 [实施与验收记录](acceptance.md)；真实 Key 下的模型能力和免费套餐运行表现仍需验收。

## 正式配置

1. 准备已授权的 Cloudflare 账户、稳定的聊天域名和独立 Gateway HTTPS 来源。Workers Free 可用于本次部署，不需要先开通 Paid。网站与 Gateway 来源不能相同；改变网站来源会使 IndexedDB 历史无法自动互通。
2. 在 `wrangler.jsonc` 中维护账户、路由、`PUBLIC_ORIGIN`、`GATEWAY_ORIGIN` 与功能配置。当前自定义域名路由为 `chat.water555.com`，`workers_dev` 与 `preview_urls` 均关闭。两个来源变量必须是纯 HTTPS origin，不能带 `/v1` 或其他路径、URL 凭据、查询参数、片段；本次分别为 `https://chat.water555.com` 和 `https://codex.water555.com`。
3. `MODEL_CAPABILITIES` 配置为 `gpt-5.5`、`gpt-5.6-luna`、`gpt-5.6-terra`、`gpt-5.6-sol`、`gpt-6-astra`，图片能力均设为 `true`；仓库配置须重新部署才会在线上生效，这些 ID 和能力尚待真实 Key 验证。实际模型列表与当前用户可访问的 Gateway 模型取交集，内部治理模型不允许进入列表。基础文本和图片附件已启用，PDF/DOCX 暂关闭。功能开启不等于验收通过；完整 P0 最终验收仍要求图片、PDF、DOCX 都通过。
4. 不配置共享上游 API Key、OAuth Token 或管理员凭证。用户 Key 只从每次 Bearer 请求取得；不复制 Gateway Cookie。
5. 配置保留 `RATE_LIMITER`（每个 IP、60 秒 30 次）并实测其作用范围和失败行为。它是平台限流设施，不是全球额度保证。Gateway 继续决定最终权限和计费。

`compatibility_date` 固定为 `2026-08-22`，同时在单元使用的 workerd 和 Wrangler 版本中验证。开发环境显式开启 `ALLOW_LOCAL_GATEWAY` 且两端都为 loopback 时才允许 HTTP；生产不要设置此项。

`GATEWAY_ORIGIN` 作为设置页面的默认地址。用户可在「设置 → Gateway 连接」验证并切换公网 HTTPS Gateway；此处支持代理路径和末尾的 `/v1`，网站通过每次请求的 `X-Gateway-URL` 使用该地址，模型仍须与 `MODEL_CAPABILITIES` 相交。默认地址和自定义地址均不接收 URL 内的凭据、查询参数或片段，用户 Key 独立通过 Bearer 传递。更新部署默认值或模型、附件能力时，修改 `wrangler.jsonc` 后重新构建发布。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:workers
pnpm test:e2e
pnpm deploy:check
# 确认模型、附件配置并完成发布检查后：
pnpm deploy
```

发布前确认配置中的精确模型与实际 Gateway 一致。dry-run 不创建远程资源，也不代表账户套餐、DNS、域名路由或网关已经可用。真实 Key、模型能力与设备矩阵仍需单独验收。

## 连接 Git 仓库自动部署

本仓库的 `origin` 为 `git@github.com:wsw12321/chat-browser.git`，生产分支为 `main`。在现有的 `chat-browser` Worker 中启用 Workers Builds，即可让推送到 `main` 的提交自动构建并发布到 `https://chat.water555.com`。Cloudflare 支持给已有 Worker 连接 Git 仓库，入口为 **Workers & Pages → chat-browser → Settings → Builds → Connect**。参见 [Workers Builds 官方步骤](https://developers.cloudflare.com/workers/ci-cd/builds/#connect-an-existing-worker)。

1. 登录当前 Worker 所在的 Cloudflare 账户，按上述入口点击 **Connect**。
2. 选择 GitHub，按提示安装或授权 Cloudflare GitHub App，并授予它访问 `wsw12321/chat-browser` 的权限；随后选中该仓库。
3. 填写下面的构建配置。项目使用仓库根目录的 pnpm workspace 和 `wrangler.jsonc`；Worker 名称必须与配置文件中的 `name` 一致。字段说明见 [构建配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。

| 设置 | 本项目填写值 |
| --- | --- |
| Worker 名称 | `chat-browser` |
| Git 仓库 | `wsw12321/chat-browser` |
| 生产分支 / Git branch | `main` |
| 根目录 / Root directory | 仓库根目录，保留默认值；不填 `apps/web` 或 `apps/edge` |
| 构建命令 / Build command | `pnpm install --frozen-lockfile && pnpm check` |
| 部署命令 / Deploy command | `pnpm exec wrangler deploy` |
| 非生产分支构建 | 关闭；当前配置已关闭预览 URL |
| 部署 API token | 使用 Cloudflare 自动创建的默认 Token |

4. 在 **Build Variables and Secrets** 中添加以下构建变量；Cloudflare 支持通过 `NODE_VERSION`、`PNPM_VERSION` 固定工具版本，并通过 `SKIP_DEPENDENCY_INSTALL` 将依赖安装交给构建命令。参见 [构建环境与版本覆盖](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)。

| 构建变量 | 值 |
| --- | --- |
| `NODE_VERSION` | `24.16.0` |
| `PNPM_VERSION` | `11.18.0` |
| `SKIP_DEPENDENCY_INSTALL` | `true` |

5. 保存连接和构建设置后，在本地仓库推送已经完成的提交，触发本次更新：

   ```sh
   git push origin main
   ```

6. 在 Worker 的 **Deployments → View build history** 查看构建日志，确认本次提交构建和部署成功；随后打开 `https://chat.water555.com`，使用自己的 Gateway Key 验证模型列表。列表只显示五个配置模型与该 Key 可访问模型的交集。

构建命令依次执行冻结依赖安装、类型检查、单元测试和前端构建；部署命令读取 `wrangler.jsonc`，发布 Worker 及其中配置的 `dist` 静态资源。运行时模型、域名、Gateway 和功能开关继续在 `wrangler.jsonc` 中维护，Gateway Key 由用户在网页输入。

以后更新代码时，在本地验证后提交并推送，Cloudflare 会自动部署：

```sh
pnpm check
git add <本次修改的文件>
git commit -m "说明本次更新"
git push origin main
```

只执行本地 `git commit` 不会更新线上站点；需要推送到已连接的生产分支并等待部署成功。

## 安全头与缓存

Cloudflare Static Assets 提供 `dist`；`/api/*` 先进入 Worker，其他 API 路径返回 JSON 404。主页面 CSP 禁止内联脚本、eval、原始 HTML 和外部图片自动加载；`/parsers/*` 使用独立 `connect-src 'none'` 策略。解析脚本不读取附件外链。

API、SSE、错误和模型权限查询均 `no-store`。Service Worker 只预缓存构建清单中的静态外壳；不缓存 API、Authorization 请求、文件 Blob 或聊天记录。构建版本写入 SW，更新需要用户确认；保留当前与前一份静态缓存用于已有页面的哈希资源。

首页与 `index.html` 使用 `Cache-Control: no-cache, no-transform`，保留重新验证并阻止 Cloudflare 自动注入 Web Analytics 脚本；JavaScript、CSS 和解析资源继续使用原有不可变缓存，不设置 `no-transform`。参见 [Cloudflare Web Analytics FAQ](https://developers.cloudflare.com/web-analytics/faq/)。

更新前必须核对实际响应头，包括 Cloudflare 自定义规则是否覆盖 `_headers`。开发服务器不等于生产 CSP 环境，浏览器测试使用 Wrangler 静态资源路径。

## 日志与资源

`observability.enabled=false`；应用不打印 Key、文件名、文件哈希、消息、图片、完整事件或原始异常。Wrangler 本机开发日志不代表正式平台日志策略。上线前另查账户的 Logpush、Trace、请求回放、异常采集、Tunnel 和 Gateway 日志配置。

本次选择 Workers Free，与 [设计预算](plan.md) 中的 Paid 方案不同：已移除 `limits.cpu_ms`，使用平台每请求 10 ms CPU 限额及每天 10 万次 Worker 请求额度。等待 Gateway 网络响应不计 CPU，但请求解析、图片校验和 SSE 处理会消耗 CPU；大附件和长回复仍需实测。持续出现 CPU 超限错误 1102 时，应优化处理或经账户持有人选择升级 Paid；Paid 可在 `wrangler.jsonc` 设置 `"limits": { "cpu_ms": 1000 }`。参见 [Cloudflare 官方限额](https://developers.cloudflare.com/workers/platform/limits/)。

入口每 isolate 4 个受保护请求、其中 2 个请求解析许可；长流持有入口许可直至关闭。它们不能代替并发峰值内存测量和跨位置 Gateway 额度。

发布前仍需记录边界 4 MiB 请求、2 张边界图、4 路长流、慢客户端、首事件与首正文延迟、停止后 Gateway 并发释放时间。不要把本机测试时长或 Cloudflare 配额数值写成已实测的生产性能。

## 数据兼容与回滚

首次发布 Schema=1，应用契约=1，文件策略=`file-policy-v1`，解析版本单独保存在附件与确认记录中。PDF.js 补丁与完整锁文件一起发布，不能只替换其中一个文件。

回滚使用上一份完整的 Worker+静态资源构建，保持正式域名。旧应用遇到更高数据库版本时，只在必需 Store 及索引仍兼容的情况下打开只读恢复模式，允许历史查看与标准备份导出；禁止写入和隐式降级。遇到不兼容结构保留数据库并提示存储不可用，不能删除站点数据作为修复。

策略变化后已有附件需重新审查和重新确认，用户再次发送；任何生成都不自动重试。Service Worker 更新同样不能清空 IndexedDB。先保留未保存的内存回复，再刷新或回滚。
