export const DATABASE_VERSION = 1;
export const BACKUP_VERSION = 1;
export const APPLICATION_BUDGET = 200 * 1024 * 1024;
export const BACKUP_LIMIT = 100 * 1024 * 1024;
export const RECORD_LIMIT = 4 * 1024 * 1024;
export const LEASE_MS = 15_000;
export type GenerationStatus =
  'preparing' | 'streaming' | 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'incomplete';
export interface ScopedRecord {
  profileId: string;
  stageId?: string;
}
export interface Profile {
  id: string;
  profileId: string;
  name: string;
  createdAt: number;
}
export interface Conversation extends ScopedRecord {
  id: string;
  title: string;
  model: string;
  currentLeafId: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface Message extends ScopedRecord {
  id: string;
  conversationId: string;
  parentId: string | null;
  role: 'user' | 'assistant';
  text: string;
  attachmentIds: string[];
  attemptId: string;
  status: GenerationStatus;
  createdAt: number;
}
export interface Attachment extends ScopedRecord {
  id: string;
  name: string;
  mimeType: string;
  kind: 'text' | 'image';
  sourceSize: number;
  sourceSha256: string;
  normalizedSha256: string;
  policyVersion: string;
  parserVersion: string;
  status: 'ready' | 'needs_review';
  createdAt: number;
}
export interface BlobRecord extends ScopedRecord {
  sha256: string;
  blob: Blob;
  size: number;
}
export interface Extraction extends ScopedRecord {
  attachmentId: string;
  policyVersion: string;
  parserVersion: string;
  normalizedSha256: string;
  text?: string;
  losses: string[];
  confirmed: boolean;
  confirmationKey: string;
}
export interface GenerationRun extends ScopedRecord {
  id: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  ownerId: string;
  model: string;
  status: GenerationStatus;
  startedAt: number;
  updatedAt: number;
  requestId?: string;
  gatewayRequestId?: string;
  responseId?: string;
  usage?: Record<string, number>;
  errorCode?: string;
}
export interface Setting extends ScopedRecord {
  key: string;
  value: unknown;
}
export interface AttachmentInput {
  name: string;
  source: Blob;
  normalized: Blob;
  text?: string;
  mimeType: string;
  sourceSha256: string;
  normalizedSha256: string;
  policyVersion: string;
  parserVersion: string;
  losses: string[];
  confirmed: boolean;
  kind: 'text' | 'image';
}
export interface AttachmentBinding {
  id: string;
  sourceSha256: string;
  normalizedSha256: string;
  policyVersion: string;
  parserVersion: string;
}
export interface PrepareGenerationInput {
  profileId: string;
  conversationId: string;
  model: string;
  text: string;
  attachmentIds: string[];
  parentId?: string | null;
  expectedRevision?: number;
  ownerId: string;
  attachmentBindings?: AttachmentBinding[];
}
export interface GenerationUpdate {
  text: string;
  status: GenerationStatus;
  responseId?: string;
  requestId?: string;
  gatewayRequestId?: string;
  usage?: Record<string, number>;
  errorCode?: string;
}
export interface ConversationLease {
  ownerId: string;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}
export interface Usage {
  knownBytes: number;
  reservedBytes: number;
  budgetBytes: number;
  warning: boolean;
}
export interface ImportOptions {
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
  review?: (source: Blob, attachment: Attachment, signal?: AbortSignal) => Promise<AttachmentInput>;
}
export class StorageError extends Error {
  constructor(
    public readonly code:
      | 'local_storage_full'
      | 'storage_unavailable'
      | 'storage_conflict'
      | 'conversation_busy'
      | 'attachment_missing'
      | 'attachment_needs_review'
      | 'invalid_backup'
      | 'backup_too_large'
      | 'cancelled',
    message = code,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}
