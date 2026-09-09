import { z } from 'zod';
import type { ChatStore } from './store';
import { confirmationKey, isActive, sha256, sourceLimit, utf8Size } from './store';
import {
  BACKUP_LIMIT,
  BACKUP_VERSION,
  RECORD_LIMIT,
  StorageError,
  type Attachment,
  type Conversation,
  type ImportOptions,
} from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const id = z.string().uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const version = z.string().min(1).max(100);
const status = z.enum([
  'preparing',
  'streaming',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
  'incomplete',
]);
const name = z
  .string()
  .min(1)
  .refine(
    (value) =>
      [...value].length <= 200 && !/[\x00-\x1f\x7f-\x9f/\\\u202a-\u202e\u2066-\u2069]/u.test(value),
  );
const text = z.string().refine((value) => utf8Size(value) <= 512 * 1024);
const conversationSchema = z
  .object({
    id,
    title: z.string().max(100),
    model: z.string().max(200),
    currentLeafId: id.nullable(),
    revision: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
const messageSchema = z
  .object({
    id,
    conversationId: id,
    parentId: id.nullable(),
    role: z.enum(['user', 'assistant']),
    text,
    attachmentIds: z.array(id).max(2000),
    attemptId: id,
    status,
    createdAt: timestamp,
  })
  .strict()
  .refine((value) => value.role !== 'assistant' || value.attachmentIds.length === 0);
const attachmentSchema = z
  .object({
    id,
    name,
    mimeType: z.string().max(120),
    kind: z.enum(['text', 'image']),
    sourceSize: timestamp,
    sourceSha256: hash,
    normalizedSha256: hash,
    policyVersion: version,
    parserVersion: version,
    status: z.enum(['ready', 'needs_review']),
    createdAt: timestamp,
  })
  .strict();
const extractionSchema = z
  .object({
    attachmentId: id,
    policyVersion: version,
    parserVersion: version,
    normalizedSha256: hash,
    text: text.optional(),
    losses: z.array(z.string().max(1000)).max(100),
    confirmed: z.boolean(),
    confirmationKey: z.string().max(400),
  })
  .strict();
const runSchema = z
  .object({
    id,
    conversationId: id,
    userMessageId: id,
    assistantMessageId: id,
    model: z.string().max(200),
    status,
    startedAt: timestamp,
    updatedAt: timestamp,
    requestId: z.string().max(200).optional(),
    gatewayRequestId: z.string().max(200).optional(),
    responseId: z.string().max(200).optional(),
    usage: z
      .record(z.string().regex(/^[a-z_]{1,50}$/), z.number().finite().nonnegative())
      .optional(),
    errorCode: z
      .string()
      .regex(/^[a-z_]{1,100}$/)
      .optional(),
  })
  .strict();
const recordSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('conversation'), value: conversationSchema }).strict(),
  z.object({ type: z.literal('message'), value: messageSchema }).strict(),
  z.object({ type: z.literal('attachment'), value: attachmentSchema }).strict(),
  z.object({ type: z.literal('extraction'), value: extractionSchema }).strict(),
  z.object({ type: z.literal('run'), value: runSchema }).strict(),
]);
type BackupRecord = z.infer<typeof recordSchema>;
const manifestSchema = z
  .object({
    format: z.literal('chatbackup'),
    version: z.literal(BACKUP_VERSION),
    schemaVersion: z.literal(1),
    createdAt: timestamp,
    records: z.array(z.string().regex(/^records\/[0-9]{6}\.json$/)).max(1999),
    blobs: z.array(z.object({ sha256: hash, size: timestamp }).strict()).max(1999),
  })
  .strict();
const invalid = (): never => {
  throw new StorageError('invalid_backup');
};
const cancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new StorageError('cancelled');
};

