import { precheckFile, isImage } from './preflight';
import { parseText } from './text';
import { parseDocx } from './docx';
import { normalizeImage } from './images';
import {
  FILE_POLICY_VERSION,
  PARSER_VERSION,
  sha256,
  LIMITS,
  ReviewError,
  type Features,
  type ReviewedArtifact,
  type TaskContext,
} from './types';
export * from './types';
export * from './preflight';
export async function reviewBytes(
  file: Pick<File, 'name' | 'size' | 'type'>,
  bytes: Uint8Array,
  context: TaskContext,
  features: Features = {},
): Promise<ReviewedArtifact> {
  const format = precheckFile(file, features);
  if (bytes.length !== file.size) throw new ReviewError('document_unverifiable');
  const source = new Blob([bytes.slice().buffer], {
      type: file.type || 'application/octet-stream',
    }),
    sourceSha256 = await sha256(bytes);
  context.progress('parsing');
  context.check();
  const parsed = isImage(format)
    ? await normalizeImage(bytes, format, context)
    : format === 'docx'
      ? parseDocx(bytes, context)
      : format === 'pdf'
        ? await (await import('./pdf')).parsePdf(bytes, context)
        : parseText(bytes, format);
  context.check();
  const normalized =
    parsed.normalized ?? new Blob([parsed.text ?? ''], { type: 'text/plain;charset=utf-8' });
  if (
    (isImage(format) && normalized.size > LIMITS.outputImage) ||
    (!isImage(format) && normalized.size > LIMITS.text)
  )
    throw new ReviewError('extracted_text_too_large');
  const normalizedSha256 = await sha256(normalized),
    confirmationKey = `${sourceSha256}:${normalizedSha256}:${FILE_POLICY_VERSION}:${PARSER_VERSION}`;
  return {
    kind: isImage(format) ? 'image' : 'text',
    format,
    name: file.name,
    source,
    normalized,
    text: parsed.text,
    mime: parsed.mime ?? 'text/plain',
    width: parsed.width,
    height: parsed.height,
    sourceSha256,
    normalizedSha256,
    policyVersion: FILE_POLICY_VERSION,
    parserVersion: PARSER_VERSION,
    metrics: { ...parsed.metrics, sourceBytes: source.size, normalizedBytes: normalized.size },
    warnings: parsed.warnings,
    requiresConfirmation: parsed.warnings.length > 0,
    confirmationKey,
  };
}
