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
  const port = chrome.runtime.connect({ name: SIDEPANEL_EVENT_PORT_NAME });

  const listener = (message: unknown) => {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return;
    }
    handler(message as SidePanelEvent);
  };

  port.onMessage.addListener(listener);
  return () => {
    port.onMessage.removeListener(listener);
    port.disconnect();
  };
}
