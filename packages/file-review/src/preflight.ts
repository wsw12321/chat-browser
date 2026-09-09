import { LIMITS, ReviewError, type Features, type Format } from './types';
const extensions: Record<string, Format> = {
  txt: 'txt',
  md: 'md',
  markdown: 'md',
  json: 'json',
  csv: 'csv',
  pdf: 'pdf',
  docx: 'docx',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  webp: 'webp',
};
const media: Record<Format, string[]> = {
  txt: ['text/plain'],
  md: ['text/plain', 'text/markdown', 'text/x-markdown'],
  json: ['application/json', 'text/json'],
  csv: ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'],
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  jpeg: ['image/jpeg'],
  png: ['image/png'],
  webp: ['image/webp'],
};
export function isImage(format: Format): boolean {
  return format === 'jpeg' || format === 'png' || format === 'webp';
}
export function precheckFile(
  file: Pick<File, 'name' | 'size' | 'type'>,
  features: Features = {},
): Format {
  if (
    !file.name ||
    [...file.name].length > 200 ||
    /[\u0000-\u001f\u007f-\u009f\/\\\u202a-\u202e\u2066-\u2069]/u.test(file.name)
  )
    throw new ReviewError('file_type_mismatch');
  const format = extensions[file.name.split('.').at(-1)?.toLowerCase() ?? ''];
  if (
    !format ||
    (format === 'pdf' && features.pdf === false) ||
    (format === 'docx' && features.docx === false) ||
    (isImage(format) && features.images === false)
  )
    throw new ReviewError('unsupported_file_type');
  if (
    file.type &&
    file.type !== 'application/octet-stream' &&
    !media[format].includes(file.type.toLowerCase())
  )
    throw new ReviewError('file_type_mismatch');
  const max = isImage(format)
    ? LIMITS.imageFile
    : format === 'pdf'
      ? LIMITS.pdfFile
      : format === 'docx'
        ? LIMITS.docxFile
        : format === 'csv'
          ? LIMITS.csvFile
          : LIMITS.textFile;
  if (!Number.isSafeInteger(file.size) || file.size < 1)
    throw new ReviewError('document_parse_failed');
  if (file.size > max) throw new ReviewError('file_too_large');
  return format;
}
export function precheckBatch(
  files: readonly Pick<File, 'name' | 'size' | 'type'>[],
  features: Features = {},
): void {
  if (
    files.length > LIMITS.batchFiles ||
    files.reduce((sum, f) => sum + f.size, 0) > LIMITS.batchBytes
  )
    throw new ReviewError('attachment_batch_too_large');
  // Unsupported individual files are handled independently; only count recognizable images here.
  if (
    files.filter((file) =>
      isImage(extensions[file.name.split('.').at(-1)?.toLowerCase() ?? ''] as Format),
    ).length > LIMITS.batchImages
  )
    throw new ReviewError('attachment_batch_too_large');
  void features;
}
