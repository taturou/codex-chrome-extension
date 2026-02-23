import type {
  ApiResponse,
  AttachSelectionResult,
  CreateThreadResult,
  UsageLimitsResult,
  ListThreadsResult,
  MessagesResult,
  RuntimeCommand,
  SettingsResult,
  SidePanelEvent
} from './contracts/messages';
import type { Attachment, Message, Thread, UsageLimits, WsStatus } from './contracts/types';
import { StorageRepository } from './storage/repository';
import { DEFAULT_WS_URL } from './shared/constants';
import { createId } from './shared/id';
import { SIDEPANEL_EVENT_PORT_NAME } from './shared/runtimePorts';
import { WebSocketTransport } from './transport/wsTransport';
import TurndownService from 'turndown';
import { createDocument } from '@mixmark-io/domino';

const repository = new StorageRepository();
const sidePanelPorts = new Set<chrome.runtime.Port>();

let wsStatus: WsStatus = 'disconnected';
let wsReason: string | undefined;
let usageLimits: UsageLimits = {
  rateLimits: [],
  updatedAt: 0
};

function ensureDocumentForTurndown(): void {
  if (typeof document !== 'undefined') {
    return;
  }
  (globalThis as typeof globalThis & { document?: Document }).document = createDocument('') as unknown as Document;
}

ensureDocumentForTurndown();

const markdownConverter = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined'
});

function convertSelectionHtmlToMarkdown(html: string, fallbackText: string): string {
  const doc = createDocument('<div id="turndown-root"></div>');
  const root = doc.getElementById('turndown-root');
  if (!root) {
    return fallbackText;
  }
  root.innerHTML = html;
  const markdown = markdownConverter.turndown(root).trim();
  return markdown || fallbackText;
}

function now(): number {
  return Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
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

async function setUsage(next: UsageLimits): Promise<void> {
  usageLimits = next;
  await broadcast({
    type: 'USAGE_LIMITS_UPDATED',
    payload: { usage: usageLimits }
  });
}

async function refreshUsageLimits(timeoutMs = 1600): Promise<UsageLimits> {
  const before = usageLimits.updatedAt;
  transport.requestUsageLimits();
  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    if (usageLimits.updatedAt > before) {
      break;
    }
    await sleep(80);
  }
  return usageLimits;
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
  onUsage: (usage) => {
    void setUsage(usage);
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
      if (wsStatus === 'connected') {
        try {
          await refreshUsageLimits();
        } catch {
          // no-op: usage refresh is best-effort.
        }
      }
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
      if (wsStatus === 'connected') {
        try {
          await refreshUsageLimits();
        } catch {
          // no-op: usage refresh is best-effort.
        }
      }
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
    title: await repository.reserveNextThreadTitle(),
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
    throw new Error('Failed to get active tab');
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
    throw new Error('Failed to get tab URL');
  }

  const protocol = getTabProtocol(tab.url);
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`Selection attachment is not available on this page (${protocol})`);
  }

  const originPattern = getTabOriginPattern(tab.url);
  const hasPermission = await chrome.permissions.contains({ origins: [originPattern] });
  if (hasPermission) {
    return;
  }
  throw new Error(`Insufficient page permission (${originPattern})`);
}

async function attachSelection(tabId?: number): Promise<Attachment> {
  const tab = await getActiveTab(tabId);
  if (typeof tab.id !== 'number') {
    throw new Error('Invalid tabId');
  }
  await ensureTabHostPermission(tab);

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.toString().trim() === '') {
        return {
          html: '',
          text: '',
          url: window.location.href
        };
      }

      const root = document.createElement('div');
      for (let i = 0; i < selection.rangeCount; i += 1) {
        const range = selection.getRangeAt(i);
        root.appendChild(range.cloneContents());
        if (i < selection.rangeCount - 1) {
          root.appendChild(document.createElement('br'));
        }
      }

      return {
        html: root.innerHTML,
        text: selection.toString().trim(),
        url: window.location.href
      };
    }
  });

  const first = results[0]?.result as { html: string; text: string; url: string } | undefined;
  if (!first || !first.text) {
    throw new Error('Selected text is empty');
  }

  return {
    type: 'selected_text',
    text: convertSelectionHtmlToMarkdown(first.html, first.text),
    tabId: tab.id,
    url: first.url,
    capturedAt: now()
  };
}

interface DomSelectionState {
  active: boolean;
  selectedCount: number;
}

interface PageContextCapture {
  source: 'viewport' | 'dom_selection';
  text: string;
  html: string;
  url: string;
  title: string;
  selectedCount: number;
}

