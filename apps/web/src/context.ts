import {
  APP_CONTRACT_VERSION,
  POLICY_VERSION,
  ContractError,
  validateChatRequest,
  rebuildGatewayRequest,
  type ChatRequest,
  type ChatMessage,
  type ModelCapability,
  type PublicConfig,
} from '@chat/contracts';
import { PARSER_VERSION } from '@chat/file-review';
import {
  StorageError,
  confirmationKey,
  sha256,
  type ChatStore,
  type Message,
  type AttachmentBinding,
} from '@chat/local-store';
import { base64 } from './utils';

export interface Snapshot {
  request: ChatRequest;
  text: string;
  attachmentIds: string[];
  parentId: string | null;
  conversationId: string;
  profileId: string;
  revision: number;
  model: string;
  attachmentBindings?: AttachmentBinding[];
}
export async function buildContext(options: {
  store: ChatStore | null;
  profileId: string;
  history: Message[];
  text: string;
  attachmentIds: string[];
  excluded: string[];
  startId: string | null;
  model: string;
  config: PublicConfig;
  models: ModelCapability[];
  attachmentBindings?: AttachmentBinding[];
}): Promise<ChatRequest> {
  const { store, profileId, config } = options;
  if (config.schemaVersion !== APP_CONTRACT_VERSION || config.policyVersion !== POLICY_VERSION)
    throw new ContractError('policy_outdated');
  // Validate the entire supplied branch before selecting a shorter context. A stale UI render
  // must never combine the newly selected local profile with the old profile's message text.
  const conversationId = options.history[0]?.conversationId;
  const messageIds = new Set<string>();
  for (const [index, message] of options.history.entries()) {
    if (
      message.profileId !== profileId ||
      message.conversationId !== conversationId ||
      messageIds.has(message.id) ||
      message.parentId !== (index ? options.history[index - 1].id : null)
    )
      throw new StorageError('storage_conflict');
    if (message.role === 'assistant' && message.attachmentIds.length)
      throw new StorageError('storage_conflict');
    messageIds.add(message.id);
  }
  const from = options.startId
    ? options.history.findIndex((message) => message.id === options.startId)
    : 0;
  if (from === -1) throw new StorageError('storage_conflict');
  const history = options.history.slice(from);
  while (history[0]?.role === 'assistant') history.shift();
  const excluded = new Set(options.excluded);
  const activeIds = [
    ...new Set(
      options.history.flatMap((message) => message.attachmentIds).filter((id) => !excluded.has(id)),
    ),
  ];
  const requestedIds = [
    ...new Set([...activeIds, ...options.attachmentIds.filter((id) => !excluded.has(id))]),
  ];
  type Material = Awaited<ReturnType<ChatStore['getArtifact']>> & { identity: string };
  const materials = new Map<string, Material>();
  const identities = new Map<string, string>();
  for (const id of requestedIds) {
    if (!store) throw new StorageError('attachment_missing');
    const artifact = await store.getArtifact(profileId, id);
    const { attachment, source, normalized, extraction } = artifact;
    if (
      attachment.status !== 'ready' ||
      attachment.policyVersion !== config.policyVersion ||
      attachment.parserVersion !== PARSER_VERSION ||
      extraction.policyVersion !== attachment.policyVersion ||
      extraction.parserVersion !== attachment.parserVersion ||
      extraction.normalizedSha256 !== attachment.normalizedSha256 ||
      extraction.confirmationKey !== confirmationKey(attachment) ||
      (extraction.losses.length > 0 && !extraction.confirmed)
    )
      throw new StorageError('attachment_needs_review');
    if (
      (attachment.kind === 'image' && !config.features.images) ||
      (/\.pdf$/i.test(attachment.name) && !config.features.pdf) ||
      (/\.docx$/i.test(attachment.name) && !config.features.docx)
    )
      throw new StorageError('attachment_needs_review');
    const [sourceHash, normalizedHash] = await Promise.all([sha256(source), sha256(normalized)]);
    if (
      sourceHash !== attachment.sourceSha256 ||
      normalizedHash !== attachment.normalizedSha256 ||
      (attachment.kind === 'text' &&
        (extraction.text === undefined || (await normalized.text()) !== extraction.text))
    )
      throw new StorageError('attachment_needs_review');
    options.attachmentBindings?.push({
      id,
      sourceSha256: attachment.sourceSha256,
      normalizedSha256: attachment.normalizedSha256,
      policyVersion: attachment.policyVersion,
      parserVersion: attachment.parserVersion,
    });
    const identity = `${attachment.sourceSha256}:${attachment.normalizedSha256}`;
    materials.set(id, { ...artifact, identity });
  }
  const seen = new Set<string>();
  const messages: ChatMessage[] = [];
  const materialize = async (
    message: { role: 'user' | 'assistant'; text: string; attachmentIds: string[] },
    reinjectedIds: string[] = [],
  ) => {
    if (message.role === 'assistant') {
      if (message.text)
        messages.push({ role: 'assistant', content: [{ type: 'text', text: message.text }] });
      return;
    }
    const content: ChatMessage['content'] = [{ type: 'text', text: message.text }];
    const references: string[] = [];
    for (const id of [...new Set([...reinjectedIds, ...message.attachmentIds])]) {
      if (excluded.has(id)) continue;
      const material = materials.get(id);
      if (!material) throw new StorageError('attachment_missing');
      const { attachment, normalized, extraction, identity } = material;
      let label = identities.get(identity);
      if (!label) {
        label = `A${identities.size + 1}`;
        identities.set(identity, label);
      }
      if (seen.has(identity)) {
        // A stable ordinal explicitly points to the earlier full item, without reinjecting it.
        references.push(
          `继续引用附件 ${label}（本轮第 ${label.slice(1)} 份资料）：${JSON.stringify(attachment.name)}`,
        );
        continue;
      }
      seen.add(identity);
      if (attachment.kind === 'text')
        content.push({ type: 'document_text', name: attachment.name, text: extraction.text! });
      else {
        if (attachment.mimeType !== 'image/jpeg' && attachment.mimeType !== 'image/png')
          throw new ContractError('invalid_image');
        content.push({
          type: 'image',
          mimeType: attachment.mimeType,
          base64: base64(new Uint8Array(await normalized.arrayBuffer())),
        });
      }
    }
    if (references.length)
      content[0] = {
        type: 'text',
        text: `${message.text}\n\n[${[...new Set(references)].join('\n')}]`,
      };
    messages.push({ role: 'user', content });
  };
  // Session attachment selection survives choosing a later context start. Only the references
  // whose original introduction was excluded move to the new first retained user message.
  const retainedIds = new Set(history.flatMap((message) => message.attachmentIds));
  const reinjected = activeIds.filter((id) => !retainedIds.has(id));
  for (const [index, message] of history.entries())
    await materialize(message, index === 0 ? reinjected : []);
  await materialize(
    { role: 'user', text: options.text, attachmentIds: options.attachmentIds },
    history.length ? [] : reinjected,
  );
  const request = validateChatRequest(
    {
      schemaVersion: APP_CONTRACT_VERSION,
      policyVersion: config.policyVersion,
      clientRequestId: crypto.randomUUID(),
      model: options.model,
      messages,
    },
    { models: options.models, images: config.features.images },
  );
  rebuildGatewayRequest(request);
  return structuredClone(request);
}
