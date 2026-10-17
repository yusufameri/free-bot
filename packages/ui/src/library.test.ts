/**
 * The Library's pure model: the grouping rule, the size wording, and the status line.
 *
 * These are the assertions a person would make about the list: a file written today is under
 * `Today`, an empty group is not drawn at all, and 1536 bytes reads as `1.5 KB`.
 */

import { describe, expect, test } from "bun:test";
import type { FileEntry } from "@freebot/protocol";
import { groupEntries, groupOf, humanSize, statusLine } from "./library.ts";

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 17, 14, 30).getTime();

function entry(over: Partial<FileEntry> & { name: string }): FileEntry {
  return {
    path: over.name,
    kind: "file",
    size: 0,
    mtimeMs: NOW,
    ...over,
  };
}

describe("groupOf", () => {
  test("the calendar day decides, not the elapsed hours", () => {
    expect(groupOf(new Date(2026, 9, 17, 0, 1).getTime(), NOW)).toBe("Today");
    expect(groupOf(new Date(2026, 9, 17, 23, 59).getTime(), NOW)).toBe("Today");
    expect(groupOf(new Date(2026, 9, 16, 23, 59).getTime(), NOW)).toBe("This week");
    expect(groupOf(NOW - 6 * DAY, NOW)).toBe("This week");
    expect(groupOf(NOW - 7 * DAY, NOW)).toBe("Older");
    expect(groupOf(NOW - 30 * DAY, NOW)).toBe("Older");
    expect(groupOf(NOW + DAY, NOW)).toBe("Older");
  });
});

describe("groupEntries", () => {
  test("groups come in order, empty groups are omitted, and the server's order within a group holds", () => {
    const entries = [
      entry({ name: "today-two.txt", mtimeMs: new Date(2026, 9, 17, 9, 0).getTime() }),
      entry({ name: "old.txt", mtimeMs: NOW - 20 * DAY }),
      entry({ name: "today-one.txt", mtimeMs: new Date(2026, 9, 17, 8, 0).getTime() }),
    ];
    expect(
      groupEntries(entries, NOW).map((group) => [group.group, group.entries.map((e) => e.name)]),
    ).toEqual([
      ["Today", ["today-two.txt", "today-one.txt"]],
      ["Older", ["old.txt"]],
    ]);
    expect(groupEntries([entry({ name: "only.txt" })], NOW).map((group) => group.group)).toEqual([
      "Today",
    ]);
    expect(groupEntries([], NOW)).toEqual([]);
  });
});

describe("humanSize", () => {
  test("bytes stay bytes and larger sizes carry one decimal", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(999)).toBe("999 B");
    expect(humanSize(1024)).toBe("1.0 KB");
    expect(humanSize(1536)).toBe("1.5 KB");
    expect(humanSize(1048576)).toBe("1.0 MB");
    expect(humanSize(3_355_443)).toBe("3.2 MB");
  });
});

describe("statusLine", () => {
  test("one line per state, and none once the list is the evidence", () => {
    expect(statusLine("idle", ".", null)).toBe("");
    expect(statusLine("loading", ".", null)).toBe("Reading the workspace...");
    expect(statusLine("empty", ".", null)).toBe(
      "Nothing here yet. Files a run writes to /workspace land in this list.",
    );
    expect(statusLine("loaded", ".", null)).toBe("");
    expect(statusLine("refused", "escape.txt", "symlink_escape")).toBe(
      "Could not list escape.txt: symlink_escape",
    );
  });
});