async function runDomSelectionCommand(
  tabId: number,
  action: 'start' | 'stop' | 'clear' | 'state' | 'capture',
  maxChars = 12000,
  source: 'viewport' | 'dom_or_viewport' = 'dom_or_viewport'
): Promise<DomSelectionState | PageContextCapture> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: ({ nextAction, nextMaxChars, nextSource }) => {
      type SelectionState = {
        active: boolean;
        selectedIds: string[];
        seq: number;
        listenersAttached: boolean;
      };

      type HostWindow = Window & typeof globalThis & { __codexDomSelectionState?: SelectionState };

      const host = window as HostWindow;
      const styleId = 'codex-dom-selection-style';
      const panelId = 'codex-dom-selection-panel';
      const selectedAttr = 'data-codex-dom-selected-id';
      const selectedClass = 'codex-dom-selected';
      const hoverClass = 'codex-dom-hover';

      const defaultState: SelectionState = {
        active: false,
        selectedIds: [],
        seq: 0,
        listenersAttached: false
      };

      if (!host.__codexDomSelectionState) {
        host.__codexDomSelectionState = { ...defaultState };
      }
      const state = host.__codexDomSelectionState;

      function getElementBySelectionId(id: string): Element | null {
        return document.querySelector(`[${selectedAttr}="${CSS.escape(id)}"]`);
      }

      function removeHover(): void {
        const hoverElements = document.querySelectorAll(`.${hoverClass}`);
        for (const hoverElement of hoverElements) {
          hoverElement.classList.remove(hoverClass);
        }
      }

      function ensureStyle(): void {
        if (document.getElementById(styleId)) {
          return;
        }
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
          .${hoverClass} {
            outline: 1px solid #60a5fa !important;
            outline-offset: 2px !important;
          }
          .${selectedClass} {
            outline: 2px solid #2563eb !important;
            outline-offset: 2px !important;
            background-color: rgba(37, 99, 235, 0.08) !important;
          }
          #${panelId} {
            position: fixed;
            right: 12px;
            top: 12px;
            z-index: 2147483647;
            font-family: 'Noto Sans JP', sans-serif;
            font-size: 12px;
            background: rgba(15, 23, 42, 0.92);
            color: #e2e8f0;
            border-radius: 999px;
            padding: 6px 10px;
            display: none;
            gap: 8px;
            align-items: center;
          }
          #${panelId}[data-active="true"] {
            display: inline-flex;
          }
          #${panelId} button {
            border: 0;
            border-radius: 999px;
            background: #1d4ed8;
            color: #fff;
            padding: 2px 8px;
            font-size: 11px;
            cursor: pointer;
          }
          #${panelId} button[data-kind="clear"] {
            background: #475569;
          }
        `;
        document.documentElement.appendChild(style);
      }

      function ensurePanel(): HTMLDivElement {
        const existing = document.getElementById(panelId);
        if (existing && existing instanceof HTMLDivElement) {
          return existing;
        }
        const panel = document.createElement('div');
        panel.id = panelId;
        panel.innerHTML = `
          <span data-role="status">DOM Selection Mode</span>
          <button type="button" data-kind="clear">Clear</button>
          <button type="button" data-kind="done">Done</button>
        `;
        panel.addEventListener('click', (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) {
            return;
          }
          if (target.dataset.kind === 'clear') {
            clearSelection();
            renderPanel();
            return;
          }
          if (target.dataset.kind === 'done') {
            deactivate();
            renderPanel();
          }
        });
        document.documentElement.appendChild(panel);
        return panel;
      }

      function isSelectableElement(element: Element): boolean {
        const tag = element.tagName.toLowerCase();
        if (tag === 'html' || tag === 'body' || tag === 'main') {
          return false;
        }
        return true;
      }

      function normalizeState(): void {
        state.selectedIds = state.selectedIds.filter((id) => Boolean(getElementBySelectionId(id)));
      }

      function renderPanel(): void {
        const panel = ensurePanel();
        normalizeState();
        panel.dataset.active = state.active ? 'true' : 'false';
        const status = panel.querySelector('[data-role="status"]');
        if (status) {
          status.textContent = `DOM selected: ${state.selectedIds.length} (Esc to exit)`;
        }
      }

      function clearSelection(): void {
        const selectedNodes = document.querySelectorAll(`[${selectedAttr}]`);
        for (const node of selectedNodes) {
          if (!(node instanceof HTMLElement)) {
            continue;
          }
          node.classList.remove(selectedClass);
          node.classList.remove(hoverClass);
          node.removeAttribute(selectedAttr);
        }
        state.selectedIds = [];
      }

      function toggleSelection(target: Element): void {
        if (!isSelectableElement(target)) {
          return;
        }
        target.classList.remove(hoverClass);
        const currentId = target.getAttribute(selectedAttr);
        if (currentId) {
          target.removeAttribute(selectedAttr);
          target.classList.remove(selectedClass);
          state.selectedIds = state.selectedIds.filter((id) => id !== currentId);
          return;
        }
        state.seq += 1;
        const id = `codex-${Date.now()}-${state.seq}`;
        target.setAttribute(selectedAttr, id);
        target.classList.add(selectedClass);
        state.selectedIds.push(id);
      }

      function handleMouseMove(event: MouseEvent): void {
        if (!state.active) {
          return;
        }
        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }
        if (target.closest(`#${panelId}`)) {
          return;
        }
        const element = target.closest('*');
        if (!element || !isSelectableElement(element)) {
          removeHover();
          return;
        }
        const selectedId = element.getAttribute(selectedAttr);
        if (selectedId) {
          removeHover();
          return;
        }
        const currentHover = document.querySelector(`.${hoverClass}`);
        if (currentHover === element) {
          return;
        }
        removeHover();
        element.classList.add(hoverClass);
      }

      function handleClick(event: MouseEvent): void {
        if (!state.active) {
          return;
        }
        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }
        if (target.closest(`#${panelId}`)) {
          return;
        }
        const element = target.closest('*');
        if (!element) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        toggleSelection(element);
        renderPanel();
      }

      function handleKeyDown(event: KeyboardEvent): void {
        if (!state.active) {
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          deactivate();
          renderPanel();
        }
      }

      function activate(): void {
        if (state.active) {
          renderPanel();
          return;
        }
        state.active = true;
        if (!state.listenersAttached) {
          document.addEventListener('mousemove', handleMouseMove, true);
          document.addEventListener('click', handleClick, true);
          document.addEventListener('keydown', handleKeyDown, true);
          state.listenersAttached = true;
        }
        renderPanel();
      }

      function deactivate(): void {
        if (!state.active) {
          renderPanel();
          return;
        }
        state.active = false;
        removeHover();
        renderPanel();
      }

      function extractViewportText(maxChars: number): string {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const lines: string[] = [];
        let total = 0;

        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!(node instanceof Text)) {
            continue;
          }
          const raw = node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
          if (!raw) {
            continue;
          }
          const parent = node.parentElement;
          if (!parent) {
            continue;
          }
          const tag = parent.tagName.toLowerCase();
          if (tag === 'script' || tag === 'style' || tag === 'noscript') {
            continue;
          }
          const style = getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            continue;
          }
          const rect = parent.getBoundingClientRect();
          const isVisible =
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth;
          if (!isVisible) {
            continue;
          }
          const remaining = maxChars - total;
          if (remaining <= 0) {
            break;
          }
          const clipped = raw.length > remaining ? raw.slice(0, remaining) : raw;
          lines.push(clipped);
          total += clipped.length + 1;
        }
        return lines.join('\n');
      }

      function captureDomSelection(maxChars: number): { text: string; html: string; count: number } {
        normalizeState();
        if (state.selectedIds.length === 0) {
          return { text: '', html: '', count: 0 };
        }

        const parts: string[] = [];
        const htmlParts: string[] = [];
        let total = 0;

        for (const id of state.selectedIds) {
          const element = getElementBySelectionId(id);
          if (!element || !(element instanceof HTMLElement)) {
            continue;
          }
          const raw = element.innerText.replace(/\s+/g, ' ').trim();
          if (!raw) {
            continue;
          }
          const remaining = maxChars - total;
          if (remaining <= 0) {
            break;
          }
          const clipped = raw.length > remaining ? raw.slice(0, remaining) : raw;
          parts.push(clipped);
          htmlParts.push(element.outerHTML);
          total += clipped.length + 1;
        }

        return {
          text: parts.join('\n'),
          html: htmlParts.join('\n'),
          count: state.selectedIds.length
        };
      }

      ensureStyle();
      ensurePanel();

      if (nextAction === 'start') {
        activate();
        return { active: state.active, selectedCount: state.selectedIds.length };
      }
      if (nextAction === 'stop') {
        deactivate();
        return { active: state.active, selectedCount: state.selectedIds.length };
      }
      if (nextAction === 'clear') {
        clearSelection();
        renderPanel();
        return { active: state.active, selectedCount: state.selectedIds.length };
      }
      if (nextAction === 'state') {
        renderPanel();
        return { active: state.active, selectedCount: state.selectedIds.length };
      }

      const selected = captureDomSelection(nextMaxChars);
      const canUseDom = selected.count > 0 && selected.text;
      if (nextSource === 'dom_or_viewport' && canUseDom) {
        return {
          source: 'dom_selection',
          text: selected.text,
          html: selected.html,
          url: window.location.href,
          title: document.title,
          selectedCount: selected.count
        };
      }

      return {
        source: 'viewport',
        text: extractViewportText(nextMaxChars),
        html: '',
        url: window.location.href,
        title: document.title,
        selectedCount: selected.count
      };
    },
    args: [{ nextAction: action, nextMaxChars: maxChars, nextSource: source }]
  });

  return results[0]?.result as DomSelectionState | PageContextCapture;
}

