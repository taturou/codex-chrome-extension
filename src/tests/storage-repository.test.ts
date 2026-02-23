import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageShape } from '../contracts/types';
import { StorageRepository } from '../storage/repository';

function cloneStore<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createChromeStorageMock(
  initial?: StorageShape,
  delays?: { getMs?: number; setMs?: number }
): chrome.storage.LocalStorageArea {
  let store = initial
    ? { codex_extension_store_v1: initial }
    : {};

  const wait = async (ms: number | undefined): Promise<void> => {
    if (!ms || ms <= 0) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  };

  return {
    get: vi.fn(async (_keys?: string | string[] | Record<string, unknown> | null) => {
      await wait(delays?.getMs);
      return cloneStore(store);
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      await wait(delays?.setMs);
      store = { ...store, ...items };
    }),
    remove: vi.fn(async (_keys: string | string[]) => {}),
    clear: vi.fn(async () => {
      store = {};
    }),
    getBytesInUse: vi.fn(async (_keys?: string | string[] | null) => 0)
  } as unknown as chrome.storage.LocalStorageArea;
}

describe('StorageRepository appendToken', () => {
  beforeEach(() => {
    const local = createChromeStorageMock();
    vi.stubGlobal('chrome', {
      storage: { local }
    });
  });

  it('doneメッセージには遅延tokenを反映しない', async () => {
    const repo = new StorageRepository();
    await repo.upsertThread({
      id: 't1',
      title: 't1',
      createdAt: 1,
      updatedAt: 1,
      lastMessageAt: 1
    });
    await repo.appendMessage({
      id: 'm1',
      threadId: 't1',
      role: 'assistant',
      contentMd: 'hello',
      createdAt: 1,
      status: 'done'
    });

    await repo.appendToken('t1', 'm1', ' world');
    const messages = await repo.getThreadMessages('t1');

    expect(messages[0].contentMd).toBe('hello');
    expect(messages[0].status).toBe('done');
  });

  it('errorメッセージには遅延tokenを反映しない', async () => {
    const repo = new StorageRepository();
    await repo.upsertThread({
      id: 't1',
      title: 't1',
      createdAt: 1,
      updatedAt: 1,
      lastMessageAt: 1
    });
    await repo.appendMessage({
      id: 'm1',
      threadId: 't1',
      role: 'assistant',
      contentMd: 'hello',
      createdAt: 1,
      status: 'error'
    });

    await repo.appendToken('t1', 'm1', ' world');
    const messages = await repo.getThreadMessages('t1');

    expect(messages[0].contentMd).toBe('hello');
    expect(messages[0].status).toBe('error');
  });

  it('appendToken と updateMessage を並行実行しても更新欠落しない', async () => {
    const local = createChromeStorageMock(undefined, { getMs: 5, setMs: 5 });
    vi.stubGlobal('chrome', {
      storage: { local }
    });

    const repo = new StorageRepository();
    await repo.upsertThread({
      id: 't1',
      title: 't1',
      createdAt: 1,
      updatedAt: 1,
      lastMessageAt: 1
    });
    await repo.appendMessage({
      id: 'm1',
      threadId: 't1',
      role: 'assistant',
      contentMd: 'hello',
      createdAt: 1,
      status: 'streaming'
    });

    await Promise.all([
      repo.appendToken('t1', 'm1', ' world'),
      repo.updateMessage('t1', 'm1', { status: 'done' })
    ]);

    const messages = await repo.getThreadMessages('t1');
    expect(messages).toHaveLength(1);
    expect(messages[0].contentMd).toBe('hello world');
    expect(messages[0].status).toBe('done');
  });
});
