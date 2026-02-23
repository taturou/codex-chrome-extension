import type { Attachment, WsDebugLogEntry, WsStatus } from '../contracts/types';
import { computeBackoffMs } from '../shared/backoff';

interface ChatSendPayload {
  threadId: string;
  messageId: string;
  text: string;
  attachments: Attachment[];
}

interface TransportEvents {
  onStatus: (status: WsStatus, reason?: string) => void;
  onDebug: (entry: WsDebugLogEntry) => void;
  onToken: (event: { threadId: string; messageId?: string; token: string }) => void;
  onDone: (event: { threadId: string; messageId?: string }) => void;
  onError: (event: { threadId?: string; messageId?: string; error: string }) => void;
}

type InitState = 'idle' | 'pending' | 'ready';

type PendingRequest =
  | {
      kind: 'thread/start';
      localThreadId: string;
      localMessageId: string;
      text: string;
      attachments: Attachment[];
      retryCount: number;
    }
  | {
      kind: 'turn/start';
      remoteThreadId: string;
      localThreadId: string;
      localMessageId: string;
      text: string;
      attachments: Attachment[];
      retryCount: number;
    }

const QUEUE_OVERFLOW_CODE = -32001;
const MAX_QUEUE_RETRIES = 3;

function extractString(input: unknown): string | undefined {
  return typeof input === 'string' ? input : undefined;
}

function extractRecord(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  return input as Record<string, unknown>;
}

function extractNumber(input: unknown): number | undefined {
  return typeof input === 'number' ? input : undefined;
}

