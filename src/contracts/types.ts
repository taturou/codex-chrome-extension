export type WsStatus = 'connected' | 'connecting' | 'disconnected' | 'error';
export type WsDebugLogCategory = 'state' | 'send' | 'recv' | 'error';

export interface WsDebugLogEntry {
  ts: number;
  category: WsDebugLogCategory;
  message: string;
  detail?: string;
}

export interface Setting {
  wsUrl: string;
}

export interface Attachment {
  type: 'selected_text';
  text: string;
  tabId: number;
  url: string;
  capturedAt: number;
}

export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageStatus = 'pending' | 'streaming' | 'done' | 'error';

export interface Message {
  id: string;
  threadId: string;
  role: MessageRole;
  contentMd: string;
  attachments?: Attachment[];
  createdAt: number;
  status: MessageStatus;
}

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number;
}

export interface StorageShape {
  settings: Setting;
  threads: Thread[];
  messagesByThread: Record<string, Message[]>;
  meta: {
    currentThreadId?: string;
  };
}
