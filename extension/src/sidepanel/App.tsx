import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import type {
  AttachSelectionResult,
  CapturePageContextResult,
  CreateThreadResult,
  DomSelectionStateResult,
  ExportThreadsResult,
  ListThreadsResult,
  MessagesResult,
  SettingsResult,
  SidePanelEvent,
  UsageLimitsResult,
  WsStatusResult
} from '../contracts/messages';
import type { Attachment, Message, RateLimitItem, Thread, UsageLimits, WsDebugLogEntry, WsStatus } from '../contracts/types';
import { SafeMarkdown } from '../shared/markdown';
import {
  assertUrlAllowedByPermissionPolicy,
  extractPermissionPolicy,
  isUrlAllowedByPermissionPolicy
} from '../shared/permissionPolicy';
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
const FAST_SCROLL_DURATION_MS = 140;

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

function parseResetTime(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const ms = numeric >= 1e12 ? numeric : numeric * 1000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date;
}

function formatResetTime(value: string | undefined): string | undefined {
  const resetAt = parseResetTime(value);
  if (!resetAt) {
    return undefined;
  }
  const hours = String(resetAt.getHours()).padStart(2, '0');
  const minutes = String(resetAt.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function rateLimitMeta(item: RateLimitItem): string {
  const left = `${Math.round(rateLimitLeftPercent(item))}% left`;
  const resetTime = formatResetTime(item.resetsAt);
  if (!resetTime) {
    return left;
  }
  return `${left} (resets ${resetTime})`;
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
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
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
  onDeleteRequest: (thread: Thread) => void;
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
    <section className="threads-panel" aria-label="Threads">
      <div className="threads-panel-header">
        <h2>Threads</h2>
        <button type="button" onClick={props.onCreate} className="primary-button">
          New
        </button>
      </div>

      <input
        aria-label="Search threads"
        className="threads-search"
        placeholder="Search threads"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      <div className="threads">
        {filteredThreads.length === 0 ? (
          <small className="thread-empty">No matching threads.</small>
        ) : (
          filteredThreads.map((thread) => (
            <div key={thread.id} className="thread-row">
              <button
                className={`thread-item ${props.currentThreadId === thread.id ? 'active' : ''}`}
                onClick={() => props.onSwitch(thread.id)}
                type="button"
              >
                <span>{thread.title}</span>
                <small className="thread-meta">Updated: {formatThreadUpdatedAt(thread.updatedAt)}</small>
              </button>
              <div className="thread-actions">
                <button
                  type="button"
                  className="thread-rename"
                  onClick={() => void openRenameDialog(thread, props.onRename)}
                  aria-label={`Rename thread ${thread.title}`}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="thread-delete"
                  onClick={() => props.onDeleteRequest(thread)}
                  aria-label={`Delete thread ${thread.title}`}
                >
                  Delete
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
  const entered = globalThis.prompt('Enter a new thread name', thread.title);
  if (entered === null) {
    return;
  }

  const nextTitle = entered.trim();
  if (!nextTitle || nextTitle === thread.title) {
    return;
  }

  await onRename(thread.id, nextTitle);
}

function MessageList({
  messages,
  wsStatus,
  nowTs,
  tokenTimestampByMessage,
  messageErrors,
  containerRef
}: {
  messages: Message[];
  wsStatus: WsStatus;
  nowTs: number;
  tokenTimestampByMessage: TokenTimestampByMessage;
  messageErrors: MessageErrors;
  containerRef?: Ref<HTMLDivElement>;
}): JSX.Element {
  function roleLabel(role: Message['role']): string {
    if (role === 'user') {
      return 'You';
    }
    if (role === 'assistant') {
      return 'Codex';
    }
    return role;
  }

  function toDisplayMarkdown(message: Message): string {
    const body = message.contentMd.trim();
    const attachments = (message.attachments ?? [])
      .map((item, index) => {
        const source = item.url ? `Source URL: ${item.url}\n\n` : '';
        return `### Attachment ${index + 1} (${attachmentSummary(item)})\n\n${source}${item.text}`;
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

  if (messages.length === 0) {
    return (
      <div ref={containerRef} className="messages-empty">
        <strong>No messages yet.</strong>
        <small>Start a chat from the input box below.</small>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="messages">
      {messages.map((message) => {
        const statusMeta =
          message.role === 'assistant'
            ? getAssistantStatusMeta({
                message,
                wsStatus,
                nowTs,
                lastTokenTs: tokenTimestampByMessage[message.id],
                errorText: messageErrors[message.id]
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
              <span className="message-author-meta">
                <strong>{roleLabel(message.role)}</strong>
                <small className="message-timestamp">{formatMessageTimestamp(message.createdAt)}</small>
              </span>
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
    throw new Error('Failed to get active tab');
  }
  if (!tab.url) {
    throw new Error('Failed to get tab URL');
  }

  const protocol = getTabProtocol(tab.url);
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`Selection attachment is not available on this page (${protocol})`);
  }
  return tab;
}

async function requestActiveTabHostPermission(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.url) {
    throw new Error('Failed to get tab URL');
  }
  const policy = extractPermissionPolicy(chrome.runtime.getManifest());
  assertUrlAllowedByPermissionPolicy(tab.url, policy, 'Tab URL');
  const originPattern = getTabOriginPattern(tab.url);
  const hasPermission = await chrome.permissions.contains({ origins: [originPattern] });
  if (hasPermission) {
    return;
  }
  const granted = await chrome.permissions.request({ origins: [originPattern] });
  if (!granted) {
    throw new Error(`Page permission was not granted (${originPattern})`);
  }
}

function attachmentSummary(attachment: Attachment): string {
  if (attachment.type === 'selected_text') {
    return 'Selected text';
  }
  const scope = attachment.scope === 'dom_selection' ? 'DOM selection' : 'Viewport';
  return `Page context (${scope})`;
}

function sanitizeFilePart(input: string): string {
  return input
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

function formatDateForFile(ts: number): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function threadFileName(thread: Thread, exportedAt: number): string {
  const title = sanitizeFilePart(thread.title || 'thread');
  const id = sanitizeFilePart(thread.id);
  return `${formatDateForFile(exportedAt)}_${title}_${id}.json`;
}

function triggerDownload(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  const [domSelectionUnavailableReason, setDomSelectionUnavailableReason] = useState('');
  const [tokenTimestampByMessage, setTokenTimestampByMessage] = useState<TokenTimestampByMessage>({});
  const [messageErrors, setMessageErrors] = useState<MessageErrors>({});
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [shouldScrollToBottom, setShouldScrollToBottom] = useState(false);
  const [deleteTargetThread, setDeleteTargetThread] = useState<Thread>();
  const [deleteDialogNotice, setDeleteDialogNotice] = useState('');
  const [isDeleteActionRunning, setIsDeleteActionRunning] = useState(false);
  const [usageLimits, setUsageLimits] = useState<UsageLimits>({
    rateLimits: [],
    updatedAt: 0
  });
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollAnimationFrameRef = useRef<number>();

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
  const isDomSelectionUnavailable = domSelectionUnavailableReason.length > 0;
  const hasAnyContentForSend = Boolean(input.trim() || pendingAttachments.length > 0 || contextArmed);
  const composerDisabled = !hasThread || !isConnected;

  const composerPlaceholder = useMemo(() => {
    if (!hasThread && !isConnected) {
      return 'Connect first, then create a thread';
    }
    if (!hasThread) {
      return 'Create a thread first';
    }
    if (!isConnected) {
      return 'WebSocket connection is required to send';
    }
    return 'Type your message';
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

  useEffect(() => {
    return () => {
      if (typeof scrollAnimationFrameRef.current === 'number') {
        cancelAnimationFrame(scrollAnimationFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!shouldScrollToBottom) {
      return;
    }
    const container = messagesContainerRef.current;
    if (!container) {
      return;
    }

    if (typeof scrollAnimationFrameRef.current === 'number') {
      cancelAnimationFrame(scrollAnimationFrameRef.current);
    }

    const startTop = container.scrollTop;
    const targetTop = container.scrollHeight;
    const distance = targetTop - startTop;
    if (Math.abs(distance) < 1) {
      setShouldScrollToBottom(false);
      return;
    }

    const startedAt = performance.now();
    const step = (now: number): void => {
      const elapsed = now - startedAt;
      const progress = Math.min(1, elapsed / FAST_SCROLL_DURATION_MS);
      const eased = 1 - (1 - progress) ** 3;
      container.scrollTop = startTop + distance * eased;

      if (progress < 1) {
        scrollAnimationFrameRef.current = requestAnimationFrame(step);
        return;
      }

      scrollAnimationFrameRef.current = undefined;
      setShouldScrollToBottom(false);
    };

    scrollAnimationFrameRef.current = requestAnimationFrame(step);
  }, [currentMessages, shouldScrollToBottom]);

  const loadThreadsAndMaybeMessages = useCallback(async (): Promise<void> => {
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
  }, []);

  const refreshDomSelectionAvailability = useCallback(async (): Promise<void> => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];
      if (!activeTab?.url) {
        setDomSelectionUnavailableReason('Active tab URL is unavailable.');
        return;
      }

      const policy = extractPermissionPolicy(chrome.runtime.getManifest());
      if (policy.optionalHostPermissions.length === 0) {
        setDomSelectionUnavailableReason('optional_host_permissions is empty.');
        return;
      }

      const protocol = getTabProtocol(activeTab.url);
      if (protocol !== 'http:' && protocol !== 'https:') {
        setDomSelectionUnavailableReason(`This page protocol is not supported (${protocol}).`);
        return;
      }

      const optionalOnlyPolicy = {
        hostPermissions: [] as string[],
        optionalHostPermissions: policy.optionalHostPermissions
      };
      if (!isUrlAllowedByPermissionPolicy(activeTab.url, optionalOnlyPolicy)) {
        setDomSelectionUnavailableReason('This site is not included in optional_host_permissions.');
        return;
      }

      setDomSelectionUnavailableReason('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDomSelectionUnavailableReason(`Failed to evaluate active tab: ${message}`);
    }
  }, []);

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

  const applySidePanelEvent = useCallback((event: SidePanelEvent): void => {
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

    if (event.type === 'THREADS_UPDATED') {
      void loadThreadsAndMaybeMessages();
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
      const { threadId, messageId, finalText } = event.payload;
      setTokenTimestampByMessage((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
      setMessagesByThread((prev) => {
        const current = prev[threadId] ?? [];
        const next = current.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                ...(typeof finalText === 'string' && finalText.length > 0 ? { contentMd: finalText } : {}),
                status: 'done' as const
              }
            : msg
        );
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
  }, [loadThreadsAndMaybeMessages]);

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
  }, [applySidePanelEvent, loadThreadsAndMaybeMessages]);

  useEffect(() => {
    void refreshDomSelectionAvailability();

    const onActivated = (): void => {
      void refreshDomSelectionAvailability();
    };
    const onUpdated = (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab): void => {
      if (!tab.active) {
        return;
      }
      if (!changeInfo.url && changeInfo.status !== 'complete') {
        return;
      }
      void refreshDomSelectionAvailability();
    };

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [refreshDomSelectionAvailability]);

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

  function openDeleteDialog(thread: Thread): void {
    setDeleteTargetThread(thread);
    setDeleteDialogNotice('');
  }

  function closeDeleteDialog(): void {
    if (isDeleteActionRunning) {
      return;
    }
    setDeleteTargetThread(undefined);
    setDeleteDialogNotice('');
  }

  async function saveThreadBeforeDelete(thread: Thread): Promise<void> {
    setIsDeleteActionRunning(true);
    setDeleteDialogNotice('');
    try {
      const result = await sendCommand<ExportThreadsResult>({
        type: 'EXPORT_THREADS',
        payload: { threadIds: [thread.id] }
      });
      const archive = result.archives[0];
      if (!archive) {
        throw new Error('Target thread was not found');
      }
      triggerDownload(threadFileName(archive.thread, archive.exportedAt), JSON.stringify(archive, null, 2));
      setDeleteDialogNotice('Thread file saved.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDeleteDialogNotice(`Failed to save thread: ${message}`);
    } finally {
      setIsDeleteActionRunning(false);
    }
  }

  async function deleteThreadConfirmed(thread: Thread): Promise<void> {
    setIsDeleteActionRunning(true);
    setDeleteDialogNotice('');
    try {
      await sendCommand({ type: 'DELETE_THREAD', payload: { threadId: thread.id } });
      await loadThreadsAndMaybeMessages();
      setDeleteTargetThread(undefined);
    } finally {
      setIsDeleteActionRunning(false);
    }
  }

  async function renameThread(threadId: string, title: string): Promise<void> {
    try {
      await sendCommand({ type: 'RENAME_THREAD', payload: { threadId, title } });
      await loadThreadsAndMaybeMessages();
      setStatusReason('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusReason(`Failed to rename thread: ${message}`);
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
      setStatusReason(`Failed to attach selection: ${message}. Re-select text in the tab and re-grant permissions if needed.`);
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
    setStatusReason('DOM selection mode started. Click elements on the page to select/deselect.');
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
        setStatusReason('Cleared all DOM selections.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!silent) {
        setStatusReason(`Failed to clear DOM selections: ${message}`);
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
      setStatusReason(`Failed to switch context mode: ${message}`);
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

    const scope = result.source === 'dom_selection' ? 'DOM selection' : 'Viewport';
    setStatusReason(`Context source: ${scope}`);

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
    setStatusReason('Sent page context once and turned off context mode.');
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
        setStatusReason(`Failed to capture page context: ${message}`);
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
      setShouldScrollToBottom(true);
      await loadThreadsAndMaybeMessages();
      await consumeOnceContextIfNeeded(contextWillBeAttached);
      if (!contextWillBeAttached) {
        setStatusReason('');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusReason(`Failed to send: ${message}`);
    }
  }

  function removePendingAttachment(index: number): void {
    setPendingAttachments((prev) => prev.filter((_, idx) => idx !== index));
  }

  async function connectWs(): Promise<void> {
    try {
      const policy = extractPermissionPolicy(chrome.runtime.getManifest());
      const nextUrl = assertUrlAllowedByPermissionPolicy(wsUrl, policy, 'WebSocket URL');
      setWsUrl(nextUrl);
      await sendCommand({ type: 'CONNECT_WS', payload: { url: nextUrl } });
      await loadWsStatus();
      await refreshUsageLimitsWithRetry();
      setStatusReason('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusReason(`Failed to connect: ${message}`);
    }
  }

  async function disconnectWs(): Promise<void> {
    try {
      await sendCommand({ type: 'DISCONNECT_WS', payload: {} });
      await loadWsStatus();
      setStatusReason('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusReason(`Failed to disconnect: ${message}`);
    }
  }

  async function saveSettings(): Promise<void> {
    const policy = extractPermissionPolicy(chrome.runtime.getManifest());
    const nextUrl = assertUrlAllowedByPermissionPolicy(wsUrl, policy, 'WebSocket URL');
    setWsUrl(nextUrl);
    await sendCommand({ type: 'SAVE_SETTINGS', payload: { wsUrl: nextUrl } });
    setStatusReason('Connection URL saved.');
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
      await navigator.clipboard.writeText(text || 'No logs');
      setCopyNotice(mode === 'latest' ? 'Copied latest log.' : 'Copied all logs.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCopyNotice(`Copy failed: ${message}`);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-main">
          <StatusBadge status={status} />
          {isConnected ? (
            <button
              type="button"
              onClick={() => void disconnectWs()}
              className="subtle-action-button"
              aria-label="Disconnect"
              title="Disconnect"
            >
              Disconnect
            </button>
          ) : null}
        </div>
        <div className="header-actions">
          <UsageLimitBars usage={usageLimits} />
        </div>
      </header>

      {statusReason ? <p className="status-reason">{statusReason}</p> : null}

      {!isConnected ? (
        <section className="connection-gate" aria-label="Connection settings">
          <h2>Connection Settings</h2>
          <label>
            Codex app-server URL
            <input value={wsUrl} onChange={(event) => setWsUrl(event.target.value)} placeholder="ws://127.0.0.1:43172" />
          </label>
          <div className="connection-gate-actions">
            <button type="button" onClick={() => void saveSettings()}>
              Save URL
            </button>
            <button type="button" onClick={() => void connectWs()} className="primary-button">
              Connect
            </button>
          </div>
          <small>Threads and chat will appear after connecting.</small>
          <small>Press Ctrl+Shift+D to show WS debug logs.</small>
        </section>
      ) : (
        <>
          <div className="main">
            <ThreadList
              threads={threads}
              currentThreadId={currentThreadId}
              onCreate={() => void createThread()}
              onSwitch={(id) => void switchThread(id)}
              onDeleteRequest={(thread) => openDeleteDialog(thread)}
              onRename={(id, title) => renameThread(id, title)}
            />
            <section className="chat-panel" aria-label="Chat">
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
                  containerRef={messagesContainerRef}
                />
              </div>

              {pendingAttachments.length > 0 ? (
                <div className="pending-attachments">
                  <div className="attachments">Pending attachments (included in next send)</div>
                  <div className="pending-attachment-list">
                    {pendingAttachments.map((item, index) => (
                      <div key={`${item.capturedAt}-${index}`} className="pending-attachment-item">
                        <div>
                          <small>{attachmentSummary(item)}</small>
                          <small>{item.url}</small>
                          <span>{item.text}</span>
                        </div>
                        <button type="button" onClick={() => removePendingAttachment(index)}>
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="composer">
                <div className="context-controls" role="group" aria-label="Reference context">
                  <button
                    type="button"
                    className={`context-chip ${contextMode === 'chat_only' ? 'active' : ''}`}
                    onClick={() => void changeContextMode('chat_only')}
                    disabled={!isConnected}
                  >
                    Chat only
                  </button>
                  <button
                    type="button"
                    className={`context-chip ${contextMode === 'dom' ? 'active' : ''}`}
                    onClick={() => void changeContextMode('dom')}
                    disabled={!isConnected || isDomSelectionUnavailable}
                  >
                    DOM selection
                  </button>
                  {isDomSelectionUnavailable ? <small>{domSelectionUnavailableReason}</small> : null}
                  {contextMode === 'dom' ? (
                    <>
                      <span className={`dom-mode-state ${domSelectionActive ? 'active' : 'inactive'}`}>
                        {domSelectionActive ? 'Active' : 'Idle'}: {domSelectionCount} items
                      </span>
                      <button
                        type="button"
                        onClick={() => void clearDomSelectionMode()}
                        disabled={!isConnected || isDomSelectionUnavailable}
                      >
                        Clear DOM
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
                      Attach current page selection
                    </button>
                    <small>`Enter`: newline / `Ctrl+Enter`: send</small>
                  </div>

                  <div className="composer-buttons">
                    <button
                      type="button"
                      onClick={() => void sendAttachmentsOnly()}
                      disabled={composerDisabled || (pendingAttachments.length === 0 && !contextArmed)}
                    >
                      Send attachments only
                    </button>
                    <button
                      type="button"
                      onClick={() => void sendMessage()}
                      className="primary-button"
                      disabled={composerDisabled || !hasAnyContentForSend}
                    >
                      Send
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </div>

          {deleteTargetThread ? (
            <div className="confirm-overlay" role="presentation">
              <div className="confirm-dialog" role="dialog" aria-modal="true" aria-label="Delete thread confirmation">
                <h3>Delete thread?</h3>
                <p className="confirm-title">{deleteTargetThread.title}</p>
                <p className="confirm-note">Save a local file before deletion if you need to keep this thread.</p>
                {deleteDialogNotice ? <p className="confirm-notice">{deleteDialogNotice}</p> : null}
                <div className="confirm-actions">
                  <button type="button" onClick={closeDeleteDialog} disabled={isDeleteActionRunning}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveThreadBeforeDelete(deleteTargetThread)}
                    disabled={isDeleteActionRunning}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => void deleteThreadConfirmed(deleteTargetThread)}
                    disabled={isDeleteActionRunning}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}

      {devMode ? (
        <section className="ws-debug-log" aria-label="WS debug log">
          <div className="ws-debug-log-header">
            <strong>WS Logs</strong>
            <div className="ws-debug-log-actions">
              <button type="button" onClick={() => void copyWsLogs('latest')}>
                Copy latest
              </button>
              <button type="button" onClick={() => void copyWsLogs('all')}>
                Copy all
              </button>
              <button type="button" onClick={() => setWsLogs([])}>
                Clear
              </button>
            </div>
          </div>
          {copyNotice ? <small>{copyNotice}</small> : null}
          <div className="ws-debug-log-body">
            {wsLogs.length === 0 ? (
              <small>No logs</small>
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
    </div>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

function formatMessageTimestamp(ts: number): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function formatThreadUpdatedAt(ts: number): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}
