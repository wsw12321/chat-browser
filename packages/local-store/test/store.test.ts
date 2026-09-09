import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openLocalStore, openRecoveryStore, sha256, type ChatStore } from '../src/store';
import { StorageError, type AttachmentInput } from '../src/types';
import { createStoreZip, inspectBackupZip, parseBackupJSON } from '../src/backup';

const stores: ChatStore[] = [];
const leases: { release(): Promise<void> }[] = [];
const open = async (options?: Parameters<typeof openLocalStore>[0]): Promise<ChatStore> => {
  const store = await openLocalStore({ name: crypto.randomUUID(), ...options });
  stores.push(store);
  return store;
};
const attachment = async (text = '这里是原始资料。'): Promise<AttachmentInput> => {
  const source = new Blob([text], { type: 'text/plain' });
  const hash = await sha256(source);
  return {
    name: '资料.txt',
    source,
    normalized: source,
    text,
    mimeType: 'text/plain',
    sourceSha256: hash,
    normalizedSha256: hash,
    policyVersion: 'file-policy-v1',
    parserVersion: 'test-v1',
    losses: [],
    confirmed: true,
    kind: 'text',
  };
};
const prepare = async (
  store: ChatStore,
  profileId: string,
  conversationId: string,
  attachmentIds: string[] = [],
) => {
  const lease = await store.acquireConversationLock(profileId, conversationId);
  leases.push(lease);
  const result = await store.prepareGeneration({
    profileId,
    conversationId,
    ownerId: lease.ownerId,
    text: '这份材料说了什么？',
    model: 'test-model',
    attachmentIds,
  });
  return { ...result, lease };
};
const fixture = async (store: ChatStore) => {
  const profile = await store.createProfile('个人');
  const conversation = await store.createConversation(profile.id);
  const imported = await store.commitAttachment(profile.id, await attachment());
  const result = await prepare(store, profile.id, conversation.id, [imported.id]);
  await store.saveGeneration(profile.id, result.run.id, {
    text: '材料主要讨论项目。',
    status: 'completed',
  });
  await result.lease.release();
  return { profile, conversation, imported, result };
};
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const lease of leases.splice(0)) await lease.release().catch(() => undefined);
  for (const store of stores.splice(0)) store.close();
});

