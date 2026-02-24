import type { Message, Setting, StorageShape, Thread, ThreadArchive } from '../contracts/types';
import { MAX_MESSAGES_PER_THREAD, MAX_THREADS, DEFAULT_WS_URL } from '../shared/constants';
import { enforceMessageLimit, enforceThreadLimit } from './limits';

const STORAGE_KEY = 'codex_extension_store_v1';

function now(): number {
  return Date.now();
}

function extractThreadNumber(title: string): number | undefined {
  const matched = title.match(/^Thread #(\d+)$/);
  if (!matched) {
    return undefined;
  }
  const num = Number.parseInt(matched[1], 10);
  if (!Number.isFinite(num) || num <= 0) {
    return undefined;
  }
  return num;
}

function defaultStore(): StorageShape {
  return {
    settings: { wsUrl: DEFAULT_WS_URL },
    threads: [],
    messagesByThread: {},
    meta: {}
  };
}

export class StorageRepository {
  private writeQueue: Promise<void> = Promise.resolve();

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue
      .catch(() => {
        // previous write error は後続更新を止めない
      })
      .then(task);

    this.writeQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async getStore(): Promise<StorageShape> {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const store = result[STORAGE_KEY] as StorageShape | undefined;
    return store ?? defaultStore();
  }

  private async saveStore(store: StorageShape): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: store });
  }

  async listThreads(): Promise<Thread[]> {
    const store = await this.getStore();
    return [...store.threads].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getCurrentThreadId(): Promise<string | undefined> {
    const store = await this.getStore();
    return store.meta.currentThreadId;
  }

  async setCurrentThread(threadId: string | undefined): Promise<void> {
    await this.enqueueWrite(async () => {
      const store = await this.getStore();
      store.meta.currentThreadId = threadId;
      await this.saveStore(store);
    });
  }

  async saveSettings(settings: Setting): Promise<Setting> {
    return this.enqueueWrite(async () => {
      const store = await this.getStore();
      store.settings = settings;
      await this.saveStore(store);
      return settings;
    });
  }

  async getSettings(): Promise<Setting> {
    const store = await this.getStore();
    return store.settings;
  }

  async reserveNextThreadTitle(): Promise<string> {
    return this.enqueueWrite(async () => {
      const store = await this.getStore();
      const inferredNext = store.threads.reduce((max, thread) => {
        const num = extractThreadNumber(thread.title);
        if (!num) {
          return max;
        }
        return Math.max(max, num);
      }, 0) + 1;

      const nextThreadNumber = Math.max(store.meta.nextThreadNumber ?? inferredNext, inferredNext);
      store.meta.nextThreadNumber = nextThreadNumber + 1;
      await this.saveStore(store);
      return `Thread #${nextThreadNumber}`;
    });
  }

  async upsertThread(thread: Thread): Promise<Thread> {
    return this.enqueueWrite(async () => {
      const store = await this.getStore();
      const existingIndex = store.threads.findIndex((item) => item.id === thread.id);

      if (existingIndex >= 0) {
        store.threads[existingIndex] = thread;
      } else {
        store.threads.push(thread);
      }

      const enforced = enforceThreadLimit(store.threads, store.messagesByThread, MAX_THREADS);
      store.threads = enforced.threads;
      store.messagesByThread = enforced.messagesByThread;

      if (store.meta.currentThreadId && enforced.removedThreadIds.includes(store.meta.currentThreadId)) {
        store.meta.currentThreadId = store.threads[0]?.id;
      }

      await this.saveStore(store);
      return thread;
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const store = await this.getStore();
      store.threads = store.threads.filter((thread) => thread.id !== threadId);
      delete store.messagesByThread[threadId];

      if (store.meta.currentThreadId === threadId) {
        store.meta.currentThreadId = store.threads[0]?.id;
      }

      await this.saveStore(store);
    });
  }

  async renameThread(threadId: string, title: string): Promise<Thread | undefined> {
    return this.enqueueWrite(async () => {
      const store = await this.getStore();
      const index = store.threads.findIndex((thread) => thread.id === threadId);
      if (index < 0) {
        return undefined;
      }

      const existing = store.threads[index];
      const updated: Thread = {
        ...existing,
        title,
        updatedAt: now()
      };
      store.threads[index] = updated;
      await this.saveStore(store);
      return updated;
    });
  }

  async setThreadRemoteId(threadId: string, remoteThreadId: string): Promise<Thread | undefined> {
    return this.enqueueWrite(async () => {
      const store = await this.getStore();
      const index = store.threads.findIndex((thread) => thread.id === threadId);
      if (index < 0) {
        return undefined;
      }

      const existing = store.threads[index];
      if (existing.remoteThreadId === remoteThreadId) {
        return existing;
      }

      const updated: Thread = {
        ...existing,
        remoteThreadId
      };
      store.threads[index] = updated;
      await this.saveStore(store);
      return updated;
    });
  }

  async getThreadMessages(threadId: string): Promise<Message[]> {
    const store = await this.getStore();
    return store.messagesByThread[threadId] ?? [];
  }

  async exportThreads(threadIds: string[]): Promise<{ archives: ThreadArchive[]; missingThreadIds: string[] }> {
    const store = await this.getStore();
    const byId = new Map(store.threads.map((thread) => [thread.id, thread]));
    const archives: ThreadArchive[] = [];
    const missingThreadIds: string[] = [];

    for (const threadId of threadIds) {
      const thread = byId.get(threadId);
      if (!thread) {
        missingThreadIds.push(threadId);
        continue;
      }
      archives.push({
        format: 'codex-thread-v1',
        exportedAt: now(),
        thread,
        messages: store.messagesByThread[threadId] ?? []
      });
    }

    return { archives, missingThreadIds };
  }

  async importThreads(archives: ThreadArchive[]): Promise<{ importedCount: number }> {
    return this.enqueueWrite(async () => {
      const store = await this.getStore();
      const nextThreads = [...store.threads];
      const nextMessagesByThread = { ...store.messagesByThread };
      let importedCount = 0;

      for (const archive of archives) {
        if (archive.format !== 'codex-thread-v1') {
          continue;
        }

        const thread = archive.thread;
        if (!thread?.id) {
          continue;
        }

        const existingIndex = nextThreads.findIndex((item) => item.id === thread.id);
        if (existingIndex >= 0) {
          nextThreads[existingIndex] = thread;
        } else {
          nextThreads.push(thread);
        }

        nextMessagesByThread[thread.id] = enforceMessageLimit(
          Array.isArray(archive.messages) ? archive.messages : [],
          MAX_MESSAGES_PER_THREAD
        );
        importedCount += 1;
      }

      const enforced = enforceThreadLimit(nextThreads, nextMessagesByThread, MAX_THREADS);
      store.threads = enforced.threads;
      store.messagesByThread = enforced.messagesByThread;

      if (!store.meta.currentThreadId || enforced.removedThreadIds.includes(store.meta.currentThreadId)) {
        store.meta.currentThreadId = store.threads[0]?.id;
      }

      await this.saveStore(store);
      return { importedCount };
    });
  }

  async appendMessage(message: Message): Promise<Message> {
    return this.enqueueWrite(async () => {
      const store = await this.getStore();
      const messages = store.messagesByThread[message.threadId] ?? [];
      const next = enforceMessageLimit([...messages, message], MAX_MESSAGES_PER_THREAD);
      store.messagesByThread[message.threadId] = next;

      const thread = store.threads.find((item) => item.id === message.threadId);
      if (thread) {
        const updatedAt = now();
        thread.updatedAt = updatedAt;
        thread.lastMessageAt = updatedAt;
      }

      await this.saveStore(store);
      return message;
    });
  }

  async updateMessage(threadId: string, messageId: string, patch: Partial<Message>): Promise<Message | undefined> {
    return this.enqueueWrite(async () => {
      const store = await this.getStore();
      const messages = store.messagesByThread[threadId] ?? [];
      const index = messages.findIndex((msg) => msg.id === messageId);

      if (index < 0) {
        return undefined;
      }

      const updated = { ...messages[index], ...patch };
      messages[index] = updated;
      store.messagesByThread[threadId] = enforceMessageLimit(messages, MAX_MESSAGES_PER_THREAD);

      const thread = store.threads.find((item) => item.id === threadId);
      if (thread) {
        thread.updatedAt = now();
        thread.lastMessageAt = thread.updatedAt;
      }

      await this.saveStore(store);
      return updated;
    });
  }

  async appendToken(threadId: string, messageId: string, token: string): Promise<Message | undefined> {
    return this.enqueueWrite(async () => {
      const store = await this.getStore();
      const messages = store.messagesByThread[threadId] ?? [];
      const index = messages.findIndex((msg) => msg.id === messageId);

      if (index < 0) {
        return undefined;
      }

      const current = messages[index];
      if (current.status === 'done' || current.status === 'error') {
        return current;
      }

      const updatedAt = now();
      const updated = {
        ...current,
        contentMd: `${current.contentMd}${token}`,
        status: 'streaming' as const
      };
      messages[index] = updated;
      store.messagesByThread[threadId] = enforceMessageLimit(messages, MAX_MESSAGES_PER_THREAD);

      const thread = store.threads.find((item) => item.id === threadId);
      if (thread) {
        thread.updatedAt = updatedAt;
        thread.lastMessageAt = updatedAt;
      }

      await this.saveStore(store);
      return updated;
    });
  }
}
