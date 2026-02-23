import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type {
  AttachSelectionResult,
  CreateThreadResult,
  ListThreadsResult,
  MessagesResult,
  SettingsResult,
  SidePanelEvent
} from '../contracts/messages';
import type { Attachment, Message, Thread, WsStatus } from '../contracts/types';
import { SafeMarkdown } from '../shared/markdown';
import { sendCommand, listenEvents } from '../shared/runtime';

interface MessagesByThread {
  [threadId: string]: Message[];
}

function StatusBadge({ status }: { status: WsStatus }): JSX.Element {
  return <span className="status">{status}</span>;
}

function ThreadList(props: {
  threads: Thread[];
  currentThreadId?: string;
  onSwitch: (threadId: string) => void;
  onDelete: (threadId: string) => void;
}): JSX.Element {
  return (
    <div className="threads">
      {props.threads.map((thread) => (
        <div key={thread.id}>
          <button
            className={`thread-item ${props.currentThreadId === thread.id ? 'active' : ''}`}
            onClick={() => props.onSwitch(thread.id)}
            type="button"
          >
            {thread.title}
          </button>
          <button type="button" onClick={() => props.onDelete(thread.id)}>
            削除
          </button>
        </div>
      ))}
    </div>
  );
}

function MessageList({ messages }: { messages: Message[] }): JSX.Element {
  return (
    <div className="messages">
      {messages.map((message) => (
        <article key={message.id} className={`message ${message.role}`}>
          <header>
            <strong>{message.role}</strong> / {message.status}
          </header>
          <div className="message-content">
            <SafeMarkdown markdown={message.contentMd} />
          </div>
          {message.attachments && message.attachments.length > 0 ? (
            <div className="attachments">
              添付: {message.attachments.map((item) => item.text).join(' / ')}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
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

  const currentMessages = useMemo(() => {
    if (!currentThreadId) {
      return [];
    }
    return messagesByThread[currentThreadId] ?? [];
  }, [currentThreadId, messagesByThread]);

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

  function applySidePanelEvent(event: SidePanelEvent): void {
    if (event.type === 'WS_STATUS_CHANGED') {
      setStatus(event.payload.status);
      setStatusReason(event.payload.reason ?? '');
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
    const unlisten = listenEvents(applySidePanelEvent);
    return () => unlisten();
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

  async function attachSelection(): Promise<void> {
    try {
      await sendCommand<AttachSelectionResult>({ type: 'ATTACH_SELECTION', payload: {} });
      setStatusReason('');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusReason(
        `選択の添付に失敗: ${message}。タブでテキストを再選択し、必要なら拡張アイコンをクリックして権限を再付与してください。`
      );
    }
  }

  async function sendMessage(): Promise<void> {
    if (!currentThreadId || (!input.trim() && pendingAttachments.length === 0)) {
      return;
    }

    const text = input;
    const attachments = pendingAttachments;

    setInput('');
    setPendingAttachments([]);

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
  }

  async function connectWs(): Promise<void> {
    await sendCommand({ type: 'CONNECT_WS', payload: { url: wsUrl } });
  }

  async function disconnectWs(): Promise<void> {
    await sendCommand({ type: 'DISCONNECT_WS', payload: {} });
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
          <div className="attachments">添付候補: {pendingAttachments.map((item) => item.text).join(' / ')}</div>
        ) : null}

        <textarea
          placeholder="メッセージ"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onComposerKeyDown}
        />

        <div className="composer-actions">
          <small>Enter送信 / Shift+Enter改行</small>
          <button type="button" onClick={() => void sendMessage()}>
            送信
          </button>
        </div>
      </div>
    </div>
  );
}
