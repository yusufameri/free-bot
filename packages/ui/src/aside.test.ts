/**
 * The pane's pure model: the drag geometry, what a stored width reads back as, and the rows each tab
 * derives from a real record.
 *
 * Every assertion is a literal a person could check on the page: the exported default is 372, a
 * drag to a position 440px from the right edge is 440, the Details tab shows the Bot record's own
 * name, and the Computer tab shows the command the transcript really holds.
 */

import { describe, expect, test } from "bun:test";
import type { Bot, FileEntry, ProviderConnection, Thread } from "@freebot/protocol";
import {
  ASIDE_DEFAULT_TAB,
  ASIDE_DEFAULT_W,
  ASIDE_MAX_W,
  ASIDE_MIN_W,
  ASIDE_NOT_SET,
  type AsideInput,
  asideBlocks,
  asideWidthFromPointer,
  clampAsideWidth,
  latestCommand,
  latestRun,
  liveRunStatus,
  readAsideStored,
  stampOf,
} from "./aside.ts";
import { initialState, type ThreadState, type ToolCard } from "./thread.ts";

const NOW = new Date(2026, 9, 17, 14, 30).getTime();

const BOT: Bot = {
  botId: "bot-local",
  name: "Frame Check",
  role: "Chief of staff",
  purpose: "Release pipeline",
  createdAt: NOW,
  threadCount: 2,
};

const THREAD: Thread = {
  threadId: "new-conversation",
  botId: "bot-local",
  title: "New conversation",
  createdAt: NOW,
  runs: [
    { runId: "run-1", prompt: "first", status: "done", startedAt: NOW - 60_000 },
    { runId: "run-2", prompt: "second", status: "failed", startedAt: NOW },
  ],
};

const CONNECTION: ProviderConnection = {
  baseUrl: "http://127.0.0.1:9/contract-not-a-provider",
  model: "design-contract-placeholder",
  status: "untested",
  testedAt: null,
  flags: null,
  refusal: null,
  answer: null,
};

function input(over: Partial<AsideInput> = {}): AsideInput {
  return {
    bot: BOT,
    thread: THREAD,
    connection: CONNECTION,
    live: {
      connection: "connected",
      runId: null,
      runStatus: null,
      lastSeq: 0,
      frames: 0,
      command: null,
    },
    files: { path: ".", entries: [], state: "idle", refusal: null },
    now: NOW,
    ...over,
  };
}

function labels(blocks: ReturnType<typeof asideBlocks>): string[] {
  return blocks.flatMap((block) => (block.kind === "rows" ? block.rows.map((r) => r.label) : []));
}

function values(blocks: ReturnType<typeof asideBlocks>): string[] {
  return blocks.flatMap((block) => (block.kind === "rows" ? block.rows.map((r) => r.value) : []));
}

describe("the pane's width", () => {
  test("a drag sets the width from the right edge and clamps it", () => {
    expect(asideWidthFromPointer(1440, 1000)).toBe(440);
    expect(asideWidthFromPointer(1440, 100)).toBe(ASIDE_MAX_W);
    expect(asideWidthFromPointer(1440, 1400)).toBe(ASIDE_MIN_W);
  });

  test("the clamp holds exactly the export's two numbers", () => {
    expect(ASIDE_MIN_W).toBe(280);
    expect(ASIDE_MAX_W).toBe(560);
    expect(clampAsideWidth(279.6)).toBe(280);
    expect(clampAsideWidth(560.4)).toBe(560);
    expect(clampAsideWidth(372)).toBe(372);
  });

  test("a fresh page renders the export's own default, not the declared token", () => {
    expect(ASIDE_DEFAULT_W).toBe(372);
    expect(readAsideStored(null)).toEqual({ width: 372, collapsed: false, tab: "computer" });
    expect(ASIDE_DEFAULT_TAB).toBe("computer");
  });

  test("what a page stored is read back, and nonsense falls back to the default", () => {
    expect(readAsideStored('{"width":440,"collapsed":true,"tab":"tasks"}')).toEqual({
      width: 440,
      collapsed: true,
      tab: "tasks",
    });
    expect(readAsideStored("not json")).toEqual({ width: 372, collapsed: false, tab: "computer" });
    expect(readAsideStored('{"width":900,"tab":"memory"}')).toEqual({
      width: 560,
      collapsed: false,
      tab: "computer",
    });
  });
});

