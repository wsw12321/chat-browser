# 可执行策略与错误码

`packages/contracts/src/policy.ts` 是公开策略定义，`GET /api/config` 返回其完整内容。请求契约为 1，初版文件策略为 `file-policy-v1`。前端附件审查和 Worker 都执行实际字节检查；浏览器通过状态不能绕过边缘校验。

| 边界 | 上限 |
| --- | --- |
| 一次添加 | 4 文件 / 2 图片 / 20 MiB |
| TXT/MD/JSON、CSV、PDF、DOCX、图片原件 | 1、2、8、5、8 MiB |
| 原图 | 最长边 8192 / 1200 万像素 |
| 规范化图片 | JPEG/PNG / 最长边 2048 / 单图 1 MiB |
| 单文档、整批提取文字 | 192、384 KiB |
| PDF | 40 页 / 单页 20000 文字项 / 合计 100000 文字项 |
| PDF 结构审查 | 50000 访问预算 / 深度 64 |
| DOCX ZIP | 512 条目 / 展开 32 MiB / 单条目 8 MiB / 压缩比 100:1 |
| DOCX XML/表格/图片 | 深度 64、200000 事件 / 50 表与 5000 单元格 / 8 图与 4 MiB |
| JSON 文档 | 深度 32 |
| CSV | 2000 行 / 50 列 / 50000 非空单元格 / 单元格 8 KiB |
| API 入站与重建 | 各 4 MiB / JSON 深度 16 / 拒绝重复键 |
| 整轮上下文 | 80 消息 / 128 块 / 480 KiB 文字 / 2 图 |
| 当前问题 | 一个非空普通文字块 / 32 KiB |
| 响应 | 16 MiB 流 / 4 MiB 单事件 / 512 KiB 可见文字 |
| 解析超时 | 单文件 15 秒 / PDF 单页 2 秒 |
| 网络超时 | 模型查询 10 秒 / 入站读取 30 秒 / 生成响应头 100 秒 / 上游字节空闲 120 秒 / 总生成 10 分钟 |
| 存储与备份 | 本机 200 MiB 预算（含 20% 余量） / 单备份 100 MiB、2000 条目 |

`packages/contracts/src/errors.ts` 为 HTTP 与 SSE 固定错误映射；`packages/file-review/src/types.ts` 为审查拒绝码；`apps/web/src/utils.ts` 提供中文处理提示。

| 类别 | 错误码 |
| --- | --- |
| 契约/输入 | `invalid_request`, `invalid_json`, `invalid_utf8`, `invalid_image`, `request_too_large` |
| 认证/权限 | `unauthorized`, `forbidden`, `model_not_allowed`, `origin_denied` |
| 版本/配置 | `policy_outdated`, `configuration_error` |
| 额度/容量 | `rate_limited`, `insufficient_quota`, `edge_busy`, `request_spool_busy` |
| 上游/流 | `upstream_error`, `upstream_timeout`, `upstream_reauthentication_required`, `stream_invalid`, `unsupported_response_item`, `response_too_large`, `interrupted`, `response_incomplete`, `cancelled` |
| 文件入口 | `unsupported_file_type`, `file_type_mismatch`, `file_too_large`, `attachment_batch_too_large` |
| 文档检查 | `document_too_many_pages`, `document_too_complex`, `archive_expansion_limit`, `encrypted_document`, `active_content_not_allowed`, `document_requires_ocr`, `document_unverifiable`, `extracted_text_too_large`, `document_parse_timeout`, `document_parse_failed` |
| 图片 | `image_dimensions_exceeded`, `image_normalization_failed` |
| 本机恢复 | `local_storage_full`, `storage_unavailable`, `storage_conflict`, `conversation_busy`, `attachment_missing`, `attachment_needs_review`, `invalid_backup`, `backup_too_large` |

错误采用 `{error:{code,message,requestId,gatewayRequestId,retryable}}`。`retryable` 表示用户可手动决定是否重试，应用从不自动重发生成。未知上游信息映射为固定提示，不向页面传递原始错误正文；开始 SSE 后以 `webchat.error` 结束。
