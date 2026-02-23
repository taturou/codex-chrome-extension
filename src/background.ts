import type {
  ApiResponse,
  AttachSelectionResult,
  CreateThreadResult,
  ListThreadsResult,
  MessagesResult,
  RuntimeCommand,
  SettingsResult,
  SidePanelEvent
} from './contracts/messages';
import type { Attachment, Message, Thread, WsStatus } from './contracts/types';
import { StorageRepository } from './storage/repository';
import { DEFAULT_WS_URL } from './shared/constants';
import { createId } from './shared/id';
import { SIDEPANEL_EVENT_PORT_NAME } from './shared/runtimePorts';
import { WebSocketTransport } from './transport/wsTransport';

const repository = new StorageRepository();
const sidePanelPorts = new Set<chrome.runtime.Port>();

let wsStatus: WsStatus = 'disconnected';
let wsReason: string | undefined;

function now(): number {
  return Date.now();
}

function makeThreadTitle(): string {
  return `スレッド ${new Date().toLocaleString('ja-JP')}`;
}

async function broadcast(event: SidePanelEvent): Promise<void> {
  const disconnectedPorts: chrome.runtime.Port[] = [];

  for (const port of sidePanelPorts) {
    try {
      port.postMessage(event);
    } catch {
      disconnectedPorts.push(port);
    }
  }

  for (const port of disconnectedPorts) {
    sidePanelPorts.delete(port);
  }
}

function isSidePanelPort(port: chrome.runtime.Port): boolean {
  return port.name === SIDEPANEL_EVENT_PORT_NAME;
}

async function setStatus(status: WsStatus, reason?: string): Promise<void> {
  wsStatus = status;
  wsReason = reason;
  await broadcast({
    type: 'WS_STATUS_CHANGED',
    payload: { status, reason }
  });
}

async function findFallbackAssistantMessageId(threadId: string): Promise<string | undefined> {
  const messages = await repository.getThreadMessages(threadId);

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'assistant' && message.status === 'streaming') {
      return message.id;
    }
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'assistant') {
      return message.id;
    }
  }

  return undefined;
}

async function appendTokenWithFallback(
  threadId: string,
  messageId: string | undefined,
  token: string
): Promise<{ resolvedMessageId?: string; updated?: Message }> {
  if (messageId) {
    const updated = await repository.appendToken(threadId, messageId, token);
    if (updated) {
      return { resolvedMessageId: messageId, updated };
    }
  }

  const fallbackMessageId = await findFallbackAssistantMessageId(threadId);
  if (!fallbackMessageId || fallbackMessageId === messageId) {
    return {};
  }

  const fallbackUpdated = await repository.appendToken(threadId, fallbackMessageId, token);
  return { resolvedMessageId: fallbackMessageId, updated: fallbackUpdated };
}

async function updateMessageStatusWithFallback(
  threadId: string,
  messageId: string | undefined,
  status: Message['status']
): Promise<string | undefined> {
  if (messageId) {
    const updated = await repository.updateMessage(threadId, messageId, { status });
    if (updated) {
      return messageId;
    }
  }

  const fallbackMessageId = await findFallbackAssistantMessageId(threadId);
  if (!fallbackMessageId || fallbackMessageId === messageId) {
    return undefined;
  }

  await repository.updateMessage(threadId, fallbackMessageId, { status });
  return fallbackMessageId;
}

