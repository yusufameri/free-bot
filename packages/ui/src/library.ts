/**
 * The Library's model: the Bot's workspace as a person reads it.
 *
 * `packages/ui/browser/library.ts` renders this and decides nothing; the grouping rule, the size
 * wording and the copy live here so the page and the evidence read the same words. The entries are
 * the contract's own `fileEntrySchema` rows, so a change to the wire shape is a compile error here
 * rather than a rendered blank.
 *
 * Grouping is the calendar, not elapsed time: a file written at 23:59 is under `Today` at 00:01 the
 * next morning, which is what a person who just watched a run finish expects.
 */

import type { FileEntry } from "@freebot/protocol";

export const LIBRARY_GROUPS = ["Today", "This week", "Older"] as const;

export type LibraryGroup = (typeof LIBRARY_GROUPS)[number];

export const LIBRARY_TITLE = "Library";

export const LIBRARY_NOTE =
  "This Bot's workspace is kept on this computer, so the files here outlive the run that wrote them. Every run mounts it at /workspace.";

export const LIBRARY_EMPTY =
  "Nothing here yet. Files a run writes to /workspace land in this list.";

export const LIBRARY_LOADING = "Reading the workspace...";

export const LIBRARY_PINNED_LABEL = "/workspace";

export const LIBRARY_PINNED_NOTE = "every run mounts it here";

/** The path the pinned row lists: the workspace root, spelled the way the contract spells it. */
export const LIBRARY_PINNED_PATH = ".";

export type LibraryState = "idle" | "loading" | "empty" | "loaded" | "refused";

export type LibraryTab = "conversation" | "library";

export interface LibraryEntryView {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly size: number;
  readonly group: LibraryGroup;
}

/**
 * What the page shows, in the shape the evidence reads. Every field is something a reader can see
 * in the DOM; none of it is a server response echoed back.
 */
export interface LibraryFacts {
  readonly tab: LibraryTab;
  readonly state: LibraryState;
  /** The pinned row's rendered label. */
  readonly pinnedLabel: string;
  /** The pinned row's own path, which is the workspace root. */
  readonly pinnedPath: string;
  /** The path the listing on screen was asked for. */
  readonly listPath: string;
  /** The group headings rendered, in order. */
  readonly groups: string[];
  readonly entries: LibraryEntryView[];
  /** The path the file view shows, or null when no read has happened. */
  readonly openPath: string | null;
  /** The exact text the file view shows, or null when none was read. */
  readonly openText: string | null;
  /** The refusal name of the last refused read or listing. */
  readonly refused: string | null;
  /** The one line the panel's status shows. */
  readonly message: string;
}

const DAY_MS = 86_400_000;

/** Midnight local time at the start of the day `at` falls in. */
function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * The group one timestamp falls in. `Today` is the same local day as `now`, `This week` is within
 * seven days of today's midnight, and a timestamp in the future reads as `Older` rather than being
 * clamped into today.
 */
export function groupOf(mtimeMs: number, now: number): LibraryGroup {
  const today = startOfDay(now);
  if (mtimeMs >= today && mtimeMs < today + DAY_MS) return "Today";
  if (mtimeMs < today && mtimeMs >= today - 6 * DAY_MS) return "This week";
  return "Older";
}

/** The entries in the order the list renders them: one group per group, empty groups omitted. */
export function groupEntries(
  entries: readonly FileEntry[],
  now: number,
): Array<{ group: LibraryGroup; entries: LibraryEntryView[] }> {
  return LIBRARY_GROUPS.flatMap((group) => {
    const inGroup = entries
      .filter((entry) => groupOf(entry.mtimeMs, now) === group)
      .map((entry) => ({
        name: entry.name,
        path: entry.path,
        kind: entry.kind,
        size: entry.size,
        group,
      }));
    return inGroup.length === 0 ? [] : [{ group, entries: inGroup }];
  });
}

/** A byte count as a person reads it. Powers of 1024, one decimal above a kilobyte. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** What the status line says for a state, so the panel and the facts hook never disagree. */
export function statusLine(state: LibraryState, path: string, code: string | null): string {
  switch (state) {
    case "loading":
      return LIBRARY_LOADING;
    case "empty":
      return LIBRARY_EMPTY;
    case "refused":
      return `Could not list ${path}: ${code ?? "unknown"}`;
    default:
      return "";
  }
}

/** The refusal sentence the file view shows, or the empty string when nothing was refused. */
export function refusedLine(path: string, code: string): string {
  return `Could not open ${path}: ${code}`;
}
