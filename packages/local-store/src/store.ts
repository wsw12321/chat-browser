import { openDB, type IDBPDatabase, type DBSchema, type IDBPTransaction } from 'idb';
import {
  APPLICATION_BUDGET,
  DATABASE_VERSION,
  LEASE_MS,
  StorageError,
  type Profile,
  type Conversation,
  type Message,
  type Attachment,
  type BlobRecord,
  type Extraction,
  type GenerationRun,
  type Setting,
  type AttachmentInput,
  type PrepareGenerationInput,
  type GenerationUpdate,
  type ConversationLease,
  type Usage,
  type ImportOptions,
} from './types';
import { exportBackup, importBackup } from './backup';

export interface ChatDB extends DBSchema {
  profiles: { key: string; value: Profile };
  conversations: {
    key: string;
    value: Conversation;
    indexes: { profile: string; updated: [string, number] };
  };
  messages: {
    key: string;
    value: Message;
    indexes: { profile: string; conversation: [string, string, number] };
  };
  attachments: {
    key: string;
    value: Attachment;
    indexes: { profile: string; source: [string, string] };
  };
  blobs: { key: [string, string]; value: BlobRecord; indexes: { profile: string } };
  extractions: {
    key: [string, string, string, string];
    value: Extraction;
    indexes: { profile: string };
  };
  generationRuns: {
    key: string;
    value: GenerationRun;
    indexes: { profile: string; conversation: [string, string] };
  };
  settings: { key: [string, string]; value: Setting; indexes: { profile: string } };
}
export const STORES = [
  'profiles',
  'conversations',
  'messages',
  'attachments',
  'blobs',
  'extractions',
  'generationRuns',
  'settings',
] as const;
type WriteTx = IDBPTransaction<ChatDB, (typeof STORES)[number][], 'readwrite'>;
const encoder = new TextEncoder();
export const utf8Size = (value: string): number => encoder.encode(value).byteLength;
export const isActive = (status: string): boolean =>
  status === 'preparing' || status === 'streaming';
export const confirmationKey = (
  value: Pick<Attachment, 'sourceSha256' | 'normalizedSha256' | 'policyVersion' | 'parserVersion'>,
): string =>
  [value.sourceSha256, value.normalizedSha256, value.policyVersion, value.parserVersion].join(':');