const transport = new WebSocketTransport({
  onStatus: (status, reason) => {
    void setStatus(status, reason);
  },
  onDebug: (entry) => {
    void broadcast({
      type: 'WS_DEBUG_LOG',
      payload: { entry }
    });
  },
  onToken: ({ threadId, messageId, token }) => {
    void (async () => {
      const { resolvedMessageId, updated } = await appendTokenWithFallback(threadId, messageId, token);
      const shouldBroadcast = Boolean(resolvedMessageId && updated && updated.status === 'streaming');

      if (shouldBroadcast) {
        await broadcast({
          type: 'CHAT_TOKEN',
          payload: { threadId, messageId: resolvedMessageId, token }
        });
      }
    })();
  },
  onDone: ({ threadId, messageId }) => {
    void (async () => {
      const resolvedMessageId = await updateMessageStatusWithFallback(threadId, messageId, 'done');
      if (!resolvedMessageId) {
        return;
      }
      await broadcast({
        type: 'CHAT_DONE',
        payload: { threadId, messageId: resolvedMessageId }
      });
    })();
  },
  onError: ({ threadId, messageId, error }) => {
    void (async () => {
      if (!threadId) {
        await setStatus('error', error);
        return;
      }

      const resolvedMessageId = await updateMessageStatusWithFallback(threadId, messageId, 'error');
      if (!resolvedMessageId) {
        await setStatus('error', error);
        return;
      }

      await broadcast({
        type: 'CHAT_ERROR',
        payload: { threadId, messageId: resolvedMessageId, error }
      });
    })();
  }
});

async function ensureThread(threadId?: string): Promise<Thread> {
  if (threadId) {
    const threads = await repository.listThreads();
    const found = threads.find((item) => item.id === threadId);
    if (found) {
      return found;
    }
  }

  const createdAt = now();
  const thread: Thread = {
    id: createId('thread'),
    title: makeThreadTitle(),
    createdAt,
    updatedAt: createdAt,
    lastMessageAt: createdAt
  };
  await repository.upsertThread(thread);
  await repository.setCurrentThread(thread.id);
  return thread;
}

async function getActiveTab(tabId?: number): Promise<chrome.tabs.Tab> {
  if (typeof tabId === 'number') {
    const tab = await chrome.tabs.get(tabId);
    return tab;
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('active tab が取得できませんでした');
  }
  return tab;
}

function getTabOriginPattern(tabUrl: string): string {
  const parsed = new URL(tabUrl);
  return `${parsed.origin}/*`;
}

function getTabProtocol(tabUrl: string): string {
  return new URL(tabUrl).protocol;
}

async function ensureTabHostPermission(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.url) {
    throw new Error('tab の URL が取得できませんでした');
  }

  const protocol = getTabProtocol(tab.url);
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`このページでは選択を添付できません (${protocol})`);
  }

  const originPattern = getTabOriginPattern(tab.url);
  const hasPermission = await chrome.permissions.contains({ origins: [originPattern] });
  if (hasPermission) {
    return;
  }
  throw new Error(`ページ権限が不足しています (${originPattern})`);
}

async function attachSelection(tabId?: number): Promise<Attachment> {
  const tab = await getActiveTab(tabId);
  if (typeof tab.id !== 'number') {
    throw new Error('tabId が不正です');
  }
  await ensureTabHostPermission(tab);

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const selected = window.getSelection()?.toString() ?? '';
      return {
        text: selected.trim(),
        url: window.location.href
      };
    }
  });

  const first = results[0]?.result as { text: string; url: string } | undefined;
  if (!first || !first.text) {
    throw new Error('選択テキストが空です');
  }

  return {
    type: 'selected_text',
    text: first.text,
    tabId: tab.id,
    url: first.url,
    capturedAt: now()
  };
}

