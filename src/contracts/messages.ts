import type { Attachment, Message, Setting, Thread, WsDebugLogEntry, WsStatus } from './types';

export interface RuntimeEnvelope<T extends string, P> {
  type: T;
  payload: P;
}

export type RuntimeCommand =
  | RuntimeEnvelope<'CONNECT_WS', { url?: string }>
  | RuntimeEnvelope<'DISCONNECT_WS', Record<string, never>>
  | RuntimeEnvelope<'GET_WS_STATUS', Record<string, never>>
  | RuntimeEnvelope<'SEND_CHAT_MESSAGE', { threadId: string; text: string; attachments: Attachment[] }>
  | RuntimeEnvelope<'ATTACH_SELECTION', { tabId?: number }>
  | RuntimeEnvelope<'CREATE_THREAD', { title?: string }>
  | RuntimeEnvelope<'SWITCH_THREAD', { threadId: string }>
  | RuntimeEnvelope<'DELETE_THREAD', { threadId: string }>
  | RuntimeEnvelope<'LIST_THREADS', Record<string, never>>
  | RuntimeEnvelope<'GET_THREAD_MESSAGES', { threadId: string }>
  | RuntimeEnvelope<'SAVE_SETTINGS', { wsUrl: string }>
  | RuntimeEnvelope<'GET_SETTINGS', Record<string, never>>;

export type SidePanelEvent =
  | RuntimeEnvelope<'WS_STATUS_CHANGED', { status: WsStatus; reason?: string }>
  | RuntimeEnvelope<'WS_DEBUG_LOG', { entry: WsDebugLogEntry }>
  | RuntimeEnvelope<'CHAT_TOKEN', { threadId: string; messageId: string; token: string }>
  | RuntimeEnvelope<'CHAT_DONE', { threadId: string; messageId: string }>
  | RuntimeEnvelope<'CHAT_ERROR', { threadId: string; messageId: string; error: string }>
  | RuntimeEnvelope<'SELECTION_ATTACHED', { attachment: Attachment }>;

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface ListThreadsResult {
  threads: Thread[];
  currentThreadId?: string;
}

export interface MessagesResult {
  messages: Message[];
}

export interface SettingsResult {
  settings: Setting;
}

export interface CreateThreadResult {
  thread: Thread;
}

export interface AttachSelectionResult {
  attachment: Attachment;
}

export interface WsStatusResult {
  status: WsStatus;
  reason?: string;
}
