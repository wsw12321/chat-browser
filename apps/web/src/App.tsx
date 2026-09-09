import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  APP_CONTRACT_VERSION,
  POLICY_VERSION,
  POLICY,
  ContractError,
  GATEWAY_URL_HEADER,
  normalizeGatewayUrl,
  ResponseReconciler,
  SSEParser,
  requestMetrics,
  type PublicConfig,
  type ModelCapability,
  type SafeError,
} from '@chat/contracts';
import {
  openLocalStore,
  StorageError,
  type ChatStore,
  type Profile,
  type Conversation,
  type Message,
  type Attachment,
  type ConversationLease,
  type GenerationStatus,
  type GenerationRun,
  type Usage,
  type AttachmentBinding,
} from '@chat/local-store';
import {
  precheckBatch,
  reviewFile,
  PARSER_VERSION,
  type ReviewedArtifact,
} from '@chat/file-review';
import { getConfig, getModels, apiError, ApiError } from './api';
import { buildContext, type Snapshot } from './context';
import { download, errorCode, errorMessage, formatBytes, toAttachmentInput } from './utils';
import { Icon } from './icons';

type DraftFile = {
  id: string;
  name: string;
  size: number;
  status: 'selected' | 'parsing' | 'awaiting_confirmation' | 'ready' | 'rejected' | 'cancelled';
  artifact?: ReviewedArtifact;
  attachment?: Attachment;
  error?: string;
  progress?: string;
  existingId?: string;
};
const initialConfig: PublicConfig = {
  schemaVersion: APP_CONTRACT_VERSION,
  policyVersion: POLICY_VERSION,
  policy: POLICY,
  features: { pdf: false, docx: false, images: false },
};
const statuses: Record<string, string> = {
  selected: '等待检查',
  parsing: '检查中',
  awaiting_confirmation: '等待确认',
  ready: '可发送',
  rejected: '已拒绝',
  cancelled: '已取消',
  preparing: '等待回复',
  streaming: '正在生成',
  completed: '已完成',
  failed: '生成失败',
  interrupted: '连接中断',
  incomplete: '回复不完整',
  needs_review: '需重新检查',
};

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className="modal"
      onCancel={(event) => {
        event.preventDefault();
        onClose?.();
      }}
    >
      <header>
        <h2>{title}</h2>
        {onClose && (
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <Icon name="close" />
          </button>
        )}
      </header>
      {children}
    </dialog>
  );
}
function BlobImage({ blob, name }: { blob: Blob; name: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return <img className="image-preview" src={url || undefined} alt={name} />;
}
const SafeMarkdown = lazy(() => import('./SafeMarkdown'));

function RunDetails({ run }: { run: GenerationRun | undefined }) {
  if (!run) return null;
  return (
    <details className="run-details">
      <summary>请求信息</summary>
      <p>
        网站请求 ID：{run.requestId || '未取得'}
        <br />
        Gateway 请求 ID：{run.gatewayRequestId || '未取得'}
        <br />
        Response ID：{run.responseId || '未取得'}
      </p>
      {run.errorCode && <p>{errorMessage(run.errorCode)}</p>}
      {run.usage && <p>上游返回用量：{JSON.stringify(run.usage)}</p>}
    </details>
  );
}

export function App() {
  const [store, setStore] = useState<ChatStore | null>(null),
    [storageFailed, setStorageFailed] = useState(false),
    [readOnly, setReadOnly] = useState(false),
    [temporary, setTemporary] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]),
    [profileId, setProfileId] = useState(''),
    [profileName, setProfileName] = useState('我的资料');
  const [conversations, setConversations] = useState<Conversation[]>([]),
    [conversation, setConversation] = useState<Conversation | null>(null),
    [messages, setMessages] = useState<Message[]>([]),
    [allMessages, setAllMessages] = useState<Message[]>([]),
    [runs, setRuns] = useState<GenerationRun[]>([]);
  const [config, setConfig] = useState<PublicConfig>(initialConfig),
    [key, setKey] = useState(''),
    [keyDraft, setKeyDraft] = useState(''),
    [gatewayUrl, setGatewayUrl] = useState(''),
    [gatewayUrlDraft, setGatewayUrlDraft] = useState<string | null>(null),
    [models, setModels] = useState<ModelCapability[]>([]),
    [model, setModel] = useState('');
  const [connecting, setConnecting] = useState(false),
    [connectProfile, setConnectProfile] = useState(''),
    [settingsOpen, setSettingsOpen] = useState(false),
    [settingsPanel, setSettingsPanel] = useState<'gateway' | 'local'>('gateway');
  const [draft, setDraft] = useState(''),
    [files, setFiles] = useState<DraftFile[]>([]),
    [attachments, setAttachments] = useState<Attachment[]>([]),
    [excluded, setExcluded] = useState<string[]>([]),
    [startId, setStartId] = useState<string | null>(null),
    [branchParent, setBranchParent] = useState<string | null | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [preview, setPreview] = useState<ReviewedArtifact | null>(null),
    [previewFile, setPreviewFile] = useState<string | null>(null),
    [building, setBuilding] = useState(false),
    [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState(''),
    [diagnostic, setDiagnostic] = useState<SafeError | null>(null),
    [usage, setUsage] = useState<Usage | null>(null),
    [online, setOnline] = useState(navigator.onLine),
    [sidebar, setSidebar] = useState(false),
    [search, setSearch] = useState('');
  const [backupBusy, setBackupBusy] = useState(false),
    [backupProgress, setBackupProgress] = useState(''),
    [updateWaiting, setUpdateWaiting] = useState<ServiceWorker | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
      kind: 'conversation' | 'profile';
      id: string;
      name: string;
    } | null>(null),
    [rename, setRename] = useState<{ id: string; title: string; revision: number } | null>(null);
  const [unsaved, setUnsaved] = useState(''),
    [booting, setBooting] = useState(true);
  const abortRef = useRef<AbortController | null>(null),
    backupAbort = useRef<AbortController | null>(null),
    fileControllers = useRef(new Map<string, AbortController>()),
    inputRef = useRef<HTMLInputElement>(null),
    backupInputRef = useRef<HTMLInputElement>(null),
    tail = useRef<HTMLDivElement>(null),
    loadVersion = useRef(0),
    busyRef = useRef(false);
  const parsing = files.some((file) => file.status === 'selected' || file.status === 'parsing');
  const profile = profiles.find((item) => item.id === profileId);
  const busy = generating || parsing || backupBusy || building;
  const gatewayInput = gatewayUrlDraft ?? (gatewayUrl || config.gatewayUrl || '');
  busyRef.current = generating;

  const report = useCallback((error: unknown) => {
    setNotice(errorMessage(error));
    if (error instanceof ApiError) {
      setDiagnostic(error.detail);
      if (error.code === 'unauthorized') {
        setKey('');
        setKeyDraft('');
        setModels([]);
        setSettingsPanel('gateway');
        setSettingsOpen(true);
      }
    }
  }, []);
  const refresh = useCallback(async (db: ChatStore, pid: string, cid?: string) => {
    const token = ++loadVersion.current;
    const [list, budget, attachmentList] = await Promise.all([
      db.listConversations(pid),
      db.usage(),
      db.listAttachments(pid),
    ]);
    if (token !== loadVersion.current) return;
    setConversations(list);
    setUsage(budget);
    setAttachments(attachmentList);
    const current = cid ? list.find((c) => c.id === cid) : list[0];
    if (current) {
      const [branch, full, runsValue, excludedValue, startValue] = await Promise.all([
        db.getBranch(pid, current.id),
        db.listMessages(pid, current.id),
        db.listGenerationRuns(pid, current.id),
        db.getSetting<string[]>(pid, `excludedAttachmentIds/${current.id}`),
        db.getSetting<string | null>(pid, `contextStart/${current.id}`),
      ]);
      if (token !== loadVersion.current) return;
      setConversation(current);
      setMessages(branch);
      setAllMessages(full);
      setRuns(runsValue);
      setExcluded(excludedValue ?? []);
      setStartId(startValue ?? null);
    } else {
      setConversation(null);
      setMessages([]);
      setAllMessages([]);
      setRuns([]);
      setExcluded([]);
      setStartId(null);
    }
  }, []);

  useEffect(() => {
    let disposed = false,
      db: ChatStore | undefined;
    void getConfig()
      .then((value) => {
        if (!disposed) setConfig(value);
      })
      .catch(() => {
        if (!disposed && navigator.onLine) setNotice('暂时无法连接服务；本机历史仍可查看。');
      });
    void openLocalStore({
      readOnlyOnVersionError: true,
      onBlocked: () => setNotice('数据库升级正在等待其他标签页关闭，请关闭旧页面后重试。'),
      onVersionChange: () => {
        setReadOnly(true);
        abortRef.current?.abort();
        setNotice('其他标签页正在更新数据库。本页已停止写入，请导出未保存内容后刷新。');
      },
    })
      .then(async (opened) => {
        db = opened;
        if (disposed) {
          opened.close();
          return;
        }
        setStore(opened);
        setReadOnly(opened.readOnly);
        if (opened.readOnly)
          setNotice(
            '此数据库由较新版本创建，当前以只读模式打开。可查看历史和导出备份，请更新应用后编辑。',
          );
        const list = await opened.listProfiles();
        if (disposed) return;
        setProfiles(list);
        if (list[0]) {
          setProfileId(list[0].id);
          setConnectProfile(list[0].id);
          if (!opened.readOnly) {
            await opened.recoverInterrupted(list[0].id);
            await opened.gc(list[0].id);
          }
          await refresh(opened, list[0].id);
        }
      })
      .catch(() => setStorageFailed(true))
      .finally(() => setBooting(false));
    return () => {
      disposed = true;
      db?.close();
      abortRef.current?.abort();
      backupAbort.current?.abort();
      for (const controller of fileControllers.current.values()) controller.abort();
    };
  }, [refresh]);
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);
    const leave = () => {
      abortRef.current?.abort();
      for (const controller of fileControllers.current.values()) controller.abort();
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('online', changed);
      window.removeEventListener('offline', changed);
      window.removeEventListener('pagehide', leave);
    };
  }, []);
  useEffect(() => {
    if (!store || !profileId) return;
    const sync = () => {
      if (!busyRef.current) void refresh(store, profileId, conversation?.id).catch(report);
    };
    const off = store.subscribe(sync);
    const timer = setInterval(() => {
      if (!busyRef.current && !store.readOnly)
        void store
          .recoverInterrupted(profileId)
          .then((count) => {
            if (count) sync();
          })
          .catch(() => {});
    }, 5000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [store, profileId, conversation?.id, refresh, report]);
  useEffect(() => {
    if ('serviceWorker' in navigator)
      void navigator.serviceWorker.ready.then((reg) => {
        if (reg.waiting) setUpdateWaiting(reg.waiting);
        reg.addEventListener('updatefound', () =>
          reg.installing?.addEventListener('statechange', () => {
            if (reg.waiting) setUpdateWaiting(reg.waiting);
          }),
        );
      });
  }, []);
  useEffect(() => {
    tail.current?.scrollIntoView({ behavior: generating ? 'instant' : 'smooth', block: 'end' });
  }, [messages.length, generating]);

  async function selectProfile(id: string) {
    if (!store) return;
    setBuilding(true);
    setConversation(null);
    setMessages([]);
    setAllMessages([]);
    setRuns([]);
    setAttachments([]);
    setConversations([]);
    setKey('');
    setKeyDraft('');
    setModels([]);
    setModel('');
    setDraft('');
    setFiles([]);
    setSnapshot(null);
    setBranchParent(undefined);
    setProfileId(id);
    setConnectProfile(id);
    try {
      if (!store.readOnly) {
        await store.recoverInterrupted(id);
        await store.gc(id);
      }
      await refresh(store, id);
    } finally {
      setBuilding(false);
    }
  }
  async function createProfile(event: FormEvent) {
    event.preventDefault();
    if (!store) return;
    try {
      const created = await store.createProfile(profileName);
      setProfiles(await store.listProfiles());
      await selectProfile(created.id);
      setSettingsOpen(false);
    } catch (error) {
      report(error);
    }
  }
  async function connect(event: FormEvent) {
    event.preventDefault();
    if (busy || connecting) return;
    setConnecting(true);
    setNotice('');
    setDiagnostic(null);
    const value = keyDraft.trim();
    try {
      const destination = normalizeGatewayUrl(gatewayInput);
      const [available, latest] = await Promise.all([getModels(value, destination), getConfig()]);
      if (!available.length) {
        setNotice('当前 Key 的模型与网站已验收模型没有交集，请联系部署人员。');
        return;
      }
      if (store && connectProfile !== profileId) await selectProfile(connectProfile);
      setConfig(latest);
      setModels(available);
      setModel(available.some((m) => m.id === model) ? model : available[0].id);
      setKey(value);
      setKeyDraft('');
      setGatewayUrl(destination);
      setGatewayUrlDraft(null);
      setSnapshot(null);
      setSettingsOpen(false);
    } catch (error) {
      setNotice(errorMessage(error));
      if (error instanceof ApiError) setDiagnostic(error.detail);
    } finally {
      setConnecting(false);
    }
  }
  async function newConversation() {
    if (busy) return;
    setDraft('');
    setFiles([]);
    setBranchParent(undefined);
    setSidebar(false);
    try {
      if (store) {
        const created = await store.createConversation(profileId, model);
        await refresh(store, profileId, created.id);
      } else {
        setConversation({
          id: crypto.randomUUID(),
          profileId: 'temporary',
          title: '临时对话',
          model,
          currentLeafId: null,
          revision: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        setMessages([]);
        setAllMessages([]);
      }
    } catch (error) {
      report(error);
    }
  }
  function updateFile(id: string, change: Partial<DraftFile>) {
    setFiles((current) => current.map((file) => (file.id === id ? { ...file, ...change } : file)));
  }
  async function saveArtifact(file: DraftFile, artifact: ReviewedArtifact) {
    if (!store) throw new StorageError('storage_unavailable');
    const attachment = file.existingId
      ? await store.reReviewAttachment(
          profileId,
          file.existingId,
          toAttachmentInput(artifact, true),
        )
      : await store.commitAttachment(profileId, toAttachmentInput(artifact, true));
    updateFile(file.id, { attachment, artifact, status: 'ready' });
    setAttachments(await store.listAttachments(profileId));
    setUsage(await store.usage());
  }
  async function addFiles(list: File[]) {
    if (!store || readOnly || temporary || parsing) return;
    try {
      precheckBatch(list);
    } catch (error) {
      report(error);
      return;
    }
    const batch = list.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      status: 'selected' as const,
    }));
    setFiles((current) => [...current, ...batch]);
    for (const file of batch) fileControllers.current.set(file.id, new AbortController());
    let batchText = 0;
    for (let index = 0; index < batch.length; index++) {
      const item = batch[index],
        controller = fileControllers.current.get(item.id)!;
      if (controller.signal.aborted) {
        updateFile(item.id, { status: 'cancelled' });
        continue;
      }
      try {
        updateFile(item.id, { status: 'parsing' });
        const artifact = await reviewFile(list[index], {
          signal: controller.signal,
          features: config.features,
          onProgress: (progress) =>
            updateFile(item.id, {
              progress: progress.total
                ? `${progress.completed ?? 0} / ${progress.total}`
                : '正在本机检查',
            }),
        });
        batchText += artifact.text ? new TextEncoder().encode(artifact.text).length : 0;
        if (batchText > POLICY.parsing.batchTextBytes)
          throw Object.assign(new Error(), { code: 'extracted_text_too_large' });
        updateFile(item.id, {
          artifact,
          status: artifact.requiresConfirmation ? 'awaiting_confirmation' : 'parsing',
        });
        if (!artifact.requiresConfirmation) await saveArtifact(item, artifact);
      } catch (error) {
        updateFile(item.id, {
          status: controller.signal.aborted ? 'cancelled' : 'rejected',
          error: errorMessage(error),
          artifact: undefined,
        });
      } finally {
        fileControllers.current.delete(item.id);
      }
    }
  }
  async function recheckAttachment(id: string) {
    if (!store || busy) return;
    try {
      const existing = await store.getArtifact(profileId, id);
      const item: DraftFile = {
        id: crypto.randomUUID(),
        name: existing.attachment.name,
        size: existing.source.size,
        status: 'parsing',
        existingId: id,
      };
      setFiles((current) => [...current, item]);
      const controller = new AbortController();
      fileControllers.current.set(item.id, controller);
      try {
        const artifact = await reviewFile(
          new File([existing.source], existing.attachment.name, { type: existing.source.type }),
          { signal: controller.signal, features: config.features },
        );
        updateFile(item.id, {
          artifact,
          status: artifact.requiresConfirmation ? 'awaiting_confirmation' : 'parsing',
        });
        if (!artifact.requiresConfirmation) await saveArtifact(item, artifact);
      } catch (error) {
        updateFile(item.id, { status: 'rejected', error: errorMessage(error) });
      } finally {
        fileControllers.current.delete(item.id);
      }
    } catch (error) {
      report(error);
    }
  }
  async function removeFile(file: DraftFile) {
    fileControllers.current.get(file.id)?.abort();
    setFiles((current) => current.filter((item) => item.id !== file.id));
    if (file.attachment && !file.existingId && store)
      await store.removeAttachment(profileId, file.attachment.id).catch(() => {});
  }
  async function setExcludedIds(ids: string[]) {
    setExcluded(ids);
    if (store && conversation)
      await store
        .setSetting(profileId, `excludedAttachmentIds/${conversation.id}`, ids)
        .catch(report);
  }
  async function previewSend() {
    if (!key) {
      setConnectProfile(profileId);
      setSettingsPanel('gateway');
      setSettingsOpen(true);
      return;
    }
    if (!online) {
      setNotice(errorMessage('offline'));
      return;
    }
    if (!draft.trim() || generating) return;
    if (files.some((file) => file.status !== 'ready')) {
      setNotice('请先确认、取消或移除未就绪附件。');
      return;
    }
    setBuilding(true);
    setNotice('');
    setDiagnostic(null);
    try {
      const latest = await getConfig();
      setConfig(latest);
      if (
        latest.policyVersion !== config.policyVersion ||
        latest.schemaVersion !== config.schemaVersion
      )
        throw new ContractError('policy_outdated');
      let selected = conversation;
      if (!selected) {
        if (store) {
          selected = await store.createConversation(profileId, model);
          await refresh(store, profileId, selected.id);
        } else
          selected = {
            id: crypto.randomUUID(),
            profileId: 'temporary',
            title: '临时对话',
            model,
            currentLeafId: null,
            revision: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
      }
      const parentId = branchParent === undefined ? selected.currentLeafId : branchParent;
      const history =
        branchParent === undefined
          ? messages
          : store
            ? await store.getBranch(profileId, selected.id, parentId)
            : messages.slice(0, messages.findIndex((m) => m.id === parentId) + 1);
      const attachmentIds = files.flatMap((file) => (file.attachment ? [file.attachment.id] : []));
      const attachmentBindings: AttachmentBinding[] = [];
      const request = await buildContext({
        attachmentBindings,
        store,
        profileId: store ? profileId : 'temporary',
        history,
        text: draft,
        attachmentIds,
        excluded,
        startId: branchParent === undefined ? startId : null,
        model,
        config: latest,
        models,
      });
      setSnapshot({
        request,
        attachmentBindings,
        text: draft,
        attachmentIds,
        parentId,
        conversationId: selected.id,
        profileId: store ? profileId : 'temporary',
        revision: selected.revision,
        model,
      });
      setConversation(selected);
    } catch (error) {
      report(error);
    } finally {
      setBuilding(false);
    }
  }
  async function generate() {
    const fixed = snapshot;
    if (!fixed || generating) return;
    setSnapshot(null);
    setGenerating(true);
    busyRef.current = true;
    setNotice('');
    setUnsaved('');
    setDiagnostic(null);
    const controller = new AbortController();
    abortRef.current = controller;
    let lease: ConversationLease | undefined,
      runId = '',
      assistantId = '',
      text = '',
      lastSave = 0,
      requestId = '',
      gatewayRequestId = '',
      finalSaved = false;
    let finalState: GenerationStatus = 'interrupted',
      responseId: string | undefined,
      usageValue: Record<string, number> | undefined;
    let finalError: string | undefined;
    const timeout = setTimeout(() => controller.abort('timeout'), POLICY.timeouts.generationMs);
    const setOutput = (value: string, state: GenerationStatus) => {
      text = value;
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId ? { ...message, text: value, status: state } : message,
        ),
      );
    };
    const persist = async (state: GenerationStatus) => {
      if (store && runId) {
        await store.saveGeneration(fixed.profileId, runId, {
          text,
          status: state,
          requestId,
          gatewayRequestId,
          responseId,
          usage: usageValue,
          errorCode: finalError,
        });
        lastSave = Date.now();
      }
    };
    try {
      if (store) {
        lease = await store.acquireConversationLock(fixed.profileId, fixed.conversationId);
        const prepared = await store.prepareGeneration({
          profileId: fixed.profileId,
          conversationId: fixed.conversationId,
          text: fixed.text,
          attachmentIds: fixed.attachmentIds,
          parentId: fixed.parentId,
          model: fixed.model,
          expectedRevision: fixed.revision,
          ownerId: lease.ownerId,
          attachmentBindings: fixed.attachmentBindings,
        });
        runId = prepared.run.id;
        assistantId = prepared.assistant.id;
        setConversation(prepared.conversation);
        setMessages([...(await store.getBranch(fixed.profileId, fixed.conversationId))]);
      } else {
        const user: Message = {
          id: crypto.randomUUID(),
          profileId: 'temporary',
          conversationId: fixed.conversationId,
          parentId: fixed.parentId,
          role: 'user',
          text: fixed.text,
          attachmentIds: [],
          attemptId: fixed.request.clientRequestId,
          status: 'completed',
          createdAt: Date.now(),
        };
        assistantId = crypto.randomUUID();
        const assistant: Message = {
          ...user,
          id: assistantId,
          parentId: user.id,
          role: 'assistant',
          text: '',
          status: 'preparing',
        };
        setMessages((current) => [
          ...(fixed.parentId
            ? current.slice(0, current.findIndex((item) => item.id === fixed.parentId) + 1)
            : []),
          user,
          assistant,
        ]);
        setConversation((current) =>
          current
            ? { ...current, currentLeafId: assistantId, revision: current.revision + 1 }
            : current,
        );
      }
      setDraft('');
      setFiles([]);
      setBranchParent(undefined);
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          [GATEWAY_URL_HEADER]: gatewayUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(fixed.request),
        signal: controller.signal,
        cache: 'no-store',
      });
      requestId = response.headers.get('X-Webchat-Request-ID') ?? '';
      gatewayRequestId = response.headers.get('X-Gateway-Request-ID') ?? '';
      if (!response.ok) throw await apiError(response);
      if (!response.body || !response.headers.get('Content-Type')?.startsWith('text/event-stream'))
        throw new ContractError('stream_invalid');
      const reader = response.body.getReader(),
        parser = new SSEParser(),
        reconciler = new ResponseReconciler();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            parser.finish();
            break;
          }
          for (const event of parser.push(result.value)) {
            const state = reconciler.consume(event);
            setOutput(state.text, state.state === 'pending' ? 'preparing' : state.state);
            responseId = state.responseId;
            usageValue = state.usage
              ? Object.fromEntries(
                  Object.entries(state.usage).filter(
                    (entry): entry is [string, number] => typeof entry[1] === 'number',
                  ),
                )
              : undefined;
            if (state.error) {
              finalError = state.error.code;
              setDiagnostic({
                ...state.error,
                requestId: state.error.requestId || requestId,
                gatewayRequestId: state.error.gatewayRequestId || gatewayRequestId || null,
              });
              setNotice(state.error.message);
            }
            if (reconciler.terminal) break;
          }
          if (reconciler.terminal) break;
          if (Date.now() - lastSave >= POLICY.storage.streamSaveMs) await persist('streaming');
        }
        const final = reconciler.finish();
        finalState = final.state === 'pending' ? 'interrupted' : final.state;
        setOutput(final.text, finalState);
        if (final.error) {
          finalError = final.error.code;
          setNotice(final.error.message);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      await persist(finalState);
      finalSaved = true;
    } catch (error) {
      finalError = controller.signal.aborted ? 'cancelled' : errorCode(error);
      finalState = controller.signal.aborted
        ? 'cancelled'
        : error instanceof StorageError
          ? 'interrupted'
          : 'failed';
      if (controller.signal.reason === 'timeout') {
        finalError = 'upstream_timeout';
        finalState = 'incomplete';
      }
      controller.abort();
      setOutput(text, finalState);
      if (finalError !== 'cancelled') report(error);
      else setNotice('已停止生成。已有内容已保留；再次尝试可能产生新的额度消耗。');
      if (runId) {
        try {
          await persist(finalState);
          finalSaved = true;
        } catch {
          setUnsaved(text || fixed.text);
          setNotice(errorMessage('local_storage_full'));
        }
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
      if (lease) await lease.release().catch(report);
      abortRef.current = null;
      setGenerating(false);
      busyRef.current = false;
      if (store && (!runId || finalSaved))
        await refresh(store, fixed.profileId, fixed.conversationId).catch(report);
    }
  }
  async function editMessage(message: Message) {
    if (busy) return;
    const user =
      message.role === 'user'
        ? message
        : (allMessages.find((item) => item.id === message.parentId) ??
          messages.find((item) => item.id === message.parentId));
    if (!user) return;
    setDraft(user.text);
    setBranchParent(user.parentId);
    setStartId(null);
    const restored: DraftFile[] = [];
    if (store)
      for (const id of user.attachmentIds) {
        const attachment = await store.getAttachment(profileId, id);
        if (attachment)
          restored.push({
            id: crypto.randomUUID(),
            name: attachment.name,
            size: attachment.sourceSize,
            status: attachment.status === 'ready' ? 'ready' : 'rejected',
            attachment,
            existingId: id,
            error:
              attachment.status === 'ready' ? undefined : errorMessage('attachment_needs_review'),
          });
        else
          restored.push({
            id: crypto.randomUUID(),
            name: '原附件缺失',
            size: 0,
            status: 'rejected',
            error: errorMessage('attachment_missing'),
          });
      }
    setFiles(restored);
    setNotice('正在创建新的回复分支，原来的内容会保留。确认发送将产生一次新请求。');
  }
  async function exportBackup(all: boolean) {
    if (!store) return;
    setBackupBusy(true);
    setBackupProgress('正在检查并打包本机记录…');
    try {
      download(
        await store.exportBackup(
          profileId,
          all ? undefined : conversation ? [conversation.id] : [],
        ),
        `纸间-${new Date().toISOString().slice(0, 10)}.chatbackup`,
      );
    } catch (error) {
      report(error);
    } finally {
      setBackupBusy(false);
      setBackupProgress('');
    }
  }
  async function importBackup(file: File) {
    if (!store) return;
    setBackupBusy(true);
    const controller = new AbortController();
    backupAbort.current = controller;
    try {
      const imported = await store.importBackup(profileId, file, {
        signal: controller.signal,
        onProgress: (done, total) => setBackupProgress(`正在恢复 ${done} / ${total}`),
        review: async (source, attachment, signal) => {
          const artifact = await reviewFile(
            new File([source], attachment.name, { type: source.type }),
            { signal, features: config.features },
          );
          return toAttachmentInput(artifact, !artifact.requiresConfirmation);
        },
      });
      await refresh(store, profileId, imported[0]?.id);
      setNotice('备份已恢复到当前档案。需要提取模式确认的附件，请重新检查预览后再发送。');
    } catch (error) {
      report(error);
    } finally {
      setBackupBusy(false);
      setBackupProgress('');
      backupAbort.current = null;
    }
  }
  async function confirmDelete() {
    if (!store || !deleteTarget) return;
    try {
      if (deleteTarget.kind === 'conversation') {
        await store.deleteConversation(profileId, deleteTarget.id);
        await refresh(
          store,
          profileId,
          conversation?.id === deleteTarget.id ? undefined : conversation?.id,
        );
      } else {
        await store.deleteProfile(deleteTarget.id);
        const list = await store.listProfiles();
        setProfiles(list);
        setKey('');
        setKeyDraft('');
        if (list[0]) await selectProfile(list[0].id);
        else {
          setProfileId('');
          setConversation(null);
          setMessages([]);
          setConversations([]);
          setSettingsOpen(false);
        }
      }
      setDeleteTarget(null);
    } catch (error) {
      report(error);
    }
  }
  const referencedIds = [...new Set(messages.flatMap((message) => message.attachmentIds))];
  const relatedAttachments = referencedIds.map((id) => ({
    id,
    attachment: attachments.find((a) => a.id === id),
  }));
  const accepted = [
    '.txt',
    '.md',
    '.markdown',
    '.json',
    '.csv',
    ...(config.features.pdf ? ['.pdf'] : []),
    ...(config.features.docx ? ['.docx'] : []),
    ...(config.features.images ? ['.jpg', '.jpeg', '.png', '.webp'] : []),
  ].join(',');
  const sendDisabled =
    generating ||
    building ||
    readOnly ||
    !draft.trim() ||
    files.some((file) => file.status !== 'ready');

  return (
    <div className="app">
      {sidebar && (
        <button className="sidebar-scrim" aria-label="收起导航" onClick={() => setSidebar(false)} />
      )}
      <aside className={`sidebar ${sidebar ? 'open' : ''}`}>
        <a className="brand" href="/" onClick={(event) => event.preventDefault()}>
          <span className="brand-mark">
            <Icon name="chat" size={25} />
          </span>
          <span>
            纸间<small>留一点空间，认真对话。</small>
          </span>
        </a>
        <button
          className="new-chat"
          onClick={() => void newConversation()}
          disabled={busy || readOnly || (!profileId && !temporary)}
        >
          <Icon name="plus" />
          新建对话<span>＋</span>
        </button>
        <label className="search">
          <Icon name="chat" size={16} />
          <input
            aria-label="搜索会话"
            placeholder="搜索本机对话"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="section-label">
          本机对话 <span>{conversations.length}</span>
        </div>
        <nav className="conversation-list" aria-label="会话列表">
          {conversations
            .filter((c) => c.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
            .map((item) => (
              <div
                className={`conversation-row ${item.id === conversation?.id ? 'active' : ''}`}
                key={item.id}
              >
                <button
                  className="conversation-select"
                  disabled={busy}
                  onClick={() => {
                    setDraft('');
                    setFiles([]);
                    setBranchParent(undefined);
                    setSidebar(false);
                    void refresh(store!, profileId, item.id).catch(report);
                  }}
                >
                  <Icon name="chat" size={17} />
                  <span>{item.title}</span>
                </button>
                <button
                  className="row-action"
                  aria-label={`重命名 ${item.title}`}
                  disabled={busy || readOnly}
                  onClick={() =>
                    setRename({ id: item.id, title: item.title, revision: item.revision })
                  }
                >
                  ···
                </button>
              </div>
            ))}
          {!conversations.length && (
            <p className="sidebar-empty">
              新的想法，从一段对话开始。
              <br />
              历史会留在这台设备上。
            </p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <span className="status-dot" />
            历史仅保存在本机{usage && <small>{formatBytes(usage.reservedBytes)} / 200 MiB</small>}
          </div>
          <button
            className="profile-button"
            aria-label="设置"
            onClick={() => {
              setConnectProfile(profileId);
              setSettingsPanel('gateway');
              setSettingsOpen(true);
              setSidebar(false);
            }}
          >
            <span className="avatar">{temporary ? '临' : profile?.name.slice(0, 1) || '本'}</span>
            <span>
              设置
              <small>Gateway、档案与备份</small>
            </span>
            <Icon name="settings" size={18} />
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu"
              aria-label="展开导航"
              onClick={() => setSidebar(true)}
            >
              <Icon name="menu" />
            </button>
            <div className="model-picker">
              <select
                aria-label="模型"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={generating || !models.length}
              >
                {!models.length && <option value="">选择模型</option>}
                {models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id}
                    {item.images ? ' · 图文' : ''}
                  </option>
                ))}
              </select>
              <small>{online ? '浏览器里的思考空间' : '离线 · 可查看历史'}</small>
            </div>
          </div>
        </header>
        {updateWaiting && (
          <div className="banner">
            新版本已就绪。
            <button
              disabled={busy}
              onClick={() => {
                updateWaiting.postMessage('activate-update');
                navigator.serviceWorker.addEventListener(
                  'controllerchange',
                  () => location.reload(),
                  { once: true },
                );
              }}
            >
              保存完成后更新
            </button>
          </div>
        )}
        {(notice || !online || usage?.warning || readOnly) && (
          <div className="banner" role="status">
            <div>
              {notice ||
                (!online
                  ? '当前离线，可以继续查看本机历史。'
                  : readOnly
                    ? '本页已停止写入，请刷新后继续。'
                    : '本机数据已接近预算，请先备份再清理。')}
              {diagnostic && (
                <small>
                  网站请求 ID：{diagnostic.requestId || '未取得'} · Gateway：
                  {diagnostic.gatewayRequestId || '未取得'}
                </small>
              )}
            </div>
            <button
              className="icon-button"
              aria-label="关闭提示"
              onClick={() => {
                setNotice('');
                setDiagnostic(null);
              }}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        <div className="chat-scroll">
          {!messages.length ? (
            <section className="welcome">
              <div className="welcome-symbol">
                <Icon name="chat" size={36} />
                <span>✦</span>
              </div>
              <div className="eyebrow">想法，在这里展开</div>
              <h1>今天，想聊些什么？</h1>
              <p>
                一个问题，一份资料，或一个还没成形的想法。
                <br />
                把它放在这里，我们一起理清。
              </p>
              <div className="starter-grid">
                <button onClick={() => setDraft('帮我梳理这个想法：\n')}>
                  <span className="starter-icon lavender">✦</span>
                  <strong>理清一个想法</strong>
                  <span>从零散的灵感，找到下一步</span>
                  <Icon name="arrow" size={17} />
                </button>
                <button onClick={() => inputRef.current?.click()} disabled={!store || readOnly}>
                  <span className="starter-icon peach">
                    <Icon name="file" size={20} />
                  </span>
                  <strong>读一份资料</strong>
                  <span>添加本机附件，提炼关键信息</span>
                  <Icon name="arrow" size={17} />
                </button>
                <button onClick={() => setDraft('请帮我改进这段文字，让表达更清晰：\n')}>
                  <span className="starter-icon sage">Aa</span>
                  <strong>打磨一段文字</strong>
                  <span>让表达更清楚，也更像自己</span>
                  <Icon name="arrow" size={17} />
                </button>
              </div>
              <div className="privacy-caption">
                <Icon name="check" size={14} />
                附件先在本机检查，点击发送后才传输选中的内容。
              </div>
            </section>
          ) : (
            <section className="messages" aria-label="聊天记录">
              {messages.map((message) => (
                <article key={message.id} className={`message ${message.role}`}>
                  <div
                    className={`message-avatar ${message.role === 'assistant' ? 'assistant-avatar' : ''}`}
                  >
                    {message.role === 'assistant' ? <Icon name="chat" size={18} /> : '我'}
                  </div>
                  <div className="message-body">
                    <div className="message-heading">
                      <strong>{message.role === 'assistant' ? '纸间' : '你'}</strong>
                      <span>{message.role === 'assistant' ? statuses[message.status] : ''}</span>
                    </div>
                    {message.role === 'assistant' ? (
                      <div className="markdown">
                        <Suspense fallback={<p className="user-text">{message.text}</p>}>
                          <SafeMarkdown text={message.text} />
                        </Suspense>
                        {!message.text &&
                          (message.status === 'preparing' || message.status === 'streaming') && (
                            <span className="thinking">
                              正在等待模型回复<span>…</span>
                            </span>
                          )}
                      </div>
                    ) : (
                      <p className="user-text">{message.text}</p>
                    )}
                    {message.attachmentIds.length > 0 && (
                      <div className="message-files">
                        {message.attachmentIds.map((id) => (
                          <span key={id}>
                            <Icon name="file" size={13} />
                            {attachments.find((item) => item.id === id)?.name || '附件缺失'}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="message-actions">
                      {message.role === 'user' ? (
                        <button disabled={busy} onClick={() => void editMessage(message)}>
                          编辑并创建分支
                        </button>
                      ) : (
                        <>
                          <button disabled={busy} onClick={() => void editMessage(message)}>
                            手动重试
                          </button>
                          <button
                            onClick={() =>
                              download(
                                new Blob([message.text], { type: 'text/plain;charset=utf-8' }),
                                '回复.txt',
                              )
                            }
                          >
                            导出文字
                          </button>
                          <RunDetails
                            run={runs.find((run) => run.assistantMessageId === message.id)}
                          />
                        </>
                      )}
                    </div>
                  </div>
                </article>
              ))}
              <div ref={tail} />
            </section>
          )}
        </div>
        <section className="composer-area">
          {unsaved && (
            <div className="unsaved">
              当前结果尚未可靠保存。
              <button
                onClick={() =>
                  download(
                    new Blob([unsaved], { type: 'text/plain;charset=utf-8' }),
                    '未保存的回复.txt',
                  )
                }
              >
                导出内存内容
              </button>
            </div>
          )}
          {messages.length > 0 && (
            <details className="context-controls">
              <summary>
                本轮上下文 · {messages.length} 条历史
                {relatedAttachments.length
                  ? ` · ${relatedAttachments.length - excluded.length} 个附件引用`
                  : ''}
              </summary>
              <div className="context-panel">
                <label>
                  上下文起点
                  <select
                    value={startId ?? ''}
                    disabled={generating}
                    onChange={(event) => {
                      const value = event.target.value || null;
                      setStartId(value);
                      if (store && conversation)
                        void store
                          .setSetting(profileId, `contextStart/${conversation.id}`, value)
                          .catch(report);
                    }}
                  >
                    <option value="">当前分支全部历史</option>
                    {messages
                      .filter((m) => m.role === 'user')
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.text.slice(0, 45)}
                        </option>
                      ))}
                  </select>
                </label>
                {allMessages.filter((m) => m.role === 'assistant').length > 1 && (
                  <label>
                    查看保留的分支
                    <select
                      value={conversation?.currentLeafId ?? ''}
                      disabled={busy || readOnly}
                      onChange={(event) => {
                        if (store && conversation)
                          void store
                            .setBranch(
                              profileId,
                              conversation.id,
                              event.target.value,
                              conversation.revision,
                            )
                            .then(() => refresh(store, profileId, conversation.id))
                            .catch(report);
                      }}
                    >
                      {allMessages
                        .filter((m) => m.role === 'assistant')
                        .map((m, index) => (
                          <option key={m.id} value={m.id}>
                            回复 {index + 1} · {statuses[m.status]} · {m.text.slice(0, 30)}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                {relatedAttachments.map(({ id, attachment }) => (
                  <div className="context-attachment" key={id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!excluded.includes(id)}
                        disabled={generating}
                        onChange={(event) =>
                          void setExcludedIds(
                            event.target.checked
                              ? excluded.filter((item) => item !== id)
                              : [...excluded, id],
                          )
                        }
                      />
                      {attachment?.name || '原附件缺失'}
                    </label>
                    <span>
                      {attachment?.status === 'ready' &&
                      attachment.parserVersion === PARSER_VERSION &&
                      attachment.policyVersion === config.policyVersion
                        ? '可用'
                        : '需重新检查'}
                    </span>
                    {attachment && (
                      <button disabled={busy} onClick={() => void recheckAttachment(id)}>
                        重新检查
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
          {files.length > 0 && (
            <div className="attachment-tray">
              {files.map((file) => (
                <div className={`attachment-card ${file.status}`} key={file.id}>
                  <Icon name="file" size={21} />
                  <div>
                    <strong>{file.name}</strong>
                    <small>
                      {formatBytes(file.size)} · {statuses[file.status]}{' '}
                      {file.status === 'parsing' ? file.progress : ''}
                    </small>
                    {file.error && <p>{file.error}</p>}
                    {file.artifact && (
                      <button
                        onClick={() => {
                          setPreview(file.artifact!);
                          setPreviewFile(file.id);
                        }}
                      >
                        {file.status === 'awaiting_confirmation'
                          ? '查看并确认提取模式'
                          : '查看实际发送版本'}
                      </button>
                    )}
                  </div>
                  {file.status === 'parsing' || file.status === 'selected' ? (
                    <button
                      className="icon-button"
                      aria-label={`取消检查 ${file.name}`}
                      onClick={() => {
                        fileControllers.current.get(file.id)?.abort();
                        updateFile(file.id, { status: 'cancelled' });
                      }}
                    >
                      <Icon name="stop" size={15} />
                    </button>
                  ) : (
                    <button
                      className="icon-button"
                      aria-label={`移除 ${file.name}`}
                      onClick={() => void removeFile(file)}
                    >
                      <Icon name="close" size={15} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {branchParent !== undefined && (
            <div className="branch-note">
              新的对话分支 · 原有内容会保留{' '}
              <button
                onClick={() => {
                  setBranchParent(undefined);
                  setDraft('');
                  setFiles([]);
                }}
              >
                取消编辑
              </button>
            </div>
          )}
          <div className="composer">
            <textarea
              aria-label="输入问题"
              placeholder="写下你的问题，或添加一份资料…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={readOnly || (!profileId && !temporary)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !sendDisabled) {
                  event.preventDefault();
                  void previewSend();
                }
              }}
            />
            <div className="composer-toolbar">
              <div>
                <button
                  className="attach-button"
                  disabled={!store || temporary || parsing || readOnly || generating}
                  onClick={() => inputRef.current?.click()}
                >
                  <Icon name="paperclip" size={19} />
                  <span>添加附件</span>
                </button>
              </div>
              <div>
                <span className="shortcut">⌘ / Ctrl + Enter</span>
                {generating ? (
                  <button
                    className="send-button stop-button"
                    aria-label="停止生成"
                    onClick={() => abortRef.current?.abort()}
                  >
                    <Icon name="stop" size={17} />
                  </button>
                ) : (
                  <button
                    className="send-button"
                    aria-label="预览并发送"
                    disabled={sendDisabled}
                    onClick={() => void previewSend()}
                  >
                    <Icon name="send" size={21} />
                  </button>
                )}
              </div>
            </div>
          </div>
          <p className="composer-footnote">
            {temporary
              ? '临时模式不保存历史；离开页面前请导出需要的内容。'
              : '回复可能有误，请核对重要信息。历史未加密，请定期导出备份。'}
          </p>
          <input
            className="hidden"
            ref={inputRef}
            type="file"
            aria-label="选择附件"
            multiple
            accept={accepted}
            onChange={(event) => {
              const list = Array.from(event.target.files ?? []);
              event.target.value = '';
              void addFiles(list);
            }}
          />
          <input
            className="hidden"
            ref={backupInputRef}
            type="file"
            aria-label="选择备份"
            accept=".chatbackup"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importBackup(file);
            }}
          />
        </section>
      </main>
      {!booting && !profiles.length && !temporary && !storageFailed && store && (
        <Modal title="给你的想法一个本机档案">
          <p className="muted">
            聊天记录和附件仅保存在当前浏览器。档案用于分组，不提供加密隔离；清除站点数据会丢失历史。
          </p>
          <form onSubmit={(event) => void createProfile(event)}>
            <label className="field">
              档案名称
              <input
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                maxLength={100}
                required
                autoFocus
              />
            </label>
            <button className="primary wide" type="submit">
              创建本机档案
            </button>
          </form>
        </Modal>
      )}
      {storageFailed && !temporary && (
        <Modal title="本机存储暂时不可用">
          <p>
            已有数据不会被清空。可以关闭其他标签页或检查浏览器设置后刷新，也可以明确选择临时文字聊天。
          </p>
          <p className="muted">临时聊天不支持附件，刷新或关闭页面后内容会丢失。</p>
          <button
            className="primary wide"
            onClick={() => {
              setTemporary(true);
              setProfileId('temporary');
              setStore(null);
              setSettingsOpen(false);
              setConnectProfile('temporary');
            }}
          >
            进入临时文字聊天
          </button>
          <button className="secondary wide" onClick={() => location.reload()}>
            重新检查存储
          </button>
        </Modal>
      )}
      {settingsOpen && (
        <Modal
          title="设置"
          onClose={
            connecting
              ? undefined
              : () => {
                  setSettingsOpen(false);
                  setKeyDraft('');
                  setGatewayUrlDraft(null);
                }
          }
        >
          <div className="settings-tabs" role="tablist" aria-label="设置分类">
            <button
              id="gateway-tab"
              role="tab"
              aria-selected={settingsPanel === 'gateway'}
              aria-controls="gateway-panel"
              disabled={connecting}
              onClick={() => setSettingsPanel('gateway')}
            >
              Gateway 连接
            </button>
            <button
              id="local-tab"
              role="tab"
              aria-selected={settingsPanel === 'local'}
              aria-controls="local-panel"
              disabled={connecting}
              onClick={() => {
                setSettingsPanel('local');
                setKeyDraft('');
              }}
            >
              档案、存储与备份
            </button>
          </div>
          {settingsPanel === 'gateway' && (
            <section id="gateway-panel" role="tabpanel" aria-labelledby="gateway-tab">
              <p className={`connection-status ${key ? 'connected' : ''}`}>
                <span className="status-dot" />
                {key ? '已连接 Gateway' : '未连接 Gateway'}
              </p>
              <p className="muted">
                使用自己的 API Key。Key 只留在页面内存，刷新或清除连接后需要重新输入。
              </p>
              {notice && (
                <p className="loss-warning" role="alert">
                  {notice}
                </p>
              )}
              <form onSubmit={(event) => void connect(event)}>
                <label className="field">
                  Gateway URL
                  <input
                    type="url"
                    name="gateway-url"
                    value={gatewayInput}
                    onChange={(event) => setGatewayUrlDraft(event.target.value)}
                    placeholder="https://gateway.example.com 或 https://gateway.example.com/v1"
                    disabled={busy || connecting}
                    autoComplete="url"
                    spellCheck={false}
                    maxLength={2048}
                    required
                    aria-describedby="gateway-url-help"
                  />
                </label>
                <p className="fine-print" id="gateway-url-help">
                  填写 Gateway 地址，可带 /v1。修改后输入对应的 Key，验证成功后生效。
                </p>
                {!temporary && (
                  <label className="field">
                    本次使用的本机档案
                    <select
                      value={connectProfile || profileId}
                      disabled={busy || connecting}
                      onChange={(event) => setConnectProfile(event.target.value)}
                      required
                    >
                      {profiles.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="field">
                  Gateway API Key
                  <input
                    type="password"
                    name="gateway-key"
                    autoComplete="off"
                    spellCheck={false}
                    value={keyDraft}
                    disabled={busy || connecting}
                    onChange={(event) => setKeyDraft(event.target.value)}
                    placeholder="输入专用于本站的 Key"
                    required
                    autoFocus
                  />
                </label>
                <p className="fine-print">
                  发送的文字和图片会经过 Cloudflare、Gateway 及模型服务。本机档案与 Gateway
                  身份相互独立。
                </p>
                <button
                  className="primary wide"
                  type="submit"
                  disabled={busy || connecting || !keyDraft.trim() || !gatewayInput.trim()}
                >
                  {connecting ? '正在验证…' : '验证并连接'}
                </button>
              </form>
              {key && (
                <button
                  className="secondary wide"
                  disabled={busy || connecting}
                  onClick={() => {
                    abortRef.current?.abort();
                    setKey('');
                    setKeyDraft('');
                    setModels([]);
                    setModel('');
                  }}
                >
                  清除内存 Key
                </button>
              )}
            </section>
          )}
          {settingsPanel === 'local' && (
            <section id="local-panel" role="tabpanel" aria-labelledby="local-tab">
              <p className="muted">
                这些明文数据只在当前浏览器中。网站服务器没有可供恢复的聊天副本。
              </p>
              {store && (
                <>
                  <label className="field">
                    当前档案
                    <select
                      value={profileId}
                      disabled={busy}
                      onChange={(event) => void selectProfile(event.target.value).catch(report)}
                    >
                      {profiles.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <form className="inline-form" onSubmit={(event) => void createProfile(event)}>
                    <input
                      aria-label="新档案名称"
                      placeholder="新的本机档案名称"
                      value={profileName}
                      onChange={(event) => setProfileName(event.target.value)}
                      required
                    />
                    <button className="secondary" disabled={busy || readOnly}>
                      创建档案
                    </button>
                  </form>
                  <div className="settings-divider" />
                  <div className="storage-stat">
                    <strong>
                      {usage ? formatBytes(usage.reservedBytes) : '—'}
                      <small> / 200 MiB 应用预算</small>
                    </strong>
                    <p>包含约 20% 索引和序列化余量。浏览器实际可用空间可能更少。</p>
                  </div>
                  <button
                    className="secondary wide"
                    onClick={() =>
                      void navigator.storage
                        ?.persist?.()
                        .then(async (granted) => {
                          await store.setSetting(profileId, 'persistentStorage', granted);
                          setNotice(
                            granted
                              ? '浏览器已允许持久保存。仍需定期备份。'
                              : '浏览器未批准持久保存，请定期备份。',
                          );
                        })
                        .catch(report)
                    }
                  >
                    请求浏览器持久保存
                  </button>
                  <div className="button-pair">
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void exportBackup(true)}
                    >
                      导出档案备份
                    </button>
                    <button
                      className="secondary"
                      disabled={busy || !conversation}
                      onClick={() => void exportBackup(false)}
                    >
                      仅导出本会话
                    </button>
                  </div>
                  <button
                    className="secondary wide"
                    disabled={busy || readOnly}
                    onClick={() => backupInputRef.current?.click()}
                  >
                    导入 .chatbackup 到当前档案
                  </button>
                  <p className="fine-print">
                    备份未加密，请妥善保存。导入会重新映射 ID 并检查附件，不覆盖已有历史。每份最多
                    100 MiB。
                  </p>
                  {backupBusy && (
                    <p role="status">
                      {backupProgress}
                      <button onClick={() => backupAbort.current?.abort()}>取消导入</button>
                    </p>
                  )}
                  <div className="settings-divider" />
                  <div className="button-pair">
                    <button
                      className="danger-text"
                      disabled={busy || readOnly || !conversation}
                      onClick={() =>
                        conversation &&
                        setDeleteTarget({
                          kind: 'conversation',
                          id: conversation.id,
                          name: conversation.title,
                        })
                      }
                    >
                      删除当前会话
                    </button>
                    <button
                      className="danger-text"
                      disabled={busy || readOnly}
                      onClick={() =>
                        setDeleteTarget({
                          kind: 'profile',
                          id: profileId,
                          name: profile?.name ?? '',
                        })
                      }
                    >
                      清除当前档案
                    </button>
                  </div>
                </>
              )}
              <div className="support-list">
                <strong>文件支持</strong>
                <span>TXT · Markdown · JSON · CSV</span>
                <span>
                  PDF {config.features.pdf ? '文字模式' : '暂不支持'} · DOCX{' '}
                  {config.features.docx ? '文字与简单表格' : '暂不支持'} · 图片{' '}
                  {config.features.images ? 'JPEG / PNG / 静态 WebP' : '暂不支持'}
                </span>
                <small>
                  单次最多 4 个附件 / 20 MiB；图片最多 2 张。PDF ≤ 8 MiB / 40 页，DOCX ≤ 5 MiB，文字
                  ≤ 1 MiB，CSV ≤ 2 MiB，原图 ≤ 8 MiB。
                </small>
              </div>
            </section>
          )}
        </Modal>
      )}
      {preview && (
        <Modal
          title="实际发送版本"
          onClose={() => {
            setPreview(null);
            setPreviewFile(null);
          }}
        >
          <div className="preview-meta">
            <strong>{preview.name}</strong>
            <span>
              {formatBytes(preview.normalized.size)}
              {preview.width ? ` · ${preview.width} × ${preview.height}` : ''}
            </span>
          </div>
          {preview.warnings.length > 0 && (
            <div className="loss-warning">
              {preview.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          )}
          {preview.kind === 'image' ? (
            <BlobImage blob={preview.normalized} name={preview.name} />
          ) : (
            <pre className="extraction-preview">{preview.text}</pre>
          )}
          <p className="fine-print">
            此预览与发送使用同一规范化产物。确认仅对当前原件、提取结果和版本有效。
          </p>
          {files.find((file) => file.id === previewFile)?.status === 'awaiting_confirmation' && (
            <button
              className="primary wide"
              onClick={() => {
                const file = files.find((item) => item.id === previewFile);
                if (file)
                  void saveArtifact(file, preview)
                    .then(() => {
                      setPreview(null);
                      setPreviewFile(null);
                    })
                    .catch((error) => {
                      updateFile(file.id, { status: 'rejected', error: errorMessage(error) });
                      report(error);
                    });
              }}
            >
              我已检查预览，接受上述提取模式
            </button>
          )}
        </Modal>
      )}
      {snapshot && (
        <Modal title="确认本轮发送内容" onClose={() => setSnapshot(null)}>
          <div className="send-metrics">
            <span>{snapshot.request.messages.length} 条消息</span>
            <span>{formatBytes(requestMetrics(snapshot.request).requestBytes)}</span>
            <span>{requestMetrics(snapshot.request).images} 张图片</span>
          </div>
          <p className="fine-print">
            文本估算上界 {requestMetrics(snapshot.request).estimatedTextTokens.toLocaleString()}{' '}
            Token（以 UTF-8 字节保守估算）；目标约 32,768。图片 Token 未估算，不代表费用上限。
          </p>
          {requestMetrics(snapshot.request).estimatedTextTokens > POLICY.request.targetTokens && (
            <div className="loss-warning">
              已超过目标文本上下文估算，建议减少历史或拆分文档。实际模型上下文和额度仍由 Gateway
              判定。
            </div>
          )}
          <div className="send-preview">
            {snapshot.request.messages.map((message, index) => (
              <section key={index}>
                <strong>
                  {message.role === 'user' ? '你' : '助手'} · {index + 1}
                </strong>
                {message.content.map((block, i) =>
                  block.type === 'image' ? (
                    <img
                      key={i}
                      className="image-preview"
                      src={`data:${block.mimeType};base64,${block.base64}`}
                      alt="本轮规范化图片"
                    />
                  ) : (
                    <details key={i} open={index === snapshot.request.messages.length - 1}>
                      <summary>
                        {block.type === 'document_text' ? block.name : '文字'} ·{' '}
                        {formatBytes(new TextEncoder().encode(block.text).length)}
                      </summary>
                      <pre>{block.text}</pre>
                    </details>
                  ),
                )}
              </section>
            ))}
          </div>
          <p className="fine-print">
            发送到 {snapshot.model}。点击后会先保存本轮记录，再向 Gateway
            发起一次生成请求。手动重试可能再次消耗额度。
          </p>
          <button
            className="primary wide"
            disabled={generating || !online || !key}
            onClick={() => void generate()}
          >
            确认发送
          </button>
        </Modal>
      )}
      {deleteTarget && (
        <Modal title="确认删除本机数据" onClose={() => setDeleteTarget(null)}>
          <p>
            将删除
            {deleteTarget.kind === 'profile'
              ? '档案及其中的历史和附件'
              : '会话及不再被其他会话引用的附件'}
            「{deleteTarget.name}」。此操作无法撤销，请先导出需要的备份。
          </p>
          <button className="danger wide" onClick={() => void confirmDelete()}>
            确认删除
          </button>
        </Modal>
      )}
      {rename && (
        <Modal title="重命名会话" onClose={() => setRename(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (store)
                void store
                  .renameConversation(profileId, rename.id, rename.title, rename.revision)
                  .then(() => {
                    setRename(null);
                    return refresh(store, profileId, conversation?.id);
                  })
                  .catch(report);
            }}
          >
            <label className="field">
              会话名称
              <input
                value={rename.title}
                onChange={(event) => setRename({ ...rename, title: event.target.value })}
                required
                maxLength={200}
                autoFocus
              />
            </label>
            <button className="primary wide">保存名称</button>
          </form>
          <button
            className="danger-text wide"
            onClick={() => {
              setDeleteTarget({ kind: 'conversation', id: rename.id, name: rename.title });
              setRename(null);
            }}
          >
            删除此会话
          </button>
        </Modal>
      )}
    </div>
  );
}
