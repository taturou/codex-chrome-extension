import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketTransport } from '../transport/wsTransport';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: string[] = [];

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }
}

describe('WebSocketTransport', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = originalWebSocket;
  });

  it('CONNECTING中のconnect呼び出しでsocketを多重生成しない', () => {
    const transport = new WebSocketTransport({
      onStatus: () => {},
      onToken: () => {},
      onDone: () => {},
      onError: () => {}
    });

    transport.connect('ws://localhost:3000');
    transport.connect('ws://localhost:3000');

    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it('reconnectNowでURL更新して再接続する', () => {
    const transport = new WebSocketTransport({
      onStatus: () => {},
      onToken: () => {},
      onDone: () => {},
      onError: () => {}
    });

    transport.connect('ws://localhost:3000');
    expect(FakeWebSocket.instances[0].url).toBe('ws://localhost:3000');

    transport.reconnectNow('ws://localhost:4000');
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(FakeWebSocket.instances[1].url).toBe('ws://localhost:4000');
  });

  it('item/agentMessage/delta を token として解釈する', () => {
    const onToken = vi.fn();
    const transport = new WebSocketTransport({
      onStatus: () => {},
      onToken,
      onDone: () => {},
      onError: () => {}
    });

    transport.connect('ws://localhost:3000');
    const socket = FakeWebSocket.instances[0];

    socket.onmessage?.({
      data: JSON.stringify({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 't1',
          turnId: 'turn-1',
          itemId: 'item-1',
          delta: 'こんにちは'
        }
      })
    } as MessageEvent);

    expect(onToken).toHaveBeenCalledWith({
      threadId: 't1',
      messageId: 'item-1',
      token: 'こんにちは'
    });
  });

  it('turn/completed で messageId 欠落時は送信済み local messageId を補完する', () => {
    const onDone = vi.fn();
    const transport = new WebSocketTransport({
      onStatus: () => {},
      onToken: () => {},
      onDone,
      onError: () => {}
    });

    transport.connect('ws://localhost:3000');
    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;

    transport.sendChat({
      threadId: 't1',
      messageId: 'local-msg-1',
      text: 'hi',
      attachments: []
    });

    socket.onmessage?.({
      data: JSON.stringify({
        method: 'turn/completed',
        params: {
          threadId: 't1',
          turn: { id: 'turn-1', status: 'completed', error: null }
        }
      })
    } as MessageEvent);

    expect(onDone).toHaveBeenCalledWith({
      threadId: 't1',
      messageId: 'local-msg-1'
    });
  });

  it('JSON-RPC error response を onError に流す', () => {
    const onError = vi.fn();
    const transport = new WebSocketTransport({
      onStatus: () => {},
      onToken: () => {},
      onDone: () => {},
      onError
    });

    transport.connect('ws://localhost:3000');
    const socket = FakeWebSocket.instances[0];

    socket.onmessage?.({
      data: JSON.stringify({
        id: '2',
        error: {
          code: -32600,
          message: 'thread not found'
        }
      })
    } as MessageEvent);

    expect(onError).toHaveBeenCalledWith({
      threadId: undefined,
      messageId: undefined,
      error: 'thread not found'
    });
  });
});
