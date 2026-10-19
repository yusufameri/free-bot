/**
 * The shell's model: the Bots a person owns, and the threads inside one of them.
 *
 * `packages/ui/browser/shell.ts` renders this and decides nothing. The row order, the labels, the
 * wording and the state vocabulary live here, so the page and the evidence read the same words, the
 * same split `library.ts` and `thread.ts` keep for their surfaces.
 *
 * The two lists are derived from the contract's own records rather than stored: a row exists
 * because a record exists, and its count is the record's own. Nothing here mints an id, because a
 * Bot's id is the key of its workspace directory and the server owns it.
 */

import type { Bot, RunSummary, Thread } from "@freebot/protocol";
import { runInFlight, type ThreadState } from "./thread.ts";

export const BOTS_EMPTY = "No Bots yet.";

export const THREADS_EMPTY = "No threads in this Bot yet.";

export const NEW_BOT_PLACEHOLDER = "Name a new Bot";

export const NEW_BOT_LABEL = "New Bot";

export const NEW_THREAD_LABEL = "New thread";

/** The label every thread carries until a person renames it. Mirrors the server's default title. */
export const NEW_THREAD_TITLE = "New conversation";

/** How long a run's prompt is allowed to be when the thread list uses it as the row's detail. */
export const RUN_LABEL_MAX = 60;

/**
 * What a Bot's row can say about the runs behind it. The four words are the export's own status
 * language (`freebot-prototype.html:955-970`): a pulse while it works, a filled dot when it needs a
 * person, a ring when its latest run failed, and the empty dot when it is idle. `attention` is the
 * export's name; the row's sub line reads it as `needs you`.
 */
export const BOT_STATUSES = ["working", "attention", "failed", "idle"] as const;

export type BotStatus = (typeof BOT_STATUSES)[number];

/** The run statuses that mean a run has not reached an ending yet. */
const IN_FLIGHT: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "awaiting_approval",
  "paused",
]);

/** One Bot as the sidebar renders it. */
export interface BotRow {
  readonly botId: string;
  readonly name: string;
  /** How many threads the Bot holds, which is what the record carries. */
  readonly threadCount: number;
  readonly selected: boolean;
  /** Derived from the Bot's runs, never from a label written into the page. */
  readonly status: BotStatus;
  /** The export's one-word line under the name: the status, or the first word of the role. */
  readonly sub: string;
}

/** The class list of the row's status dot, exactly the export's three dot shapes plus idle. */
export function botDotClass(status: BotStatus): string {
  switch (status) {
    case "working":
      return "pulse";
    case "attention":
      return "dot on";
    case "failed":
      return "dot ring";
    case "idle":
      return "dot";
  }
}

/** The first word of a role, which is what the export shows on an idle row. */
export function roleWord(role: string): string {
  return role.trim().split(/\s+/)[0] ?? "";
}

/** The sub line the row shows for a status, with the export's idle fallback. */
export function botSubLabel(status: BotStatus, role: string): string {
  switch (status) {
    case "working":
      return "working";
    case "attention":
      return "needs you";
    case "failed":
      return "failed";
    case "idle":
      return roleWord(role);
  }
}

/** The run a Bot's row is about: the newest one it holds, across all its threads. */
export function latestRun(runs: readonly RunSummary[]): RunSummary | null {
  let latest: RunSummary | null = null;
  for (const run of runs) {
    if (latest === null || run.startedAt > latest.startedAt) latest = run;
  }
  return latest;
}

/**
 * The Bot's status, from its runs alone.
 *
 * A park outranks work: while any run waits on a person the row says `needs you`, even if another
 * run of the same Bot is still moving. `paused` counts as in flight because the taxonomy says a
 * paused run is a wait inside a run, not an ending. With nothing in flight, only the newest run can
 * fail the Bot; an old failure behind a newer success is history, not status.
 */
export function deriveBotStatus(runs: readonly RunSummary[]): BotStatus {
  if (runs.some((run) => run.status === "awaiting_approval")) return "attention";
  if (runs.some((run) => IN_FLIGHT.has(run.status))) return "working";
  return latestRun(runs)?.status === "failed" ? "failed" : "idle";
}

