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

function MessageList({ messages }: { messages: Message[] }): JSX.Element {
  function toDisplayMarkdown(message: Message): string {
    const body = message.contentMd.trim();
    const attachments = (message.attachments ?? [])
      .map((item, index) => {
        const source = item.url ? `出典URL: ${item.url}\n\n` : '';
        return `### 添付 ${index + 1}\n\n${source}${item.text}`;
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
      <div className="messages-empty">
        <strong>メッセージがありません</strong>
        <small>下の入力欄からチャットを開始してください</small>
      </div>
    );
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
  const [devMode, setDevMode] = useState(false);

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
    try {
      await sendCommand({ type: 'CONNECT_WS', payload: { url: wsUrl } });
      await loadWsStatus();
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
    if (event.key === 'Enter' && !event.shiftKey) {
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
              <MessageList messages={currentMessages} />

              {pendingAttachments.length > 0 ? (
                <div className="pending-attachments">
                  <div className="attachments">添付候補（次の送信に同梱）</div>
                  <div className="pending-attachment-list">
                    {pendingAttachments.map((item, index) => (
                      <div key={`${item.capturedAt}-${index}`} className="pending-attachment-item">
                        <div>
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
                    <small>Enter送信 / Shift+Enter改行</small>
                  </div>

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
                      className="primary-button"
                      disabled={composerDisabled || (!input.trim() && pendingAttachments.length === 0)}
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
