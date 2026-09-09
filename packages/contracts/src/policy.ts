export const KiB = 1024;
export const MiB = 1024 * KiB;
export const APP_CONTRACT_VERSION = 1 as const;
export const POLICY_VERSION = 'file-policy-v1' as const;

export const POLICY = Object.freeze({
  files: {
    batchCount: 4,
    batchImages: 2,
    batchBytes: 20 * MiB,
    textBytes: MiB,
    csvBytes: 2 * MiB,
    pdfBytes: 8 * MiB,
    docxBytes: 5 * MiB,
    imageBytes: 8 * MiB,
    imageSide: 8192,
    imagePixels: 12_000_000,
    nameCharacters: 200,
    concurrency: 1,
  },
  parsing: {
    documentTextBytes: 192 * KiB,
    batchTextBytes: 384 * KiB,
    jsonDepth: 32,
    csvRows: 2000,
    csvColumns: 50,
    csvCells: 50_000,
    csvCellBytes: 8 * KiB,
    pdfPages: 40,
    pdfPageItems: 20_000,
    pdfTotalItems: 100_000,
    pdfStructureNodes: 50_000,
    pdfStructureDepth: 64,
    zipEntries: 512,
    zipExpandedBytes: 32 * MiB,
    zipEntryBytes: 8 * MiB,
    zipRatio: 100,
    xmlDepth: 64,
    xmlNodes: 200_000,
    docxTables: 50,
    docxCells: 5000,
    docxImages: 8,
    docxMediaBytes: 4 * MiB,
    imageSide: 2048,
    imageBytes: MiB,
  },
  request: {
    bytes: 4 * MiB,
    depth: 16,
    messages: 80,
    blocks: 128,
    textBlockBytes: 192 * KiB,
    questionBytes: 32 * KiB,
    textBytes: 480 * KiB,
    images: 2,
    imageBytes: MiB,
    imageSide: 2048,
    imagePixels: 4_194_304,
    targetTokens: 32_768,
    modelResponseBytes: MiB,
    errorResponseBytes: 16 * KiB,
    headerBytes: 16 * KiB,
    activePermits: 4,
    parsingPermits: 2,
  },
  response: { bytes: 16 * MiB, eventBytes: 4 * MiB, textBytes: 512 * KiB },
  timeouts: {
    fileMs: 15_000,
    pdfPageMs: 2000,
    modelsMs: 10_000,
    uploadMs: 30_000,
    headersMs: 100_000,
    idleMs: 120_000,
    generationMs: 600_000,
    heartbeatMs: 15_000,
  },
  storage: { budgetBytes: 200 * MiB, streamSaveMs: 500, schemaVersion: 1 },
});

export type AttachmentState =
  | 'selected'
  | 'prechecking'
  | 'parsing'
  | 'awaiting_confirmation'
  | 'ready'
  | 'stale'
  | 'rejected'
  | 'cancelled';
const transitions: Record<AttachmentState, readonly AttachmentState[]> = {
  selected: ['prechecking', 'cancelled'],
  prechecking: ['parsing', 'rejected', 'cancelled'],
  parsing: ['awaiting_confirmation', 'ready', 'rejected', 'cancelled'],
  awaiting_confirmation: ['ready', 'rejected', 'cancelled'],
  ready: ['stale'],
  stale: ['prechecking', 'cancelled'],
  rejected: [],
  cancelled: [],
};
export function canTransitionAttachment(from: AttachmentState, to: AttachmentState): boolean {
  return transitions[from].includes(to);
}
export type GenerationState =
  'pending' | 'streaming' | 'completed' | 'failed' | 'incomplete' | 'interrupted' | 'cancelled';
export interface ModelCapability {
  id: string;
  images: boolean;
}
export interface PublicConfig {
  gatewayUrl?: string;
  schemaVersion: number;
  policyVersion: string;
  policy: typeof POLICY;
  features: { pdf: boolean; docx: boolean; images: boolean };
}
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
export function validFilename(value: string): boolean {
  return (
    [...value].length > 0 &&
    [...value].length <= POLICY.files.nameCharacters &&
    !/[\u0000-\u001f\u007f-\u009f/\\\u202a-\u202e\u2066-\u2069]/u.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}
