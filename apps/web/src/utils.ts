import { isErrorCode, safeError } from '@chat/contracts';
import type { ReviewedArtifact } from '@chat/file-review';
import type { AttachmentInput } from '@chat/local-store';

const messages: Record<string, string> = {
  unsupported_file_type: '暂不支持此文件格式，请转为已支持的格式。',
  file_type_mismatch: '文件内容与格式不一致，请重新导出原文件。',
  file_too_large: '原文件超过该格式大小上限，请在本地拆分或缩小。',
  attachment_batch_too_large: '一次最多 4 个附件（其中图片 2 张），总计 20 MiB。',
  document_too_many_pages: 'PDF 超过 40 页，请拆分需要分析的部分。',
  document_too_complex: '文档结构超过处理范围，请导出简化文字版。',
  archive_expansion_limit: '文档解压后超过处理上限，请重新导出精简 DOCX。',
  encrypted_document: '暂不处理加密文档，请使用有权访问的未加密副本。',
  active_content_not_allowed: '文档包含宏、脚本、嵌入对象或其他主动内容，请导出普通文字版。',
  document_requires_ocr: '缺少足够可提取文字，请先在本地 OCR 或导出文字版。',
  document_unverifiable: '无法完成文件结构检查，请重新导出文字版。',
  extracted_text_too_large: '提取文字超过 192 KiB，或本批文档合计超过 384 KiB，请拆分相关章节。',
  document_parse_timeout: '文件在 15 秒内未完成检查，任务已终止，请简化文件后重试。',
  document_parse_failed: '文件无法可靠读取，请重新导出。',
  image_dimensions_exceeded: '图片像素过大，请先在本地缩小或裁剪。',
  image_normalization_failed: '无法转换为可发送图片，请重新导出 JPEG / PNG。',
  local_storage_full: '本机存储空间不足。已停止生成，请导出未保存内容或备份后清理。',
  storage_unavailable: '本机存储不可用，历史未被清空。可导出当前内容或选择临时文字聊天。',
  storage_conflict: '会话已在另一标签页更改，请重新打开后再发送。',
  conversation_busy: '此会话正在另一标签页生成，请等待或使用新会话。',
  attachment_missing: '附件原件或提取结果缺失，请重新添加或明确移除上下文引用。',
  attachment_needs_review: '附件需要重新检查和确认后才能发送。',
  invalid_backup: '备份结构、校验值或引用不完整，未覆盖已有历史。',
  backup_too_large: '备份超过 100 MiB 或条目上限，请按会话拆分。',
  cancelled: '已取消。',
  offline: '当前离线，仍可查看本机历史。连接恢复后请手动发送。',
};
export function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : error instanceof DOMException && error.name === 'AbortError'
      ? 'cancelled'
      : 'upstream_error';
}
export function errorMessage(error: unknown): string {
  const code = typeof error === 'string' ? error : errorCode(error);
  return (
    messages[code] ??
    (isErrorCode(code) ? safeError(code).error.message : '操作未完成，请保留内容后手动重试。')
  );
}
export function formatBytes(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function toAttachmentInput(artifact: ReviewedArtifact, confirmed: boolean): AttachmentInput {
  return {
    name: artifact.name,
    kind: artifact.kind,
    source: artifact.source,
    normalized: artifact.normalized,
    text: artifact.text,
    mimeType: artifact.mime,
    sourceSha256: artifact.sourceSha256,
    normalizedSha256: artifact.normalizedSha256,
    policyVersion: artifact.policyVersion,
    parserVersion: artifact.parserVersion,
    losses: artifact.warnings,
    confirmed,
  };
}
export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