/** Bounded JSON tokenizer rejects duplicate object keys before JSON.parse can erase them. */
export function parseBackupJSON(bytes: Uint8Array): unknown {
  if (bytes.byteLength > RECORD_LIMIT) invalid();
  let source: string;
  try {
    source = decoder.decode(bytes);
  } catch {
    return invalid();
  }
  let cursor = 0;
  const whitespace = (): void => {
    while (/\s/u.test(source[cursor] ?? '') && cursor < source.length) cursor++;
  };
  const string = (): string => {
    const start = cursor++;
    while (cursor < source.length) {
      const character = source[cursor++];
      if (character === '\\') {
        cursor++;
        continue;
      }
      if (character === '"') {
        try {
          return JSON.parse(source.slice(start, cursor)) as string;
        } catch {
          return invalid();
        }
      }
    }
    return invalid();
  };
  const value = (depth: number): void => {
    if (depth > 16) invalid();
    whitespace();
    const character = source[cursor];
    if (character === '{') {
      cursor++;
      whitespace();
      const keys = new Set<string>();
      if (source[cursor] === '}') {
        cursor++;
        return;
      }
      while (cursor < source.length) {
        if (source[cursor] !== '"') invalid();
        const key = string();
        if (keys.has(key)) invalid();
        keys.add(key);
        whitespace();
        if (source[cursor++] !== ':') invalid();
        value(depth + 1);
        whitespace();
        const delimiter = source[cursor++];
        if (delimiter === '}') return;
        if (delimiter !== ',') invalid();
        whitespace();
      }
      invalid();
    } else if (character === '[') {
      cursor++;
      whitespace();
      if (source[cursor] === ']') {
        cursor++;
        return;
      }
      while (cursor < source.length) {
        value(depth + 1);
        whitespace();
        const delimiter = source[cursor++];
        if (delimiter === ']') return;
        if (delimiter !== ',') invalid();
      }
      invalid();
    } else if (character === '"') {
      string();
    } else {
      const match =
        /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(
          source.slice(cursor),
        );
      if (!match) invalid();
      cursor += match![0].length;
    }
  };
  value(1);
  whitespace();
  if (cursor !== source.length) invalid();
  try {
    return JSON.parse(source);
  } catch {
    return invalid();
  }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export async function crc32(blob: Blob, signal?: AbortSignal): Promise<number> {
  let crc = 0xffffffff;
  const reader = blob.stream().getReader();
  try {
    while (true) {
      cancelled(signal);
      const { done, value } = await reader.read();
      if (done) break;
      for (const byte of value) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return (crc ^ 0xffffffff) >>> 0;
}
interface ZipEntry {
  path: string;
  blob: Blob;
  crc: number;
  offset: number;
}
/** Parse only Store ZIP; every byte belongs to exactly one checked local entry or the directory. */
export async function inspectBackupZip(file: Blob, signal?: AbortSignal): Promise<ZipEntry[]> {
  if (file.size > BACKUP_LIMIT) throw new StorageError('backup_too_large');
  if (file.size < 22) invalid();
  const end = new DataView(await file.slice(file.size - 22).arrayBuffer());
  if (
    end.getUint32(0, true) !== 0x06054b50 ||
    end.getUint16(4, true) ||
    end.getUint16(6, true) ||
    end.getUint16(20, true)
  )
    invalid();
  const count = end.getUint16(10, true);
  const directorySize = end.getUint32(12, true);
  const directoryOffset = end.getUint32(16, true);
  if (
    !count ||
    count > 2000 ||
    end.getUint16(8, true) !== count ||
    directoryOffset + directorySize !== file.size - 22
  )
    invalid();
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let position = directoryOffset;
  let localPosition = 0;
  let total = 0;
  for (let index = 0; index < count; index++) {
    cancelled(signal);
    if (position + 46 > file.size - 22) invalid();
    const central = new DataView(await file.slice(position, position + 46).arrayBuffer());
    if (
      central.getUint32(0, true) !== 0x02014b50 ||
      ![10, 20].includes(central.getUint16(6, true)) ||
      ![0, 2048].includes(central.getUint16(8, true)) ||
      central.getUint16(10, true) !== 0
    )
      invalid();
    const size = central.getUint32(24, true);
    const compressedSize = central.getUint32(20, true);
    const length = central.getUint16(28, true);
    const extra = central.getUint16(30, true);
    const comment = central.getUint16(32, true);
    const disk = central.getUint16(34, true);
    const attributes = central.getUint32(38, true);
    const mode = attributes >>> 16;
    const crc = central.getUint32(16, true);
    const offset = central.getUint32(42, true);
    if (
      compressedSize !== size ||
      size === 0xffffffff ||
      extra ||
      comment ||
      disk ||
      !length ||
      length > 100 ||
      offset !== localPosition ||
      (attributes & 0x10) !== 0 ||
      (mode !== 0 && (mode & 0xf000) !== 0x8000)
    )
      invalid();
    if (position + 46 + length > file.size - 22 || offset + 30 > directoryOffset) invalid();
    let path: string;
    try {
      path = decoder.decode(await file.slice(position + 46, position + 46 + length).arrayBuffer());
    } catch {
      return invalid();
    }
    if (
      !(
        path === 'manifest.json' ||
        /^records\/[0-9]{6}\.json$/.test(path) ||
        /^blobs\/[0-9a-f]{64}\.bin$/.test(path)
      ) ||
      seen.has(path)
    )
      invalid();
    seen.add(path);
    const local = new DataView(await file.slice(offset, offset + 30).arrayBuffer());
    if (
      local.getUint32(0, true) !== 0x04034b50 ||
      local.getUint16(4, true) !== central.getUint16(6, true) ||
      local.getUint16(6, true) !== central.getUint16(8, true) ||
      local.getUint16(8, true) !== 0 ||
      local.getUint32(14, true) !== crc ||
      local.getUint32(18, true) !== size ||
      local.getUint32(22, true) !== size ||
      local.getUint16(26, true) !== length ||
      local.getUint16(28, true)
    )
      invalid();
    let localPath: string;
    try {
      localPath = decoder.decode(await file.slice(offset + 30, offset + 30 + length).arrayBuffer());
    } catch {
      return invalid();
    }
    if (localPath !== path) invalid();
    const start = offset + 30 + length;
    const stop = start + size;
    if (
      stop > directoryOffset ||
      (path.endsWith('.json') && size > RECORD_LIMIT) ||
      (path.startsWith('blobs/') && size > 8 * 1024 * 1024)
    )
      invalid();
    total += size;
    if (total > BACKUP_LIMIT) throw new StorageError('backup_too_large');
    const blob = file.slice(start, stop);
    if ((await crc32(blob, signal)) !== crc) invalid();
    entries.push({ path, blob, crc, offset });
    localPosition = stop;
    position += 46 + length;
  }
  if (
    position !== directoryOffset + directorySize ||
    localPosition !== directoryOffset ||
    !seen.has('manifest.json')
  )
    invalid();
  return entries;
}

export async function createStoreZip(
  files: { path: string; blob: Blob }[],
  signal?: AbortSignal,
): Promise<Blob> {
  if (!files.length || files.length > 2000) throw new StorageError('backup_too_large');
  let size = 22;
  let actual = 0;
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) invalid();
    paths.add(file.path);
    actual += file.blob.size;
    size += 76 + 2 * encoder.encode(file.path).length + file.blob.size;
  }
  if (size > BACKUP_LIMIT || actual > BACKUP_LIMIT) throw new StorageError('backup_too_large');
  const pieces: BlobPart[] = [];
  const directory: BlobPart[] = [];
  let offset = 0;
  let directorySize = 0;
  for (const file of files) {
    cancelled(signal);
    const filename = encoder.encode(file.path);
    const crc = await crc32(file.blob, signal);
    const local = new Uint8Array(30 + filename.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 2048, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, file.blob.size, true);
    localView.setUint32(22, file.blob.size, true);
    localView.setUint16(26, filename.length, true);
    local.set(filename, 30);
    const central = new Uint8Array(46 + filename.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 2048, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, file.blob.size, true);
    centralView.setUint32(24, file.blob.size, true);
    centralView.setUint16(28, filename.length, true);
    centralView.setUint32(42, offset, true);
    central.set(filename, 46);
    pieces.push(local, file.blob);
    directory.push(central);
    offset += local.length + file.blob.size;
    directorySize += central.length;
  }
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true);
  view.setUint32(12, directorySize, true);
  view.setUint32(16, offset, true);
  return new Blob([...pieces, ...directory, end], { type: 'application/vnd.webchat.backup+zip' });
}
const cleanRow = <T extends { profileId: string; stageId?: string; ownerId?: string }>(
  row: T,
): Omit<T, 'profileId' | 'stageId' | 'ownerId'> => {
  const { profileId: _profile, stageId: _stage, ownerId: _owner, ...safe } = row;
  return safe;
};

