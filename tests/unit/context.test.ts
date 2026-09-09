import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_CONTRACT_VERSION,
  POLICY,
  POLICY_VERSION,
  type PublicConfig,
} from '../../packages/contracts/src';
import { PARSER_VERSION } from '../../packages/file-review/src';
import {
  openLocalStore,
  sha256,
  type AttachmentInput,
  type ChatStore,
  type Message,
} from '../../packages/local-store/src';
import { buildContext } from '../../apps/web/src/context';

const stores: ChatStore[] = [];
const config: PublicConfig = {
  schemaVersion: APP_CONTRACT_VERSION,
  policyVersion: POLICY_VERSION,
  policy: POLICY,
  features: { pdf: true, docx: true, images: true },
};
async function setup() {
  const store = await openLocalStore({ name: crypto.randomUUID() });
  stores.push(store);
  const profile = await store.createProfile('本机');
  const conversation = await store.createConversation(profile.id);
  return { store, profileId: profile.id, conversationId: conversation.id };
}
async function input(text = '附件中的完整文字', name = '资料.txt'): Promise<AttachmentInput> {
  const blob = new Blob([text], { type: 'text/plain' });
  const hash = await sha256(blob);
  return {
    name,
    source: blob,
    normalized: blob,
    text,
    mimeType: 'text/plain',
    sourceSha256: hash,
    normalizedSha256: hash,
    policyVersion: POLICY_VERSION,
    parserVersion: PARSER_VERSION,
    losses: [],
    confirmed: true,
    kind: 'text',
  };
}
function history(
  profileId: string,
  conversationId: string,
  entries: { text: string; attachments?: string[] }[],
): Message[] {
  const result: Message[] = [];
  for (const [index, entry] of entries.entries()) {
    const user: Message = {
      id: crypto.randomUUID(),
      profileId,
      conversationId,
      parentId: result.at(-1)?.id ?? null,
      role: 'user',
      text: entry.text,
      attachmentIds: entry.attachments ?? [],
      attemptId: crypto.randomUUID(),
      status: 'completed',
      createdAt: index * 2,
    };
    result.push(user, {
      ...user,
      id: crypto.randomUUID(),
      role: 'assistant',
      parentId: user.id,
      text: `回复 ${index + 1}`,
      attachmentIds: [],
      createdAt: index * 2 + 1,
    });
  }
  return result;
}
function options(store: ChatStore | null, profileId: string, messages: Message[] = []) {
  return {
    store,
    profileId,
    history: messages,
    text: '继续分析',
    attachmentIds: [] as string[],
    excluded: [] as string[],
    startId: null as string | null,
    model: 'test-model',
    config,
    models: [{ id: 'test-model', images: true }],
  };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe('immutable selected conversation context', () => {
  it('preserves multi-turn text and snapshots without retaining mutable UI references', async () => {
    const { store, profileId, conversationId } = await setup();
    const branch = history(profileId, conversationId, [{ text: '第一问' }, { text: '第二问' }]);
    const selected = options(store, profileId, branch);
    const request = await buildContext(selected);
    branch[0]!.text = '在另一界面修改';
    selected.text = '变更草稿';
    expect(request.messages.map((message) => message.content[0])).toEqual([
      { type: 'text', text: '第一问' },
      { type: 'text', text: '回复 1' },
      { type: 'text', text: '第二问' },
      { type: 'text', text: '回复 2' },
      { type: 'text', text: '继续分析' },
    ]);
    expect(Object.keys(request).sort()).toEqual([
      'clientRequestId',
      'messages',
      'model',
      'policyVersion',
      'schemaVersion',
    ]);
  });
  it('injects identical attachment content once and adds stable references for later introductions', async () => {
    const { store, profileId, conversationId } = await setup();
    const first = await store.commitAttachment(profileId, await input());
    const duplicate = await store.commitAttachment(profileId, await input());
    const branch = history(profileId, conversationId, [
      { text: '第一问', attachments: [first.id] },
      { text: '再引用', attachments: [duplicate.id] },
    ]);
    const request = await buildContext({
      ...options(store, profileId, branch),
      attachmentIds: [first.id],
    });
    const documents = request.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'document_text');
    expect(documents).toEqual([
      { type: 'document_text', name: '资料.txt', text: '附件中的完整文字' },
    ]);
    expect(request.messages[2]!.content[0]).toMatchObject({
      text: expect.stringContaining('附件 A1'),
    });
    expect(request.messages.at(-1)!.content[0]).toMatchObject({
      text: expect.stringContaining('附件 A1'),
    });
  });
  it('reinjects active session documents when context excludes their original introduction', async () => {
    const { store, profileId, conversationId } = await setup();
    const attachment = await store.commitAttachment(profileId, await input());
    const branch = history(profileId, conversationId, [
      { text: '第一问', attachments: [attachment.id] },
      { text: '第二问' },
    ]);
    const request = await buildContext({
      ...options(store, profileId, branch),
      startId: branch[2]!.id,
    });
    expect(request.messages).toHaveLength(3);
    expect(request.messages[0]!.content).toEqual([
      { type: 'text', text: '第二问' },
      { type: 'document_text', name: '资料.txt', text: '附件中的完整文字' },
    ]);
    const currentOnly = await buildContext({
      ...options(store, profileId, branch),
      startId: branch[3]!.id,
    });
    expect(currentOnly.messages).toHaveLength(1);
    expect(currentOnly.messages[0]!.content[1]).toMatchObject({ type: 'document_text' });
  });
  it('honors explicit exclusions without trying to read removed or missing blobs', async () => {
    const { store, profileId, conversationId } = await setup();
    const missing = crypto.randomUUID();
    const branch = history(profileId, conversationId, [
      { text: '第一问', attachments: [missing] },
      { text: '第二问' },
    ]);
    const request = await buildContext({
      ...options(store, profileId, branch),
      excluded: [missing],
      startId: branch[2]!.id,
    });
    expect(request.messages.every((message) => message.content.length === 1)).toBe(true);
    await expect(
      buildContext({ ...options(store, profileId, branch), startId: branch[2]!.id }),
    ).rejects.toMatchObject({ code: 'attachment_missing' });
  });
  it('rejects cross-profile history before start selection, mixed conversations and broken branches', async () => {
    const { store, profileId, conversationId } = await setup();
    const branch = history(profileId, conversationId, [{ text: '私人问题' }, { text: '第二问' }]);
    const other = await store.createProfile('其他档案');
    await expect(
      buildContext({ ...options(store, other.id, branch), startId: branch[2]!.id }),
    ).rejects.toMatchObject({ code: 'storage_conflict' });
    const mixed = structuredClone(branch);
    mixed[2]!.conversationId = crypto.randomUUID();
    await expect(buildContext(options(store, profileId, mixed))).rejects.toMatchObject({
      code: 'storage_conflict',
    });
    const broken = structuredClone(branch);
    broken[2]!.parentId = broken[0]!.id;
    await expect(buildContext(options(store, profileId, broken))).rejects.toMatchObject({
      code: 'storage_conflict',
    });
    await expect(
      buildContext({ ...options(store, profileId, branch), startId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'storage_conflict' });
  });
  it('rejects cross-profile attachment IDs, obsolete policy and parser versions, or changed stored bytes', async () => {
    const { store, profileId } = await setup();
    const attached = await store.commitAttachment(profileId, await input());
    const other = await store.createProfile('其他');
    await expect(
      buildContext({ ...options(store, other.id), attachmentIds: [attached.id] }),
    ).rejects.toMatchObject({ code: 'attachment_missing' });
    await store.db.put('attachments', { ...attached, parserVersion: 'older-parser' });
    await expect(
      buildContext({ ...options(store, profileId), attachmentIds: [attached.id] }),
    ).rejects.toMatchObject({ code: 'attachment_missing' });
    await store.db.put('attachments', attached);
    await store.db.put('blobs', {
      profileId,
      sha256: attached.normalizedSha256,
      size: 1,
      blob: new Blob(['x']),
    });
    await expect(
      buildContext({ ...options(store, profileId), attachmentIds: [attached.id] }),
    ).rejects.toMatchObject({ code: 'attachment_needs_review' });
    await expect(
      buildContext({
        ...options(store, profileId),
        config: { ...config, policyVersion: 'file-policy-future' },
      }),
    ).rejects.toMatchObject({ code: 'policy_outdated' });
  });
  it('rejects invalidated loss confirmation while allowing current no-loss artifacts', async () => {
    const { store, profileId } = await setup();
    const attached = await store.commitAttachment(profileId, await input());
    const extraction = (await store.getArtifact(profileId, attached.id)).extraction;
    await store.db.put('extractions', { ...extraction, confirmed: false });
    await expect(
      buildContext({ ...options(store, profileId), attachmentIds: [attached.id] }),
    ).resolves.toMatchObject({ model: 'test-model' });
    await store.db.put('extractions', {
      ...extraction,
      losses: ['本次只提取文字'],
      confirmed: false,
    });
    await expect(
      buildContext({ ...options(store, profileId), attachmentIds: [attached.id] }),
    ).rejects.toMatchObject({ code: 'attachment_needs_review' });
    await store.db.put('extractions', { ...extraction, confirmationKey: 'older binding' });
    await expect(
      buildContext({ ...options(store, profileId), attachmentIds: [attached.id] }),
    ).rejects.toMatchObject({ code: 'attachment_needs_review' });
  });
  it('blocks shifted attachment overload rather than silently truncating the active session', async () => {
    const { store, profileId, conversationId } = await setup();
    const ids: string[] = [];
    for (let index = 0; index < 5; index++)
      ids.push(
        (await store.commitAttachment(profileId, await input(`文档 ${index}`, `${index}.txt`))).id,
      );
    const branch = history(profileId, conversationId, [
      { text: '第一问', attachments: ids.slice(0, 4) },
      { text: '第二问', attachments: ids.slice(4) },
      { text: '第三问' },
    ]);
    await expect(
      buildContext({ ...options(store, profileId, branch), startId: branch[4]!.id }),
    ).rejects.toMatchObject({ code: 'request_too_large' });
    expect((await store.listAttachments(profileId)).length).toBe(5);
  });
  it('supports explicit temporary text history and refuses temporary attachment references', async () => {
    const branch = history('temporary', 'temporary-conversation', [{ text: '临时问题' }]);
    expect((await buildContext(options(null, 'temporary', branch))).messages).toHaveLength(3);
    await expect(
      buildContext({ ...options(null, 'temporary', branch), attachmentIds: [crypto.randomUUID()] }),
    ).rejects.toMatchObject({ code: 'attachment_missing' });
  });
});
