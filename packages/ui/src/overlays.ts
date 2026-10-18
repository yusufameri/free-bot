/**
 * The three overlays' model: what the command palette lists, what the Bot picker offers, and what a
 * file reads back as in the export's modal.
 *
 * `packages/ui/browser/overlays.ts` renders these rows and decides nothing. The groups and their
 * order, the matching rule, the mark, the picker's three-character threshold, the copy and the
 * refusal wording all live here, so the page and the evidence read the same words, the same split
 * every other surface in this package keeps.
 *
 * Every palette row carries the command that choosing it runs. The host performs that command
 * through the same call the matching button makes, which is what makes the palette another door to
 * the same room rather than a lookalike.
 *
 * The sources are the app's own records: the Bots come from `list_bots`, the threads from the
 * selected Bot's thread list, and the pages and actions from the controls the app really ships. The
 * export's `Routines`, `Groups` and `Messages` groups have no source at this head: routines and
 * groups are Phase 3, and a quoted term would need a message search route, which does not exist.
 * `docs/overlays.md` names that gap and `UX.md:330` is why the palette ships without it.
 */

import type { Bot, Thread } from "@freebot/protocol";
import { humanSize, refusedLine } from "./library.ts";

/** The palette's own door, as the export's sidebar control opens it: everything, or Bots alone. */
export type PaletteMode = "all" | "bots";

export type OverlayId = "palette" | "picker" | "modal";

export const PALETTE_MODE_ALL: PaletteMode = "all";
export const PALETTE_MODE_BOTS: PaletteMode = "bots";

/** The two chain: the palette lists them, and the picker is where a chosen Bot is described. */
export const PALETTE_PLACEHOLDER = "Bots, threads and actions";
export const PICKER_PLACEHOLDER = "Find a Bot, or name a new one";
export const CREATE_BOT_LABEL = "Create new Bot";
export const CREATING_LABEL = "Creating…";

/**
 * What a quoted term answers here. The export routes one to its `Messages` group; this app has no
 * message search route, so a quoted term matches nothing and says so rather than pretending.
 */
export const PALETTE_NO_RESULTS = "Nothing matched. Message search is not in this build.";

/** The picker's own threshold, from `UX.md:87`: the search field filters once three characters land. */
export const PICKER_SEARCH_MIN = 3;

/** The export caps its list at forty rows (`freebot-prototype.html:2136`); this one keeps the cap. */
export const PALETTE_MAX_ROWS = 40;

export const PALETTE_GROUPS = ["Bots", "Threads", "Pages", "Actions"] as const;

export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

/** What a row is, which is what its `.sub` shows, in the export's own lowercase vocabulary. */
export type PaletteKind = "bot" | "thread" | "page" | "action";

/**
 * Every command an overlay can run. The host owns the performing: one dispatch table, keyed by
 * `run`, whose arms call the same functions the matching buttons call.
 */
export type OverlayCommand =
  | { readonly run: "select-bot"; readonly botId: string }
  | { readonly run: "create-bot"; readonly name: string }
  | { readonly run: "select-thread"; readonly threadId: string }
  | { readonly run: "show-conversation" }
  | { readonly run: "show-library" }
  | { readonly run: "open-provider" }
  | { readonly run: "new-bot" }
  | { readonly run: "new-thread" };

export interface PaletteRow {
  readonly group: PaletteGroup;
  /** The text the matched term is marked in. */
  readonly label: string;
  readonly kind: PaletteKind;
  readonly command: OverlayCommand;
}

export interface PaletteInput {
  readonly mode: PaletteMode;
  readonly bots: readonly Bot[];
  /** The selected Bot's own threads, which is the record the app holds. */
  readonly threads: readonly Thread[];
}

/** The pages this app really has: the two tabs and the provider page behind the footer's row. */
const PAGES: readonly PaletteRow[] = [
  { group: "Pages", label: "Conversation", kind: "page", command: { run: "show-conversation" } },
  { group: "Pages", label: "Library", kind: "page", command: { run: "show-library" } },
  {
    group: "Pages",
    label: "Connect a provider",
    kind: "page",
    command: { run: "open-provider" },
  },
];

/** The actions this app really offers, each of which is one of its own controls. */
const ACTIONS: readonly PaletteRow[] = [
  { group: "Actions", label: "New Bot", kind: "action", command: { run: "new-bot" } },
  { group: "Actions", label: "New thread", kind: "action", command: { run: "new-thread" } },
];

