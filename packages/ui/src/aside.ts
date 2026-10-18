/**
 * The details pane's model: the tabs the product names, the geometry a drag produces, and the rows
 * each tab shows.
 *
 * `packages/ui/browser/aside.ts` renders this and decides nothing, the same split `bots.ts` and
 * `library.ts` keep for their surfaces. Every row here is derived from a record the app really
 * holds (a Bot, a thread and its runs, the provider connection, the stream's own transcript) or
 * from a file the workspace really contains. Nothing is a placeholder, and a fact the app has no
 * source for is named in `docs/DESIGN-CONTRACT.md` rather than approximated here.
 *
 * The width numbers settle a contract question. The export declares `--aside-w: 384px` at
 * `freebot-prototype.html:37` and then overwrites it at boot with `S.asideW || 372` (`:2248`, seed
 * at `:829`), so the export renders 372 while declaring 384. The app keeps the declared token and
 * renders the export's own default, which is why `ASIDE_DEFAULT_W` is 372 and the token table still
 * says 384.
 */

import type {
  Bot,
  FileEntry,
  ProviderConnection,
  RunStatusValue,
  RunSummary,
  Thread,
} from "@freebot/protocol";
import { groupEntries, LIBRARY_EMPTY, LIBRARY_PINNED_PATH, refusedLine } from "./library.ts";
import type { StreamConnection } from "./notices.ts";
import { statusLabel, type ThreadState } from "./thread.ts";

/**
 * The pane's five tabs are `UX.md:33`'s own: `Computer`, `Details`, `Tasks`, `Library`, `Media`.
 * `Media` needs a capture source this app does not have, so it is not in this list and the delta is
 * recorded in `docs/DESIGN-CONTRACT.md`. The export's `ASIDE_TABS` also carries `Memory` and
 * `Routines`, whose subject matter is Phase 3 and has no data here either.
 */
export const ASIDE_TABS = [
  { id: "computer", label: "Computer" },
  { id: "details", label: "Details" },
  { id: "tasks", label: "Tasks" },
  { id: "library", label: "Library" },
] as const;

export type AsideTab = (typeof ASIDE_TABS)[number]["id"];

/** The export's initial tab (`freebot-prototype.html:829` seeds `tab: 'computer'`). */
export const ASIDE_DEFAULT_TAB: AsideTab = "computer";

/** The drag's clamps, from the export's own pointer handler (`freebot-prototype.html:2252`). */
export const ASIDE_MIN_W = 280;
export const ASIDE_MAX_W = 560;

/** What the export renders on a fresh profile: `S.asideW || 372`, seeded 372 at `:829`. */
export const ASIDE_DEFAULT_W = 372;

/** Where the declared width and the rendered width come from, in the export. */
export const ASIDE_WIDTH_SOURCE =
  "freebot-prototype.html:37 declares --aside-w: 384px and :2248 overwrites it with S.asideW || 372, seeded 372 at :829";

/** The strip's close button, whose label the export writes at `freebot-prototype.html:1188`. */
export const ASIDE_COLLAPSE_LABEL = "Collapse the pane";

/** The header control's label, and what it says it does in each state. */
export const ASIDE_TOGGLE_TEXT = "Details";
export const ASIDE_REOPEN_LABEL = "Show details pane";

/** Where the pane keeps its width, its collapse state and its tab between reloads. */
export const ASIDE_STORAGE_KEY = "freebot.aside";

/** The browser's width for one pointer position: the distance from the right edge, clamped. */
export function asideWidthFromPointer(innerWidth: number, clientX: number): number {
  return clampAsideWidth(innerWidth - clientX);
}

export function clampAsideWidth(width: number): number {
  return Math.min(ASIDE_MAX_W, Math.max(ASIDE_MIN_W, Math.round(width)));
}

/** What the pane restores from storage: a width it will use, and the two states it remembers. */
export interface AsideStored {
  readonly width: number;
  readonly collapsed: boolean;
  readonly tab: AsideTab;
}

