import type { Attachment, WsStatus } from '../contracts/types';
import { computeBackoffMs } from '../shared/backoff';

interface ChatSendPayload {
  threadId: string;
  messageId: string;
  text: string;
  attachments: Attachment[];
}

interface TransportEvents {
  onStatus: (status: WsStatus, reason?: string) => void;
  onToken: (event: { threadId: string; messageId?: string; token: string }) => void;
  onDone: (event: { threadId: string; messageId?: string }) => void;
  onError: (event: { threadId?: string; messageId?: string; error: string }) => void;
}

function extractString(input: unknown): string | undefined {
  return typeof input === 'string' ? input : undefined;
}

function extractRecord(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  return input as Record<string, unknown>;
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
  | { kind: 'token'; threadId?: string; messageId?: string; token: string }
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

    const method = pickString([data], ['method']);
    const type = pickString([data, params, msg], ['type', 'event']);
    const threadId = pickString([data, params, msg], ['threadId', 'thread_id']);
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
      return { kind: 'token', threadId, messageId, token };
    }

    if (method === 'turn/completed' || Boolean(type && (type.includes('done') || type.includes('complete')))) {
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

  constructor(private readonly events: TransportEvents) {}

  connect(url: string): void {
    this.url = url;
    this.shouldReconnect = true;
    this.clearReconnectTimer();

    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.events.onStatus('connecting');
    this.socket = new WebSocket(url);

    this.socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.events.onStatus('connected');
    };

    this.socket.onmessage = (event) => {
      const parsed = parseIncoming(String(event.data));
      if (parsed.kind === 'token') {
        if (!parsed.threadId) {
          return;
        }
        const resolvedMessageId = parsed.messageId ?? this.latestLocalMessageByThread.get(parsed.threadId);
        this.events.onToken({ threadId: parsed.threadId, messageId: resolvedMessageId, token: parsed.token });
      } else if (parsed.kind === 'done') {
        if (!parsed.threadId) {
          return;
        }
        const resolvedMessageId = parsed.messageId ?? this.latestLocalMessageByThread.get(parsed.threadId);
        this.events.onDone({ threadId: parsed.threadId, messageId: resolvedMessageId });
        if (resolvedMessageId) {
          this.latestLocalMessageByThread.delete(parsed.threadId);
        }
      } else if (parsed.kind === 'error') {
        const resolvedMessageId =
          parsed.threadId && (parsed.messageId ?? this.latestLocalMessageByThread.get(parsed.threadId));
        this.events.onError({
          threadId: parsed.threadId,
          messageId: resolvedMessageId,
          error: parsed.error
        });
      }
    };

    this.socket.onerror = () => {
      this.events.onStatus('error', 'socket error');
    };

    this.socket.onclose = () => {
      this.events.onStatus('disconnected');
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
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.latestLocalMessageByThread.clear();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.events.onStatus('disconnected', 'manual disconnect');
  }

  reconnectNow(nextUrl?: string): void {
    if (nextUrl) {
      this.url = nextUrl;
    }
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.latestLocalMessageByThread.clear();
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
    this.latestLocalMessageByThread.set(payload.threadId, payload.messageId);

    this.socket.send(
      JSON.stringify({
        type: 'chat.send',
        ...payload
      })
    );
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = computeBackoffMs(this.reconnectAttempts);
    this.reconnectAttempts += 1;

    this.reconnectTimer = globalThis.setTimeout(() => {
      if (this.url && this.shouldReconnect) {
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
}