/**
 * The selected Bot's status while its stream is live. The record is re-read when a run ends, so
 * between frames the page has the run's own state and should show it now: a park is `attention`, an
 * unfinished run is `working`, a failed run is `failed`, and a finished or stopped one is `idle`.
 * Null means the stream has no run yet and the record's answer stands.
 */
export function liveBotStatus(state: ThreadState): BotStatus | null {
  if (state.runId === null) return null;
  if (state.runStatus === "awaiting_approval" || state.awaiting !== null) return "attention";
  if (runInFlight(state)) return "working";
  if (state.failed !== null || state.runStatus === "failed") return "failed";
  return "idle";
}

/**
 * The row's status when both the Bot's runs and its live stream have an answer.
 *
 * A park in any of the Bot's threads outranks a live frame from the selected one, so another
 * thread's `working` cannot hide a `needs you`. Otherwise the stream is the fresher reading and
 * wins, including a live idle over a record that still says working or failed. With no live word
 * the derivation from the runs stands.
 */
export function mergeBotStatus(derived: BotStatus, live: BotStatus | null): BotStatus {
  if (derived === "attention") return "attention";
  return live ?? derived;
}

/** One thread as the list renders it. */
export interface ThreadRow {
  readonly threadId: string;
  readonly title: string;
  /** The first run's prompt, cut to one line, or the empty string when the thread has none. */
  readonly detail: string;
  readonly runs: number;
  readonly selected: boolean;
}

/**
 * What the sidebar and the thread list show, in the shape the evidence reads. Every field is
 * something a reader can see in the DOM; none of it is a server response echoed back.
 */
export interface ShellFacts {
  /** Whether the page was opened with an operator token, which is what a Bot list needs. */
  readonly operator: boolean;
  readonly bots: Array<{
    botId: string;
    name: string;
    threadCount: number;
    selected: boolean;
    status: BotStatus;
    /** The row's own sub line, read back from the DOM. */
    sub: string;
    /** The row's status dot class list, read back from the DOM. */
    dot: string;
  }>;
  readonly selectedBotId: string | null;
  readonly threads: Array<{ threadId: string; title: string; runs: number; selected: boolean }>;
  readonly selectedThreadId: string | null;
  /** The conversation header's own line, which names the Bot and the thread it is showing. */
  readonly title: string;
}

/** The row label for one Run's prompt: one line, no newlines, bounded. */
export function runDetail(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length <= RUN_LABEL_MAX ? oneLine : `${oneLine.slice(0, RUN_LABEL_MAX - 1)}…`;
}

export function botRows(
  bots: readonly Bot[],
  selectedBotId: string | null,
  statuses: ReadonlyMap<string, BotStatus> = new Map(),
): BotRow[] {
  return bots.map((bot) => {
    const status = statuses.get(bot.botId) ?? "idle";
    return {
      botId: bot.botId,
      name: bot.name,
      threadCount: bot.threadCount,
      selected: bot.botId === selectedBotId,
      status,
      sub: botSubLabel(status, bot.role),
    };
  });
}

/**
 * The threads of one Bot, in creation order. `runs` is the server's own count for the thread, so a
 * row cannot claim a conversation the record does not hold.
 */
export function threadRows(
  threads: readonly Thread[],
  selectedThreadId: string | null,
): ThreadRow[] {
  return threads.map((thread) => ({
    threadId: thread.threadId,
    title: thread.title,
    detail: thread.runs.length === 0 ? "" : runDetail(thread.runs[0]?.prompt ?? ""),
    runs: thread.runs.length,
    selected: thread.threadId === selectedThreadId,
  }));
}

/** The one line the conversation header shows above the transcript. */
export function conversationTitle(botName: string | null, threadTitle: string | null): string {
  if (botName === null) return "";
  return threadTitle === null ? botName : `${botName} · ${threadTitle}`;
}

/** The count a thread row shows, spelled the way a person reads it. */
export function runCountLabel(runs: number): string {
  if (runs === 0) return "no runs";
  return runs === 1 ? "1 run" : `${runs} runs`;
}

/** The count a Bot row shows, spelled the same way for the other list. */
export function threadCountLabel(threads: number): string {
  if (threads === 0) return "no threads";
  return threads === 1 ? "1 thread" : `${threads} threads`;
}