/** The rows the palette holds before a query touches them, in the order `UX.md:330` ranks them. */
export function paletteRows(input: PaletteInput): PaletteRow[] {
  const bots: PaletteRow[] = input.bots.map((bot) => ({
    group: "Bots",
    label: bot.name,
    kind: "bot",
    command: { run: "select-bot", botId: bot.botId },
  }));
  // The export's `bots` mode is the Bots group alone (`freebot-prototype.html:2125`).
  if (input.mode === PALETTE_MODE_BOTS) return bots;
  const threads: PaletteRow[] = input.threads.map((thread) => ({
    group: "Threads",
    label: thread.title,
    kind: "thread",
    command: { run: "select-thread", threadId: thread.threadId },
  }));
  return [...bots, ...threads, ...PAGES, ...ACTIONS];
}

/**
 * The rows a query leaves, capped the way the export caps them.
 *
 * A quoted term answers nothing, because the search it would run belongs to a route this app does
 * not have. Every other query matches a label or a group by substring, case-insensitively, which is
 * the export's own rule (`freebot-prototype.html:2135`).
 */
export function matchPalette(rows: readonly PaletteRow[], query: string): PaletteRow[] {
  const trimmed = query.trim();
  if (trimmed.startsWith('"')) return [];
  const needle = trimmed.toLowerCase();
  const matched =
    needle === ""
      ? [...rows]
      : rows.filter(
          (row) =>
            row.label.toLowerCase().includes(needle) || row.group.toLowerCase().includes(needle),
        );
  return matched.slice(0, PALETTE_MAX_ROWS);
}

export interface MarkedLabel {
  readonly before: string;
  readonly hit: string;
  readonly after: string;
}

/**
 * One label split around the term a query matched, so the browser draws the mark and the evidence
 * reads the hit. A label that does not carry the term splits with an empty hit.
 */
export function markLabel(label: string, query: string): MarkedLabel {
  const needle = query.trim().toLowerCase();
  if (needle === "") return { before: label, hit: "", after: "" };
  const at = label.toLowerCase().indexOf(needle);
  if (at < 0) return { before: label, hit: "", after: "" };
  return {
    before: label.slice(0, at),
    hit: label.slice(at, at + needle.length),
    after: label.slice(at + needle.length),
  };
}

export type PickerRow =
  | { readonly kind: "create"; readonly label: string; readonly name: string }
  | {
      readonly kind: "bot";
      readonly label: string;
      readonly sub: string;
      readonly botId: string;
    };

export interface PickerModel {
  readonly rows: readonly PickerRow[];
  /** The line the export shows while a name is too short to search Bots with. */
  readonly hint: string | null;
}

/**
 * The picker's rows: the create row the export puts first, then the Bots.
 *
 * Typing a name turns the create row into `Create "name" Bot`, and the field filters once three
 * characters land (`UX.md:87`). Below that it says how many more it needs. The name a create carries
 * is the raw query: the shell's own `createBot` trims it and answers `New Bot` for an empty one, so
 * this surface and the sidebar's own control mint the same name for the same input.
 */
export function pickerRows(input: {
  readonly bots: readonly Bot[];
  readonly query: string;
}): PickerModel {
  const { query } = input;
  const rows: PickerRow[] = [
    {
      kind: "create",
      label: query === "" ? CREATE_BOT_LABEL : `Create “${query}” Bot`,
      name: query,
    },
  ];
  const searched =
    query.length >= PICKER_SEARCH_MIN
      ? input.bots.filter((bot) => bot.name.toLowerCase().includes(query.toLowerCase()))
      : input.bots;
  for (const bot of searched) {
    rows.push({
      kind: "bot",
      label: bot.name,
      sub: bot.role === "" ? "Bot" : bot.role,
      botId: bot.botId,
    });
  }
  const missing = PICKER_SEARCH_MIN - query.length;
  const hint =
    query.length > 0 && missing > 0
      ? `Type ${missing} more character${missing === 1 ? "" : "s"} to search Bots.`
      : null;
  return { rows, hint };
}

/** One file as the modal reads it: the title, the path line, the size tag and the bytes. */
export interface OverlayFile {
  readonly title: string;
  readonly path: string;
  readonly size: string;
  readonly text: string | null;
  readonly refusal: string | null;
}

/** The last segment of a workspace path, which is the file's name. */
export function fileName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/**
 * The refusal name a failed call carries, or `unknown` for a failure that names nothing. A refusal
 * is whatever the server called it on the wire, so a surface branches on the reason rather than on
 * an error string.
 */
export function refusalCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "unknown";
}

/** A file the read answered with: the export's title, its path line and its size tag. */
export function fileFromRead(read: {
  readonly path: string;
  readonly text: string;
  readonly size: number;
}): OverlayFile {
  return {
    title: fileName(read.path),
    path: read.path,
    size: humanSize(read.size),
    text: read.text,
    refusal: null,
  };
}

/** A file the read refused: the named reason and no bytes, which is what the surface shows. */
export function fileFromRefusal(path: string, code: string): OverlayFile {
  return {
    title: fileName(path),
    path,
    size: "",
    text: null,
    refusal: refusedLine(path, code),
  };
}
