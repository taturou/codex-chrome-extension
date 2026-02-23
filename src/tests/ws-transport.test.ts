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
    this.onclose?.({ code: 1000, reason: '' } as CloseEvent);
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

  function openAndInitialize(socket: FakeWebSocket): void {
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.({} as Event);
    const initializeRaw = socket.sent.find((entry) => entry.includes('"method":"initialize"'));
    if (!initializeRaw) {
      throw new Error('initialize not sent');
    }
    const initialize = JSON.parse(initializeRaw) as { id: string };
    socket.onmessage?.({
      data: JSON.stringify({
        id: initialize.id,
        result: {
          userAgent: 'test'
        }
      })
    } as MessageEvent);
  }

  it('CONNECTING中のconnect呼び出しでsocketを多重生成しない', () => {
    const transport = new WebSocketTransport({
      onStatus: () => {},
      onDebug: () => {},
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
      onDebug: () => {},
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
      onDebug: () => {},
      onToken,
      onDone: () => {},
      onError: () => {}
    });

    transport.connect('ws://localhost:3000');
    const socket = FakeWebSocket.instances[0];
    openAndInitialize(socket);

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
      onDebug: () => {},
      onToken: () => {},
      onDone,
      onError: () => {}
    });

    transport.connect('ws://localhost:3000');
    const socket = FakeWebSocket.instances[0];
    openAndInitialize(socket);

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

  it('item/completed は done として扱わない', () => {
    const onDone = vi.fn();
    const transport = new WebSocketTransport({
      onStatus: () => {},
      onDebug: () => {},
      onToken: () => {},
      onDone,
      onError: () => {}
    });

    transport.connect('ws://localhost:3000');
    const socket = FakeWebSocket.instances[0];
    openAndInitialize(socket);

    socket.onmessage?.({
      data: JSON.stringify({
        method: 'item/completed',
        params: {
          threadId: 't1',
          turnId: 'turn-1',
          item: { id: 'item-1' }
        }
      })
    } as MessageEvent);

    expect(onDone).not.toHaveBeenCalled();
  });

  it('agent message delta の重複系イベントを二重反映しない', () => {
    const onToken = vi.fn();
    const transport = new WebSocketTransport({
      onStatus: () => {},
      onDebug: () => {},
      onToken,
      onDone: () => {},
      onError: () => {}
    });

    transport.connect('ws://localhost:3000');
    const socket = FakeWebSocket.instances[0];
    openAndInitialize(socket);

    socket.onmessage?.({
      data: JSON.stringify({
        method: 'codex/event/agent_message_content_delta',
        params: {
          msg: {
            type: 'agent_message_content_delta',
            thread_id: 't1',
            item_id: 'm1',
            delta: 'こんにちは'
          }
        }
      })
    } as MessageEvent);

    socket.onmessage?.({
      data: JSON.stringify({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 't1',
          itemId: 'm1',
          delta: 'こんにちは'
        }
      })
    } as MessageEvent);

    socket.onmessage?.({
      data: JSON.stringify({
        method: 'codex/event/agent_message_delta',
        params: {
          msg: {
            type: 'agent_message_delta',
            delta: 'こんにちは'
          }
        }
      })
    } as MessageEvent);

    expect(onToken).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith({
      threadId: 't1',
      messageId: 'm1',
      token: 'こんにちは'
    });
  });

  it('JSON-RPC error response を onError に流す', () => {
    const onError = vi.fn();
    const transport = new WebSocketTransport({
      onStatus: () => {},
      onDebug: () => {},
      onToken: () => {},
      onDone: () => {},
      onError
    });

    transport.connect('ws://localhost:3000');
    const socket = FakeWebSocket.instances[0];
    openAndInitialize(socket);

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

  it('initialized は initialize 応答後に送信する', () => {
    const transport = new WebSocketTransport({
      onStatus: () => {},
      onDebug: () => {},
      onToken: () => {},
      onDone: () => {},
      onError: () => {}
    });

    transport.connect('ws://localhost:3000');
    const socket = FakeWebSocket.instances[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.({} as Event);

    expect(socket.sent.some((entry) => entry.includes('"method":"initialize"'))).toBe(true);
    expect(socket.sent.some((entry) => entry.includes('"method":"initialized"'))).toBe(false);

    const initializeRaw = socket.sent.find((entry) => entry.includes('"method":"initialize"'));
    if (!initializeRaw) {
      throw new Error('initialize not sent');
    }
    const initialize = JSON.parse(initializeRaw) as { id: string };
    socket.onmessage?.({
      data: JSON.stringify({
        id: initialize.id,
        result: { userAgent: 'test' }
      })
    } as MessageEvent);

    expect(socket.sent.some((entry) => entry.includes('"method":"initialized"'))).toBe(true);

    const initializePayload = JSON.parse(initializeRaw) as Record<string, unknown>;
    expect('jsonrpc' in initializePayload).toBe(false);
    const initializedRaw = socket.sent.find((entry) => entry.includes('"method":"initialized"'));
    if (!initializedRaw) {
      throw new Error('initialized not sent');
    }
    const initializedPayload = JSON.parse(initializedRaw) as Record<string, unknown>;
    expect('jsonrpc' in initializedPayload).toBe(false);
  });

  it('-32001 を受けたら turn/start を再試行する', () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const transport = new WebSocketTransport({
        onStatus: () => {},
        onDebug: () => {},
        onToken: () => {},
        onDone: () => {},
        onError
      });

      transport.connect('ws://localhost:3000');
      const socket = FakeWebSocket.instances[0];
      openAndInitialize(socket);

      transport.sendChat({
        threadId: 't1',
        messageId: 'local-msg-1',
        text: 'hi',
        attachments: []
      });

      const threadStartRaw = socket.sent.find((entry) => entry.includes('"method":"thread/start"'));
      if (!threadStartRaw) {
        throw new Error('thread/start not sent');
      }
      const threadStart = JSON.parse(threadStartRaw) as { id: string };
      socket.onmessage?.({
        data: JSON.stringify({
          id: threadStart.id,
          result: { thread: { id: 'remote-t1' } }
        })
      } as MessageEvent);

      const firstTurnStartRaw = socket.sent.find((entry) => entry.includes('"method":"turn/start"'));
      if (!firstTurnStartRaw) {
        throw new Error('turn/start not sent');
      }
      const firstTurnStart = JSON.parse(firstTurnStartRaw) as { id: string };
      socket.onmessage?.({
        data: JSON.stringify({
          id: firstTurnStart.id,
          error: { code: -32001, message: 'queue full' }
        })
      } as MessageEvent);

      vi.runAllTimers();
      const turnStartCount = socket.sent.filter((entry) => entry.includes('"method":"turn/start"')).length;
      expect(turnStartCount).toBe(2);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