async function startDomSelectionMode(tabId?: number): Promise<DomSelectionState> {
  const tab = await getActiveTab(tabId);
  if (typeof tab.id !== 'number') {
    throw new Error('Invalid tabId');
  }
  await ensureTabHostPermission(tab);
  return (await runDomSelectionCommand(tab.id, 'start')) as DomSelectionState;
}

async function stopDomSelectionMode(tabId?: number): Promise<DomSelectionState> {
  const tab = await getActiveTab(tabId);
  if (typeof tab.id !== 'number') {
    throw new Error('Invalid tabId');
  }
  await ensureTabHostPermission(tab);
  return (await runDomSelectionCommand(tab.id, 'stop')) as DomSelectionState;
}

async function clearDomSelection(tabId?: number): Promise<DomSelectionState> {
  const tab = await getActiveTab(tabId);
  if (typeof tab.id !== 'number') {
    throw new Error('Invalid tabId');
  }
  await ensureTabHostPermission(tab);
  return (await runDomSelectionCommand(tab.id, 'clear')) as DomSelectionState;
}

async function getDomSelectionState(tabId?: number): Promise<DomSelectionState> {
  const tab = await getActiveTab(tabId);
  if (typeof tab.id !== 'number') {
    throw new Error('Invalid tabId');
  }
  await ensureTabHostPermission(tab);
  return (await runDomSelectionCommand(tab.id, 'state')) as DomSelectionState;
}