describe("stampOf", () => {
  test("today reads as a clock, an older day reads as a date", () => {
    expect(stampOf(new Date(2026, 9, 17, 9, 5).getTime(), NOW)).toBe("09:05");
    expect(stampOf(new Date(2026, 9, 16, 23, 59).getTime(), NOW)).toBe("Oct 16");
  });
});

describe("latestRun", () => {
  test("the newest run by its own start time", () => {
    expect(latestRun(THREAD)?.runId).toBe("run-2");
    expect(latestRun({ ...THREAD, runs: [] })).toBeNull();
    expect(latestRun(null)).toBeNull();
  });
});

describe("the live half", () => {
  const idle = initialState();

  test("a run's status word comes from the model's own transitions", () => {
    expect(liveRunStatus(idle)).toBeNull();
    expect(liveRunStatus({ ...idle, runId: "run-3" })).toBe("running");
    expect(liveRunStatus({ ...idle, runId: "run-3", awaiting: "appr-1" })).toBe(
      "awaiting_approval",
    );
    expect(liveRunStatus({ ...idle, runId: "run-3", done: true })).toBe("done");
    expect(liveRunStatus({ ...idle, runId: "run-3", failed: "provider refused" })).toBe("failed");
  });

  test("the newest tool card is the command the pane shows", () => {
    expect(latestCommand(idle)).toBeNull();
    const card: ToolCard = {
      toolCallId: "call-1",
      toolName: "bash",
      command: 'bash -lc "ls -la"',
      destructive: false,
      status: "running",
      output: null,
      durationMs: null,
      decision: null,
      callSeq: 1,
      resultSeq: null,
    };
    const withCard: ThreadState = { ...idle, toolCards: [card] };
    expect(latestCommand(withCard)).toEqual({
      toolName: "bash",
      command: 'bash -lc "ls -la"',
      status: "running",
      decision: null,
      output: null,
    });
    expect(
      latestCommand({
        ...withCard,
        toolCards: [
          {
            ...card,
            status: "denied",
            decision: { allow: false, code: "outside_workspace", detail: null },
          },
        ],
      })?.decision,
    ).toBe("deny (outside_workspace)");
  });
});

describe("the Details tab", () => {
  test("the rows are the Bot record's own fields", () => {
    const blocks = asideBlocks("details", input());
    expect(labels(blocks)).toEqual([
      "Name",
      "Label",
      "Purpose",
      "Threads",
      "Created",
      "Title",
      "Runs",
      "Created",
      "Model",
      "Connection",
      "Tested",
      "Endpoint",
    ]);
    expect(values(blocks).slice(0, 5)).toEqual([
      "Frame Check",
      "Chief of staff",
      "Release pipeline",
      "2",
      "14:30",
    ]);
    expect(values(blocks).slice(8)).toEqual([
      "design-contract-placeholder",
      "untested",
      "never",
      "127.0.0.1:9",
    ]);
  });

  test("an empty field says so rather than reading as a value", () => {
    const blocks = asideBlocks("details", input({ bot: { ...BOT, role: "", purpose: "" } }));
    expect(values(blocks).slice(0, 3)).toEqual(["Frame Check", ASIDE_NOT_SET, ASIDE_NOT_SET]);
  });

  test("no Bot and no connection are both named", () => {
    const blocks = asideBlocks("details", input({ bot: null }));
    expect(blocks).toEqual([{ kind: "note", text: "No Bot is selected." }]);
    expect(values(asideBlocks("details", input({ connection: null }))).slice(8)).toEqual([
      "none",
      ASIDE_NOT_SET,
    ]);
  });
});

