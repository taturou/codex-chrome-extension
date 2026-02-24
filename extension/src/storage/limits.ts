import type { Message, Thread } from '../contracts/types';

export function enforceThreadLimit(
  threads: Thread[],
  messagesByThread: Record<string, Message[]>,
  maxThreads: number
): { threads: Thread[]; messagesByThread: Record<string, Message[]>; removedThreadIds: string[] } {
  if (threads.length <= maxThreads) {
    return { threads, messagesByThread, removedThreadIds: [] };
  }

  const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = sorted.slice(0, maxThreads);
  const keptIds = new Set(kept.map((thread) => thread.id));

  const removedThreadIds = sorted
    .slice(maxThreads)
    .map((thread) => thread.id);

  const nextMessages: Record<string, Message[]> = {};
  for (const [threadId, messages] of Object.entries(messagesByThread)) {
    if (keptIds.has(threadId)) {
      nextMessages[threadId] = messages;
    }
  }

  return {
    threads: kept,
    messagesByThread: nextMessages,
    removedThreadIds
  };
}

export function enforceMessageLimit(messages: Message[], maxMessages: number): Message[] {
  if (messages.length <= maxMessages) {
    return messages;
  }
  return messages.slice(messages.length - maxMessages);
}
