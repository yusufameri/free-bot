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

import type { Bot, Thread } from "@freebot/protocol";

export const BOTS_EMPTY = "No Bots yet.";

export const THREADS_EMPTY = "No threads in this Bot yet.";

export const NEW_BOT_PLACEHOLDER = "Name a new Bot";

export const NEW_BOT_LABEL = "New Bot";

export const NEW_THREAD_LABEL = "New thread";

/** The label every thread carries until a person renames it. Mirrors the server's default title. */
export const NEW_THREAD_TITLE = "New conversation";

/** How long a run's prompt is allowed to be when the thread list uses it as the row's detail. */
export const RUN_LABEL_MAX = 60;

/** One Bot as the sidebar renders it. */
export interface BotRow {
  readonly botId: string;
  readonly name: string;
  /** How many threads the Bot holds, which is what the row shows beside the name. */
  readonly threadCount: number;
  readonly selected: boolean;
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
  readonly bots: Array<{ botId: string; name: string; threadCount: number; selected: boolean }>;
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

export function botRows(bots: readonly Bot[], selectedBotId: string | null): BotRow[] {
  return bots.map((bot) => ({
    botId: bot.botId,
    name: bot.name,
    threadCount: bot.threadCount,
    selected: bot.botId === selectedBotId,
  }));
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