export async function exportBackup(
  store: ChatStore,
  profileId: string,
  conversationIds?: string[],
): Promise<Blob> {
  const files: { path: string; blob: Blob }[] = [];
  const recordPaths: string[] = [];
  const attachmentIds = new Set<string>();
  const hashes = new Set<string>();
  let shard: string[] = [];
  let shardSize = 2;
  let total = 0;
  const flush = (): void => {
    if (!shard.length) return;
    const path = `records/${String(recordPaths.length).padStart(6, '0')}.json`;
    recordPaths.push(path);
    files.push({ path, blob: new Blob([`[${shard.join(',')}]`], { type: 'application/json' }) });
    shard = [];
    shardSize = 2;
    if (files.length + hashes.size + 1 > 2000) throw new StorageError('backup_too_large');
  };
  const appendRecord = (record: unknown): void => {
    const serialized = JSON.stringify(recordSchema.parse(record));
    const length = utf8Size(serialized);
    if (length + 2 > RECORD_LIMIT) throw new StorageError('backup_too_large');
    if (shardSize + length + (shard.length ? 1 : 0) > RECORD_LIMIT) flush();
    shardSize += length + (shard.length ? 1 : 0);
    shard.push(serialized);
    total += length + 1;
    if (total > BACKUP_LIMIT) throw new StorageError('backup_too_large');
  };
  const blobs: { sha256: string; size: number }[] = [];
  // All selected records and Blob references come from one consistent read transaction. Text
  // is visited one record at a time, then moved into bounded Blob shards rather than a full
  // archive-sized array of parsed records. CRC calculation happens after this transaction.
  const tx = store.db.transaction(
    [
      'profiles',
      'conversations',
      'messages',
      'generationRuns',
      'attachments',
      'extractions',
      'blobs',
    ],
    'readonly',
  );
  try {
    if (!(await tx.objectStore('profiles').get(profileId)))
      throw new StorageError('storage_conflict');
    let conversationCursor = await tx
      .objectStore('conversations')
      .index('profile')
      .openCursor(profileId);
    while (conversationCursor) {
      const conversation = conversationCursor.value;
      if (
        !conversation.stageId &&
        (!conversationIds || conversationIds.includes(conversation.id))
      ) {
        appendRecord({ type: 'conversation', value: cleanRow(conversation) });
        let messageCursor = await tx
          .objectStore('messages')
          .index('conversation')
          .openCursor(
            IDBKeyRange.bound(
              [profileId, conversation.id, 0],
              [profileId, conversation.id, Number.MAX_SAFE_INTEGER],
            ),
          );
        while (messageCursor) {
          const message = messageCursor.value;
          if (!message.stageId) {
            appendRecord({
              type: 'message',
              value: {
                ...cleanRow(message),
                status: isActive(message.status) ? 'interrupted' : message.status,
              },
            });
            for (const attachmentId of message.attachmentIds) attachmentIds.add(attachmentId);
          }
          messageCursor = await messageCursor.continue();
        }
        let runCursor = await tx
          .objectStore('generationRuns')
          .index('conversation')
          .openCursor([profileId, conversation.id]);
        while (runCursor) {
          const run = runCursor.value;
          if (!run.stageId)
            appendRecord({
              type: 'run',
              value: {
                ...cleanRow(run),
                status: isActive(run.status) ? 'interrupted' : run.status,
              },
            });
          runCursor = await runCursor.continue();
        }
      }
      conversationCursor = await conversationCursor.continue();
    }
    for (const attachmentId of attachmentIds) {
      const attachment = await tx.objectStore('attachments').get(attachmentId);
      if (!attachment || attachment.profileId !== profileId || attachment.stageId)
        throw new StorageError('attachment_missing');
      const extraction = await tx
        .objectStore('extractions')
        .get([profileId, attachment.id, attachment.policyVersion, attachment.parserVersion]);
      if (!extraction || extraction.stageId) throw new StorageError('attachment_missing');
      appendRecord({ type: 'attachment', value: cleanRow(attachment) });
      appendRecord({ type: 'extraction', value: cleanRow(extraction) });
      hashes.add(attachment.sourceSha256);
      hashes.add(attachment.normalizedSha256);
      if (files.length + hashes.size + 1 > 2000) throw new StorageError('backup_too_large');
    }
    flush();
    for (const hash of hashes) {
      const row = await tx.objectStore('blobs').get([profileId, hash]);
      if (!row || row.stageId || row.size !== row.blob.size)
        throw new StorageError('attachment_missing');
      total += row.blob.size;
      if (total > BACKUP_LIMIT) throw new StorageError('backup_too_large');
      blobs.push({ sha256: hash, size: row.blob.size });
      files.push({ path: `blobs/${hash}.bin`, blob: row.blob });
    }
    await tx.done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Read transaction may already have completed. */
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
  const manifest = manifestSchema.parse({
    format: 'chatbackup',
    version: BACKUP_VERSION,
    schemaVersion: 1,
    createdAt: Date.now(),
    records: recordPaths,
    blobs,
  });
  files.unshift({
    path: 'manifest.json',
    blob: new Blob([JSON.stringify(manifest)], { type: 'application/json' }),
  });
  return createStoreZip(files);
}

export async function importBackup(
  store: ChatStore,
  profileId: string,
  file: Blob,
  options: ImportOptions = {},
): Promise<Conversation[]> {
  const stageId = crypto.randomUUID();
  const { signal, onProgress, review } = options;
  cancelled(signal);
  if (!(await store.db.get('profiles', profileId))) throw new StorageError('storage_conflict');
  if (file.size > BACKUP_LIMIT) throw new StorageError('backup_too_large');
  const usage = await store.usage();
  // Existing data and a complete staged copy must coexist until atomic publication.
  if (usage.reservedBytes + Math.ceil(file.size * 1.2) > usage.budgetBytes)
    throw new StorageError('local_storage_full');
  let importStarted = false;
  try {
    const entries = await inspectBackupZip(file, signal);
    const entryMap = new Map(entries.map((entry) => [entry.path, entry]));
    const manifestEntry = entryMap.get('manifest.json')!;
    const manifest = manifestSchema.parse(
      parseBackupJSON(new Uint8Array(await manifestEntry.blob.arrayBuffer())),
    );
    const expectedPaths = new Set([
      'manifest.json',
      ...manifest.records,
      ...manifest.blobs.map((blob) => `blobs/${blob.sha256}.bin`),
    ]);
    if (
      expectedPaths.size !== 1 + manifest.records.length + manifest.blobs.length ||
      expectedPaths.size !== entries.length ||
      entries.some((entry) => !expectedPaths.has(entry.path))
    )
      invalid();
    const blobs = new Map<string, Blob>();
    for (const declaration of manifest.blobs) {
      cancelled(signal);
      const entry = entryMap.get(`blobs/${declaration.sha256}.bin`);
      if (
        !entry ||
        entry.blob.size !== declaration.size ||
        (await sha256(entry.blob)) !== declaration.sha256
      )
        invalid();
      blobs.set(declaration.sha256, entry!.blob);
    }
    const records: BackupRecord[] = [];
    const unique = new Set<string>();
    for (const path of manifest.records) {
      cancelled(signal);
      const entry = entryMap.get(path);
      if (!entry) invalid();
      const shard = z
        .array(recordSchema)
        .parse(parseBackupJSON(new Uint8Array(await entry!.blob.arrayBuffer())));
      for (const record of shard) {
        const key =
          record.type === 'extraction'
            ? `${record.type}/${record.value.attachmentId}/${record.value.policyVersion}/${record.value.parserVersion}`
            : `${record.type}/${record.value.id}`;
        if (unique.has(key)) invalid();
        unique.add(key);
        // Retain only graph metadata between shards; message/document bodies are re-read when staged.
        if (record.type === 'message')
          records.push({ ...record, value: { ...record.value, text: '' } });
        else if (record.type === 'extraction') {
          if (
            record.value.text !== undefined &&
            (await sha256(new Blob([record.value.text]))) !== record.value.normalizedSha256
          )
            invalid();
          records.push({
            ...record,
            value: { ...record.value, ...(record.value.text === undefined ? {} : { text: '' }) },
          });
        } else records.push(record);
      }
    }
    const conversations = new Map(
      records.filter((row) => row.type === 'conversation').map((row) => [row.value.id, row.value]),
    );
    const messages = new Map(
      records.filter((row) => row.type === 'message').map((row) => [row.value.id, row.value]),
    );
    const attachments = new Map(
      records.filter((row) => row.type === 'attachment').map((row) => [row.value.id, row.value]),
    );
    const extractions = new Map(
      records
        .filter((row) => row.type === 'extraction')
        .map((row) => [row.value.attachmentId, row.value]),
    );
    const runs = new Map(
      records.filter((row) => row.type === 'run').map((row) => [row.value.id, row.value]),
    );
    const referencedBlobs = new Set<string>();
    const referencedAttachments = new Set<string>();
    for (const message of messages.values()) {
      const run = runs.get(message.attemptId);
      if (
        !conversations.has(message.conversationId) ||
        !run ||
        (message.role === 'user' ? run.userMessageId : run.assistantMessageId) !== message.id
      )
        invalid();
      if (message.parentId) {
        const parent = messages.get(message.parentId);
        if (!parent || parent.conversationId !== message.conversationId || parent.id === message.id)
          invalid();
      }
      for (const attachmentId of message.attachmentIds) {
        if (!attachments.has(attachmentId)) invalid();
        referencedAttachments.add(attachmentId);
      }
    }
    // Parent links form a forest. Memoize complete paths so long imported histories remain linear.
    const visited = new Set<string>();
    for (const message of messages.values()) {
      const path = new Set<string>();
      let current: typeof message | undefined = message;
      while (current && !visited.has(current.id)) {
        if (path.has(current.id)) invalid();
        path.add(current.id);
        current = current.parentId ? messages.get(current.parentId) : undefined;
      }
      for (const key of path) visited.add(key);
    }
    for (const conversation of conversations.values())
      if (
        conversation.currentLeafId &&
        messages.get(conversation.currentLeafId)?.conversationId !== conversation.id
      )
        invalid();
    for (const run of runs.values()) {
      const user = messages.get(run.userMessageId);
      const assistant = messages.get(run.assistantMessageId);
      if (
        !conversations.has(run.conversationId) ||
        user?.role !== 'user' ||
        assistant?.role !== 'assistant' ||
        user.attemptId !== run.id ||
        assistant.attemptId !== run.id ||
        user.conversationId !== run.conversationId ||
        assistant.conversationId !== run.conversationId ||
        assistant.parentId !== user.id
      )
        invalid();
    }
    for (const attachment of attachments.values()) {
      const source = blobs.get(attachment.sourceSha256);
      const normalized = blobs.get(attachment.normalizedSha256);
      const extraction = extractions.get(attachment.id);
      if (
        !referencedAttachments.has(attachment.id) ||
        !source ||
        !normalized ||
        !extraction ||
        source.size !== attachment.sourceSize ||
        source.size === 0 ||
        source.size > sourceLimit(attachment.name) ||
        extraction.policyVersion !== attachment.policyVersion ||
        extraction.parserVersion !== attachment.parserVersion ||
        extraction.normalizedSha256 !== attachment.normalizedSha256
      )
        invalid();
      if (
        (attachment.kind === 'text' && extraction!.text === undefined) ||
        (attachment.kind === 'image' && normalized!.size > 1024 * 1024)
      )
        invalid();
      referencedBlobs.add(attachment.sourceSha256);
      referencedBlobs.add(attachment.normalizedSha256);
    }
    if (
      referencedBlobs.size !== blobs.size ||
      extractions.size !== attachments.size ||
      records.filter((row) => row.type === 'extraction').length !== attachments.size
    )
      invalid();
    const remap = new Map<string, string>();
    for (const original of [
      ...conversations.keys(),
      ...messages.keys(),
      ...attachments.keys(),
      ...runs.keys(),
    ]) {
      if (remap.has(original)) invalid();
      remap.set(original, crypto.randomUUID());
    }
    const mapped = (original: string): string => remap.get(original) ?? invalid();
    const scope = { profileId, stageId };
    await store.transaction(async (tx) => {
      if (!(await tx.objectStore('profiles').get(profileId)))
        throw new StorageError('storage_conflict');
      await tx
        .objectStore('settings')
        .add({
          profileId,
          key: `import/${stageId}`,
          value: { ownerId: store.ownerId, expiresAt: Date.now() + 60_000 },
        });
    });
    importStarted = true;
    let completed = 0;
    const total = blobs.size + records.length;
    const progress = (): void => {
      onProgress?.(++completed, total);
      cancelled(signal);
    };
    for (const [hash, blob] of blobs) {
      cancelled(signal);
      await store.transaction(async (tx) => {
        // Reusing a committed Blob is safe; never replace it with a staged record.
        const previous = await tx.objectStore('blobs').get([profileId, hash]);
        if (!previous)
          await tx.objectStore('blobs').add({ ...scope, sha256: hash, blob, size: blob.size });
        else if (previous.stageId && previous.stageId !== stageId)
          throw new StorageError('storage_conflict');
        await tx
          .objectStore('settings')
          .put({
            profileId,
            key: `import/${stageId}`,
            value: { ownerId: store.ownerId, expiresAt: Date.now() + 60_000 },
          });
      });
      progress();
    }
    for (const path of manifest.records) {
      cancelled(signal);
      const shard = z
        .array(recordSchema)
        .parse(parseBackupJSON(new Uint8Array(await entryMap.get(path)!.blob.arrayBuffer())));
      for (let start = 0; start < shard.length; start += 128) {
        cancelled(signal);
        const batch = shard.slice(start, start + 128);
        await store.transaction(async (tx) => {
          for (const record of batch) {
            switch (record.type) {
              case 'conversation':
                await tx
                  .objectStore('conversations')
                  .add({
                    ...record.value,
                    ...scope,
                    id: mapped(record.value.id),
                    currentLeafId: record.value.currentLeafId
                      ? mapped(record.value.currentLeafId)
                      : null,
                    revision: 0,
                  });
                break;
              case 'message':
                await tx
                  .objectStore('messages')
                  .add({
                    ...record.value,
                    ...scope,
                    id: mapped(record.value.id),
                    conversationId: mapped(record.value.conversationId),
                    parentId: record.value.parentId ? mapped(record.value.parentId) : null,
                    attemptId: mapped(record.value.attemptId),
                    attachmentIds: record.value.attachmentIds.map(mapped),
                    status: isActive(record.value.status) ? 'interrupted' : record.value.status,
                  });
                break;
              case 'run':
                await tx
                  .objectStore('generationRuns')
                  .add({
                    ...record.value,
                    ...scope,
                    id: mapped(record.value.id),
                    conversationId: mapped(record.value.conversationId),
                    userMessageId: mapped(record.value.userMessageId),
                    assistantMessageId: mapped(record.value.assistantMessageId),
                    ownerId: 'imported',
                    status: isActive(record.value.status) ? 'interrupted' : record.value.status,
                  });
                break;
              case 'attachment':
                await tx
                  .objectStore('attachments')
                  .add({
                    ...record.value,
                    ...scope,
                    id: mapped(record.value.id),
                    status: 'needs_review',
                  });
                break;
              case 'extraction':
                await tx
                  .objectStore('extractions')
                  .add({
                    ...record.value,
                    ...scope,
                    attachmentId: mapped(record.value.attachmentId),
                    confirmed: false,
                    confirmationKey: '',
                  });
                break;
            }
          }
          await tx
            .objectStore('settings')
            .put({
              profileId,
              key: `import/${stageId}`,
              value: { ownerId: store.ownerId, expiresAt: Date.now() + 60_000 },
            });
        });
        for (const _record of batch) progress();
      }
    }
    if (review) {
      for (const original of attachments.values()) {
        cancelled(signal);
        const restored: Attachment = {
          ...original,
          ...scope,
          id: mapped(original.id),
          status: 'needs_review',
        };
        try {
          const reviewed = await review(blobs.get(original.sourceSha256)!, restored, signal);
          cancelled(signal);
          if (
            reviewed.sourceSha256 !== original.sourceSha256 ||
            (await sha256(reviewed.source)) !== original.sourceSha256 ||
            (await sha256(reviewed.normalized)) !== reviewed.normalizedSha256 ||
            reviewed.normalized.size > (reviewed.kind === 'image' ? 1024 * 1024 : 192 * 1024)
          )
            continue;
          if (
            reviewed.kind === 'text' &&
            (reviewed.text === undefined || (await reviewed.normalized.text()) !== reviewed.text)
          )
            continue;
          const reviewedRow: Attachment = {
            ...restored,
            name: reviewed.name,
            kind: reviewed.kind,
            mimeType: reviewed.mimeType,
            normalizedSha256: reviewed.normalizedSha256,
            policyVersion: reviewed.policyVersion,
            parserVersion: reviewed.parserVersion,
            status: reviewed.losses.length ? 'needs_review' : 'ready',
          };
          // Previous confirmation never carries across imports, including callback-provided claims.
          await store.transaction(async (tx) => {
            const key: [string, string] = [profileId, reviewed.normalizedSha256];
            if (!(await tx.objectStore('blobs').get(key)))
              await tx
                .objectStore('blobs')
                .add({
                  ...scope,
                  sha256: reviewed.normalizedSha256,
                  blob: reviewed.normalized,
                  size: reviewed.normalized.size,
                });
            await tx.objectStore('attachments').put(reviewedRow);
            await tx
              .objectStore('extractions')
              .put({
                ...scope,
                attachmentId: reviewedRow.id,
                policyVersion: reviewedRow.policyVersion,
                parserVersion: reviewedRow.parserVersion,
                normalizedSha256: reviewedRow.normalizedSha256,
                ...(reviewed.text !== undefined ? { text: reviewed.text } : {}),
                losses: [...reviewed.losses],
                confirmed: reviewed.losses.length === 0,
                confirmationKey: confirmationKey(reviewedRow),
              });
          });
        } catch (error) {
          cancelled(signal);
          if (
            error instanceof StorageError &&
            ['local_storage_full', 'storage_unavailable'].includes(error.code)
          )
            throw error;
          // A rejected attachment stays readable in history, explicitly unavailable for sending.
        }
      }
    }
    cancelled(signal);
    // The completion marker and removal of all staging flags publish in one transaction.
    await store.transaction(async (tx) => {
      for (const name of [
        'conversations',
        'messages',
        'attachments',
        'blobs',
        'extractions',
        'generationRuns',
      ] as const) {
        let cursor = await tx.objectStore(name).index('profile').openCursor(profileId);
        while (cursor) {
          if (cursor.value.stageId === stageId) {
            const value = cursor.value;
            delete value.stageId;
            await cursor.update(value as never);
          }
          cursor = await cursor.continue();
        }
      }
      await tx.objectStore('settings').delete([profileId, `import/${stageId}`]);
    });
    store.notify(profileId);
    return (await store.listConversations(profileId)).filter((row) =>
      [...remap.values()].includes(row.id),
    );
  } catch (error) {
    if (importStarted) await store.cleanupStage(profileId, stageId);
    if (error instanceof StorageError) throw error;
    throw new StorageError('invalid_backup');
  }
}
