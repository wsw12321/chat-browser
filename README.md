# 纸间 · 浏览器聊天

独立的简体中文聊天网站：React 静态前端、Cloudflare Module Worker、IndexedDB 本机历史。用户使用自己的 Gateway Key；TXT、Markdown、JSON、CSV、PDF、DOCX 和图片先在本机检查，确认发送时只传输规范化内容。

已部署至 [chat.water555.com](https://chat.water555.com)，使用 Workers Free，默认 Gateway 为 `https://codex.water555.com`。当前启用文本附件和图片，PDF/DOCX 暂关闭；仓库中的模型配置为 `gpt-5.5`、`gpt-5.6-luna`、`gpt-5.6-terra`、`gpt-5.6-sol`、`gpt-6-astra`，部署后生效，实际可选列表仍与用户 Key 的权限取交集。**尚未完成 P0-E 正式发布验收**：真实 Key 下的模型 ID、图片能力、设备矩阵和 Free CPU 限额下的运行表现仍待验收。

## 本地运行

需要 Node.js 24 和 pnpm 11.18.0：

```sh
pnpm install --frozen-lockfile
pnpm dev:mock
```

打开 `http://127.0.0.1:5173`，创建本机档案，连接模拟 Key `test-key`，选择 `mock-text` 或 `mock-vision`。模拟服务不访问真实模型。首次开发启动先构建离线外壳；开发页面由 Vite 提供，API 代理到本地 Worker。

左下角「设置 → Gateway 连接」可填写自定义 Gateway URL 和对应 Key。地址支持根地址、代理路径和末尾的 `/v1`；点击「验证并连接」成功后，模型查询和聊天都使用该地址。取消编辑或验证失败会保留原连接。地址与 Key 仅保留在当前页面内存，刷新后地址恢复部署默认值，Key 需重新输入。生产使用公网 HTTPS；本机开发可连接 loopback HTTP 地址。

仅预览生产构建与严格 CSP：

```sh
node scripts/preview.mjs
```

打开 `http://127.0.0.1:8787`。模拟场景：问题包含「慢速测试」「异常结束」「长回复测试」「工具测试」；`quota-key` 返回额度不足，`busy-key` 返回网关繁忙，其他 Key 返回 401。

## 验证命令

```sh
pnpm typecheck
pnpm test
pnpm test:workers
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
pnpm build
pnpm deploy:check
pnpm audit
```

`test:workers` 使用真实 workerd 运行环境，`test:e2e` 会自行启动生产构建、模拟 Gateway 和 Wrangler。两者需要本机回环监听权限；不依赖付费 Key。`pnpm check` 运行类型、单元测试和构建；CI 另跑 Workers 与浏览器测试。

## 代码与记录

| 目录 | 内容 |
| --- | --- |
| `apps/web` | 中文界面、固定发送快照、聊天流、离线外壳 |
| `apps/edge` | Gateway 地址校验、认证、严格请求校验、并发许可、SSE 转发 |
| `packages/contracts` | 公开策略、错误码、Schema、严格 JSON、图片/SSE 校验 |
| `packages/file-review` | 本机解析 Worker、受限适配器、PDF.js 审查补丁 |
| `packages/local-store` | 八个 IndexedDB Store、租约、分支、备份与只读恢复 |
| `tests/fixtures` | 无真实用户资料的可公开合成样本 |

设计基线：[docs/plan.md](docs/plan.md)。实施与剩余验收：[docs/acceptance.md](docs/acceptance.md)。
部署：[docs/deployment.md](docs/deployment.md)（含 [连接 Git 仓库自动部署](docs/deployment.md#连接-git-仓库自动部署)）。备份恢复：[docs/storage.md](docs/storage.md)。
PDF 补丁：[docs/pdf-review.md](docs/pdf-review.md)。Gateway 核对：[docs/gateway-contract.md](docs/gateway-contract.md)。

Key 不写入本机数据库、备份或服务端日志。历史与备份未加密；发送内容经过 Cloudflare、Gateway 和模型服务。关闭页面不保证继续生成，重试必须由用户明确发起，可能再次消耗额度。