export async function sha256(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer();
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
const assertName = (name: string): void => {
  if (
    !name ||
    [...name].length > 200 ||
    /[\x00-\x1f\x7f-\x9f/\\\u202a-\u202e\u2066-\u2069]/u.test(name)
  )
    throw new StorageError('attachment_needs_review');
};
function mapStorageError(error: unknown): never {
  if (error instanceof StorageError) throw error;
  if (error instanceof DOMException && error.name === 'QuotaExceededError')
    throw new StorageError('local_storage_full');
  throw new StorageError('storage_unavailable');
}
function storedBytes(value: unknown): number {
  if (value && typeof value === 'object' && 'blob' in value) {
    const row = value as BlobRecord;
    return row.size + utf8Size(JSON.stringify({ ...row, blob: undefined }));
  }
  return utf8Size(JSON.stringify(value));
}
interface LeaseRecord {
  ownerId: string;
  expiresAt: number;
}
function parseLease(value: unknown): LeaseRecord | undefined {
  if (!value || typeof value !== 'object' || !('ownerId' in value) || !('expiresAt' in value))
    return undefined;
  return typeof value.ownerId === 'string' && typeof value.expiresAt === 'number'
    ? { ownerId: value.ownerId, expiresAt: value.expiresAt }
    : undefined;
}
function validateSetting(key: string, value: unknown): void {
  if (key === 'selectedModel' && typeof value === 'string' && value.length <= 200) return;
  if (key === 'persistentStorage' && typeof value === 'boolean') return;
  if (
    /^excludedAttachmentIds\/[a-zA-Z0-9-]+$/.test(key) &&
    Array.isArray(value) &&
    value.length <= 2000 &&
    value.every((id) => typeof id === 'string' && id.length <= 100)
  )
    return;
  if (
    /^contextStart\/[a-zA-Z0-9-]+$/.test(key) &&
    (value === null || (typeof value === 'string' && value.length <= 100))
  )
    return;
  throw new StorageError('storage_conflict');
}

export async function openLocalStore(
  options: {
    name?: string;
    budgetBytes?: number;
    onBlocked?: () => void;
    onVersionChange?: () => void;
    readOnlyOnVersionError?: boolean;
  } = {},
): Promise<ChatStore> {
  if (typeof indexedDB === 'undefined') throw new StorageError('storage_unavailable');
  let db: IDBPDatabase<ChatDB>;
  try {
    db = await openDB<ChatDB>(options.name ?? 'webchat-local', DATABASE_VERSION, {
      upgrade(database, oldVersion) {
        // Schema versions are append-only migrations. Never clear or rewrite user Blob stores.
        if (oldVersion < 1) {
          database.createObjectStore('profiles', { keyPath: 'id' });
          const conversations = database.createObjectStore('conversations', { keyPath: 'id' });
          conversations.createIndex('profile', 'profileId');
          conversations.createIndex('updated', ['profileId', 'updatedAt']);
          const messages = database.createObjectStore('messages', { keyPath: 'id' });
          messages.createIndex('profile', 'profileId');
          messages.createIndex('conversation', ['profileId', 'conversationId', 'createdAt']);
          const attachments = database.createObjectStore('attachments', { keyPath: 'id' });
          attachments.createIndex('profile', 'profileId');
          attachments.createIndex('source', ['profileId', 'sourceSha256']);
          database
            .createObjectStore('blobs', { keyPath: ['profileId', 'sha256'] })
            .createIndex('profile', 'profileId');
          database
            .createObjectStore('extractions', {
              keyPath: ['profileId', 'attachmentId', 'policyVersion', 'parserVersion'],
            })
            .createIndex('profile', 'profileId');
          const runs = database.createObjectStore('generationRuns', { keyPath: 'id' });
          runs.createIndex('profile', 'profileId');
          runs.createIndex('conversation', ['profileId', 'conversationId']);
          database
            .createObjectStore('settings', { keyPath: ['profileId', 'key'] })
            .createIndex('profile', 'profileId');
        }
      },
      blocked: options.onBlocked,
      blocking() {
        db?.close();
        options.onVersionChange?.();
      },
      terminated: options.onVersionChange,
    });
  } catch (error) {
    if (
      options.readOnlyOnVersionError &&
      error instanceof DOMException &&
      error.name === 'VersionError'
    )
      return openRecoveryStore(options);
    mapStorageError(error);
  }
  const store = new ChatStore(db!, options.budgetBytes ?? APPLICATION_BUDGET);
  await store.cleanupAbandonedImports();
  return store;
}

/** Open an existing, structurally compatible newer database without requesting a migration.
 * Recovery never creates a database, modifies rows, cleans stages, or changes the stored version.
 */
export async function openRecoveryStore(
  options: {
    name?: string;
    budgetBytes?: number;
    onBlocked?: () => void;
    onVersionChange?: () => void;
  } = {},
): Promise<ChatStore> {
  if (typeof indexedDB === 'undefined') throw new StorageError('storage_unavailable');
  let db: IDBPDatabase<ChatDB> | undefined;
  try {
    db = await openDB<ChatDB>(options.name ?? 'webchat-local', undefined, {
      upgrade(_database, _oldVersion, _newVersion, transaction) {
        transaction.abort();
      },
      blocked: options.onBlocked,
      blocking() {
        db?.close();
        options.onVersionChange?.();
      },
      terminated: options.onVersionChange,
    });
    for (const name of STORES)
      if (!db.objectStoreNames.contains(name)) throw new StorageError('storage_unavailable');
    const tx = db.transaction([...STORES], 'readonly');
    for (const name of STORES) {
      if (name !== 'profiles' && !tx.objectStore(name).indexNames.contains('profile'))
        throw new StorageError('storage_unavailable');
    }
    if (
      !tx.objectStore('messages').indexNames.contains('conversation') ||
      !tx.objectStore('generationRuns').indexNames.contains('conversation')
    )
      throw new StorageError('storage_unavailable');
    await tx.done;
    return new ChatStore(db, options.budgetBytes ?? APPLICATION_BUDGET, true);
  } catch (error) {
    db?.close();
    mapStorageError(error);
  }
}

export class ChatStore {
  readonly ownerId = crypto.randomUUID();
  private readonly channel: BroadcastChannel | null;
  constructor(
    readonly db: IDBPDatabase<ChatDB>,
    readonly budgetBytes = APPLICATION_BUDGET,
    readonly readOnly = false,
  ) {
    this.channel =
      typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`webchat:${db.name}`) : null;
  }
  close(): void {
    this.channel?.close();
    this.db.close();
  }
  subscribe(listener: () => void): () => void {
    const handler = (): void => listener();
    this.channel?.addEventListener('message', handler);
    return () => this.channel?.removeEventListener('message', handler);
  }
  notify(profileId: string): void {
    this.channel?.postMessage({ type: 'changed', profileId });
  }
  async transaction<T>(operation: (tx: WriteTx) => Promise<T>, checkBudget = true): Promise<T> {
    if (this.readOnly) throw new StorageError('storage_conflict');
    const tx = this.db.transaction([...STORES], 'readwrite');
    try {
      const result = await operation(tx);
      if (checkBudget) await this.assertBudget(tx);
      await tx.done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already rolled back or closed. */
      }
      await tx.done.catch(() => undefined);
      mapStorageError(error);
    }
  }
  private async assertBudget(tx: WriteTx): Promise<void> {
    let total = 0;
    for (const name of STORES) {
      let cursor = await tx.objectStore(name).openCursor();
      while (cursor) {
        total += storedBytes(cursor.value);
        cursor = await cursor.continue();
      }
    }
    if (Math.ceil(total * 1.2) > this.budgetBytes) throw new StorageError('local_storage_full');
  }
  async usage(): Promise<Usage> {
    const tx = this.db.transaction([...STORES], 'readonly');
    let knownBytes = 0;
    for (const name of STORES) {
      let cursor = await tx.objectStore(name).openCursor();
      while (cursor) {
        knownBytes += storedBytes(cursor.value);
        cursor = await cursor.continue();
      }
    }
    await tx.done;
    const reservedBytes = Math.ceil(knownBytes * 1.2);
    return {
      knownBytes,
      reservedBytes,
      budgetBytes: this.budgetBytes,
      warning: reservedBytes >= this.budgetBytes * 0.8,
    };
  }
  async listProfiles(): Promise<Profile[]> {
    return this.db.getAll('profiles');
  }
  async createProfile(name: string): Promise<Profile> {
    const id = crypto.randomUUID();
    const row: Profile = {
      id,
      profileId: id,
      name: name.trim().slice(0, 80) || '本机档案',
      createdAt: Date.now(),
    };
    await this.transaction(async (tx) => {
      await tx.objectStore('profiles').add(row);
    });
    this.notify(id);
    return row;
  }
  async deleteProfile(profileId: string): Promise<void> {
    const held =
      typeof navigator !== 'undefined' && navigator.locks?.query
        ? ((await navigator.locks.query()).held ?? [])
        : [];
    if (held.some((lock) => lock.name?.startsWith(`webchat:${this.db.name}:${profileId}:`)))
      throw new StorageError('conversation_busy');
    await this.transaction(async (tx) => {
      const settings = await tx.objectStore('settings').index('profile').getAll(profileId);
      if (
        settings.some(
          (row) =>
            (row.key.startsWith('lease/') || row.key.startsWith('import/')) &&
            (parseLease(row.value)?.expiresAt ?? 0) > Date.now(),
        )
      )
        throw new StorageError('conversation_busy');
      for (const name of STORES) {
        let cursor = await tx.objectStore(name).openCursor();
        while (cursor) {
          if (cursor.value.profileId === profileId) await cursor.delete();
          cursor = await cursor.continue();
        }
      }
    }, false);
    this.notify(profileId);
  }
  async listConversations(profileId: string): Promise<Conversation[]> {
    return (await this.db.getAllFromIndex('conversations', 'profile', profileId))
      .filter((row) => !row.stageId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async getConversation(profileId: string, id: string): Promise<Conversation | undefined> {
    const row = await this.db.get('conversations', id);
    return row?.profileId === profileId && !row.stageId ? row : undefined;
  }
  async createConversation(profileId: string, model = '', title = '新对话'): Promise<Conversation> {
    const row: Conversation = {
      id: crypto.randomUUID(),
      profileId,
      title: title.slice(0, 100),
      model,
      currentLeafId: null,
      revision: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.transaction(async (tx) => {
      if (!(await tx.objectStore('profiles').get(profileId)))
        throw new StorageError('storage_conflict');
      await tx.objectStore('conversations').add(row);
    });
    this.notify(profileId);
    return row;
  }
  async renameConversation(
    profileId: string,
    id: string,
    title: string,
    expectedRevision?: number,
  ): Promise<void> {
    await this.transaction(async (tx) => {
      const row = await tx.objectStore('conversations').get(id);
      if (
        !row ||
        row.profileId !== profileId ||
        row.stageId ||
        (expectedRevision !== undefined && row.revision !== expectedRevision)
      )
        throw new StorageError('storage_conflict');
      row.title = title.trim().slice(0, 100) || '新对话';
      row.revision++;
      row.updatedAt = Date.now();
      await tx.objectStore('conversations').put(row);
    });
    this.notify(profileId);
  }
  async deleteConversation(profileId: string, id: string): Promise<void> {
    const held =
      typeof navigator !== 'undefined' && navigator.locks?.query
        ? ((await navigator.locks.query()).held ?? [])
        : [];
    if (held.some((lock) => lock.name === `webchat:${this.db.name}:${profileId}:${id}`))
      throw new StorageError('conversation_busy');
    await this.transaction(async (tx) => {
      const row = await tx.objectStore('conversations').get(id);
      if (!row || row.profileId !== profileId) throw new StorageError('storage_conflict');
      const lease = parseLease(
        (await tx.objectStore('settings').get([profileId, `lease/${id}`]))?.value,
      );
      if (lease && lease.expiresAt > Date.now()) throw new StorageError('conversation_busy');
      await tx.objectStore('conversations').delete(id);
      const removedAttachments = new Set<string>();
      for (const name of ['messages', 'generationRuns'] as const) {
        let cursor = await tx.objectStore(name).index('profile').openCursor(profileId);
        while (cursor) {
          if (cursor.value.conversationId === id) {
            if ('attachmentIds' in cursor.value)
              for (const attachmentId of cursor.value.attachmentIds)
                removedAttachments.add(attachmentId);
            await cursor.delete();
          }
          cursor = await cursor.continue();
        }
      }
      for (const key of [`lease/${id}`, `excludedAttachmentIds/${id}`, `contextStart/${id}`])
        await tx.objectStore('settings').delete([profileId, key]);
      await this.collectOrphans(tx, profileId, removedAttachments);
    }, false);
    this.notify(profileId);
  }
  async listMessages(profileId: string, conversationId: string): Promise<Message[]> {
    return (
      await this.db.getAllFromIndex(
        'messages',
        'conversation',
        IDBKeyRange.bound(
          [profileId, conversationId, 0],
          [profileId, conversationId, Number.MAX_SAFE_INTEGER],
        ),
      )
    ).filter((row) => !row.stageId);
  }
  async getBranch(
    profileId: string,
    conversationId: string,
    leafId?: string | null,
  ): Promise<Message[]> {
    const conversation = await this.getConversation(profileId, conversationId);
    if (!conversation) throw new StorageError('storage_conflict');
    const messages = new Map(
      (await this.listMessages(profileId, conversationId)).map((row) => [row.id, row]),
    );
    const result: Message[] = [];
    const seen = new Set<string>();
    let id = leafId === undefined ? conversation.currentLeafId : leafId;
    while (id) {
      if (seen.has(id)) throw new StorageError('storage_conflict');
      seen.add(id);
      const row = messages.get(id);
      if (!row) throw new StorageError('storage_conflict');
      result.unshift(row);
      id = row.parentId;
    }
    return result;
  }
  async setBranch(
    profileId: string,
    conversationId: string,
    leafId: string,
    expectedRevision: number,
  ): Promise<void> {
    await this.transaction(async (tx) => {
      const conversation = await tx.objectStore('conversations').get(conversationId);
      const message = await tx.objectStore('messages').get(leafId);
      if (
        !conversation ||
        conversation.profileId !== profileId ||
        conversation.revision !== expectedRevision ||
        !message ||
        message.profileId !== profileId ||
        message.conversationId !== conversationId
      )
        throw new StorageError('storage_conflict');
      const lease = parseLease(
        (await tx.objectStore('settings').get([profileId, `lease/${conversationId}`]))?.value,
      );
      if (lease && lease.expiresAt > Date.now()) throw new StorageError('conversation_busy');
      conversation.currentLeafId = leafId;
      conversation.revision++;
      conversation.updatedAt = Date.now();
      await tx.objectStore('conversations').put(conversation);
    });
    this.notify(profileId);
  }
  async getSetting<T = unknown>(profileId: string, key: string): Promise<T | undefined> {
    if (key.startsWith('lease/') || key.startsWith('import/'))
      throw new StorageError('storage_conflict');
    return (await this.db.get('settings', [profileId, key]))?.value as T | undefined;
  }
  async setSetting(profileId: string, key: string, value: unknown): Promise<void> {
    validateSetting(key, value);
    await this.transaction(async (tx) => {
      if (!(await tx.objectStore('profiles').get(profileId)))
        throw new StorageError('storage_conflict');
      await tx.objectStore('settings').put({ profileId, key, value });
    });
    this.notify(profileId);
  }
  async commitAttachment(profileId: string, input: AttachmentInput): Promise<Attachment> {
    return this.persistAttachment(profileId, input);
  }
  async reReviewAttachment(
    profileId: string,
    id: string,
    input: AttachmentInput,
  ): Promise<Attachment> {
    return this.persistAttachment(profileId, input, id);
  }
  private async persistAttachment(
    profileId: string,
    input: AttachmentInput,
    existingId?: string,
  ): Promise<Attachment> {
    assertName(input.name);
    if (input.losses.length && !input.confirmed) throw new StorageError('attachment_needs_review');
    if (
      input.source.size === 0 ||
      input.source.size > sourceLimit(input.name) ||
      input.normalized.size > (input.kind === 'image' ? 1024 * 1024 : 192 * 1024)
    )
      throw new StorageError('attachment_needs_review');
    const [sourceHash, normalizedHash] = await Promise.all([
      sha256(input.source),
      sha256(input.normalized),
    ]);
    if (
      sourceHash !== input.sourceSha256 ||
      normalizedHash !== input.normalizedSha256 ||
      (input.kind === 'text' &&
        (input.text === undefined || (await input.normalized.text()) !== input.text))
    )
      throw new StorageError('attachment_needs_review');
    const row: Attachment = {
      id: existingId ?? crypto.randomUUID(),
      profileId,
      name: input.name,
      mimeType: input.mimeType,
      kind: input.kind,
      sourceSize: input.source.size,
      sourceSha256: sourceHash,
      normalizedSha256: normalizedHash,
      policyVersion: input.policyVersion,
      parserVersion: input.parserVersion,
      status: 'ready',
      createdAt: Date.now(),
    };
    const extraction: Extraction = {
      profileId,
      attachmentId: row.id,
      policyVersion: row.policyVersion,
      parserVersion: row.parserVersion,
      normalizedSha256: normalizedHash,
      ...(input.text !== undefined ? { text: input.text } : {}),
      losses: [...input.losses],
      confirmed: input.confirmed,
      confirmationKey: confirmationKey(row),
    };
    await this.transaction(async (tx) => {
      if (!(await tx.objectStore('profiles').get(profileId)))
        throw new StorageError('storage_conflict');
      for (const [hash, blob] of [
        [sourceHash, input.source],
        [normalizedHash, input.normalized],
      ] as const) {
        const previous = await tx.objectStore('blobs').get([profileId, hash]);
        if (previous?.stageId) throw new StorageError('storage_conflict');
        if (!previous)
          await tx.objectStore('blobs').add({ profileId, sha256: hash, blob, size: blob.size });
      }
      if (existingId) {
        const previous = await tx.objectStore('attachments').get(existingId);
        if (!previous || previous.profileId !== profileId || previous.sourceSha256 !== sourceHash)
          throw new StorageError('attachment_missing');
        await tx.objectStore('extractions').put(extraction);
        await tx.objectStore('attachments').put(row);
      } else {
        await tx.objectStore('extractions').add(extraction);
        await tx.objectStore('attachments').add(row);
      }
    });
    this.notify(profileId);
    return row;
  }
  async getAttachment(profileId: string, id: string): Promise<Attachment | undefined> {
    const row = await this.db.get('attachments', id);
    return row?.profileId === profileId && !row.stageId ? row : undefined;
  }
  async listAttachments(profileId: string): Promise<Attachment[]> {
    return (await this.db.getAllFromIndex('attachments', 'profile', profileId)).filter(
      (row) => !row.stageId,
    );
  }
  async getArtifact(
    profileId: string,
    id: string,
  ): Promise<{ attachment: Attachment; source: Blob; normalized: Blob; extraction: Extraction }> {
    const tx = this.db.transaction(['attachments', 'blobs', 'extractions'], 'readonly');
    const attachment = await tx.objectStore('attachments').get(id);
    if (!attachment || attachment.profileId !== profileId || attachment.stageId)
      throw new StorageError('attachment_missing');
    const source = await tx.objectStore('blobs').get([profileId, attachment.sourceSha256]);
    const normalized = await tx.objectStore('blobs').get([profileId, attachment.normalizedSha256]);
    const extraction = await tx
      .objectStore('extractions')
      .get([profileId, id, attachment.policyVersion, attachment.parserVersion]);
    await tx.done;
    if (!source || !normalized || source.stageId || normalized.stageId || !extraction)
      throw new StorageError('attachment_missing');
    return { attachment, source: source.blob, normalized: normalized.blob, extraction };
  }
  async markAttachmentNeedsReview(profileId: string, id: string): Promise<void> {
    await this.transaction(async (tx) => {
      const row = await tx.objectStore('attachments').get(id);
      if (!row || row.profileId !== profileId) throw new StorageError('attachment_missing');
      row.status = 'needs_review';
      await tx.objectStore('attachments').put(row);
    });
    this.notify(profileId);
  }
  async removeAttachment(profileId: string, id: string): Promise<void> {
    await this.transaction(async (tx) => {
      const attachment = await tx.objectStore('attachments').get(id);
      if (!attachment || attachment.profileId !== profileId) return;
      const messages = await tx.objectStore('messages').index('profile').getAll(profileId);
      if (messages.some((message) => message.attachmentIds.includes(id)))
        throw new StorageError('storage_conflict');
      await tx.objectStore('attachments').delete(id);
      await this.collectOrphans(tx, profileId);
    }, false);
    this.notify(profileId);
  }
  async prepareGeneration(
    input: PrepareGenerationInput,
  ): Promise<{
    user: Message;
    assistant: Message;
    run: GenerationRun;
    conversation: Conversation;
  }> {
    if (!input.text.trim() || utf8Size(input.text) > 32 * 1024 || input.attachmentIds.length > 4)
      throw new StorageError('storage_conflict');
    const now = Date.now();
    const attemptId = crypto.randomUUID();
    const result = await this.transaction(async (tx) => {
      const conversation = await tx.objectStore('conversations').get(input.conversationId);
      if (
        !conversation ||
        conversation.profileId !== input.profileId ||
        conversation.stageId ||
        (input.expectedRevision !== undefined && conversation.revision !== input.expectedRevision)
      )
        throw new StorageError('storage_conflict');
      const lease = parseLease(
        (await tx.objectStore('settings').get([input.profileId, `lease/${input.conversationId}`]))
          ?.value,
      );
      if (!lease || lease.ownerId !== input.ownerId || lease.expiresAt <= now)
        throw new StorageError('conversation_busy');
      const runs = await tx
        .objectStore('generationRuns')
        .index('conversation')
        .getAll([input.profileId, input.conversationId]);
      if (runs.some((run) => isActive(run.status))) throw new StorageError('conversation_busy');
      const parentId = input.parentId === undefined ? conversation.currentLeafId : input.parentId;
      if (parentId) {
        const parent = await tx.objectStore('messages').get(parentId);
        if (
          !parent ||
          parent.profileId !== input.profileId ||
          parent.conversationId !== input.conversationId ||
          isActive(parent.status)
        )
          throw new StorageError('storage_conflict');
      }
      for (const binding of input.attachmentBindings ?? []) {
        const row = await tx.objectStore('attachments').get(binding.id);
        if (!row || row.profileId !== input.profileId || row.stageId)
          throw new StorageError('attachment_missing');
        if (
          row.status !== 'ready' ||
          row.sourceSha256 !== binding.sourceSha256 ||
          row.normalizedSha256 !== binding.normalizedSha256 ||
          row.policyVersion !== binding.policyVersion ||
          row.parserVersion !== binding.parserVersion
        )
          throw new StorageError('attachment_needs_review');
        const extraction = await tx
          .objectStore('extractions')
          .get([input.profileId, row.id, row.policyVersion, row.parserVersion]);
        if (
          !extraction ||
          extraction.normalizedSha256 !== row.normalizedSha256 ||
          extraction.confirmationKey !== confirmationKey(row) ||
          (extraction.losses.length && !extraction.confirmed)
        )
          throw new StorageError('attachment_needs_review');
        const source = await tx.objectStore('blobs').get([input.profileId, row.sourceSha256]);
        const normalized = await tx
          .objectStore('blobs')
          .get([input.profileId, row.normalizedSha256]);
        if (!source || source.stageId || !normalized || normalized.stageId)
          throw new StorageError('attachment_missing');
      }
      for (const id of input.attachmentIds) {
        const attachment = await tx.objectStore('attachments').get(id);
        if (!attachment || attachment.profileId !== input.profileId || attachment.stageId)
          throw new StorageError('attachment_missing');
        if (attachment.status !== 'ready') throw new StorageError('attachment_needs_review');
        const extraction = await tx
          .objectStore('extractions')
          .get([input.profileId, id, attachment.policyVersion, attachment.parserVersion]);
        if (
          !extraction ||
          extraction.confirmationKey !== confirmationKey(attachment) ||
          (extraction.losses.length && !extraction.confirmed)
        )
          throw new StorageError('attachment_needs_review');
        if (
          !(await tx.objectStore('blobs').get([input.profileId, attachment.sourceSha256])) ||
          !(await tx.objectStore('blobs').get([input.profileId, attachment.normalizedSha256]))
        )
          throw new StorageError('attachment_missing');
      }
      const user: Message = {
        id: crypto.randomUUID(),
        profileId: input.profileId,
        conversationId: input.conversationId,
        parentId,
        role: 'user',
        text: input.text,
        attachmentIds: [...new Set(input.attachmentIds)],
        attemptId,
        status: 'completed',
        createdAt: now,
      };
      const assistant: Message = {
        id: crypto.randomUUID(),
        profileId: input.profileId,
        conversationId: input.conversationId,
        parentId: user.id,
        role: 'assistant',
        text: '',
        attachmentIds: [],
        attemptId,
        status: 'preparing',
        createdAt: now + 1,
      };
      const run: GenerationRun = {
        id: attemptId,
        profileId: input.profileId,
        conversationId: input.conversationId,
        userMessageId: user.id,
        assistantMessageId: assistant.id,
        ownerId: input.ownerId,
        model: input.model,
        status: 'preparing',
        startedAt: now,
        updatedAt: now,
      };
      if (!conversation.currentLeafId && conversation.title === '新对话')
        conversation.title = [...input.text.trim()].slice(0, 28).join('');
      conversation.currentLeafId = assistant.id;
      conversation.model = input.model;
      conversation.updatedAt = now;
      conversation.revision++;
      await tx.objectStore('messages').add(user);
      await tx.objectStore('messages').add(assistant);
      await tx.objectStore('generationRuns').add(run);
      await tx.objectStore('conversations').put(conversation);
      return { user, assistant, run, conversation };
    });
    this.notify(input.profileId);
    return result;
  }
  async saveGeneration(profileId: string, runId: string, update: GenerationUpdate): Promise<void> {
    if (utf8Size(update.text) > 512 * 1024) throw new StorageError('storage_conflict');
    await this.transaction(async (tx) => {
      const run = await tx.objectStore('generationRuns').get(runId);
      if (!run || run.profileId !== profileId || !isActive(run.status))
        throw new StorageError('storage_conflict');
      const lease = parseLease(
        (await tx.objectStore('settings').get([profileId, `lease/${run.conversationId}`]))?.value,
      );
      if (!lease || lease.ownerId !== run.ownerId || lease.expiresAt <= Date.now())
        throw new StorageError('conversation_busy');
      const message = await tx.objectStore('messages').get(run.assistantMessageId);
      if (!message || message.profileId !== profileId) throw new StorageError('storage_conflict');
      message.text = update.text;
      message.status = update.status;
      run.status = update.status;
      run.updatedAt = Date.now();
      for (const key of ['responseId', 'requestId', 'gatewayRequestId', 'errorCode'] as const)
        if (update[key] !== undefined) run[key] = update[key]!.slice(0, 200);
      if (update.usage !== undefined)
        run.usage = Object.fromEntries(
          Object.entries(update.usage).filter(
            ([key, value]) => /^[a-z_]{1,50}$/.test(key) && Number.isFinite(value) && value >= 0,
          ),
        );
      await tx.objectStore('messages').put(message);
      await tx.objectStore('generationRuns').put(run);
    });
    this.notify(profileId);
  }
  async listGenerationRuns(profileId: string, conversationId: string): Promise<GenerationRun[]> {
    return (
      await this.db.getAllFromIndex('generationRuns', 'conversation', [profileId, conversationId])
    ).filter((row) => !row.stageId);
  }
  async acquireConversationLock(
    profileId: string,
    conversationId: string,
  ): Promise<ConversationLease> {
    const ownerId = crypto.randomUUID();
    const key = `lease/${conversationId}`;
    let releaseWeb: (() => void) | undefined;
    let webDone: Promise<void> | undefined;
    if (typeof navigator !== 'undefined' && navigator.locks) {
      let notifyAcquired!: (value: boolean) => void;
      const acquired = new Promise<boolean>((resolve) => {
        notifyAcquired = resolve;
      });
      webDone = navigator.locks
        .request(
          `webchat:${this.db.name}:${profileId}:${conversationId}`,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) {
              notifyAcquired(false);
              return;
            }
            const held = new Promise<void>((resolve) => {
              releaseWeb = resolve;
            });
            notifyAcquired(true);
            await held;
          },
        )
        .catch(() => {
          notifyAcquired(false);
        });
      if (!(await acquired)) throw new StorageError('conversation_busy');
    }
    try {
      await this.transaction(async (tx) => {
        const conversation = await tx.objectStore('conversations').get(conversationId);
        if (!conversation || conversation.profileId !== profileId || conversation.stageId)
          throw new StorageError('storage_conflict');
        const old = parseLease((await tx.objectStore('settings').get([profileId, key]))?.value);
        if (old && old.expiresAt > Date.now()) throw new StorageError('conversation_busy');
        await tx
          .objectStore('settings')
          .put({ profileId, key, value: { ownerId, expiresAt: Date.now() + LEASE_MS } });
      });
    } catch (error) {
      releaseWeb?.();
      await webDone;
      throw error;
    }
    let released = false;
    const heartbeat = async (): Promise<void> => {
      if (released) throw new StorageError('conversation_busy');
      await this.transaction(async (tx) => {
        const old = parseLease((await tx.objectStore('settings').get([profileId, key]))?.value);
        if (!old || old.ownerId !== ownerId || old.expiresAt <= Date.now())
          throw new StorageError('conversation_busy');
        await tx
          .objectStore('settings')
          .put({ profileId, key, value: { ownerId, expiresAt: Date.now() + LEASE_MS } });
      }, false);
    };
    // Keep the IDB fallback live while the page runs; suspended pages lose the lease and must stop.
    const timer = setInterval(() => {
      void heartbeat().catch(() => {
        clearInterval(timer);
      });
    }, LEASE_MS / 3);
    return {
      ownerId,
      heartbeat,
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        try {
          await this.transaction(async (tx) => {
            const lease = parseLease(
              (await tx.objectStore('settings').get([profileId, key]))?.value,
            );
            if (lease?.ownerId === ownerId)
              await tx.objectStore('settings').delete([profileId, key]);
          }, false);
        } finally {
          releaseWeb?.();
          await webDone;
        }
      },
    };
  }
  async recoverInterrupted(profileId: string): Promise<number> {
    let count = 0;
    // A live Web Lock is stronger evidence than a timer lease (background tabs can be suspended).
    const held =
      typeof navigator !== 'undefined' && navigator.locks?.query
        ? ((await navigator.locks.query()).held ?? [])
        : [];
    await this.transaction(async (tx) => {
      const runs = await tx.objectStore('generationRuns').index('profile').getAll(profileId);
      for (const run of runs) {
        if (!isActive(run.status) || run.stageId) continue;
        const lockName = `webchat:${this.db.name}:${profileId}:${run.conversationId}`;
        if (held.some((lock) => lock.name === lockName)) continue;
        const lease = parseLease(
          (await tx.objectStore('settings').get([profileId, `lease/${run.conversationId}`]))?.value,
        );
        if (lease?.ownerId === run.ownerId && lease.expiresAt > Date.now()) continue;
        run.status = 'interrupted';
        run.updatedAt = Date.now();
        await tx.objectStore('generationRuns').put(run);
        const message = await tx.objectStore('messages').get(run.assistantMessageId);
        if (message?.profileId === profileId) {
          message.status = 'interrupted';
          await tx.objectStore('messages').put(message);
        }
        count++;
      }
    }, false);
    if (count) this.notify(profileId);
    return count;
  }
  private async collectOrphans(
    tx: WriteTx,
    profileId: string,
    deletedReferences = new Set<string>(),
  ): Promise<void> {
    const messages = await tx.objectStore('messages').index('profile').getAll(profileId);
    const references = new Set(messages.flatMap((message) => message.attachmentIds));
    const hashes = new Set<string>();
    const extractionKeys = new Set<string>();
    let attachmentCursor = await tx
      .objectStore('attachments')
      .index('profile')
      .openCursor(profileId);
    while (attachmentCursor) {
      const attachment = attachmentCursor.value;
      if (
        attachment.stageId ||
        references.has(attachment.id) ||
        (!deletedReferences.has(attachment.id) &&
          Date.now() - attachment.createdAt < 24 * 60 * 60_000)
      ) {
        hashes.add(attachment.sourceSha256);
        hashes.add(attachment.normalizedSha256);
        extractionKeys.add(
          JSON.stringify([attachment.id, attachment.policyVersion, attachment.parserVersion]),
        );
      } else await attachmentCursor.delete();
      attachmentCursor = await attachmentCursor.continue();
    }
    let extractionCursor = await tx
      .objectStore('extractions')
      .index('profile')
      .openCursor(profileId);
    while (extractionCursor) {
      const extraction = extractionCursor.value;
      if (
        !extractionKeys.has(
          JSON.stringify([
            extraction.attachmentId,
            extraction.policyVersion,
            extraction.parserVersion,
          ]),
        ) &&
        !extraction.stageId
      )
        await extractionCursor.delete();
      extractionCursor = await extractionCursor.continue();
    }
    let blobCursor = await tx.objectStore('blobs').index('profile').openCursor(profileId);
    while (blobCursor) {
      if (!hashes.has(blobCursor.value.sha256) && !blobCursor.value.stageId)
        await blobCursor.delete();
      blobCursor = await blobCursor.continue();
    }
  }
  async gc(profileId: string): Promise<void> {
    await this.transaction((tx) => this.collectOrphans(tx, profileId), false);
    this.notify(profileId);
  }
  async cleanupStage(profileId: string, stageId: string): Promise<void> {
    await this.transaction(async (tx) => {
      for (const name of STORES) {
        if (name === 'profiles') continue;
        let cursor = await tx.objectStore(name).index('profile').openCursor(profileId);
        while (cursor) {
          if (cursor.value.stageId === stageId) await cursor.delete();
          cursor = await cursor.continue();
        }
      }
      await tx.objectStore('settings').delete([profileId, `import/${stageId}`]);
    }, false);
  }
  async cleanupAbandonedImports(): Promise<void> {
    const settings = await this.db.getAll('settings');
    for (const row of settings) {
      if (!row.key.startsWith('import/')) continue;
      const lease = parseLease(row.value);
      if (!lease || lease.expiresAt <= Date.now())
        await this.cleanupStage(row.profileId, row.key.slice('import/'.length));
    }
  }
  exportBackup(profileId: string, conversationIds?: string[]): Promise<Blob> {
    return exportBackup(this, profileId, conversationIds);
  }
  importBackup(profileId: string, file: Blob, options?: ImportOptions): Promise<Conversation[]> {
    return importBackup(this, profileId, file, options);
  }
}
export function sourceLimit(name: string): number {
  const extension = name.toLowerCase().split('.').pop();
  const limits: Record<string, number> = {
    txt: 1,
    md: 1,
    markdown: 1,
    json: 1,
    csv: 2,
    pdf: 8,
    docx: 5,
    jpg: 8,
    jpeg: 8,
    png: 8,
    webp: 8,
  };
  const mib = extension ? limits[extension] : undefined;
  if (mib === undefined) throw new StorageError('attachment_needs_review');
  return mib * 1024 * 1024;
}
