import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type {
  AttachSelectionResult,
  CapturePageContextResult,
  CreateThreadResult,
  DomSelectionStateResult,
  ListThreadsResult,
  MessagesResult,
  SettingsResult,
  SidePanelEvent,
  UsageLimitsResult,
  WsStatusResult
} from '../contracts/messages';
import type { Attachment, Message, RateLimitItem, Thread, UsageLimits, WsDebugLogEntry, WsStatus } from '../contracts/types';
import { SafeMarkdown } from '../shared/markdown';
import { sendCommand, listenEvents } from '../shared/runtime';

interface MessagesByThread {
  [threadId: string]: Message[];
}

interface TokenTimestampByMessage {
  [messageId: string]: number;
}

interface MessageErrors {
  [messageId: string]: string;
}

type ContextMode = 'chat_only' | 'dom';
type MessageStatusTone = 'normal' | 'warn' | 'alert' | 'error';

const STREAM_WAIT_WARN_MS = 10_000;
const STREAM_WAIT_ALERT_MS = 25_000;
const STREAM_STALE_WARN_MS = 12_000;

function StatusBadge({ status }: { status: WsStatus }): JSX.Element {
  return <span className={`status status-${status}`}>{status}</span>;
}

function rateLimitPercent(item: RateLimitItem): number {
  if (typeof item.usedPercent !== 'number' || !Number.isFinite(item.usedPercent)) {
    return 0;
  }
  if (item.usedPercent <= 1) {
    return Math.max(0, Math.min(100, item.usedPercent * 100));
  }
  return Math.max(0, Math.min(100, item.usedPercent));
}

function rateLimitLeftPercent(item: RateLimitItem): number {
  return Math.max(0, Math.min(100, 100 - rateLimitPercent(item)));
}

function rateLimitMeta(item: RateLimitItem): string {
  return `${Math.round(rateLimitLeftPercent(item))}% left`;
}

function isPrimaryLimit(item: RateLimitItem): boolean {
  const limitId = item.limitId.toLowerCase();
  return limitId.includes('primary') || item.windowDurationMins === 300;
}

function isWeeklyLimit(item: RateLimitItem): boolean {
  const limitId = item.limitId.toLowerCase();
  return limitId.includes('secondary') || item.windowDurationMins === 10080;
}

function rateLimitLabel(item: RateLimitItem): string {
  if (isPrimaryLimit(item)) {
    return '5h limit:';
  }
  if (isWeeklyLimit(item)) {
    return 'Weekly limit:';
  }
  return 'Limit:';
}

function rateLimitSortKey(item: RateLimitItem): number {
  if (isPrimaryLimit(item)) {
    return 0;
  }
  if (isWeeklyLimit(item)) {
    return 1;
  }
  return 2;
}