describe('transactional history and isolation', () => {
  it('commits user, placeholder and generation before any networking and survives reopening', async () => {
    const name = crypto.randomUUID();
    const store = await open({ name });
    const profile = await store.createProfile('本机');
    const conversation = await store.createConversation(profile.id);
    const { user, assistant, run, lease } = await prepare(store, profile.id, conversation.id);
    expect(await store.getBranch(profile.id, conversation.id)).toEqual([user, assistant]);
    await store.saveGeneration(profile.id, run.id, { text: '部分回复', status: 'streaming' });
    expect(await store.recoverInterrupted(profile.id)).toBe(0);
    await lease.release();
    store.close();
    const reopened = await open({ name });
    expect(await reopened.recoverInterrupted(profile.id)).toBe(1);
    const restored = await reopened.getBranch(profile.id, conversation.id);
    expect(restored[1]).toMatchObject({ text: '部分回复', status: 'interrupted' });
    expect(await reopened.listGenerationRuns(profile.id, conversation.id)).toHaveLength(1);
  });
  it('excludes other profiles and creates branches without overwriting history', async () => {
    const store = await open();
    const { profile, conversation, result } = await fixture(store);
    const other = await store.createProfile('工作');
    expect(await store.getConversation(other.id, conversation.id)).toBeUndefined();
    expect(await store.listMessages(other.id, conversation.id)).toEqual([]);
    await expect(store.renameConversation(other.id, conversation.id, '错误')).rejects.toMatchObject(
      { code: 'storage_conflict' },
    );
    const lease = await store.acquireConversationLock(profile.id, conversation.id);
    leases.push(lease);
    const branch = await store.prepareGeneration({
      profileId: profile.id,
      conversationId: conversation.id,
      ownerId: lease.ownerId,
      model: 'test-model',
      text: '修改问题',
      attachmentIds: [],
      parentId: null,
    });
    expect(await store.listMessages(profile.id, conversation.id)).toHaveLength(4);
    expect((await store.getBranch(profile.id, conversation.id)).map((row) => row.id)).toEqual([
      branch.user.id,
      branch.assistant.id,
    ]);
    expect(
      (await store.getBranch(profile.id, conversation.id, result.assistant.id)).map(
        (row) => row.id,
      ),
    ).toEqual([result.user.id, result.assistant.id]);
  });
  it('serializes IDB lease acquisition across independent tabs and rejects stale revisions', async () => {
    const name = crypto.randomUUID();
    const first = await open({ name });
    const second = await open({ name });
    const profile = await first.createProfile('本机');
    const conversation = await first.createConversation(profile.id);
    const results = await Promise.allSettled([
      first.acquireConversationLock(profile.id, conversation.id),
      second.acquireConversationLock(profile.id, conversation.id),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find(
      (result) => result.status === 'fulfilled',
    ) as PromiseFulfilledResult<Awaited<ReturnType<ChatStore['acquireConversationLock']>>>;
    leases.push(winner.value);
    await first.renameConversation(profile.id, conversation.id, '新名称', 0);
    await expect(
      first.prepareGeneration({
        profileId: profile.id,
        conversationId: conversation.id,
        model: 'test-model',
        text: '问题',
        attachmentIds: [],
        ownerId: winner.value.ownerId,
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'storage_conflict' });
    expect(await first.listMessages(profile.id, conversation.id)).toEqual([]);
  });
  it('protects a suspended tab with a live Web Lock even when its timer lease expired', async () => {
    const store = await open();
    const profile = await store.createProfile('本机');
    const conversation = await store.createConversation(profile.id);
    const result = await prepare(store, profile.id, conversation.id);
    await store.db.put('settings', {
      profileId: profile.id,
      key: `lease/${conversation.id}`,
      value: { ownerId: result.lease.ownerId, expiresAt: 0 },
    });
    const lockName = `webchat:${store.db.name}:${profile.id}:${conversation.id}`;
    vi.stubGlobal('navigator', { locks: { query: async () => ({ held: [{ name: lockName }] }) } });
    expect(await store.recoverInterrupted(profile.id)).toBe(0);
    vi.stubGlobal('navigator', { locks: { query: async () => ({ held: [] }) } });
    expect(await store.recoverInterrupted(profile.id)).toBe(1);
    await expect(
      store.saveGeneration(profile.id, result.run.id, { text: '过期页面', status: 'completed' }),
    ).rejects.toMatchObject({ code: 'storage_conflict' });
  });
  it('rejects clearing a profile while another tab owns a generation', async () => {
    const store = await open();
    const profile = await store.createProfile('本机');
    const conversation = await store.createConversation(profile.id);
    await prepare(store, profile.id, conversation.id);
    await expect(store.deleteProfile(profile.id)).rejects.toMatchObject({
      code: 'conversation_busy',
    });
    expect(await store.listProfiles()).toHaveLength(1);
    expect(await store.listMessages(profile.id, conversation.id)).toHaveLength(2);
  });
  it('opens a newer compatible database for read-only export without rolling its schema back', async () => {
    const name = crypto.randomUUID();
    const original = await open({ name });
    const { profile } = await fixture(original);
    original.close();
    const upgraded = await openDB(name, 2, {
      upgrade(database) {
        database.createObjectStore('futureMetadata');
      },
    });
    upgraded.close();
    const recovery = await openRecoveryStore({ name });
    stores.push(recovery);
    expect(recovery.readOnly).toBe(true);
    expect(recovery.db.version).toBe(2);
    expect(await recovery.listConversations(profile.id)).toHaveLength(1);
    expect((await recovery.exportBackup(profile.id)).size).toBeGreaterThan(0);
    await expect(recovery.createConversation(profile.id)).rejects.toMatchObject({
      code: 'storage_conflict',
    });
    await expect(recovery.deleteProfile(profile.id)).rejects.toMatchObject({
      code: 'storage_conflict',
    });
    await expect(recovery.recoverInterrupted(profile.id)).rejects.toMatchObject({
      code: 'storage_conflict',
    });
    expect(await recovery.db.count('messages')).toBe(2);
    const fallback = await open({ name, readOnlyOnVersionError: true });
    expect(fallback.readOnly).toBe(true);
    expect(fallback.db.version).toBe(2);
  });
  it('does not persist arbitrary credential settings', async () => {
    const store = await open();
    const profile = await store.createProfile('本机');
    await expect(store.setSetting(profile.id, 'apiKey', 'sk-sensitive')).rejects.toBeInstanceOf(
      StorageError,
    );
    await expect(
      store.setSetting(profile.id, 'selectedModel', { apiKey: 'sk-sensitive' }),
    ).rejects.toBeInstanceOf(StorageError);
    await store.setSetting(profile.id, 'selectedModel', 'test-model');
    expect(await store.getSetting(profile.id, 'selectedModel')).toBe('test-model');
  });
});

describe('attachments, quota and garbage collection', () => {
  it('deduplicates source and normalized blobs within a profile and retains cross-conversation references', async () => {
    const store = await open();
    const { profile, conversation, imported } = await fixture(store);
    const duplicate = await store.commitAttachment(profile.id, await attachment());
    expect(duplicate.id).not.toBe(imported.id);
    expect(await store.db.count('blobs')).toBe(1);
    await store.removeAttachment(profile.id, duplicate.id);
    const second = await store.createConversation(profile.id);
    const result = await prepare(store, profile.id, second.id, [imported.id]);
    await store.saveGeneration(profile.id, result.run.id, { text: '第二次', status: 'completed' });
    await result.lease.release();
    await store.deleteConversation(profile.id, conversation.id);
    expect((await store.getArtifact(profile.id, imported.id)).source.size).toBeGreaterThan(0);
    await store.deleteConversation(profile.id, second.id);
    expect(await store.db.count('blobs')).toBe(0);
    expect(await store.db.count('extractions')).toBe(0);
  });
  it('rolls back all attachment stores when the application budget is exceeded', async () => {
    const store = await open({ budgetBytes: 2000 });
    const profile = await store.createProfile('本机');
    await expect(
      store.commitAttachment(profile.id, await attachment('a'.repeat(1500))),
    ).rejects.toMatchObject({ code: 'local_storage_full' });
    expect(await store.db.count('blobs')).toBe(0);
    expect(await store.db.count('attachments')).toBe(0);
    expect(await store.db.count('extractions')).toBe(0);
    expect(await store.listProfiles()).toHaveLength(1);
  });
  it('does not mark ready a missing blob, modified hash or unconfirmed loss', async () => {
    const store = await open();
    const profile = await store.createProfile('本机');
    const input = await attachment();
    await expect(
      store.commitAttachment(profile.id, { ...input, sourceSha256: '0'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'attachment_needs_review' });
    await expect(
      store.commitAttachment(profile.id, { ...input, losses: ['遗漏图片'], confirmed: false }),
    ).rejects.toMatchObject({ code: 'attachment_needs_review' });
    const row = await store.commitAttachment(profile.id, input);
    await store.db.delete('blobs', [profile.id, row.sourceSha256]);
    const conversation = await store.createConversation(profile.id);
    await expect(prepare(store, profile.id, conversation.id, [row.id])).rejects.toMatchObject({
      code: 'attachment_missing',
    });
    expect(await store.listMessages(profile.id, conversation.id)).toEqual([]);
  });
  it('atomically rejects historical attachment bindings changed after preview', async () => {
    const store = await open();
    const { profile, conversation, imported } = await fixture(store);
    const binding = {
      id: imported.id,
      sourceSha256: imported.sourceSha256,
      normalizedSha256: imported.normalizedSha256,
      policyVersion: imported.policyVersion,
      parserVersion: imported.parserVersion,
    };
    await store.reReviewAttachment(profile.id, imported.id, {
      ...(await attachment()),
      policyVersion: 'file-policy-v2',
    });
    const lease = await store.acquireConversationLock(profile.id, conversation.id);
    leases.push(lease);
    await expect(
      store.prepareGeneration({
        profileId: profile.id,
        conversationId: conversation.id,
        text: '历史追问',
        model: 'test-model',
        attachmentIds: [],
        attachmentBindings: [binding],
        ownerId: lease.ownerId,
      }),
    ).rejects.toMatchObject({ code: 'attachment_needs_review' });
    expect(await store.listMessages(profile.id, conversation.id)).toHaveLength(2);
    expect(await store.listGenerationRuns(profile.id, conversation.id)).toHaveLength(1);
  });
  it('binds re-review to the same original and preserves attachment IDs', async () => {
    const store = await open();
    const { profile, imported } = await fixture(store);
    await store.markAttachmentNeedsReview(profile.id, imported.id);
    const updated = await store.reReviewAttachment(profile.id, imported.id, {
      ...(await attachment()),
      policyVersion: 'file-policy-v2',
    });
    expect(updated).toMatchObject({
      id: imported.id,
      policyVersion: 'file-policy-v2',
      status: 'ready',
    });
    await expect(
      store.reReviewAttachment(profile.id, imported.id, await attachment('另一个原件')),
    ).rejects.toMatchObject({ code: 'attachment_missing' });
    expect((await store.getArtifact(profile.id, imported.id)).extraction.policyVersion).toBe(
      'file-policy-v2',
    );
  });
});

describe('declarative Store ZIP backups', () => {
  it('round-trips into a selected profile with remapped IDs and stale attachment confirmations', async () => {
    const store = await open();
    const { profile, conversation, imported } = await fixture(store);
    const destination = await store.createProfile('恢复');
    const backup = await store.exportBackup(profile.id);
    const restored = await store.importBackup(destination.id, backup);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.id).not.toBe(conversation.id);
    const branch = await store.getBranch(destination.id, restored[0]!.id);
    expect(branch.map((row) => row.text)).toEqual(['这份材料说了什么？', '材料主要讨论项目。']);
    const restoredAttachment = branch[0]!.attachmentIds[0]!;
    expect(restoredAttachment).not.toBe(imported.id);
    const artifact = await store.getArtifact(destination.id, restoredAttachment);
    expect(artifact.attachment.status).toBe('needs_review');
    expect(artifact.extraction.confirmed).toBe(false);
    expect(await artifact.source.text()).toBe('这里是原始资料。');
    expect(await store.listConversations(profile.id)).toHaveLength(1);
    await store.importBackup(destination.id, backup);
    expect(await store.listConversations(destination.id)).toHaveLength(2);
    expect(await store.db.countFromIndex('blobs', 'profile', destination.id)).toBe(1);
  });
  it('calls current-policy review and never reuses confirmations for losses', async () => {
    const store = await open();
    const { profile } = await fixture(store);
    const backup = await store.exportBackup(profile.id);
    const destination = await store.createProfile('恢复');
    const review = vi.fn(async () => ({
      ...(await attachment()),
      policyVersion: 'file-policy-v2',
      losses: ['文字提取模式'],
      confirmed: true,
    }));
    await store.importBackup(destination.id, backup, { review });
    expect(review).toHaveBeenCalledOnce();
    const rows = await store.listAttachments(destination.id);
    expect(rows[0]).toMatchObject({ policyVersion: 'file-policy-v2', status: 'needs_review' });
    expect((await store.getArtifact(destination.id, rows[0]!.id)).extraction.confirmed).toBe(false);
  });
  it('marks successful current no-loss backup review ready for immediate later context use', async () => {
    const store = await open();
    const { profile } = await fixture(store);
    const backup = await store.exportBackup(profile.id);
    const destination = await store.createProfile('恢复');
    await store.importBackup(destination.id, backup, {
      review: async () => ({ ...(await attachment()), confirmed: false }),
    });
    const rows = await store.listAttachments(destination.id);
    expect(rows[0]!.status).toBe('ready');
    const restored = await store.getArtifact(destination.id, rows[0]!.id);
    expect(restored.extraction.confirmed).toBe(true);
  });
  it('cleans staged writes on cancellation, never publishing partial conversations', async () => {
    const store = await open();
    const { profile } = await fixture(store);
    const backup = await store.exportBackup(profile.id);
    const destination = await store.createProfile('恢复');
    const controller = new AbortController();
    await expect(
      store.importBackup(destination.id, backup, {
        signal: controller.signal,
        onProgress(completed) {
          if (completed === 3) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(await store.listConversations(destination.id)).toEqual([]);
    for (const name of [
      'blobs',
      'messages',
      'attachments',
      'extractions',
      'generationRuns',
      'settings',
    ] as const)
      expect(await store.db.countFromIndex(name, 'profile', destination.id)).toBe(0);
    expect(await store.listConversations(profile.id)).toHaveLength(1);
  });
  it('rejects CRC corruption, hashes, duplicate keys, paths and executable record roles', async () => {
    const store = await open();
    const { profile } = await fixture(store);
    const backup = await store.exportBackup(profile.id);
    const bytes = new Uint8Array(await backup.arrayBuffer());
    bytes[45] = bytes[45]! ^ 1;
    await expect(store.importBackup(profile.id, new Blob([bytes]))).rejects.toMatchObject({
      code: 'invalid_backup',
    });
    expect(() => parseBackupJSON(new TextEncoder().encode('{"version":1,"version":1}'))).toThrow(
      StorageError,
    );
    const entries = await inspectBackupZip(backup);
    const modified = entries.map((entry) => ({ path: entry.path, blob: entry.blob }));
    const record = modified.find((entry) => entry.path.startsWith('records/'))!;
    record.blob = new Blob([
      (await record.blob.text()).replace('"role":"user"', '"role":"system"'),
    ]);
    await expect(
      store.importBackup(profile.id, await createStoreZip(modified)),
    ).rejects.toMatchObject({ code: 'invalid_backup' });
    const badHash = entries.map((entry) => ({
      path: entry.path,
      blob: entry.path.startsWith('blobs/') ? new Blob(['x'.repeat(entry.blob.size)]) : entry.blob,
    }));
    await expect(
      store.importBackup(profile.id, await createStoreZip(badHash)),
    ).rejects.toMatchObject({ code: 'invalid_backup' });
    await expect(
      inspectBackupZip(
        await createStoreZip([{ path: '../manifest.json', blob: new Blob(['{}']) }]),
      ),
    ).rejects.toMatchObject({ code: 'invalid_backup' });
    expect(await store.listConversations(profile.id)).toHaveLength(1);
  });
  it('rejects parent cycles, unpaired attempts and archives declaring directory entries', async () => {
    const store = await open();
    const { profile } = await fixture(store);
    const backup = await store.exportBackup(profile.id);
    const entries = await inspectBackupZip(backup);
    const files = entries.map((entry) => ({ path: entry.path, blob: entry.blob }));
    const recordsFile = files.find((entry) => entry.path.startsWith('records/'))!;
    const originalRecords = JSON.parse(await recordsFile.blob.text()) as {
      type: string;
      value: { id: string; parentId?: string; role?: string };
    }[];
    const records = structuredClone(originalRecords);
    const user = records.find(
      (record) => record.type === 'message' && record.value.role === 'user',
    )!;
    const assistant = records.find(
      (record) => record.type === 'message' && record.value.role === 'assistant',
    )!;
    user.value.parentId = assistant.value.id;
    recordsFile.blob = new Blob([JSON.stringify(records)]);
    await expect(store.importBackup(profile.id, await createStoreZip(files))).rejects.toMatchObject(
      { code: 'invalid_backup' },
    );
    const extra = structuredClone(originalRecords.find((record) => record.type === 'message')!);
    extra.value.id = crypto.randomUUID();
    recordsFile.blob = new Blob([JSON.stringify([...originalRecords, extra])]);
    await expect(store.importBackup(profile.id, await createStoreZip(files))).rejects.toMatchObject(
      { code: 'invalid_backup' },
    );
    const bytes = new Uint8Array(await backup.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const directory = view.getUint32(bytes.length - 22 + 16, true);
    view.setUint32(directory + 38, 0x10, true);
    await expect(inspectBackupZip(new Blob([bytes]))).rejects.toMatchObject({
      code: 'invalid_backup',
    });
    expect(await store.listConversations(profile.id)).toHaveLength(1);
  });
  it('rejects compressed methods and cleans expired interrupted import stages on reopen', async () => {
    const store = await open();
    const { profile } = await fixture(store);
    const backup = await store.exportBackup(profile.id);
    const bytes = new Uint8Array(await backup.arrayBuffer());
    new DataView(bytes.buffer).setUint16(8, 8, true);
    await expect(inspectBackupZip(new Blob([bytes]))).rejects.toMatchObject({
      code: 'invalid_backup',
    });
    const stageId = crypto.randomUUID();
    await store.db.put('settings', {
      profileId: profile.id,
      key: `import/${stageId}`,
      value: { ownerId: 'gone', expiresAt: 0 },
    });
    await store.db.put('attachments', {
      profileId: profile.id,
      stageId,
      id: crypto.randomUUID(),
      name: 'a.txt',
      mimeType: 'text/plain',
      kind: 'text',
      sourceSize: 1,
      sourceSha256: '1'.repeat(64),
      normalizedSha256: '1'.repeat(64),
      policyVersion: 'v1',
      parserVersion: 'v1',
      status: 'needs_review',
      createdAt: 0,
    });
    expect(await store.db.count('attachments')).toBe(2);
    const name = store.db.name;
    store.close();
    const reopened = await open({ name });
    expect(await reopened.db.count('attachments')).toBe(1);
  });
});
