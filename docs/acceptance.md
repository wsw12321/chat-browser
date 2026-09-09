# 实施与验收记录

日期：2026-09-09。本记录区分自动化证据与尚未完成的外部验收。设计规范 `docs/plan.md` 保留为原始基线。

## 已实现

| 阶段 | 实现与可复核入口 |
| --- | --- |
| 准备 | pnpm workspace、严格 TS、React/Vite、Workers 静态资源、统一策略、固定依赖锁、模拟 Gateway、CI |
| P0-A | 档案/内存 Key/模型交集、会话 CRUD、手动重试分支、事务占位、流式定期保存、停止/超时、租约互斥、离线历史、临时文字聊天 |
| P0-B | TXT/MD/JSON/CSV、JPEG/PNG/静态 WebP、批次预检、单队列、任务销毁、提取确认、同产物预览发送、上下文去重与起点选择、缺失附件阻止 |
| P0-C | PDF.js 原始结构只读审查补丁、逐页受限文字提取、OCR 判定；DOCX ZIP 头/目录/CRC/实际展开量、受限 XML 和文字/简单表格 |
| P0-D | 八个 Store、档案内 Blob 去重、GC、应用预算、Store ZIP 标准备份、重新审查、分批暂存发布、ID 重映射、只读恢复、跨标签页通知 |
| P0-E | 已部署 Cloudflare Workers Free 自定义域名、静态安全头、IP 平台限流、日志关闭、真实联调脚本；真实模型与资源边界验收仍待完成 |

## 自动验证

准确的最终测试数量和执行环境见本文件末尾的最终运行记录；测试代码而非此表描述决定实际覆盖。

- `packages/contracts/test`、`apps/edge/test`：严格 JSON/UTF-8、重复键、实际请求计数、重建后才超限、认证在解析之前、未知字段、模型交集、图片二次检查、并发许可释放、重定向、SSE 分块/对账/终止/超限/取消。拒绝样本生成调用为零。
- `packages/file-review/test`：74 项附件测试（该数值为格式模块提交时结果）；包含 PDF 原始 OpenAction/Next/AA/结构树附件/批注/表单、40/41 页、交叉引用恢复拒绝、ZIP/CRC/XML、UTF-8/CSV、动画/尺寸/重编码及宿主任务销毁。阈值拒绝使用小样本和降低后的测试限制，不耗尽宿主内存。
- `packages/local-store/test`、`tests/unit/context.test.ts`：档案隔离、事务、预算错误、租约、回收、备份哈希/CRC/引用/父链、暂存清理、只读更高 Schema、附件快照原子绑定、上下文起点保留附件。
- `apps/edge/test/runtime.workers.test.ts`：真实 workerd 的入口、认证转发、SSE 取消链路；不使用 Node mock 代替此层。
- `tests/e2e/chat.spec.ts`：Chromium 中的两轮聊天、发送前落盘、Key 不持久化、离线打开、TXT/PDF/DOCX/PNG、预览与发送一致、停止、双标签页、备份往返、XSS/外部图片、手机视口、错误、配额故障注入、策略变化、50 次导入移除、只读与临时模式、刷新恢复。

合成样本位于 `tests/fixtures`。本地依赖漏洞审计先发现 fflate 0.8.2 的 ZIP64 `unzipSync` 问题及开发依赖 sharp/libheif 问题；更新至 fflate 0.8.3，并锁定 sharp 0.35.4 后，审计报告为零已知漏洞。未调用 `unzipSync` 不作为保留旧版本的理由。

## 已明确的保守规则与修正

- 首版公开策略补充 `pdfStructureNodes=50000`、`pdfStructureDepth=64`，对应固定 PDF 补丁的可达对象审查预算；这些是本项目限制，不是 PDF.js 的承诺。
- DOCX 拒绝合并单元格、隐藏文字、字段代码、内容控件、备用表示、无法完整提取的复杂结构，返回具体拒绝码，不能静默丢失文字。
- PDF 缺少可验证结构或必要内嵌映射资源时拒绝。所有 PDF 和图片规范化结果都需要预览确认。
- 新鲜源码核对发现 Gateway 的 4 MiB 常量用于使用量观察，不构成线上 SSE 事件硬拒绝。网站自己的 4 MiB 事件限制独立生效，详见 `gateway-contract.md`。
- 当前没有可声称“已通过”的真实模型能力表。`mock-text` / `mock-vision` 仅存在于本地配置。

## 未完成的发布门槛

以下不能由当前本机自动测试替代，也没有伪造通过记录：

| 待验收项 | 所需外部条件 |
| --- | --- |
| Workers Free 的实际 CPU 负载与分布式限流 | 已部署账户、真实请求与平台观测；网站与公开配置已可访问 |
| 两轮文字、图片续问、PDF/DOCX、长回复、停止、额度不足、工具自动注入/usage | 固定 Gateway 来源、专用低额度 Key、实际模型集合 |
| 停止后 Gateway 租约与额度结算释放 | Gateway 运行实例和只含安全元数据的观测 |
| 桌面 Chrome/Edge/Firefox/Safari、iOS Safari、Android Chrome | 实际设备和准确稳定版本；Playwright Chromium/手机视口不能替代设备矩阵 |
| 4 MiB 边界、并发长流、接近 200 MiB 历史、低内存设备 | 可丢弃的实测环境与资源采集 |
| 所有格式全量容量 ±1、真实 OOM/后台冻结/站点升级链路 | 可丢弃浏览器与发布环境；目前自动测试只覆盖已列出的合成资源分支 |