function UsageLimitBars({ usage }: { usage: UsageLimits }): JSX.Element {
  const limits = [...usage.rateLimits].sort((a, b) => rateLimitSortKey(a) - rateLimitSortKey(b));

  if (limits.length === 0) {
    return (
      <div className="usage-bars" aria-label="Codex usage limit">
        <div className="usage-row">
          <small>limits</small>
          <div className="usage-track">
            <div className="usage-fill" style={{ width: '0%' }} />
          </div>
          <small>N/A</small>
        </div>
      </div>
    );
  }

  return (
    <div className="usage-bars" aria-label="Codex usage limit">
      {limits.slice(0, 2).map((item) => {
        const leftPercent = rateLimitLeftPercent(item);
        const label = rateLimitLabel(item);
        return (
          <div key={item.limitId} className="usage-row">
            <small title={item.limitId}>{label}</small>
            <div className="usage-track" role="img" aria-label={`${label} ${Math.round(leftPercent)} percent left`}>
              <div className="usage-fill" style={{ width: `${leftPercent}%` }} />
            </div>
            <small>{rateLimitMeta(item)}</small>
          </div>
        );
      })}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}秒`;
  }
  return `${minutes}分${seconds}秒`;
}

function getAssistantStatusMeta(input: {
  message: Message;
  wsStatus: WsStatus;
  nowTs: number;
  lastTokenTs?: number;
  errorText?: string;
}): { label: string; detail?: string; tone: MessageStatusTone; streaming: boolean } {
  const { message, wsStatus, nowTs, lastTokenTs, errorText } = input;
  if (message.status === 'done') {
    return { label: 'done', tone: 'normal', streaming: false };
  }
  if (message.status === 'error') {
    return {
      label: 'error',
      detail: errorText ?? 'Failed to receive response',
      tone: 'error',
      streaming: false
    };
  }
  if (message.status === 'pending') {
    return { label: 'pending', tone: 'warn', streaming: false };
  }

  const elapsed = nowTs - message.createdAt;
  const hasContent = message.contentMd.trim().length > 0;

  if (wsStatus === 'disconnected' || wsStatus === 'error') {
    return {
      label: 'stopped',
      detail: `Connection lost (${formatElapsed(elapsed)} elapsed)`,
      tone: 'error',
      streaming: true
    };
  }

  if (!hasContent) {
    if (elapsed >= STREAM_WAIT_ALERT_MS) {
      return {
        label: 'waiting (delayed)',
        detail: `${formatElapsed(elapsed)} elapsed. Possible disconnection or error`,
        tone: 'alert',
        streaming: true
      };
    }
    if (elapsed >= STREAM_WAIT_WARN_MS) {
      return {
        label: 'waiting',
        detail: `${formatElapsed(elapsed)} elapsed`,
        tone: 'warn',
        streaming: true
      };
    }
    return {
      label: 'waiting',
      detail: `${formatElapsed(elapsed)} elapsed`,
      tone: 'normal',
      streaming: true
    };
  }

  const sinceLastToken = nowTs - (lastTokenTs ?? message.createdAt);
  if (sinceLastToken >= STREAM_STALE_WARN_MS) {
    return {
      label: 'streaming (stalled)',
      detail: `${formatElapsed(sinceLastToken)} since last update`,
      tone: 'warn',
      streaming: true
    };
  }
  return {
    label: 'streaming',
    detail: `${formatElapsed(sinceLastToken)} since last update`,
    tone: 'normal',
    streaming: true
  };
}

function ThreadList(props: {
  threads: Thread[];
  currentThreadId?: string;
  onCreate: () => void;
  onSwitch: (threadId: string) => void;
  onDelete: (threadId: string) => void;
  onRename: (threadId: string, title: string) => Promise<void>;
}): JSX.Element {
  const [query, setQuery] = useState('');

  const filteredThreads = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return props.threads;
    }
    return props.threads.filter((thread) => thread.title.toLowerCase().includes(q));
  }, [props.threads, query]);

  return (
    <section className="threads-panel" aria-label="スレッド">
      <div className="threads-panel-header">
        <h2>Threads</h2>
        <button type="button" onClick={props.onCreate} className="primary-button">
          新規
        </button>
      </div>

      <input
        aria-label="スレッド検索"
        className="threads-search"
        placeholder="スレッド検索"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      <div className="threads">
        {filteredThreads.length === 0 ? (
          <small className="thread-empty">一致するスレッドがありません</small>
        ) : (
          filteredThreads.map((thread) => (
            <div key={thread.id} className="thread-row">
              <button
                className={`thread-item ${props.currentThreadId === thread.id ? 'active' : ''}`}
                onClick={() => props.onSwitch(thread.id)}
                type="button"
              >
                <span>{thread.title}</span>
                <small className="thread-meta">更新: {formatThreadUpdatedAt(thread.updatedAt)}</small>
              </button>
              <div className="thread-actions">
                <button
                  type="button"
                  className="thread-rename"
                  onClick={() => void openRenameDialog(thread, props.onRename)}
                  aria-label={`スレッド ${thread.title} の名前を変更`}
                >
                  変更
                </button>
                <button
                  type="button"
                  className="thread-delete"
                  onClick={() => props.onDelete(thread.id)}
                  aria-label={`スレッド ${thread.title} を削除`}
                >
                  削除
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

async function openRenameDialog(
  thread: Thread,
  onRename: (threadId: string, title: string) => Promise<void>
): Promise<void> {
  const entered = globalThis.prompt('新しいスレッド名を入力してください', thread.title);
  if (entered === null) {
    return;
  }

  const nextTitle = entered.trim();
  if (!nextTitle || nextTitle === thread.title) {
    return;
  }

  await onRename(thread.id, nextTitle);
}

function MessageList(props: {
  messages: Message[];
  wsStatus: WsStatus;
  nowTs: number;
  tokenTimestampByMessage: TokenTimestampByMessage;
  messageErrors: MessageErrors;
}): JSX.Element {
  function toDisplayMarkdown(message: Message): string {
    const body = message.contentMd.trim();
    const attachments = (message.attachments ?? [])
      .map((item, index) => {
        const source = item.url ? `出典URL: ${item.url}\n\n` : '';
        return `### 添付 ${index + 1} (${attachmentSummary(item)})\n\n${source}${item.text}`;
      })
      .join('\n\n');

    if (!attachments) {
      return body;
    }
    if (!body) {
      return attachments;
    }
    return `${body}\n\n---\n\n${attachments}`;
  }

  if (props.messages.length === 0) {
    return (
      <div className="messages-empty">
        <strong>メッセージがありません</strong>
        <small>下の入力欄からチャットを開始してください</small>
      </div>
    );
  }

  return (
    <div className="messages">
      {props.messages.map((message) => {
        const statusMeta =
          message.role === 'assistant'
            ? getAssistantStatusMeta({
                message,
                wsStatus: props.wsStatus,
                nowTs: props.nowTs,
                lastTokenTs: props.tokenTimestampByMessage[message.id],
                errorText: props.messageErrors[message.id]
              })
            : {
                label: message.status,
                detail: undefined,
                tone: 'normal' as const,
                streaming: false
              };

        return (
          <article key={message.id} className={`message ${message.role}`}>
            <header className="message-header">
              <strong>{message.role}</strong>
              <span className={`message-status message-status-${statusMeta.tone}`}>
                {statusMeta.streaming ? <span className="message-status-dot" aria-hidden="true" /> : null}
                {statusMeta.label}
              </span>
            </header>
            {statusMeta.detail ? <small className="message-status-detail">{statusMeta.detail}</small> : null}
            <div className="message-content">
              <SafeMarkdown markdown={toDisplayMarkdown(message)} />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function getTabOriginPattern(tabUrl: string): string {
  const parsed = new URL(tabUrl);
  return `${parsed.origin}/*`;
}

function getTabProtocol(tabUrl: string): string {
  return new URL(tabUrl).protocol;
}

async function getAttachableActiveTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('active tab が取得できませんでした');
  }
  if (!tab.url) {
    throw new Error('tab の URL が取得できませんでした');
  }

  const protocol = getTabProtocol(tab.url);
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`このページでは選択を添付できません (${protocol})`);
  }
  return tab;
}

async function requestActiveTabHostPermission(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.url) {
    throw new Error('tab の URL が取得できませんでした');
  }
  const originPattern = getTabOriginPattern(tab.url);
  const hasPermission = await chrome.permissions.contains({ origins: [originPattern] });
  if (hasPermission) {
    return;
  }
  const granted = await chrome.permissions.request({ origins: [originPattern] });
  if (!granted) {
    throw new Error(`ページ権限が許可されませんでした (${originPattern})`);
  }
}

