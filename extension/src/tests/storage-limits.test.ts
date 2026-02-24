import { describe, expect, it } from 'vitest';
import type { Message, Thread } from '../contracts/types';
import { enforceMessageLimit, enforceThreadLimit } from '../storage/limits';

function thread(id: string, updatedAt: number): Thread {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    lastMessageAt: updatedAt
  };
}

function message(id: string, threadId: string): Message {
  return {
    id,
    threadId,
    role: 'user',
    contentMd: id,
    createdAt: Number(id.replace('m', '')),
    status: 'done'
  };
}

describe('storage limits', () => {
  it('thread上限超過時に更新日時が古いthreadを削除する', () => {
    const threads = [thread('t1', 10), thread('t2', 20), thread('t3', 30)];
    const messagesByThread = {
      t1: [message('m1', 't1')],
      t2: [message('m2', 't2')],
      t3: [message('m3', 't3')]
    };

    const result = enforceThreadLimit(threads, messagesByThread, 2);

    expect(result.threads.map((item) => item.id)).toEqual(['t3', 't2']);
    expect(result.removedThreadIds).toEqual(['t1']);
    expect(Object.keys(result.messagesByThread)).toEqual(['t2', 't3']);
  });

  it('message上限超過時に古いmessageから削除する', () => {
    const messages = [message('m1', 't1'), message('m2', 't1'), message('m3', 't1')];
    const result = enforceMessageLimit(messages, 2);
    expect(result.map((item) => item.id)).toEqual(['m2', 'm3']);
  });
});