因此当前交付状态是可运行实现、本机验证与 Workers Free 部署，**完整 P0-A 至 P0-E 验收尚未完成**。关闭未验收开关不替代这些门槛。

## 初版本地运行记录

执行环境为 Ubuntu 24.04.4 LTS、Node.js 24.16.0、pnpm 11.18.0。Chromium 为 Google Chrome for Testing **153.0.8010.12**，Playwright **1.63.0**，桌面视口和 390×844 手机视口；不是实际手机或 Safari/Edge 验收。

| 最终检查 | 结果 |
| --- | --- |
| `pnpm check` | TypeScript strict 通过；10 个测试文件 **150/150** 通过；生产构建成功 |
| `vitest run --config vitest.workers.config.ts` | 原生 workerd **3/3** 通过 |
| `playwright test` | Chromium **18/18** 通过，49.6 秒；生成过程中存储失败也会取消并保留可下载内存结果 |
| 干净目录离线冻结安装 | `/tmp` 独立源码副本中 `pnpm install --offline --frozen-lockfile` 成功；**27/27** PDF 补丁测试通过，随后构建成功 |
| `wrangler deploy --dry-run` | Wrangler 4.130.0 配置接受，Worker 788.14 KiB / gzip 125.75 KiB；没有正式上传或部署 |
| 最终 `pnpm audit --json` | 0 条已知漏洞；原始安全报告位于 `docs/reports/dependency-audit.json` |
| 本机重复导入 | 50 次小型 TXT 导入/移除约 6.2 秒；完成时活动解析 Worker=0、未引用 Blob=0。未测进程峰值内存，不等于容量极限验收 |
| 刷新恢复 | 慢流刷新用例约 16.7 秒完成失效租约恢复；没有再次生成 |

最终静态构建约 2.3 MiB。主入口 387.70 kB（gzip 118.71 kB），Markdown 按需块 115.89 kB；PDF 解析块约 1.63 MB，位于独立 Worker 路径，未放入主页面执行。大小为构建工具报告的十进制 kB；产品限额仍采用二进制 KiB/MiB。

受此执行环境限制，Chromium 浏览器、缺少的动态库及中文字体下载到 `/tmp`，没有更改系统包；运行使用 `PLAYWRIGHT_BROWSERS_PATH`、`LD_LIBRARY_PATH`、`FONTCONFIG_FILE`。标准 Ubuntu CI 使用 Playwright `install --with-deps chromium`。Wrangler/workerd 使用本机回环监听，测试没有调用真实 Gateway 或付费模型。CI 配置已交付，尚未在外部 GitHub Actions 账户运行。

## 2026-09-09 Workers Free 部署记录

站点：[chat.water555.com](https://chat.water555.com)。Worker：`chat-browser`。最终版本：`af3ef777-ba3e-4ed6-95cb-ba2f249b54f9`。

当前配置使用 Workers Free 默认 CPU 限额，保留 30 次/60 秒的 IP 限流绑定，关闭 `workers.dev` 与预览 URL。默认 Gateway 为 `https://codex.water555.com`；模型按提供的版本名称配置 `gpt-5.5`、`gpt-5.6`、`gpt-6`，图片能力开启。文本和图片附件已启用，PDF/DOCX 暂关闭。

| 检查 | 本次结果 |
| --- | --- |
| `pnpm check` | 类型检查、11 个测试文件 **182/182** 单测与生产构建通过 |
| `pnpm test:workers` | 原生 workerd **3/3** 通过 |
| `pnpm test:e2e` | Chromium **19/19** 通过，约 3.2 分钟 |
| 部署预检与正式上传 | Wrangler 4.130.0 接受配置；Worker 790.73 KiB / gzip 126.49 KiB，限流绑定与自定义域名发布成功 |
| HTTPS 与公开配置 | 首页、`/api/config` 均返回 200，Gateway 与附件开关正确 |
| API 边界 | 无 Key 的 `/api/models` 返回 401，错误 Origin 返回 403，未知 API 返回 JSON 404；均为 `no-store` |
| 静态资源 | 五个 JS/CSS/解析构建资源的 SHA-256 与本机构建一致，离线清单和 Service Worker 内容一致 |
| 安全头 | 主页 CSP 与 `nosniff` 生效，解析资源附加 `connect-src 'none'`；HTML 的 `no-transform` 阻止自动 Analytics Beacon 注入 |
| 线上 Chromium | 全新上下文成功创建本机档案，默认 Gateway 正确，Key 为空且显示未连接；无控制台错误、JS 异常或失败请求 |

未提供真实 Gateway Key，本次未执行真实模型生成或图片识别。精确模型 ID、用户模型权限、图片能力、停止后的计费释放和 Free CPU 限额下的大附件/长回复表现仍待验证；以上部署结果不替代完整 P0 验收。
