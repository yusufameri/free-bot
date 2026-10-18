/**
 * The shell's DOM: the sidebar of Bots, and the thread list inside one of them.
 *
 * It decides nothing. `packages/ui/src/bots.ts` owns the rows, the labels and the wording; this
 * module turns those decisions into nodes and reads them back for the evidence harness.
 *
 * The two section labels are the page's own markup, like the rest of its static chrome; everything
 * that depends on a record comes from `bots.ts`.
 *
 * The four calls arrive as `calls`, already carrying the operator token, so nothing here knows what
 * a transport is. The host owns what happens when the selection moves: this module reports it and
 * nothing else, because re-subscribing a stream is not a shell decision.
 */

import type { Bot, Thread } from "@freebot/protocol";
import {
  BOTS_EMPTY,
  type BotRow,
  botRows,
  conversationTitle,
  NEW_BOT_LABEL,
  NEW_BOT_PLACEHOLDER,
  NEW_THREAD_LABEL,
  NEW_THREAD_TITLE,
  runCountLabel,
  type ShellFacts,
  THREADS_EMPTY,
  type ThreadRow,
  threadCountLabel,
  threadRows,
} from "../src/bots.ts";

/** The four records the shell reads, with the token already applied. */
export interface ShellCalls {
  readonly listBots: () => Promise<readonly Bot[]>;
  readonly createBot: (name: string) => Promise<Bot>;
  readonly listThreads: (botId: string) => Promise<readonly Thread[]>;
  readonly createThread: (botId: string, title?: string) => Promise<Thread>;
}

export interface ShellSelection {
  readonly botId: string | null;
  readonly threadId: string | null;
}

export interface ShellHandle {
  /** Read the Bots, then the selection's threads. The first run selects the first Bot it finds. */
  load(): Promise<void>;
  /** Make a Bot and select it. Its first thread is created too, so a run has somewhere to land. */
  createBot(name: string): Promise<void>;
  selectBot(botId: string): Promise<void>;
  selectThread(threadId: string): Promise<void>;
  /** Make a thread in the selected Bot and select it. */
  createThread(): Promise<void>;
  /** Re-read the Bots and the selected Bot's threads, without moving the selection. */
  refresh(): Promise<void>;
  selection(): ShellSelection;
  /** The records the selection points at, for a second surface that renders them. */
  records(): { readonly bot: Bot | null; readonly thread: Thread | null };
  facts(): ShellFacts;
}

declare global {
  interface Window {
    /** Live shell facts, read from the DOM, for the CDP harness. */
    __shellFacts?: () => ShellFacts;
  }
}

function must<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`missing element ${selector}`);
  return found;
}