function pickString(
  sources: Array<Record<string, unknown> | undefined>,
  keys: string[]
): string | undefined {
  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const key of keys) {
      const found = extractString(source[key]);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function parseIncoming(raw: string):
  | { kind: 'token'; threadId?: string; messageId?: string; token: string; sourceMethod?: string }
  | { kind: 'done'; threadId?: string; messageId?: string }
  | { kind: 'error'; threadId?: string; messageId?: string; error: string }
  | { kind: 'unknown' } {
  try {
    const data = extractRecord(JSON.parse(raw));
    if (!data) {
      return { kind: 'unknown' };
    }

    const params = extractRecord(data.params);
    const payload = extractRecord(data.payload);
    const msg = extractRecord(params?.msg);
    const errorObj = extractRecord(data.error) ?? extractRecord(params?.error);
    const isRpcResponse = typeof data.id === 'string' || typeof data.id === 'number';
    if (isRpcResponse) {
      return { kind: 'unknown' };
    }

    const method = pickString([data], ['method']);
    const type = pickString([data, params, msg], ['type', 'event']);
    const threadId = pickString([data, params, msg], ['threadId', 'thread_id', 'conversationId', 'conversation_id']);
    const messageId = pickString([data, params, msg], ['messageId', 'message_id', 'itemId', 'item_id']);
    const token = pickString([data, params, payload, msg], ['token', 'delta']) ?? '';

    const isTokenEvent =
      method === 'item/agentMessage/delta' ||
      method === 'codex/event/agent_message_delta' ||
      method === 'codex/event/agent_message_content_delta' ||
      type === 'agent_message_delta' ||
      type === 'agent_message_content_delta' ||
      Boolean(type && type.includes('token'));

    if (isTokenEvent && token) {
      return { kind: 'token', threadId, messageId, token, sourceMethod: method };
    }

    const isDoneEvent =
      method === 'turn/completed' ||
      type === 'turn_completed' ||
      type === 'turn_done' ||
      method === 'turn/done';
    if (isDoneEvent) {
      return { kind: 'done', threadId, messageId };
    }

    if (data.error || method === 'error' || Boolean(type && type.includes('error'))) {
      return {
        kind: 'error',
        threadId,
        messageId,
        error: pickString([errorObj, data, params, msg], ['message', 'error']) ?? 'unknown error'
      };
    }

    return { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

export class WebSocketTransport {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private shouldReconnect = true;
  private url = '';
  private skipNextCloseReconnect = false;
  private latestLocalMessageByThread = new Map<string, string>();
  private remoteThreadByLocal = new Map<string, string>();
  private localThreadByRemote = new Map<string, string>();
  private initState: InitState = 'idle';
  private rpcSequence = 1;
  private initRequestId: string | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private retryTimers = new Set<number>();

  constructor(private readonly events: TransportEvents) {}

  connect(url: string): void {
    this.debug('state', 'connect requested', url);
    this.url = url;
    this.shouldReconnect = true;
    this.clearReconnectTimer();

    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      this.debug('state', 'connect skipped (socket already open/connecting)');
      return;
    }

    this.events.onStatus('connecting');
    this.debug('state', 'socket connecting', url);
    this.socket = new WebSocket(url);

    this.socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.events.onStatus('connected');
      this.debug('state', 'socket opened');
      this.sendInitialize();
    };

    this.socket.onmessage = (event) => {
      const raw = String(event.data);
      this.debug('recv', 'socket message', truncate(raw, 1200));
      this.handleRpcResponse(raw);
      const parsed = parseIncoming(raw);
      if (parsed.kind === 'token') {
        if (parsed.sourceMethod === 'codex/event/agent_message_delta') {
          return;
        }
        if (parsed.sourceMethod === 'codex/event/agent_message_content_delta') {
          return;
        }
        const localThreadId = this.resolveLocalThreadId(parsed.threadId);
        if (!localThreadId) {
          return;
        }
        const latestLocalMessageId = this.latestLocalMessageByThread.get(localThreadId);
        const resolvedMessageId = latestLocalMessageId ?? parsed.messageId;
        this.events.onToken({ threadId: localThreadId, messageId: resolvedMessageId, token: parsed.token });
      } else if (parsed.kind === 'done') {
        const localThreadId = this.resolveLocalThreadId(parsed.threadId);
        if (!localThreadId) {
          return;
        }
        const latestLocalMessageId = this.latestLocalMessageByThread.get(localThreadId);
        const resolvedMessageId = latestLocalMessageId ?? parsed.messageId;
        this.events.onDone({ threadId: localThreadId, messageId: resolvedMessageId });
        if (resolvedMessageId) {
          this.latestLocalMessageByThread.delete(localThreadId);
        }
      } else if (parsed.kind === 'error') {
        const localThreadId = this.resolveLocalThreadId(parsed.threadId);
        const latestLocalMessageId = localThreadId && this.latestLocalMessageByThread.get(localThreadId);
        const resolvedMessageId =
          localThreadId && (latestLocalMessageId ?? parsed.messageId);
        this.events.onError({
          threadId: localThreadId,
          messageId: resolvedMessageId,
          error: parsed.error
        });
      }
    };

    this.socket.onerror = () => {
      this.debug('error', 'socket error');
      this.events.onStatus('error', 'socket error');
    };

    this.socket.onclose = (event) => {
      this.initState = 'idle';
      this.initRequestId = null;
      this.pendingRequests.clear();
      this.clearRetryTimers();
      const reasonParts = [`code=${event.code}`];
      if (event.reason) {
        reasonParts.push(`reason=${event.reason}`);
      } else if (event.code === 1006) {
        reasonParts.push(
          'abnormal closure (server down / origin denied / websocket handshake rejected)'
        );
      }
      this.debug('state', 'socket closed', reasonParts.join(' '));
      this.events.onStatus('disconnected', reasonParts.join(' '));
      this.socket = null;
      if (this.skipNextCloseReconnect) {
        this.skipNextCloseReconnect = false;
        return;
      }
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };
  }

  disconnect(): void {
    this.debug('state', 'manual disconnect requested');
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.clearRetryTimers();
    this.latestLocalMessageByThread.clear();
    this.remoteThreadByLocal.clear();
    this.localThreadByRemote.clear();
    this.pendingRequests.clear();
    this.initState = 'idle';
    this.initRequestId = null;
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.events.onStatus('disconnected', 'manual disconnect');
  }

  reconnectNow(nextUrl?: string): void {
    this.debug('state', 'manual reconnect requested', nextUrl ?? this.url);
    if (nextUrl) {
      this.url = nextUrl;
    }
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.clearRetryTimers();
    this.latestLocalMessageByThread.clear();
    this.remoteThreadByLocal.clear();
    this.localThreadByRemote.clear();
    this.pendingRequests.clear();
    this.initState = 'idle';
    this.initRequestId = null;
    if (this.socket) {
      this.skipNextCloseReconnect = true;
      this.socket.close();
      this.socket = null;
    }
    if (this.url) {
      this.connect(this.url);
    }
  }

  sendChat(payload: ChatSendPayload): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    if (this.initState !== 'ready') {
      throw new Error('WebSocket is not initialized');
    }
    this.latestLocalMessageByThread.set(payload.threadId, payload.messageId);
    const remoteThreadId = this.remoteThreadByLocal.get(payload.threadId);
    if (remoteThreadId) {
      this.debug('state', 'send turn/start (existing thread)', `local=${payload.threadId} remote=${remoteThreadId}`);
      this.sendTurnStart(remoteThreadId, payload.threadId, payload.messageId, payload.text, payload.attachments);
      return;
    }
    this.debug('state', 'send thread/start (new thread)', `local=${payload.threadId}`);
    this.sendThreadStart(payload.threadId, payload.messageId, payload.text, payload.attachments);
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = computeBackoffMs(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.debug('state', 'reconnect scheduled', `${delay}ms`);

    this.reconnectTimer = globalThis.setTimeout(() => {
      if (this.url && this.shouldReconnect) {
        this.debug('state', 'reconnect timer fired', this.url);
        this.connect(this.url);
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearRetryTimers(): void {
    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
  }

  private sendInitialize(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.initState !== 'idle') {
      return;
    }
    this.initState = 'pending';
    this.initRequestId = this.sendRpcRequest('initialize', {
      clientInfo: {
        name: 'codex-chrome-extension',
        title: 'codex-chrome-extension',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: false
      }
    });
  }

  private sendThreadStart(
    localThreadId: string,
    localMessageId: string,
    text: string,
    attachments: Attachment[],
    retryCount = 0
  ): void {
    const id = this.sendRpcRequest('thread/start', {
      experimentalRawEvents: false,
      persistExtendedHistory: false
    });
    this.pendingRequests.set(id, {
      kind: 'thread/start',
      localThreadId,
      localMessageId,
      text,
      attachments,
      retryCount
    });
  }

  private sendTurnStart(
    remoteThreadId: string,
    localThreadId: string,
    localMessageId: string,
    text: string,
    attachments: Attachment[],
    retryCount = 0
  ): void {
    const id = this.sendRpcRequest('turn/start', {
      threadId: remoteThreadId,
      input: [
        {
          type: 'text',
          text: buildInputText(text, attachments),
          text_elements: []
        }
      ]
    });
    this.pendingRequests.set(id, {
      kind: 'turn/start',
      remoteThreadId,
      localThreadId,
      localMessageId,
      text,
      attachments,
      retryCount
    });
  }

  private sendRpcRequest(method: string, params?: Record<string, unknown>): string {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    const id = String(this.rpcSequence);
    this.rpcSequence += 1;
    const payload = {
      id,
      method,
      ...(params ? { params } : {})
    };
    this.socket.send(JSON.stringify(payload));
    this.debug('send', `rpc request ${method}#${id}`, truncate(safeStringify(payload), 1200));
    return id;
  }

  private sendRpcNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    const payload = {
      method,
      ...(params ? { params } : {})
    };
    this.socket.send(JSON.stringify(payload));
    this.debug('send', `rpc notification ${method}`, truncate(safeStringify(payload), 1200));
  }

  private resolveLocalThreadId(threadId?: string): string | undefined {
    if (!threadId) {
      return undefined;
    }
    return this.localThreadByRemote.get(threadId) ?? threadId;
  }

  private handleRpcResponse(raw: string): void {
    const data = this.safeParseRecord(raw);
    if (!data) {
      return;
    }

    const id = extractString(data.id);
    const result = extractRecord(data.result);
    const error = extractRecord(data.error);

    if (this.initRequestId && id === this.initRequestId && result) {
      this.initState = 'ready';
      this.sendRpcNotification('initialized');
      this.initRequestId = null;
      this.debug('state', 'initialize acknowledged');
      return;
    }

    if (!id) {
      return;
    }

    const pending = this.pendingRequests.get(id);
    if (!pending) {
      if (error) {
        const message = extractString(error.message) ?? 'unknown error';
        this.debug('error', 'rpc error (untracked id)', message);
        this.events.onError({ error: message });
      }
      return;
    }
    this.pendingRequests.delete(id);

    if (error) {
      const message = extractString(error.message) ?? 'unknown error';
      const code = extractNumber(error.code);
      if (code === QUEUE_OVERFLOW_CODE && pending.retryCount < MAX_QUEUE_RETRIES) {
        this.scheduleRetry({
          ...pending,
          retryCount: pending.retryCount + 1
        });
        return;
      }
      this.debug('error', `rpc error (${pending.kind})`, message);
      this.events.onError({
        threadId: pending.localThreadId,
        messageId: pending.localMessageId,
        error: message
      });
      return;
    }

    if (pending.kind === 'thread/start') {
      const thread = extractRecord(result?.thread);
      const remoteThreadId = extractString(thread?.id);
      if (!remoteThreadId) {
        this.debug('error', 'thread/start missing thread.id');
        this.events.onError({
          threadId: pending.localThreadId,
          messageId: pending.localMessageId,
          error: 'thread/start result missing thread.id'
        });
        return;
      }
      this.remoteThreadByLocal.set(pending.localThreadId, remoteThreadId);
      this.localThreadByRemote.set(remoteThreadId, pending.localThreadId);
      this.debug('state', 'thread mapped', `local=${pending.localThreadId} remote=${remoteThreadId}`);
      this.sendTurnStart(
        remoteThreadId,
        pending.localThreadId,
        pending.localMessageId,
        pending.text,
        pending.attachments
      );
    }
  }

  private scheduleRetry(pending: PendingRequest): void {
    const delay = computeBackoffMs(pending.retryCount, 500, 5000);
    this.debug('state', 'rpc retry scheduled', `${pending.kind} retry=${pending.retryCount} delay=${delay}ms`);
    const timer = globalThis.setTimeout(() => {
      this.retryTimers.delete(timer);
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.initState !== 'ready') {
        this.events.onError({
          threadId: pending.localThreadId,
          messageId: pending.localMessageId,
          error: 'WebSocket is not ready for retry'
        });
        return;
      }
      if (pending.kind === 'thread/start') {
        this.sendThreadStart(
          pending.localThreadId,
          pending.localMessageId,
          pending.text,
          pending.attachments,
          pending.retryCount
        );
        return;
      }
      this.sendTurnStart(
        pending.remoteThreadId,
        pending.localThreadId,
        pending.localMessageId,
        pending.text,
        pending.attachments,
        pending.retryCount
      );
    }, delay);
    this.retryTimers.add(timer);
  }

  private safeParseRecord(raw: string): Record<string, unknown> | undefined {
    try {
      return extractRecord(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  private debug(category: WsDebugLogEntry['category'], message: string, detail?: string): void {
    this.events.onDebug({
      ts: Date.now(),
      category,
      message,
      ...(detail ? { detail } : {})
    });
  }
}

function buildInputText(text: string, attachments: Attachment[]): string {
  const parts: string[] = [];
  const trimmed = text.trim();
  if (trimmed) {
    parts.push(trimmed);
  }

  for (const attachment of attachments) {
    if (attachment.type === 'selected_text') {
      parts.push(`選択テキスト\n${attachment.text}`);
      continue;
    }
    if (attachment.type === 'page_context') {
      const scope = attachment.scope === 'dom_selection' ? 'DOM範囲' : '可視領域';
      parts.push(`ページ参照 (${scope})\n${attachment.text}`);
    }
  }

  return parts.join('\n\n');
}

function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}