function attachmentSummary(attachment: Attachment): string {
  if (attachment.type === 'selected_text') {
    return '選択範囲';
  }
  const scope = attachment.scope === 'dom_selection' ? 'DOM範囲' : '可視領域';
  return `ページ参照(${scope})`;
}

export function App(): JSX.Element {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [currentThreadId, setCurrentThreadId] = useState<string>();
  const [messagesByThread, setMessagesByThread] = useState<MessagesByThread>({});
  const [input, setInput] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [status, setStatus] = useState<WsStatus>('disconnected');
  const [statusReason, setStatusReason] = useState<string>('');
  const [wsUrl, setWsUrl] = useState('');
  const [wsLogs, setWsLogs] = useState<WsDebugLogEntry[]>([]);
  const [copyNotice, setCopyNotice] = useState('');
  const [devMode, setDevMode] = useState(false);
  const [contextMode, setContextMode] = useState<ContextMode>('chat_only');
  const [domSelectionActive, setDomSelectionActive] = useState(false);
  const [domSelectionCount, setDomSelectionCount] = useState(0);
  const [tokenTimestampByMessage, setTokenTimestampByMessage] = useState<TokenTimestampByMessage>({});
  const [messageErrors, setMessageErrors] = useState<MessageErrors>({});
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [usageLimits, setUsageLimits] = useState<UsageLimits>({
    rateLimits: [],
    updatedAt: 0
  });

  const currentMessages = useMemo(() => {
    if (!currentThreadId) {
      return [];
    }
    return messagesByThread[currentThreadId] ?? [];
  }, [currentThreadId, messagesByThread]);

  const hasThread = Boolean(currentThreadId);
  const isConnected = status === 'connected';
  const hasStreamingMessage = useMemo(
    () => currentMessages.some((msg) => msg.role === 'assistant' && msg.status === 'streaming'),
    [currentMessages]
  );
  const chatStalledByConnection = hasStreamingMessage && status !== 'connected';
  const contextArmed = contextMode !== 'chat_only';
  const hasAnyContentForSend = Boolean(input.trim() || pendingAttachments.length > 0 || contextArmed);
  const composerDisabled = !hasThread || !isConnected;

  const composerPlaceholder = useMemo(() => {
    if (!hasThread && !isConnected) {
      return '先に接続し、スレッドを作成してください';
    }
    if (!hasThread) {
      return '先にスレッドを作成してください';
    }
    if (!isConnected) {
      return '送信するにはWS接続が必要です';
    }
    return 'メッセージを入力';
  }, [hasThread, isConnected]);

  useEffect(() => {
    if (!hasStreamingMessage) {
      return;
    }
    const id = globalThis.setInterval(() => {
      setNowTs(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [hasStreamingMessage]);

  useEffect(() => {
    function onGlobalKeyDown(event: globalThis.KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        setDevMode((prev) => !prev);
      }
    }

    globalThis.addEventListener('keydown', onGlobalKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', onGlobalKeyDown);
    };
  }, []);

  async function loadThreadsAndMaybeMessages(): Promise<void> {
    const list = await sendCommand<ListThreadsResult>({ type: 'LIST_THREADS', payload: {} });
    setThreads(list.threads);

    const threadId = list.currentThreadId ?? list.threads[0]?.id;
    setCurrentThreadId(threadId);

    if (threadId) {
      const res = await sendCommand<MessagesResult>({
        type: 'GET_THREAD_MESSAGES',
        payload: { threadId }
      });
      setMessagesByThread((prev) => ({ ...prev, [threadId]: res.messages }));
    }
  }

  async function loadSettings(): Promise<void> {
    const res = await sendCommand<SettingsResult>({ type: 'GET_SETTINGS', payload: {} });
    setWsUrl(res.settings.wsUrl);
  }

  async function loadWsStatus(): Promise<void> {
    const res = await sendCommand<WsStatusResult>({ type: 'GET_WS_STATUS', payload: {} });
    setStatus(res.status);
    setStatusReason(res.reason ?? '');
  }

  async function loadUsageLimits(): Promise<void> {
    const res = await sendCommand<UsageLimitsResult>({ type: 'GET_USAGE_LIMITS', payload: {} });
    setUsageLimits(res.usage);
  }

  async function refreshUsageLimits(): Promise<void> {
    const res = await sendCommand<UsageLimitsResult>({ type: 'REFRESH_USAGE_LIMITS', payload: {} });
    setUsageLimits(res.usage);
  }

  async function refreshUsageLimitsWithRetry(): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await refreshUsageLimits();
        return;
      } catch {
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, 180);
        });
      }
    }
    await loadUsageLimits();
  }

  function applySidePanelEvent(event: SidePanelEvent): void {
    if (event.type === 'WS_STATUS_CHANGED') {
      setStatus(event.payload.status);
      setStatusReason(event.payload.reason ?? '');
      return;
    }

    if (event.type === 'WS_DEBUG_LOG') {
      setWsLogs((prev) => {
        const next = [...prev, event.payload.entry];
        if (next.length > 200) {
          return next.slice(next.length - 200);
        }
        return next;
      });
      return;
    }

    if (event.type === 'USAGE_LIMITS_UPDATED') {
      setUsageLimits(event.payload.usage);
      return;
    }

    if (event.type === 'SELECTION_ATTACHED') {
      setPendingAttachments((prev) => [...prev, event.payload.attachment]);
      return;
    }

    if (event.type === 'CHAT_TOKEN') {
      const { threadId, messageId, token } = event.payload;
      setTokenTimestampByMessage((prev) => ({ ...prev, [messageId]: Date.now() }));
      setNowTs(Date.now());
      setMessagesByThread((prev) => {
        const current = prev[threadId] ?? [];
        const next = current.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                contentMd: `${msg.contentMd}${token}`,
                status: 'streaming' as const
              }
            : msg
        );
        return { ...prev, [threadId]: next };
      });
      return;
    }

    if (event.type === 'CHAT_DONE') {
      const { threadId, messageId } = event.payload;
      setTokenTimestampByMessage((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
      setMessagesByThread((prev) => {
        const current = prev[threadId] ?? [];
        const next = current.map((msg) => (msg.id === messageId ? { ...msg, status: 'done' as const } : msg));
        return { ...prev, [threadId]: next };
      });
      return;
    }

    if (event.type === 'CHAT_ERROR') {
      const { threadId, messageId, error } = event.payload;
      setMessageErrors((prev) => ({ ...prev, [messageId]: error }));
      setTokenTimestampByMessage((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
      setMessagesByThread((prev) => {
        const current = prev[threadId] ?? [];
        const next = current.map((msg) => (msg.id === messageId ? { ...msg, status: 'error' as const } : msg));
        return { ...prev, [threadId]: next };
      });
    }
  }

  useEffect(() => {
    void loadThreadsAndMaybeMessages();
    void loadSettings();
    void loadWsStatus();
    void loadUsageLimits();
    const unlisten = listenEvents(applySidePanelEvent);
    const intervalId = globalThis.setInterval(() => {
      void loadWsStatus();
    }, 1000);
    return () => {
      unlisten();
      clearInterval(intervalId);
    };
  }, []);

  async function createThread(): Promise<void> {
    const res = await sendCommand<CreateThreadResult>({ type: 'CREATE_THREAD', payload: {} });
    await loadThreadsAndMaybeMessages();
    setCurrentThreadId(res.thread.id);
  }

  async function switchThread(threadId: string): Promise<void> {
    await sendCommand({ type: 'SWITCH_THREAD', payload: { threadId } });
    setCurrentThreadId(threadId);
    const res = await sendCommand<MessagesResult>({ type: 'GET_THREAD_MESSAGES', payload: { threadId } });
    setMessagesByThread((prev) => ({ ...prev, [threadId]: res.messages }));
  }

  async function deleteThread(threadId: string): Promise<void> {
    const target = threads.find((item) => item.id === threadId);
    const ok = globalThis.confirm(`スレッド「${target?.title ?? threadId}」を削除します。`);
    if (!ok) {
      return;
    }

    await sendCommand({ type: 'DELETE_THREAD', payload: { threadId } });
    await loadThreadsAndMaybeMessages();
  }

  async function renameThread(threadId: string, title: string): Promise<void> {
    try {
      await sendCommand({ type: 'RENAME_THREAD', payload: { threadId, title } });
      await loadThreadsAndMaybeMessages();
      setStatusReason('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusReason(`スレッド名の変更に失敗: ${message}`);
    }
  }

  async function attachSelection(): Promise<void> {
    try {
      const tab = await getAttachableActiveTab();
      await requestActiveTabHostPermission(tab);
      await sendCommand<AttachSelectionResult>({ type: 'ATTACH_SELECTION', payload: { tabId: tab.id } });
      setStatusReason('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusReason(
        `選択の添付に失敗: ${message}。タブでテキストを再選択し、必要なら拡張アイコンをクリックして権限を再付与してください。`
      );
    }
  }

  const refreshDomSelectionState = useCallback(async (): Promise<void> => {
    if (contextMode !== 'dom') {
      setDomSelectionActive(false);
      setDomSelectionCount(0);
      return;
    }

    try {
      const tab = await getAttachableActiveTab();
      await requestActiveTabHostPermission(tab);
      const result = await sendCommand<DomSelectionStateResult>({
        type: 'GET_DOM_SELECTION_STATE',
        payload: { tabId: tab.id }
      });
      setDomSelectionActive(result.active);
      setDomSelectionCount(result.selectedCount);
    } catch {
      setDomSelectionActive(false);
      setDomSelectionCount(0);
    }
  }, [contextMode]);

  useEffect(() => {
    if (contextMode !== 'dom') {
      return;
    }
    void refreshDomSelectionState();
    const id = globalThis.setInterval(() => {
      void refreshDomSelectionState();
    }, 900);
    return () => {
      clearInterval(id);
    };
  }, [contextMode, refreshDomSelectionState]);

  async function activateDomSelectionMode(): Promise<void> {
    const tab = await getAttachableActiveTab();
    await requestActiveTabHostPermission(tab);
    const result = await sendCommand<DomSelectionStateResult>({
      type: 'START_DOM_SELECTION_MODE',
      payload: { tabId: tab.id }
    });
    setContextMode('dom');
    setDomSelectionActive(result.active);
    setDomSelectionCount(result.selectedCount);
    setStatusReason('DOM選択モードを開始しました。ページ上をクリックして選択/解除できます。');
  }

  async function stopDomSelectionMode(nextMode: 'chat_only'): Promise<void> {
    try {
      const tab = await getAttachableActiveTab();
      await requestActiveTabHostPermission(tab);
      const result = await sendCommand<DomSelectionStateResult>({
        type: 'STOP_DOM_SELECTION_MODE',
        payload: { tabId: tab.id }
      });
      setDomSelectionActive(result.active);
      setDomSelectionCount(result.selectedCount);
    } catch {
      setDomSelectionActive(false);
      setDomSelectionCount(0);
    }
    setContextMode(nextMode);
  }

  async function clearDomSelectionMode(options?: { silent?: boolean }): Promise<void> {
    const silent = options?.silent ?? false;
    try {
      const tab = await getAttachableActiveTab();
      await requestActiveTabHostPermission(tab);
      const result = await sendCommand<DomSelectionStateResult>({
        type: 'CLEAR_DOM_SELECTION',
        payload: { tabId: tab.id }
      });
      setDomSelectionActive(result.active);
      setDomSelectionCount(result.selectedCount);
      if (!silent) {
        setStatusReason('DOM選択を全解除しました。');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!silent) {
        setStatusReason(`DOM選択の全解除に失敗: ${message}`);
      }
    }
  }

  async function changeContextMode(nextMode: ContextMode): Promise<void> {
    if (nextMode === contextMode) {
      return;
    }

    try {
      if (nextMode === 'dom') {
        await activateDomSelectionMode();
        return;
      }
      if (contextMode === 'dom') {
        await stopDomSelectionMode(nextMode);
      } else {
        setContextMode(nextMode);
      }
      setStatusReason('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusReason(`コンテキスト切替に失敗: ${message}`);
    }
  }

  async function createContextAttachment(): Promise<Attachment | null> {
    if (contextMode !== 'dom') {
      return null;
    }
    const tab = await getAttachableActiveTab();
    await requestActiveTabHostPermission(tab);

    const result = await sendCommand<CapturePageContextResult>({
      type: 'CAPTURE_PAGE_CONTEXT',
      payload: { tabId: tab.id, source: 'dom_or_viewport', maxChars: 12000 }
    });

    const scope = result.source === 'dom_selection' ? 'DOM範囲' : '可視領域';
    setStatusReason(`参照コンテキスト: ${scope}`);

    return result.attachment;
  }

  async function consumeOnceContextIfNeeded(contextWasAttached: boolean): Promise<void> {
    if (!contextWasAttached || contextMode === 'chat_only') {
      return;
    }

    if (contextMode === 'dom') {
      await clearDomSelectionMode({ silent: true });
      await stopDomSelectionMode('chat_only');
    } else {
      setContextMode('chat_only');
    }
    setStatusReason('ページ参照を1回送信し、参照モードをオフにしました。');
  }

  async function sendMessage(): Promise<void> {
    await sendPayload(input, pendingAttachments);
  }

  async function sendAttachmentsOnly(): Promise<void> {
    await sendPayload('', pendingAttachments);
  }

  async function sendPayload(text: string, attachments: Attachment[]): Promise<void> {
    if (!currentThreadId || status !== 'connected' || (!text.trim() && attachments.length === 0 && !contextArmed)) {
      return;
    }

    const contextWillBeAttached = contextMode === 'dom';
    const queuedAttachments = [...attachments];
    if (contextWillBeAttached) {
      try {
        const contextAttachment = await createContextAttachment();
        if (contextAttachment) {
          queuedAttachments.push(contextAttachment);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatusReason(`ページコンテキスト取得に失敗: ${message}`);
      }
    }

    setInput('');
    setPendingAttachments([]);

    try {
      await sendCommand({
        type: 'SEND_CHAT_MESSAGE',
        payload: {
          threadId: currentThreadId,
          text,
          attachments: queuedAttachments
        }
      });

      const res = await sendCommand<MessagesResult>({
        type: 'GET_THREAD_MESSAGES',
        payload: { threadId: currentThreadId }
      });

      setMessagesByThread((prev) => ({ ...prev, [currentThreadId]: res.messages }));
      await loadThreadsAndMaybeMessages();
      await consumeOnceContextIfNeeded(contextWillBeAttached);
      if (!contextWillBeAttached) {
        setStatusReason('');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusReason(`送信に失敗: ${message}`);
    }
  }

  function removePendingAttachment(index: number): void {
    setPendingAttachments((prev) => prev.filter((_, idx) => idx !== index));
  }

  async function connectWs(): Promise<void> {
    try {
      await sendCommand({ type: 'CONNECT_WS', payload: { url: wsUrl } });
      await loadWsStatus();
      await refreshUsageLimitsWithRetry();
      setStatusReason('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusReason(`接続に失敗: ${message}`);
    }
  }

  async function disconnectWs(): Promise<void> {
    try {
      await sendCommand({ type: 'DISCONNECT_WS', payload: {} });
      await loadWsStatus();
      setStatusReason('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusReason(`切断に失敗: ${message}`);
    }
  }

  async function saveSettings(): Promise<void> {
    await sendCommand({ type: 'SAVE_SETTINGS', payload: { wsUrl } });
    setStatusReason('接続URLを保存しました');
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void sendMessage();
    }
  }

  async function copyWsLogs(mode: 'all' | 'latest'): Promise<void> {
    const target = mode === 'latest' ? wsLogs.slice(-1) : wsLogs;
    const text = target
      .map((entry) => {
        const time = formatTime(entry.ts);
        const detail = entry.detail ? `\n${entry.detail}` : '';
        return `${time} [${entry.category}] ${entry.message}${detail}`;
      })
      .join('\n\n');

    try {
      await navigator.clipboard.writeText(text || 'ログなし');
      setCopyNotice(mode === 'latest' ? '最新ログをコピーしました' : '全ログをコピーしました');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCopyNotice(`コピー失敗: ${message}`);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-main">
          <strong>Codex Chat</strong>
          <StatusBadge status={status} />
        </div>
        <div className="header-actions">
          <UsageLimitBars usage={usageLimits} />
          {isConnected ? (
            <button type="button" onClick={() => void disconnectWs()}>
              切断
            </button>
          ) : (
            <button type="button" onClick={() => void connectWs()} className="primary-button">
              接続
            </button>
          )}
        </div>
      </header>

      {statusReason ? <p className="status-reason">{statusReason}</p> : null}

      {!isConnected ? (
        <section className="connection-gate" aria-label="接続設定">
          <h2>接続設定</h2>
          <label>
            Codex app-server URL
            <input value={wsUrl} onChange={(event) => setWsUrl(event.target.value)} placeholder="ws://127.0.0.1:4317" />
          </label>
          <div className="connection-gate-actions">
            <button type="button" onClick={() => void saveSettings()}>
              URL保存
            </button>
            <button type="button" onClick={() => void connectWs()} className="primary-button">
              接続
            </button>
          </div>
          <small>接続後にスレッドとチャットが表示されます。</small>
        </section>
      ) : (
        <>
          <div className="main">
            <ThreadList
              threads={threads}
              currentThreadId={currentThreadId}
              onCreate={() => void createThread()}
              onSwitch={(id) => void switchThread(id)}
              onDelete={(id) => void deleteThread(id)}
              onRename={(id, title) => renameThread(id, title)}
            />
            <section className="chat-panel" aria-label="チャット">
              <div className="chat-timeline">
                {chatStalledByConnection ? (
                  <div className="chat-warning">
                    Connection became unstable during streaming. The reply may not complete until reconnect.
                  </div>
                ) : null}
                <MessageList
                  messages={currentMessages}
                  wsStatus={status}
                  nowTs={nowTs}
                  tokenTimestampByMessage={tokenTimestampByMessage}
                  messageErrors={messageErrors}
                />
              </div>

              {pendingAttachments.length > 0 ? (
                <div className="pending-attachments">
                  <div className="attachments">添付候補（次の送信に同梱）</div>
                  <div className="pending-attachment-list">
                    {pendingAttachments.map((item, index) => (
                      <div key={`${item.capturedAt}-${index}`} className="pending-attachment-item">
                        <div>
                          <small>{attachmentSummary(item)}</small>
                          <small>{item.url}</small>
                          <span>{item.text}</span>
                        </div>
                        <button type="button" onClick={() => removePendingAttachment(index)}>
                          削除
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="composer">
                <div className="context-controls" role="group" aria-label="参照コンテキスト">
                  <button
                    type="button"
                    className={`context-chip ${contextMode === 'chat_only' ? 'active' : ''}`}
                    onClick={() => void changeContextMode('chat_only')}
                    disabled={!isConnected}
                  >
                    チャットのみ
                  </button>
                  <button
                    type="button"
                    className={`context-chip ${contextMode === 'dom' ? 'active' : ''}`}
                    onClick={() => void changeContextMode('dom')}
                    disabled={!isConnected}
                  >
                    DOM範囲
                  </button>
                  {contextMode === 'dom' ? (
                    <>
                      <span className={`dom-mode-state ${domSelectionActive ? 'active' : 'inactive'}`}>
                        {domSelectionActive ? '選択中' : '待機中'}: {domSelectionCount}件
                      </span>
                      <button type="button" onClick={() => void clearDomSelectionMode()} disabled={!isConnected}>
                        DOM全解除
                      </button>
                    </>
                  ) : null}
                </div>

                <textarea
                  placeholder={composerPlaceholder}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={onComposerKeyDown}
                  disabled={composerDisabled}
                />

                <div className="composer-actions">
                  <div className="composer-left-actions">
                    <button type="button" onClick={() => void attachSelection()} disabled={!isConnected}>
                      現在ページの選択範囲を添付
                    </button>
                    <small>Enter改行 / Ctrl+Enter送信</small>
                  </div>

                  <div className="composer-buttons">
                    <button
                      type="button"
                      onClick={() => void sendAttachmentsOnly()}
                      disabled={composerDisabled || (pendingAttachments.length === 0 && !contextArmed)}
                    >
                      添付のみ送信
                    </button>
                    <button
                      type="button"
                      onClick={() => void sendMessage()}
                      className="primary-button"
                      disabled={composerDisabled || !hasAnyContentForSend}
                    >
                      送信
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </div>

          {devMode ? (
            <section className="ws-debug-log" aria-label="WSデバッグログ">
              <div className="ws-debug-log-header">
                <strong>WSログ</strong>
                <div className="ws-debug-log-actions">
                  <button type="button" onClick={() => void copyWsLogs('latest')}>
                    最新をコピー
                  </button>
                  <button type="button" onClick={() => void copyWsLogs('all')}>
                    全件をコピー
                  </button>
                  <button type="button" onClick={() => setWsLogs([])}>
                    クリア
                  </button>
                </div>
              </div>
              {copyNotice ? <small>{copyNotice}</small> : null}
              <div className="ws-debug-log-body">
                {wsLogs.length === 0 ? (
                  <small>ログなし</small>
                ) : (
                  wsLogs.map((entry, index) => (
                    <div key={`${entry.ts}-${index}`} className={`ws-log-entry ${entry.category}`}>
                      <span className="ts">{formatTime(entry.ts)}</span>
                      <span className="cat">[{entry.category}]</span>
                      <span className="msg">{entry.message}</span>
                      {entry.detail ? <pre className="detail">{entry.detail}</pre> : null}
                    </div>
                  ))
                )}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ja-JP', { hour12: false });
}

function formatThreadUpdatedAt(ts: number): string {
  return new Date(ts).toLocaleString('ja-JP', { hour12: false });
}
