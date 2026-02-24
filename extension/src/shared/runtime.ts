import type { ApiResponse, RuntimeCommand, SidePanelEvent } from '../contracts/messages';
import { SIDEPANEL_EVENT_PORT_NAME } from './runtimePorts';

export async function sendCommand<T>(command: RuntimeCommand): Promise<T> {
  const response = (await chrome.runtime.sendMessage(command)) as ApiResponse<T>;
  if (!response.ok) {
    throw new Error(response.error ?? 'unknown runtime error');
  }
  return response.data as T;
}

export function listenEvents(handler: (event: SidePanelEvent) => void): () => void {
  const listener = (message: unknown) => {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return;
    }
    handler(message as SidePanelEvent);
  };
  let port: chrome.runtime.Port | null = null;
  let closed = false;
  let reconnectTimer: number | null = null;

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const cleanupPort = () => {
    if (!port) {
      return;
    }
    port.onMessage.removeListener(listener);
    port.onDisconnect.removeListener(handleDisconnect);
    try {
      port.disconnect();
    } catch {
      // no-op: already disconnected
    }
    port = null;
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== null) {
      return;
    }
    reconnectTimer = globalThis.setTimeout(() => {
      reconnectTimer = null;
      connectPort();
    }, 250);
  };

  const handleDisconnect = () => {
    cleanupPort();
    scheduleReconnect();
  };

  const connectPort = () => {
    if (closed || port) {
      return;
    }
    try {
      const nextPort = chrome.runtime.connect({ name: SIDEPANEL_EVENT_PORT_NAME });
      nextPort.onMessage.addListener(listener);
      nextPort.onDisconnect.addListener(handleDisconnect);
      port = nextPort;
    } catch {
      scheduleReconnect();
    }
  };

  connectPort();

  return () => {
    closed = true;
    clearReconnectTimer();
    cleanupPort();
  };
}