async function capturePageContext(
  tabId: number | undefined,
  source: 'viewport' | 'dom_or_viewport',
  maxChars = 12000
): Promise<{ attachment: Attachment; source: 'viewport' | 'dom_selection' }> {
  const tab = await getActiveTab(tabId);
  if (typeof tab.id !== 'number') {
    throw new Error('Invalid tabId');
  }
  await ensureTabHostPermission(tab);
  const result = (await runDomSelectionCommand(tab.id, 'capture', maxChars, source)) as PageContextCapture;
  if (!result.text.trim()) {
    throw new Error('Page context capture returned empty text');
  }

  const markdownText = result.html
    ? convertSelectionHtmlToMarkdown(result.html, result.text)
    : result.text;

  return {
    source: result.source,
    attachment: {
      type: 'page_context',
      scope: result.source,
      text: markdownText,
      tabId: tab.id,
      url: result.url,
      title: result.title,
      selectedCount: result.selectedCount,
      capturedAt: now()
    }
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
    case 'GET_USAGE_LIMITS': {
      const result: UsageLimitsResult = { usage: usageLimits };
      return result;
    }
    case 'REFRESH_USAGE_LIMITS': {
      const usage = await refreshUsageLimits();
      const result: UsageLimitsResult = { usage };
      return result;
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
    case 'START_DOM_SELECTION_MODE': {
      return await startDomSelectionMode(command.payload.tabId);
    }
    case 'STOP_DOM_SELECTION_MODE': {
      return await stopDomSelectionMode(command.payload.tabId);
    }
    case 'CLEAR_DOM_SELECTION': {
      return await clearDomSelection(command.payload.tabId);
    }
    case 'GET_DOM_SELECTION_STATE': {
      return await getDomSelectionState(command.payload.tabId);
    }
    case 'CAPTURE_PAGE_CONTEXT': {
      return await capturePageContext(command.payload.tabId, command.payload.source, command.payload.maxChars ?? 12000);
    }
    case 'CREATE_THREAD': {
      const createdAt = now();
      const title = command.payload.title?.trim() || (await repository.reserveNextThreadTitle());
      const thread: Thread = {
        id: createId('thread'),
        title,
        createdAt,
        updatedAt: createdAt,
        lastMessageAt: createdAt
      };
      await repository.upsertThread(thread);
      await repository.setCurrentThread(thread.id);
      const result: CreateThreadResult = { thread };
      return result;
    }
    case 'RENAME_THREAD': {
      const title = command.payload.title.trim();
      if (!title) {
        throw new Error('Thread name is required');
      }
      const renamed = await repository.renameThread(command.payload.threadId, title);
      if (!renamed) {
        throw new Error('Target thread was not found');
      }
      return { thread: renamed };
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
    'GET_USAGE_LIMITS',
    'REFRESH_USAGE_LIMITS',
    'SEND_CHAT_MESSAGE',
    'ATTACH_SELECTION',
    'START_DOM_SELECTION_MODE',
    'STOP_DOM_SELECTION_MODE',
    'CLEAR_DOM_SELECTION',
    'GET_DOM_SELECTION_STATE',
    'CAPTURE_PAGE_CONTEXT',
    'CREATE_THREAD',
    'RENAME_THREAD',
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
    port.postMessage({
      type: 'USAGE_LIMITS_UPDATED',
      payload: { usage: usageLimits }
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