async function handleCommand(command: RuntimeCommand): Promise<unknown> {
  switch (command.type) {
    case 'CONNECT_WS': {
      const settings = await repository.getSettings();
      const url = command.payload.url?.trim() || settings.wsUrl || DEFAULT_WS_URL;
      transport.reconnectNow(url);
      return { status: wsStatus, reason: wsReason };
    }
    case 'DISCONNECT_WS': {
      transport.disconnect();
      return { status: wsStatus, reason: wsReason };
    }
    case 'GET_WS_STATUS': {
      return { status: wsStatus, reason: wsReason };
    }
    case 'SEND_CHAT_MESSAGE': {
      const thread = await ensureThread(command.payload.threadId);
      const userMessage: Message = {
        id: createId('msg'),
        threadId: thread.id,
        role: 'user',
        contentMd: command.payload.text,
        attachments: command.payload.attachments,
        createdAt: now(),
        status: 'done'
      };

      const assistantMessage: Message = {
        id: createId('msg'),
        threadId: thread.id,
        role: 'assistant',
        contentMd: '',
        createdAt: now(),
        status: 'streaming'
      };

      await repository.appendMessage(userMessage);
      await repository.appendMessage(assistantMessage);
      await repository.setCurrentThread(thread.id);

      try {
        transport.sendChat({
          threadId: thread.id,
          messageId: assistantMessage.id,
          text: command.payload.text,
          attachments: command.payload.attachments
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await repository.updateMessage(thread.id, assistantMessage.id, { status: 'error' });
        await broadcast({
          type: 'CHAT_ERROR',
          payload: {
            threadId: thread.id,
            messageId: assistantMessage.id,
            error: message
          }
        });
      }

      return {
        userMessage,
        assistantMessage
      };
    }
    case 'ATTACH_SELECTION': {
      const attachment = await attachSelection(command.payload.tabId);
      await broadcast({
        type: 'SELECTION_ATTACHED',
        payload: { attachment }
      });
      const result: AttachSelectionResult = { attachment };
      return result;
    }
    case 'CREATE_THREAD': {
      const createdAt = now();
      const thread: Thread = {
        id: createId('thread'),
        title: command.payload.title?.trim() || makeThreadTitle(),
        createdAt,
        updatedAt: createdAt,
        lastMessageAt: createdAt
      };
      await repository.upsertThread(thread);
      await repository.setCurrentThread(thread.id);
      const result: CreateThreadResult = { thread };
      return result;
    }
    case 'SWITCH_THREAD': {
      await repository.setCurrentThread(command.payload.threadId);
      return { threadId: command.payload.threadId };
    }
    case 'DELETE_THREAD': {
      await repository.deleteThread(command.payload.threadId);
      return { threadId: command.payload.threadId };
    }
    case 'LIST_THREADS': {
      const threads = await repository.listThreads();
      const currentThreadId = await repository.getCurrentThreadId();
      const result: ListThreadsResult = { threads, currentThreadId };
      return result;
    }
    case 'GET_THREAD_MESSAGES': {
      const messages = await repository.getThreadMessages(command.payload.threadId);
      const result: MessagesResult = { messages };
      return result;
    }
    case 'SAVE_SETTINGS': {
      const wsUrl = command.payload.wsUrl.trim() || DEFAULT_WS_URL;
      const settings = await repository.saveSettings({ wsUrl });
      const result: SettingsResult = { settings };
      return result;
    }
    case 'GET_SETTINGS': {
      const settings = await repository.getSettings();
      const result: SettingsResult = { settings };
      return result;
    }
    default: {
      throw new Error('unknown command');
    }
  }
}

function isRuntimeCommand(message: unknown): message is RuntimeCommand {
  if (!message || typeof message !== 'object' || !('type' in message)) {
    return false;
  }

  const type = (message as { type: string }).type;
  return [
    'CONNECT_WS',
    'DISCONNECT_WS',
    'GET_WS_STATUS',
    'SEND_CHAT_MESSAGE',
    'ATTACH_SELECTION',
    'CREATE_THREAD',
    'SWITCH_THREAD',
    'DELETE_THREAD',
    'LIST_THREADS',
    'GET_THREAD_MESSAGES',
    'SAVE_SETTINGS',
    'GET_SETTINGS'
  ].includes(type);
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onConnect.addListener((port) => {
  if (!isSidePanelPort(port)) {
    return;
  }

  sidePanelPorts.add(port);
  try {
    port.postMessage({
      type: 'WS_STATUS_CHANGED',
      payload: { status: wsStatus, reason: wsReason }
    } satisfies SidePanelEvent);
  } catch {
    sidePanelPorts.delete(port);
    return;
  }
  port.onDisconnect.addListener(() => {
    sidePanelPorts.delete(port);
  });
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isRuntimeCommand(message)) {
    return false;
  }

  void (async () => {
    try {
      const data = await handleCommand(message);
      const response: ApiResponse<unknown> = { ok: true, data };
      sendResponse(response);
    } catch (error) {
      const response: ApiResponse<unknown> = {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
      sendResponse(response);
    }
  })();

  return true;
});
