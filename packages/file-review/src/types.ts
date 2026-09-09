export const FILE_POLICY_VERSION = 'file-policy-v1';
export const PARSER_VERSION = 'review-v1/pdfjs-6.3.289-review1/fflate-0.8.3/saxes-6.0.0/papa-5.5.3';
export const LIMITS = Object.freeze({
  batchFiles: 4,
  batchImages: 2,
  batchBytes: 20 * 1024 ** 2,
  textFile: 1024 ** 2,
  csvFile: 2 * 1024 ** 2,
  pdfFile: 8 * 1024 ** 2,
  docxFile: 5 * 1024 ** 2,
  imageFile: 8 * 1024 ** 2,
  text: 192 * 1024,
  batchText: 384 * 1024,
  jsonDepth: 32,
  csvRows: 2000,
  csvColumns: 50,
  csvCells: 50000,
  csvCellBytes: 8 * 1024,
  zipEntries: 512,
  zipTotal: 32 * 1024 ** 2,
  zipEntry: 8 * 1024 ** 2,
  zipRatio: 100,
  xmlDepth: 64,
  xmlEvents: 200000,
  tables: 50,
  tableCells: 5000,
  mediaCount: 8,
  mediaBytes: 4 * 1024 ** 2,
  pdfPages: 40,
  pdfPageItems: 20000,
  pdfItems: 100000,
  imageSide: 8192,
  imagePixels: 12000000,
  outputSide: 2048,
  outputImage: 1024 ** 2,
  totalMs: 15000,
  pdfPageMs: 2000,
});
export type Format = 'txt' | 'md' | 'json' | 'csv' | 'pdf' | 'docx' | 'jpeg' | 'png' | 'webp';
export type ReviewErrorCode =
  | 'unsupported_file_type'
  | 'file_type_mismatch'
  | 'file_too_large'
  | 'attachment_batch_too_large'
  | 'document_too_many_pages'
  | 'document_too_complex'
  | 'archive_expansion_limit'
  | 'encrypted_document'
  | 'active_content_not_allowed'
  | 'document_requires_ocr'
  | 'document_unverifiable'
  | 'extracted_text_too_large'
  | 'document_parse_timeout'
  | 'document_parse_failed'
  | 'image_dimensions_exceeded'
  | 'image_normalization_failed'
  | 'cancelled';
export class ReviewError extends Error {
  constructor(public readonly code: ReviewErrorCode) {
    super(code);
    this.name = 'ReviewError';
  }
}
export interface Features {
  pdf?: boolean;
  docx?: boolean;
  images?: boolean;
}
export interface ReviewProgress {
  taskId: string;
  stage: 'prechecking' | 'parsing' | 'normalizing';
  completed?: number;
  total?: number;
}
export interface ReviewedArtifact {
  kind: 'text' | 'image';
  format: Format;
  name: string;
  source: Blob;
  normalized: Blob;
  text?: string;
  mime: string;
  sourceSha256: string;
  normalizedSha256: string;
  policyVersion: string;
  parserVersion: string;
  metrics: Record<string, number>;
  width?: number;
  height?: number;
  warnings: string[];
  requiresConfirmation: boolean;
  confirmationKey: string;
}
export interface ParsedArtifact {
  text?: string;
  normalized?: Blob;
  mime?: string;
  width?: number;
  height?: number;
  metrics: Record<string, number>;
  warnings: string[];
}
export interface TaskContext {
  progress(stage: ReviewProgress['stage'], completed?: number, total?: number): void;
  resources: Set<() => void | Promise<void>>;
  check(): void;
  pageStarted?(page: number): void;
  pageFinished?(): void;
}
export interface ReviewOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ReviewProgress) => void;
  features?: Features;
}
export const utf8Size = (value: string): number => new TextEncoder().encode(value).byteLength;
export function ensureText(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (utf8Size(normalized) > LIMITS.text) throw new ReviewError('extracted_text_too_large');
  return normalized;
}
export async function sha256(bytes: Uint8Array | Blob): Promise<string> {
  const input = bytes instanceof Blob ? await bytes.arrayBuffer() : bytes.slice().buffer;
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
export function failure(error: unknown): ReviewError {
  return error instanceof ReviewError ? error : new ReviewError('document_parse_failed');
}