/** Parse what a page stored, refusing anything a page would not have written. */
export function readAsideStored(raw: string | null): AsideStored {
  const fallback: AsideStored = {
    width: ASIDE_DEFAULT_W,
    collapsed: false,
    tab: ASIDE_DEFAULT_TAB,
  };
  if (raw === null) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (parsed === null || typeof parsed !== "object") return fallback;
  const record = parsed as { width?: unknown; collapsed?: unknown; tab?: unknown };
  const tab = ASIDE_TABS.find((entry) => entry.id === record.tab)?.id ?? fallback.tab;
  const width =
    typeof record.width === "number" && Number.isFinite(record.width)
      ? clampAsideWidth(record.width)
      : fallback.width;
  return { width, collapsed: record.collapsed === true, tab };
}

/** One tool call as the pane reports it: the literal command and what the sandbox did with it. */
export interface AsideCommand {
  readonly toolName: string;
  readonly command: string;
  readonly status: string;
  readonly decision: string | null;
  readonly output: string | null;
}

/** The live half of the pane: what the stream is doing right now. */
export interface AsideLive {
  readonly connection: StreamConnection;
  readonly runId: string | null;
  readonly runStatus: RunStatusValue | null;
  readonly lastSeq: number;
  readonly frames: number;
  /** The newest tool call in the transcript, or null when the transcript holds none. */
  readonly command: AsideCommand | null;
}

/**
 * The live run's status word, out of the thread model's own state. The words are the wire's seven
 * (`packages/protocol/src/events.ts:79`); the model applies `run.status` without storing it, so the
 * pane reads the three transitions it does keep — a failure, an end, a parked approval — and calls
 * the rest running. `null` means no run is on screen.
 */
export function liveRunStatus(state: ThreadState): RunStatusValue | null {
  if (state.failed !== null) return "failed";
  if (state.done) return "done";
  if (state.runId === null) return null;
  if (state.awaiting !== null) return "awaiting_approval";
  return "running";
}

/**
 * The newest tool call in the transcript, which is the command the Computer tab shows. It is the
 * transcript's own card, so the pane and the message it came from read the same words.
 */
export function latestCommand(state: ThreadState): AsideCommand | null {
  const card = state.toolCards.at(-1);
  if (card === undefined) return null;
  const decision = card.decision;
  return {
    toolName: card.toolName,
    command: card.command,
    status: statusLabel(card),
    decision:
      decision === null ? null : decision.allow ? "allow" : `deny (${decision.code ?? "unknown"})`,
    output: card.output,
  };
}

/** The Library tab's own read state, kept by the browser module that made the call. */
export interface AsideFiles {
  readonly path: string;
  readonly entries: readonly FileEntry[];
  readonly state: "idle" | "loading" | "empty" | "loaded" | "refused";
  readonly refusal: string | null;
}

export interface AsideInput {
  readonly bot: Bot | null;
  readonly thread: Thread | null;
  readonly connection: ProviderConnection | null;
  readonly live: AsideLive;
  readonly files: AsideFiles;
  readonly now: number;
}

export interface AsideRow {
  readonly label: string;
  readonly value: string;
}

export interface AsideRun {
  readonly runId: string;
  readonly status: string;
  readonly prompt: string;
  readonly startedAt: number;
}

/** One block of a tab's body. The browser module turns these into nodes and decides nothing. */
export type AsideBlock =
  | { readonly kind: "cap"; readonly text: string }
  | { readonly kind: "rows"; readonly rows: readonly AsideRow[] }
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "command"; readonly command: AsideCommand }
  | { readonly kind: "run"; readonly run: AsideRun; readonly live: boolean }
  | {
      readonly kind: "files";
      readonly path: string;
      readonly pinned: boolean;
      readonly groups: readonly {
        readonly group: string;
        readonly entries: readonly {
          readonly name: string;
          readonly path: string;
          readonly kind: "file" | "dir";
          readonly size: number;
        }[];
      }[];
    };

/** What a field the record leaves empty reads as. The field is empty because nobody filled it in. */
export const ASIDE_NOT_SET = "not set";

