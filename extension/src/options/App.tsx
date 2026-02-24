import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExportThreadsResult,
  ImportThreadsResult,
  ListThreadsResult,
  SettingsResult
} from '../contracts/messages';
import type { Thread, ThreadArchive } from '../contracts/types';
import { assertUrlAllowedByPermissionPolicy, extractPermissionPolicy } from '../shared/permissionPolicy';
import { sendCommand } from '../shared/runtime';

function sanitizeFilePart(input: string): string {
  return input
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

function formatDateForFile(ts: number): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function threadFileName(thread: Thread, exportedAt: number): string {
  const title = sanitizeFilePart(thread.title || 'thread');
  const id = sanitizeFilePart(thread.id);
  return `${formatDateForFile(exportedAt)}_${title}_${id}.json`;
}

function triggerDownload(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isThreadArchive(value: unknown): value is ThreadArchive {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const archive = value as Partial<ThreadArchive>;
  return (
    archive.format === 'codex-thread-v1' &&
    Boolean(archive.thread && typeof archive.thread.id === 'string' && typeof archive.thread.title === 'string') &&
    Array.isArray(archive.messages)
  );
}

export function App(): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [wsUrl, setWsUrl] = useState('');
  const [settingsNotice, setSettingsNotice] = useState('');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [saveNotice, setSaveNotice] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [loadNotice, setLoadNotice] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [files, setFiles] = useState<File[]>([]);

  const allSelected = useMemo(() => threads.length > 0 && selectedIds.size === threads.length, [threads.length, selectedIds.size]);

  const loadThreads = useCallback(async (): Promise<void> => {
    const list = await sendCommand<ListThreadsResult>({ type: 'LIST_THREADS', payload: {} });
    setThreads(list.threads);
    setSelectedIds((prev) => {
      const next = new Set<string>();
      for (const thread of list.threads) {
        if (prev.has(thread.id)) {
          next.add(thread.id);
        }
      }
      return next;
    });
  }, []);

  useEffect(() => {
    void (async () => {
      const res = await sendCommand<SettingsResult>({ type: 'GET_SETTINGS', payload: {} });
      setWsUrl(res.settings.wsUrl);
      await loadThreads();
    })();
  }, [loadThreads]);

  async function save(): Promise<void> {
    const policy = extractPermissionPolicy(chrome.runtime.getManifest());
    const nextUrl = assertUrlAllowedByPermissionPolicy(wsUrl, policy, 'WebSocket URL');
    setWsUrl(nextUrl);
    await sendCommand({ type: 'SAVE_SETTINGS', payload: { wsUrl: nextUrl } });
    setSettingsNotice('Saved.');
  }

  async function connect(): Promise<void> {
    const policy = extractPermissionPolicy(chrome.runtime.getManifest());
    const nextUrl = assertUrlAllowedByPermissionPolicy(wsUrl, policy, 'WebSocket URL');
    setWsUrl(nextUrl);
    await sendCommand({ type: 'CONNECT_WS', payload: { url: nextUrl } });
    setSettingsNotice('Connect request sent.');
  }

  async function disconnect(): Promise<void> {
    await sendCommand({ type: 'DISCONNECT_WS', payload: {} });
    setSettingsNotice('Disconnect request sent.');
  }

  function toggleSelection(threadId: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  }

  function toggleSelectAll(): void {
    setSelectedIds((prev) => {
      if (threads.length > 0 && prev.size === threads.length) {
        return new Set<string>();
      }
      return new Set(threads.map((thread) => thread.id));
    });
  }

  async function saveSelectedThreads(): Promise<void> {
    if (selectedIds.size === 0) {
      setSaveNotice('Select at least one thread.');
      return;
    }

    setIsSaving(true);
    setSaveNotice('');
    try {
      const result = await sendCommand<ExportThreadsResult>({
        type: 'EXPORT_THREADS',
        payload: { threadIds: Array.from(selectedIds) }
      });

      for (const archive of result.archives) {
        triggerDownload(threadFileName(archive.thread, archive.exportedAt), JSON.stringify(archive, null, 2));
      }

      const missing = result.missingThreadIds.length;
      setSaveNotice(
        missing > 0
          ? `Saved ${result.archives.length} files. ${missing} threads were not found.`
          : `Saved ${result.archives.length} files.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSaveNotice(`Save failed: ${message}`);
    } finally {
      setIsSaving(false);
    }
  }

  async function loadFromFiles(): Promise<void> {
    if (files.length === 0) {
      setLoadNotice('Select one or more files.');
      return;
    }

    setIsLoading(true);
    setLoadNotice('');
    try {
      const parsed = await Promise.all(
        files.map(async (file) => {
          const text = await file.text();
          try {
            return JSON.parse(text) as unknown;
          } catch {
            return undefined;
          }
        })
      );
      const archives = parsed.filter(isThreadArchive);
      const skipped = files.length - archives.length;
      const result = await sendCommand<ImportThreadsResult>({
        type: 'IMPORT_THREADS',
        payload: { archives }
      });
      await loadThreads();
      setLoadNotice(
        skipped > 0
          ? `Loaded ${result.importedCount} threads. Skipped ${skipped} invalid files.`
          : `Loaded ${result.importedCount} threads.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLoadNotice(`Load failed: ${message}`);
    } finally {
      setIsLoading(false);
      setFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }

  return (
    <main className="page">
      <h1>Options</h1>

      <section className="section">
        <h2>Connection</h2>
        <div className="row">
          <label htmlFor="ws-url">WebSocket URL</label>
          <input
            id="ws-url"
            value={wsUrl}
            onChange={(event) => setWsUrl(event.target.value)}
            placeholder="ws://localhost:3000"
          />
        </div>
        <div className="actions">
          <button type="button" onClick={() => void save()}>
            Save
          </button>
          <button type="button" onClick={() => void connect()}>
            Connect
          </button>
          <button type="button" onClick={() => void disconnect()}>
            Disconnect
          </button>
        </div>
        {settingsNotice ? <p className="notice">{settingsNotice}</p> : null}
      </section>

      <section className="section">
        <div className="section-header">
          <h2>Save Threads</h2>
          <div className="actions">
            <button type="button" onClick={toggleSelectAll}>
              {allSelected ? 'Unselect All' : 'Select All'}
            </button>
            <button type="button" onClick={() => void loadThreads()}>
              Refresh
            </button>
          </div>
        </div>
        <div className="thread-list" role="list">
          {threads.length === 0 ? (
            <p className="empty">No threads.</p>
          ) : (
            threads.map((thread) => (
              <label key={thread.id} className="thread-item" role="listitem">
                <input
                  type="checkbox"
                  checked={selectedIds.has(thread.id)}
                  onChange={() => toggleSelection(thread.id)}
                />
                <span className="thread-title">{thread.title}</span>
                <small>{new Date(thread.updatedAt).toLocaleString('en-US')}</small>
              </label>
            ))
          )}
        </div>
        <div className="actions">
          <button type="button" disabled={isSaving || selectedIds.size === 0} onClick={() => void saveSelectedThreads()}>
            {isSaving ? 'Saving...' : `Save Selected (${selectedIds.size})`}
          </button>
        </div>
        {saveNotice ? <p className="notice">{saveNotice}</p> : null}
      </section>

      <section className="section">
        <h2>Load Threads</h2>
        <div className="row">
          <label htmlFor="thread-files">Thread files (.json, multiple)</label>
          <input
            ref={fileInputRef}
            id="thread-files"
            type="file"
            accept=".json,application/json"
            multiple
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
          />
          <small>{files.length > 0 ? `${files.length} files selected` : 'No files selected'}</small>
        </div>
        <div className="actions">
          <button type="button" disabled={isLoading || files.length === 0} onClick={() => void loadFromFiles()}>
            {isLoading ? 'Loading...' : 'Load Selected Files'}
          </button>
        </div>
        {loadNotice ? <p className="notice">{loadNotice}</p> : null}
      </section>
    </main>
  );
}
