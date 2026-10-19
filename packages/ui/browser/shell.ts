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

import type { Bot, RunSummary, Thread } from "@freebot/protocol";
import {
  BOTS_EMPTY,
  type BotRow,
  type BotStatus,
  botDotClass,
  botRows,
  conversationTitle,
  deriveBotStatus,
  mergeBotStatus,
  NEW_BOT_LABEL,
  NEW_BOT_PLACEHOLDER,
  NEW_THREAD_LABEL,
  NEW_THREAD_TITLE,
  runCountLabel,
  type ShellFacts,
  THREADS_EMPTY,
  type ThreadRow,
  threadRows,
} from "../src/bots.ts";
import { icon } from "./icons.ts";

/** One patch of a Bot's placement. The server keeps whatever the caller leaves out. */
export interface ArrangeBotPatch {
  readonly botId: string;
  readonly pinned?: boolean;
  readonly section?: string;
  readonly hidden?: boolean;
  readonly group?: boolean;
  readonly members?: string[];
}

/** The records and the one write the shell reads, with the token already applied. */
export interface ShellCalls {
  readonly listBots: () => Promise<readonly Bot[]>;
  readonly createBot: (name: string) => Promise<Bot>;
  readonly listThreads: (botId: string) => Promise<readonly Thread[]>;
  readonly createThread: (botId: string, title?: string) => Promise<Thread>;
  readonly arrangeBot: (patch: ArrangeBotPatch) => Promise<Bot>;
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
  /** Pin, hide, or move a Bot. The record comes back and the list repaints from it. */
  arrange(patch: ArrangeBotPatch): Promise<void>;
  /** Every run of every Bot, newest first, for the Activity page. */
  runs(): Array<{
    botName: string;
    threadTitle: string;
    runId: string;
    prompt: string;
    status: RunSummary["status"];
    startedAt: number;
  }>;
  /**
   * The live status of the Bot whose stream is on screen. It outranks the record between frames,
   * because the run store is written when a run changes and the page sees the change first. Null
   * clears the override, and the rows fall back to what their threads' runs say.
   */
  setLiveStatus(botId: string, status: BotStatus | null): void;
  selection(): ShellSelection;
  /** The records the selection points at, for a second surface that renders them. */
  records(): { readonly bot: Bot | null; readonly thread: Thread | null };
  /** The whole Bot list, and the selected Bot's threads, for a surface that lists them: the palette. */
  lists(): { readonly bots: readonly Bot[]; readonly threads: readonly Thread[] };
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
  /** Fired after a placement change, which moves no selection and must not reconnect a stream. */
  readonly onRecords?: () => void;
}): ShellHandle {
  const sidebarEl = must<HTMLElement>("#sidebar");
  const listEl = must<HTMLElement>("#bot-list");
  const threadListEl = must<HTMLElement>("#thread-list");
  const newBotEl = must<HTMLButtonElement>("#new-bot");
  const newBotNameEl = must<HTMLInputElement>("#new-bot-name");
  const newThreadEl = must<HTMLButtonElement>("#new-thread");
  const titleEl = must<HTMLElement>("#bot-title");
  const threadsBotEl = must<HTMLElement>("#threads-bot");
  const roleEl = document.querySelector<HTMLElement>("#bot-role");
  const botDotEl = document.querySelector<HTMLElement>("#bot-dot");
  const hiddenEl = document.querySelector<HTMLElement>("#hidden-bots");
  const hiddenGroupEl = document.querySelector<HTMLElement>("#hidden-group");
  const hiddenToggleEl = document.querySelector<HTMLButtonElement>("#hidden-toggle");
  const hiddenCountEl = document.querySelector<HTMLElement>("#hidden-count");

  newBotEl.textContent = NEW_BOT_LABEL;
  newThreadEl.textContent = NEW_THREAD_LABEL;
  newBotNameEl.placeholder = NEW_BOT_PLACEHOLDER;

  let bots: readonly Bot[] = [];
  let threads: readonly Thread[] = [];
  /**
   * Every Bot's threads, read once per paint pass. The sidebar needs the runs behind every row, and
   * the page holds one thread's stream at a time, so this is the real per-Bot read the status dot is
   * derived from rather than a label the page invents.
   */
  let threadsByBot = new Map<string, readonly Thread[]>();
  /** The selected Bot's live status while its stream is on screen. */
  const liveStatuses = new Map<string, BotStatus>();
  let selectedBotId: string | null = null;
  let selectedThreadId: string | null = null;
  /** Set while a create is in flight, so a second click cannot mint a second record. */
  let busy = false;
  /** Whether the Hidden Bots disclosure is open. The export starts it closed. */
  let hiddenOpen = false;

  function selectedBot(): Bot | undefined {
    return bots.find((bot) => bot.botId === selectedBotId);
  }

  function selectedThread(): Thread | undefined {
    return threads.find((thread) => thread.threadId === selectedThreadId);
  }

  /** The status each row shows: always derived from the Bot's runs, then merged with its live word. */
  function statuses(): Map<string, BotStatus> {
    const found = new Map<string, BotStatus>();
    for (const bot of bots) {
      const runs = (threadsByBot.get(bot.botId) ?? []).flatMap((thread) => thread.runs);
      found.set(
        bot.botId,
        mergeBotStatus(deriveBotStatus(runs), liveStatuses.get(bot.botId) ?? null),
      );
    }
    return found;
  }

  /** One `.sb-label` heading: the export's uppercase mono caption with an optional icon. */
  function sectionLabel(text: string, iconName?: "pin"): HTMLElement {
    const label = div("sb-label");
    if (iconName !== undefined) label.append(icon(iconName, "ic-sm"));
    label.append(document.createTextNode(text));
    return label;
  }

  function paint(): void {
    const rows = botRows(bots, selectedBotId, statuses());
    const visible = rows.filter((row) => !row.hidden);
    const hidden = rows.filter((row) => row.hidden);
    const pinned = visible.filter((row) => row.pinned);
    const rest = visible.filter((row) => !row.pinned);
    const sections = [...new Set(rest.map((row) => row.section).filter((name) => name !== ""))];
    const unassigned = rest.filter((row) => row.section === "");

    const parts: Node[] = [];
    if (pinned.length > 0) parts.push(sectionLabel("Pinned", "pin"), ...pinned.map(botRowNode));
    for (const section of sections) {
      parts.push(
        sectionLabel(section),
        ...rest.filter((row) => row.section === section).map(botRowNode),
      );
    }
    if (unassigned.length > 0) {
      parts.push(sectionLabel("Unassigned"), ...unassigned.map(botRowNode));
    }
    if (visible.length === 0) parts.push(div("shell-empty", BOTS_EMPTY));
    listEl.replaceChildren(...parts);

    if (hiddenEl !== null) hiddenEl.hidden = hidden.length === 0;
    if (hiddenCountEl !== null) hiddenCountEl.textContent = String(hidden.length);
    if (hiddenGroupEl !== null) {
      hiddenGroupEl.replaceChildren(...hidden.map(botRowNode));
      hiddenGroupEl.hidden = !hiddenOpen;
    }
    if (hiddenToggleEl !== null) hiddenToggleEl.setAttribute("aria-expanded", String(hiddenOpen));

    const threadRowsList = threadRows(threads, selectedThreadId);
    threadListEl.replaceChildren(...threadRowsList.map(threadRowNode));
    if (threadRowsList.length === 0) threadListEl.append(div("shell-empty", THREADS_EMPTY));

    const bot = selectedBot();
    threadsBotEl.textContent = bot?.name ?? "";
    titleEl.textContent = conversationTitle(bot?.name ?? null, selectedThread()?.title ?? null);
    if (roleEl !== null) roleEl.textContent = bot?.role ?? "";
    if (botDotEl !== null) {
      const status = bot === undefined ? undefined : statuses().get(bot.botId);
      botDotEl.className = status === undefined ? "dot" : botDotClass(status);
    }
    newThreadEl.disabled = selectedBotId === null || busy;
    newBotEl.disabled = busy;
    sidebarEl.dataset.shellState = bots.length === 0 ? "empty" : "loaded";
  }

  /** The row's own menu: pin, and hide or show. The export's `menu` (`:452-470`). */
  function openRowMenu(row: BotRow, x: number, y: number): void {
    document.querySelector(".menu")?.remove();
    const menu = div("menu");
    menu.style.left = `${Math.min(x, window.innerWidth - 240)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 120)}px`;
    const pin = document.createElement("button");
    pin.type = "button";
    pin.textContent = row.pinned ? "Unpin" : "Pin";
    pin.addEventListener("click", () => {
      menu.remove();
      void handle.arrange({ botId: row.botId, pinned: !row.pinned }).catch(() => undefined);
    });
    const hide = document.createElement("button");
    hide.type = "button";
    hide.textContent = row.hidden ? "Show in sidebar" : "Hide from sidebar";
    hide.addEventListener("click", () => {
      menu.remove();
      void handle.arrange({ botId: row.botId, hidden: !row.hidden }).catch(() => undefined);
    });
    menu.append(pin, hide);
    document.body.append(menu);
    const close = (event: MouseEvent): void => {
      if (menu.contains(event.target as Node)) return;
      menu.remove();
      document.removeEventListener("mousedown", close, true);
    };
    setTimeout(() => document.addEventListener("mousedown", close, true), 0);
  }

  /**
   * The export's `.sb-row` (`freebot-prototype.html:962-970`): a state dot, the name, and the one
   * sub line. The row's status is a real run fact, so the dot is a pulse while a run moves, a filled
   * dot while a person is needed, a ring after a failure, and an empty dot otherwise.
   */
  function botRowNode(row: BotRow): HTMLElement {
    const node = document.createElement("button");
    node.type = "button";
    node.className = `sb-row bot-row${row.selected ? " is-active" : ""}`;
    node.dataset.bot = row.botId;
    node.dataset.selected = String(row.selected);
    node.dataset.state = row.status;
    node.dataset.threads = String(row.threadCount);
    node.dataset.pinned = String(row.pinned);
    node.dataset.section = row.section;
    node.dataset.hidden = String(row.hidden);
    node.dataset.group = String(row.group);
    node.title = row.name;
    node.setAttribute("aria-current", String(row.selected));
    const dot = div(botDotClass(row.status));
    dot.setAttribute("aria-hidden", "true");
    node.append(dot);
    if (row.group) {
      const avatar = div("avatar", String(row.members.length));
      avatar.setAttribute("aria-hidden", "true");
      node.append(avatar);
    }
    node.append(div("name bot-name", row.name));
    node.append(div("sub", row.sub));
    node.addEventListener("click", () => void handle.selectBot(row.botId));
    node.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openRowMenu(row, event.clientX, event.clientY);
    });
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

  async function readAllThreads(): Promise<void> {
    const entries = await Promise.all(
      bots.map(async (bot) => [bot.botId, await config.calls.listThreads(bot.botId)] as const),
    );
    threadsByBot = new Map(entries);
    threads = selectedBotId === null ? [] : (threadsByBot.get(selectedBotId) ?? []);
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
      await readAllThreads();
      selectedThreadId = threads[0]?.threadId ?? null;
      paint();
    },

    async refresh() {
      bots = await config.calls.listBots();
      if (!bots.some((bot) => bot.botId === selectedBotId)) {
        selectedBotId = bots[0]?.botId ?? null;
      }
      await readAllThreads();
      paint();
    },

    async selectBot(botId) {
      selectedBotId = botId;
      selectedThreadId = null;
      liveStatuses.delete(botId);
      await readAllThreads();
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
        const thread = await config.calls.createThread(bot.botId, NEW_THREAD_TITLE);
        // The record the server made is the row the sidebar shows, so the list gains it here rather
        // than being read back a second time. Its count is one because the thread just above is the
        // thread it always starts with. Its threads are the one read that gives it a status.
        bots = [...bots, { ...bot, threadCount: 1 }];
        threadsByBot = new Map(threadsByBot).set(bot.botId, [thread]);
        selectedBotId = bot.botId;
        selectedThreadId = null;
        newBotNameEl.value = "";
        await readAllThreads();
        selectedThreadId = thread.threadId;
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
        threadsByBot = new Map(threadsByBot).set(selectedBotId, threads);
        selectedThreadId = thread.threadId;
        await readAllThreads();
        selectedThreadId = thread.threadId;
        paint();
        config.onChange?.(handle.selection());
      } finally {
        busy = false;
        paint();
      }
    },

    async arrange(patch) {
      const updated = await config.calls.arrangeBot(patch);
      bots = bots.map((bot) => (bot.botId === updated.botId ? updated : bot));
      paint();
      config.onRecords?.();
    },

    runs() {
      const rows: Array<{
        botName: string;
        threadTitle: string;
        runId: string;
        prompt: string;
        status: RunSummary["status"];
        startedAt: number;
      }> = [];
      for (const bot of bots) {
        for (const thread of threadsByBot.get(bot.botId) ?? []) {
          for (const run of thread.runs) {
            rows.push({
              botName: bot.name,
              threadTitle: thread.title,
              runId: run.runId,
              prompt: run.prompt,
              status: run.status,
              startedAt: run.startedAt,
            });
          }
        }
      }
      return rows.sort((a, b) => b.startedAt - a.startedAt);
    },

    setLiveStatus(botId, status) {
      const before = liveStatuses.get(botId) ?? null;
      if (status === null) liveStatuses.delete(botId);
      else liveStatuses.set(botId, status);
      const after = liveStatuses.get(botId) ?? null;
      if (before !== after) paint();
    },

    selection: () => ({ botId: selectedBotId, threadId: selectedThreadId }),

    records: () => ({ bot: selectedBot() ?? null, thread: selectedThread() ?? null }),

    lists: () => ({ bots, threads }),

    facts() {
      const domRows = new Map(
        [...listEl.querySelectorAll<HTMLElement>(".sb-row")].map((node) => [
          node.dataset.bot ?? "",
          node,
        ]),
      );
      return {
        operator: !sidebarEl.hidden,
        bots: botRows(bots, selectedBotId, statuses()).map((row) => {
          const node = domRows.get(row.botId);
          const dot = node?.querySelector<HTMLElement>(".dot, .pulse");
          return {
            botId: row.botId,
            name: row.name,
            threadCount: row.threadCount,
            selected: row.selected,
            status: row.status,
            sub: node?.querySelector<HTMLElement>(".sub")?.textContent ?? row.sub,
            dot: dot?.className ?? botDotClass(row.status),
            pinned: row.pinned,
            section: row.section,
            hidden: row.hidden,
            group: row.group,
          };
        }),
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

  hiddenToggleEl?.addEventListener("click", () => {
    hiddenOpen = !hiddenOpen;
    paint();
  });
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