export const ASIDE_NO_BOT = "No Bot is selected.";
export const ASIDE_NO_THREAD = "No thread is selected.";
export const ASIDE_NO_RUNS = "No runs in this thread yet.";
export const ASIDE_NO_RUN = "No run has used this computer yet.";
export const ASIDE_NO_COMMAND = "No command yet. A run's tool calls land here.";

/** The app's own rule about the computer, which is the one real difference from the export's pane. */
export const ASIDE_SANDBOX_NOTE =
  "This app gives a run its own container and removes it when the run ends, so the computer is the run's, not the Bot's.";

/** What the export's computer pane carries and this app has no source for. */
export const ASIDE_COMPUTER_GAP =
  "Idle auto-stop, egress, snapshots and the recovery controls are the export's per-Bot container; a per-run sandbox reports none of them.";

/** The export's own desktop strip, minus the machine name it invents; the run is the machine here. */
export const ASIDE_COMMAND_CAP = "The last command it ran";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A timestamp as one short cell: the clock for today, the calendar for anything older. */
export function stampOf(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** The newest run of a thread, which is the run the pane's Tasks tab is about. */
export function latestRun(thread: Thread | null): RunSummary | null {
  if (thread === null || thread.runs.length === 0) return null;
  return [...thread.runs].sort((left, right) => right.startedAt - left.startedAt)[0] ?? null;
}

/** The endpoint's host, which is the part of a base URL worth one cell. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function detailsBlocks(input: AsideInput): AsideBlock[] {
  const { bot, thread, connection, now } = input;
  if (bot === null) return [{ kind: "note", text: ASIDE_NO_BOT }];
  const blocks: AsideBlock[] = [
    { kind: "cap", text: "This Bot" },
    {
      kind: "rows",
      rows: [
        { label: "Name", value: bot.name },
        { label: "Label", value: bot.role === "" ? ASIDE_NOT_SET : bot.role },
        { label: "Purpose", value: bot.purpose === "" ? ASIDE_NOT_SET : bot.purpose },
        { label: "Threads", value: String(bot.threadCount) },
        { label: "Created", value: stampOf(bot.createdAt, now) },
      ],
    },
  ];
  blocks.push({ kind: "cap", text: "This thread" });
  blocks.push(
    thread === null
      ? { kind: "note", text: ASIDE_NO_THREAD }
      : {
          kind: "rows",
          rows: [
            { label: "Title", value: thread.title },
            { label: "Runs", value: String(thread.runs.length) },
            { label: "Created", value: stampOf(thread.createdAt, now) },
          ],
        },
  );
  blocks.push({ kind: "cap", text: "The model" });
  blocks.push({
    kind: "rows",
    rows:
      connection === null
        ? [
            { label: "Connection", value: "none" },
            { label: "Model", value: ASIDE_NOT_SET },
          ]
        : [
            { label: "Model", value: connection.model },
            { label: "Connection", value: connection.status },
            {
              label: "Tested",
              value: connection.testedAt === null ? "never" : stampOf(connection.testedAt, now),
            },
            { label: "Endpoint", value: hostOf(connection.baseUrl) },
          ],
  });
  return blocks;
}

function tasksBlocks(input: AsideInput): AsideBlock[] {
  const { thread, live, now } = input;
  if (thread === null) return [{ kind: "note", text: ASIDE_NO_THREAD }];
  const record = latestRun(thread);
  const shown: AsideRun | null =
    live.runId === null
      ? record === null
        ? null
        : {
            runId: record.runId,
            status: record.status,
            prompt: record.prompt,
            startedAt: record.startedAt,
          }
      : {
          runId: live.runId,
          status: live.runStatus ?? "running",
          prompt: record !== null && record.runId === live.runId ? record.prompt : "",
          startedAt: record !== null && record.runId === live.runId ? record.startedAt : now,
        };
  if (shown === null) return [{ kind: "note", text: ASIDE_NO_RUNS }];
  const blocks: AsideBlock[] = [
    { kind: "cap", text: "Latest run" },
    { kind: "run", run: shown, live: live.runId === shown.runId },
    { kind: "cap", text: "Recent runs" },
    {
      kind: "rows",
      rows: [...thread.runs]
        .sort((left, right) => right.startedAt - left.startedAt)
        .map((run) => ({
          label: `${run.runId} · ${stampOf(run.startedAt, now)}`,
          value: run.status,
        })),
    },
  ];
  return blocks;
}

function computerBlocks(input: AsideInput): AsideBlock[] {
  const { thread, live, now } = input;
  const record = latestRun(thread);
  const run: AsideRun | null =
    live.runId === null
      ? record === null
        ? null
        : {
            runId: record.runId,
            status: record.status,
            prompt: record.prompt,
            startedAt: record.startedAt,
          }
      : {
          runId: live.runId,
          status: live.runStatus ?? "running",
          prompt: record !== null && record.runId === live.runId ? record.prompt : "",
          startedAt: record !== null && record.runId === live.runId ? record.startedAt : now,
        };
  const blocks: AsideBlock[] = [{ kind: "cap", text: "This run's computer" }];
  if (run === null) {
    blocks.push({ kind: "note", text: ASIDE_NO_RUN });
  } else {
    blocks.push({
      kind: "rows",
      rows: [
        { label: "Run", value: run.runId },
        { label: "Status", value: run.status },
        { label: "Started", value: stampOf(run.startedAt, now) },
      ],
    });
  }
  blocks.push({ kind: "note", text: ASIDE_SANDBOX_NOTE });
  blocks.push({
    kind: "rows",
    rows: [
      { label: "Stream", value: live.connection },
      { label: "Frames", value: String(live.frames) },
      { label: "Seq", value: String(live.lastSeq) },
    ],
  });
  blocks.push({ kind: "cap", text: ASIDE_COMMAND_CAP });
  blocks.push(
    live.command === null
      ? { kind: "note", text: ASIDE_NO_COMMAND }
      : { kind: "command", command: live.command },
  );
  blocks.push({ kind: "note", text: ASIDE_COMPUTER_GAP });
  return blocks;
}

function libraryBlocks(input: AsideInput): AsideBlock[] {
  const { files, now } = input;
  if (files.state === "refused") {
    return [
      { kind: "note", text: refusedLine(files.path, files.refusal ?? "unknown") },
      { kind: "files", path: files.path, pinned: files.path === LIBRARY_PINNED_PATH, groups: [] },
    ];
  }
  if (files.state === "empty") {
    return [
      { kind: "note", text: LIBRARY_EMPTY },
      { kind: "files", path: files.path, pinned: files.path === LIBRARY_PINNED_PATH, groups: [] },
    ];
  }
  const groups = groupEntries(files.entries, now).map((group) => ({
    group: group.group as string,
    entries: group.entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      kind: entry.kind,
      size: entry.size,
    })),
  }));
  return [{ kind: "files", path: files.path, pinned: files.path === LIBRARY_PINNED_PATH, groups }];
}

/** One tab's body, in the order the pane renders it. */
export function asideBlocks(tab: AsideTab, input: AsideInput): AsideBlock[] {
  switch (tab) {
    case "computer":
      return computerBlocks(input);
    case "details":
      return detailsBlocks(input);
    case "tasks":
      return tasksBlocks(input);
    case "library":
      return libraryBlocks(input);
  }
}

/** What the pane shows, in the shape the evidence reads: every field is on the rendered page. */
export interface AsideFacts {
  readonly tab: AsideTab;
  readonly tabs: Array<{ id: string; label: string; selected: boolean; ariaSelected: string }>;
  readonly collapsed: boolean;
  /** The width the grid is using, read from the computed `--aside-w` of the root element. */
  readonly width: number;
  /** The width the page stored, which survives a reload. */
  readonly storedWidth: number;
  readonly storedTab: AsideTab;
  readonly bodyText: string;
  readonly caps: string[];
  readonly rows: Array<{ label: string; value: string }>;
  readonly commands: string[];
  /** The rows the Library tab rendered, as a reader reads them: name, path and kind. */
  readonly files: Array<{ readonly name: string; readonly path: string; readonly kind: string }>;
  readonly notes: string[];
}