function div(className: string, text = ""): HTMLDivElement {
  const node = document.createElement("div");
  node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

export function mountShell(config: {
  readonly calls: ShellCalls;
  /** Fired after the selection moves, with the ids the surface should now be showing. */
  readonly onChange?: (selection: ShellSelection) => void;
}): ShellHandle {
  const sidebarEl = must<HTMLElement>("#sidebar");
  const listEl = must<HTMLElement>("#bot-list");
  const threadListEl = must<HTMLElement>("#thread-list");
  const newBotEl = must<HTMLButtonElement>("#new-bot");
  const newBotNameEl = must<HTMLInputElement>("#new-bot-name");
  const newThreadEl = must<HTMLButtonElement>("#new-thread");
  const titleEl = must<HTMLElement>("#bot-title");
  const threadsBotEl = must<HTMLElement>("#threads-bot");

  newBotEl.textContent = NEW_BOT_LABEL;
  newThreadEl.textContent = NEW_THREAD_LABEL;
  newBotNameEl.placeholder = NEW_BOT_PLACEHOLDER;

  let bots: readonly Bot[] = [];
  let threads: readonly Thread[] = [];
  let selectedBotId: string | null = null;
  let selectedThreadId: string | null = null;
  /** Set while a create is in flight, so a second click cannot mint a second record. */
  let busy = false;

  function selectedBot(): Bot | undefined {
    return bots.find((bot) => bot.botId === selectedBotId);
  }

  function selectedThread(): Thread | undefined {
    return threads.find((thread) => thread.threadId === selectedThreadId);
  }

  function paint(): void {
    const rows = botRows(bots, selectedBotId);
    listEl.replaceChildren(...rows.map(botRowNode));
    if (rows.length === 0) listEl.append(div("shell-empty", BOTS_EMPTY));

    const threadRowsList = threadRows(threads, selectedThreadId);
    threadListEl.replaceChildren(...threadRowsList.map(threadRowNode));
    if (threadRowsList.length === 0) threadListEl.append(div("shell-empty", THREADS_EMPTY));

    threadsBotEl.textContent = selectedBot()?.name ?? "";
    titleEl.textContent = conversationTitle(
      selectedBot()?.name ?? null,
      selectedThread()?.title ?? null,
    );
    newThreadEl.disabled = selectedBotId === null || busy;
    newBotEl.disabled = busy;
    sidebarEl.dataset.shellState = bots.length === 0 ? "empty" : "loaded";
  }

  function botRowNode(row: BotRow): HTMLElement {
    const node = document.createElement("button");
    node.className = "bot-row";
    node.dataset.bot = row.botId;
    node.dataset.selected = String(row.selected);
    node.setAttribute("aria-current", String(row.selected));
    node.append(div("bot-name", row.name));
    node.append(div("bot-threads", threadCountLabel(row.threadCount)));
    node.addEventListener("click", () => void handle.selectBot(row.botId));
    return node;
  }

  function threadRowNode(row: ThreadRow): HTMLElement {
    const node = document.createElement("button");
    node.className = "thread-row";
    node.dataset.thread = row.threadId;
    node.dataset.selected = String(row.selected);
    node.dataset.runs = String(row.runs);
    node.setAttribute("aria-current", String(row.selected));
    node.append(div("thread-title", row.title));
    node.append(div("thread-detail", row.detail));
    node.append(div("thread-runs", runCountLabel(row.runs)));
    node.addEventListener("click", () => void handle.selectThread(row.threadId));
    return node;
  }

  async function readThreads(botId: string): Promise<void> {
    threads = await config.calls.listThreads(botId);
    if (!threads.some((thread) => thread.threadId === selectedThreadId)) {
      selectedThreadId = threads[0]?.threadId ?? null;
    }
  }

  const handle: ShellHandle = {
    async load() {
      bots = await config.calls.listBots();
      if (!bots.some((bot) => bot.botId === selectedBotId)) {
        selectedBotId = bots[0]?.botId ?? null;
      }
      threads = selectedBotId === null ? [] : await config.calls.listThreads(selectedBotId);
      selectedThreadId = threads[0]?.threadId ?? null;
      paint();
    },

    async refresh() {
      bots = await config.calls.listBots();
      if (selectedBotId !== null) await readThreads(selectedBotId);
      paint();
    },

    async selectBot(botId) {
      selectedBotId = botId;
      selectedThreadId = null;
      await readThreads(botId);
      paint();
      config.onChange?.(handle.selection());
    },

    async selectThread(threadId) {
      selectedThreadId = threadId;
      paint();
      config.onChange?.(handle.selection());
    },

    async createBot(name) {
      if (busy) return;
      busy = true;
      paint();
      try {
        const bot = await config.calls.createBot(name.trim() === "" ? NEW_BOT_LABEL : name.trim());
        await config.calls.createThread(bot.botId, NEW_THREAD_TITLE);
        // The record the server made is the row the sidebar shows, so the list gains it here rather
        // than being read back a second time. Its count is one because the thread just above is the
        // thread it always starts with.
        bots = [...bots, { ...bot, threadCount: 1 }];
        selectedBotId = bot.botId;
        selectedThreadId = null;
        newBotNameEl.value = "";
        await readThreads(bot.botId);
        paint();
        config.onChange?.(handle.selection());
      } finally {
        busy = false;
        paint();
      }
    },

    async createThread() {
      if (busy || selectedBotId === null) return;
      busy = true;
      paint();
      try {
        const thread = await config.calls.createThread(selectedBotId, NEW_THREAD_TITLE);
        threads = [...threads, thread];
        selectedThreadId = thread.threadId;
        await readThreads(selectedBotId);
        selectedThreadId = thread.threadId;
        paint();
        config.onChange?.(handle.selection());
      } finally {
        busy = false;
        paint();
      }
    },

    selection: () => ({ botId: selectedBotId, threadId: selectedThreadId }),

    records: () => ({ bot: selectedBot() ?? null, thread: selectedThread() ?? null }),

    facts() {
      return {
        operator: !sidebarEl.hidden,
        bots: botRows(bots, selectedBotId).map((row) => ({
          botId: row.botId,
          name: row.name,
          threadCount: row.threadCount,
          selected: row.selected,
        })),
        selectedBotId,
        threads: threadRows(threads, selectedThreadId).map((row) => ({
          threadId: row.threadId,
          title: row.title,
          runs: row.runs,
          selected: row.selected,
        })),
        selectedThreadId,
        title: titleEl.textContent ?? "",
      };
    },
  };

  newBotEl.addEventListener("click", () => void handle.createBot(newBotNameEl.value));
  newBotNameEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void handle.createBot(newBotNameEl.value);
    }
  });
  newThreadEl.addEventListener("click", () => void handle.createThread());

  paint();
  return handle;
}

/** Expose the live shell facts on `window`, so a CDP driver reads the page. */
export function exposeShellFacts(handle: ShellHandle): void {
  window.__shellFacts = () => handle.facts();
}