describe("the Tasks tab", () => {
  test("the latest run and the thread's own run list", () => {
    const blocks = asideBlocks("tasks", input());
    const run = blocks.find((block) => block.kind === "run");
    expect(run).toEqual({
      kind: "run",
      live: false,
      run: { runId: "run-2", status: "failed", prompt: "second", startedAt: NOW },
    });
    expect(labels(blocks)).toEqual(["run-2 · 14:30", "run-1 · 14:29"]);
    expect(values(blocks)).toEqual(["failed", "done"]);
  });

  test("a live run names itself, and an empty thread says it is empty", () => {
    const blocks = asideBlocks(
      "tasks",
      input({ live: { ...input().live, runId: "run-3", runStatus: "awaiting_approval" } }),
    );
    const run = blocks.find((block) => block.kind === "run");
    expect(
      run !== undefined && run.kind === "run" ? [run.run.runId, run.run.status, run.live] : [],
    ).toEqual(["run-3", "awaiting_approval", true]);
    expect(asideBlocks("tasks", input({ thread: { ...THREAD, runs: [] } }))).toEqual([
      { kind: "note", text: "No runs in this thread yet." },
    ]);
  });
});

describe("the Computer tab", () => {
  test("the run, the stream and the command the transcript holds", () => {
    const blocks = asideBlocks(
      "computer",
      input({
        live: {
          connection: "reconnecting",
          runId: "run-2",
          runStatus: "running",
          lastSeq: 41,
          frames: 12,
          command: {
            toolName: "bash",
            command: "bash ls -la",
            status: "done",
            decision: "allow",
            output: "total 0",
          },
        },
      }),
    );
    expect(values(blocks)).toContain("run-2");
    expect(values(blocks)).toContain("reconnecting");
    expect(values(blocks)).toContain("41");
    expect(blocks).toContainEqual({
      kind: "command",
      command: {
        toolName: "bash",
        command: "bash ls -la",
        status: "done",
        decision: "allow",
        output: "total 0",
      },
    });
    expect(JSON.stringify(blocks)).not.toContain("pre-run-4f3a");
    expect(JSON.stringify(blocks)).not.toContain("waiting on approval");
  });

  test("no run and no command are both stated", () => {
    const blocks = asideBlocks("computer", input({ thread: { ...THREAD, runs: [] } }));
    const notes = blocks.flatMap((block) => (block.kind === "note" ? [block.text] : []));
    expect(notes[0]).toBe("No run has used this computer yet.");
    expect(notes).toContain("No command yet. A run's tool calls land here.");
  });
});

describe("the Library tab", () => {
  const entries: FileEntry[] = [
    { name: "note.txt", path: "note.txt", kind: "file", size: 26, mtimeMs: NOW },
    {
      name: "old",
      path: "old",
      kind: "dir",
      size: 0,
      mtimeMs: new Date(2026, 8, 2, 10, 0).getTime(),
    },
  ];

  test("the real entries, grouped by their own timestamps", () => {
    const blocks = asideBlocks(
      "library",
      input({ files: { path: ".", entries, state: "loaded", refusal: null } }),
    );
    const files = blocks.find((block) => block.kind === "files");
    expect(files).toEqual({
      kind: "files",
      path: ".",
      pinned: true,
      groups: [
        {
          group: "Today",
          entries: [{ name: "note.txt", path: "note.txt", kind: "file", size: 26 }],
        },
        {
          group: "Older",
          entries: [{ name: "old", path: "old", kind: "dir", size: 0 }],
        },
      ],
    });
  });

  test("an empty workspace and a refusal both read as the Library's own lines", () => {
    const empty = asideBlocks(
      "library",
      input({ files: { path: ".", entries: [], state: "empty", refusal: null } }),
    );
    expect(empty[0]).toEqual({
      kind: "note",
      text: "Nothing here yet. Files a run writes to /workspace land in this list.",
    });
    const refused = asideBlocks(
      "library",
      input({
        files: { path: "../x", entries: [], state: "refused", refusal: "parent_traversal" },
      }),
    );
    expect(refused[0]).toEqual({
      kind: "note",
      text: "Could not open ../x: parent_traversal",
    });
    expect(refused[1]).toEqual({ kind: "files", path: "../x", pinned: false, groups: [] });
  });
});
