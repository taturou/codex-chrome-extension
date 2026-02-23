import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type {
  AttachSelectionResult,
  CreateThreadResult,
  ListThreadsResult,
  MessagesResult,
  SettingsResult,
  SidePanelEvent,
  WsStatusResult
} from '../contracts/messages';
import type { Attachment, Message, Thread, WsDebugLogEntry, WsStatus } from '../contracts/types';
import { SafeMarkdown } from '../shared/markdown';
import { sendCommand, listenEvents } from '../shared/runtime';

interface MessagesByThread {
  [threadId: string]: Message[];
}

function StatusBadge({ status }: { status: WsStatus }): JSX.Element {
  return <span className={`status status-${status}`}>{status}</span>;
}

function ThreadList(props: {
  threads: Thread[];
  currentThreadId?: string;
  onSwitch: (threadId: string) => void;
  onDelete: (threadId: string) => void;
  onRename: (threadId: string, title: string) => Promise<void>;
}): JSX.Element {
  async function openRenameDialog(thread: Thread): Promise<void> {
    const entered = globalThis.prompt('新しいスレッド名を入力してください', thread.title);
    if (entered === null) {
      return;
    }

    const nextTitle = entered.trim();
    if (!nextTitle || nextTitle === thread.title) {
      return;
    }
    await props.onRename(thread.id, nextTitle);
  }

  return (
    <div className="threads">
      {props.threads.map((thread) => (
        <div key={thread.id} className="thread-row">
          <button
            className={`thread-item ${props.currentThreadId === thread.id ? 'active' : ''}`}
            onClick={() => props.onSwitch(thread.id)}
            type="button"
          >
            <span>{thread.title}</span>
            <small className="thread-meta">作成: {formatThreadCreatedAt(thread.createdAt)}</small>
          </button>
          <div className="thread-actions">
            <button type="button" onClick={() => void openRenameDialog(thread)}>
              名前変更
            </button>
            <button type="button" onClick={() => props.onDelete(thread.id)}>
              削除
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function MessageList({ messages }: { messages: Message[] }): JSX.Element {
  function toDisplayMarkdown(message: Message): string {
    const body = message.contentMd.trim();
    const attachments = (message.attachments ?? [])
      .map((item, index) => `### 添付 ${index + 1}\n\n${item.text}`)
      .join('\n\n');

    if (!attachments) {
      return body;
    }
    if (!body) {
      return attachments;
    }
    return `${body}\n\n---\n\n${attachments}`;
  }

  return (
    <div className="messages">
      {messages.map((message) => (
        <article key={message.id} className={`message ${message.role}`}>
          <header>
            <strong>{message.role}</strong> / {message.status}
          </header>
          <div className="message-content">
            <SafeMarkdown markdown={toDisplayMarkdown(message)} />
          </div>
        </article>
      ))}
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

  const currentMessages = useMemo(() => {
    if (!currentThreadId) {
      return [];
    }
    return messagesByThread[currentThreadId] ?? [];
  }, [currentThreadId, messagesByThread]);

  const hasThread = Boolean(currentThreadId);
  const isConnected = status === 'connected';
  const composerDisabled = !hasThread || !isConnected;

  const composerPlaceholder = useMemo(() => {
    if (!hasThread && !isConnected) {
      return '先に「新規スレッド」を作成し、WSに接続してください';
    }
    if (!hasThread) {
      return '先に「新規スレッド」を作成してください';
    }
    if (!isConnected) {
      return '送信するにはWS接続が必要です';
    }
    return 'メッセージ';
  }, [hasThread, isConnected]);

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

    if (event.type === 'SELECTION_ATTACHED') {
      setPendingAttachments((prev) => [...prev, event.payload.attachment]);
      return;
    }

    if (event.type === 'CHAT_TOKEN') {
      const { threadId, messageId, token } = event.payload;
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
      setMessagesByThread((prev) => {
        const current = prev[threadId] ?? [];
        const next = current.map((msg) => (msg.id === messageId ? { ...msg, status: 'done' as const } : msg));
        return { ...prev, [threadId]: next };
      });
      return;
    }

    if (event.type === 'CHAT_ERROR') {
      const { threadId, messageId } = event.payload;
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

  async function sendMessage(): Promise<void> {
    await sendPayload(input, pendingAttachments);
  }

  async function sendAttachmentsOnly(): Promise<void> {
    await sendPayload('', pendingAttachments);
  }

  async function sendPayload(text: string, attachments: Attachment[]): Promise<void> {
    if (!currentThreadId || status !== 'connected' || (!text.trim() && attachments.length === 0)) {
      return;
    }

    setInput('');
    setPendingAttachments([]);

    try {
      await sendCommand({
        type: 'SEND_CHAT_MESSAGE',
        payload: {
          threadId: currentThreadId,
          text,
          attachments
        }
      });

      const res = await sendCommand<MessagesResult>({
        type: 'GET_THREAD_MESSAGES',
        payload: { threadId: currentThreadId }
      });

      setMessagesByThread((prev) => ({ ...prev, [currentThreadId]: res.messages }));
      await loadThreadsAndMaybeMessages();
      setStatusReason('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusReason(`送信に失敗: ${message}`);
    }
  }

  function removePendingAttachment(index: number): void {
    setPendingAttachments((prev) => prev.filter((_, idx) => idx !== index));
  }

  async function connectWs(): Promise<void> {
    await sendCommand({ type: 'CONNECT_WS', payload: { url: wsUrl } });
    await loadWsStatus();
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
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  async function copyWsLogs(): Promise<void> {
    const text = wsLogs
      .map((entry) => {
        const time = formatTime(entry.ts);
        const detail = entry.detail ? `\n${entry.detail}` : '';
        return `${time} [${entry.category}] ${entry.message}${detail}`;
      })
      .join('\n\n');

    try {
      await navigator.clipboard.writeText(text || 'ログなし');
      setCopyNotice('コピーしました');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCopyNotice(`コピー失敗: ${message}`);
    }
  }

  return (
    <div className="app">
      <div className="header">
        <strong>Codex Chat</strong>
        <StatusBadge status={status} />
        {statusReason ? <small>{statusReason}</small> : null}
      </div>

      <div className="toolbar">
        <button type="button" onClick={() => void createThread()}>
          新規スレッド
        </button>
        <button type="button" onClick={() => void connectWs()}>
          再接続
        </button>
        <button type="button" onClick={() => void disconnectWs()}>
          切断
        </button>
        <button type="button" onClick={() => void attachSelection()}>
          選択を添付
        </button>
      </div>

      <div className="main">
        <ThreadList
          threads={threads}
          currentThreadId={currentThreadId}
          onSwitch={(id) => void switchThread(id)}
          onDelete={(id) => void deleteThread(id)}
          onRename={(id, title) => renameThread(id, title)}
        />
        <MessageList messages={currentMessages} />
      </div>

      <div className="composer">
        <label>
          WS URL:
          <input value={wsUrl} onChange={(event) => setWsUrl(event.target.value)} />
          <button type="button" onClick={() => void saveSettings()}>
            URL保存
          </button>
        </label>

        {pendingAttachments.length > 0 ? (
          <div className="pending-attachments">
            <div className="attachments">添付候補（次の送信に同梱されます）</div>
            <small>Enterで本文+添付送信 / 「添付のみ送信」で本文なし送信</small>
            <div className="pending-attachment-list">
              {pendingAttachments.map((item, index) => (
                <div key={`${item.capturedAt}-${index}`} className="pending-attachment-item">
                  <span>{item.text}</span>
                  <button type="button" onClick={() => removePendingAttachment(index)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <textarea
          placeholder={composerPlaceholder}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onComposerKeyDown}
          disabled={composerDisabled}
        />

        <div className="composer-actions">
          <small>Enter送信 / Shift+Enter改行</small>
          <div className="composer-buttons">
            <button
              type="button"
              onClick={() => void sendAttachmentsOnly()}
              disabled={composerDisabled || pendingAttachments.length === 0}
            >
              添付のみ送信
            </button>
            <button
              type="button"
              onClick={() => void sendMessage()}
              disabled={composerDisabled || (!input.trim() && pendingAttachments.length === 0)}
            >
              送信
            </button>
          </div>
        </div>

        <div className="ws-debug-log">
          <div className="ws-debug-log-header">
            <strong>WSログ</strong>
            <div className="ws-debug-log-actions">
              <button type="button" onClick={() => void copyWsLogs()}>
                コピー
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
        </div>
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ja-JP', { hour12: false });
}

function formatThreadCreatedAt(ts: number): string {
  return new Date(ts).toLocaleString('ja-JP', { hour12: false });
}
