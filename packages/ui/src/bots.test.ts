/**
 * The shell's model, as the page and the evidence read it: the rows a Bot list and a thread list
 * produce from the contract's own records, and the labels they carry.
 */

import { describe, expect, test } from "bun:test";
import type { Bot, RunSummary, Thread } from "@freebot/protocol";
import {
  BOT_STATUSES,
  botDotClass,
  botRows,
  botSubLabel,
  conversationTitle,
  deriveBotStatus,
  latestRun,
  liveBotStatus,
  mergeBotStatus,
  runCountLabel,
  runDetail,
  threadCountLabel,
  threadRows,
} from "./bots.ts";
import { applyMessage, initialState } from "./thread.ts";

const TS = 1_792_221_550_000;

function bot(botId: string, name: string, threadCount: number): Bot {
  return { botId, name, role: "", purpose: "", createdAt: TS, threadCount };
}

function thread(threadId: string, prompts: readonly string[]): Thread {
  return {
    threadId,
    botId: "bot-local",
    title: "New conversation",
    createdAt: TS,
    runs: prompts.map((prompt, index) => ({
      runId: `run-${index + 1}`,
      prompt,
      status: "done" as const,
      startedAt: TS + index,
    })),
  };
}

describe("the Bot list", () => {
  test("one row per record, in the order the server listed them, with the selected one marked", () => {
    const rows = botRows([bot("bot-local", "Local Bot", 2), bot("bot-2", "Research", 0)], "bot-2");

    expect(rows).toEqual([
      {
        botId: "bot-local",
        name: "Local Bot",
        threadCount: 2,
        selected: false,
        status: "idle",
        sub: "",
      },
      {
        botId: "bot-2",
        name: "Research",
        threadCount: 0,
        selected: true,
        status: "idle",
        sub: "",
      },
    ]);
  });

  test("nothing selected marks no row, and no record is a row", () => {
    expect(botRows([], null)).toEqual([]);
    expect(botRows([bot("bot-local", "Local Bot", 0)], null)[0]?.selected).toBe(false);
  });

  test("a row's status and sub line come from the derivation, not from the record's count", () => {
    const rows = botRows(
      [bot("bot-local", "Atlas", 1), bot("bot-2", "Ledger", 1)],
      "bot-local",
      new Map([
        ["bot-local", "attention" as const],
        ["bot-2", "working" as const],
      ]),
    );

    expect(rows.map((row) => [row.status, row.sub])).toEqual([
      ["attention", "needs you"],
      ["working", "working"],
    ]);
  });
});

describe("the Bot's status, from its runs", () => {
  function run(runId: string, status: RunSummary["status"], startedAt: number): RunSummary {
    return { runId, prompt: "do the thing", status, startedAt };
  }

  test("a parked approval outranks every other run, including one still moving", () => {
    expect(
      deriveBotStatus([run("run-1", "awaiting_approval", TS), run("run-2", "running", TS + 1)]),
    ).toBe("attention");
  });

  test("a run in flight is working, and paused is still in flight", () => {
    expect(deriveBotStatus([run("run-1", "running", TS)])).toBe("working");
    expect(deriveBotStatus([run("run-1", "queued", TS)])).toBe("working");
    expect(deriveBotStatus([run("run-1", "paused", TS)])).toBe("working");
  });

  test("only the newest run can fail the Bot", () => {
    expect(deriveBotStatus([run("run-1", "failed", TS)])).toBe("failed");
    expect(deriveBotStatus([run("run-1", "failed", TS), run("run-2", "done", TS + 1)])).toBe(
      "idle",
    );
    expect(deriveBotStatus([run("run-1", "done", TS), run("run-2", "failed", TS + 1)])).toBe(
      "failed",
    );
  });

  test("no run, and a run that ended done or cancelled, are both idle", () => {
    expect(deriveBotStatus([])).toBe("idle");
    expect(deriveBotStatus([run("run-1", "done", TS)])).toBe("idle");
    expect(deriveBotStatus([run("run-1", "cancelled", TS)])).toBe("idle");
  });

  test("the newest run is the greatest start time, whatever order the list arrived in", () => {
    expect(latestRun([run("run-2", "done", TS + 2), run("run-1", "failed", TS)])?.runId).toBe(
      "run-2",
    );
    expect(latestRun([])).toBeNull();
  });

  test("the live stream's status wins while the record is still being written", () => {
    let state = applyMessage(initialState(), {
      v: 1,
      seq: 1,
      ts: TS,
      runId: "run-1",
      type: "run.started",
      payload: { prompt: "do it" },
    });
    expect(liveBotStatus(state)).toBe("working");

    state = applyMessage(state, {
      v: 1,
      seq: 2,
      ts: TS + 1,
      runId: "run-1",
      type: "run.status",
      payload: { runId: "run-1", status: "awaiting_approval" },
    });
    expect(liveBotStatus(state)).toBe("attention");

    state = applyMessage(state, {
      v: 1,
      seq: 3,
      ts: TS + 2,
      runId: "run-1",
      type: "run.failed",
      payload: { reason: "FreeBot stopped while this run was in flight." },
    });
    expect(liveBotStatus(state)).toBe("failed");

    const finished = applyMessage(
      applyMessage(state, {
        v: 1,
        seq: 4,
        ts: TS + 3,
        runId: "run-1",
        type: "run.started",
        payload: { prompt: "again" },
      }),
      {
        v: 1,
        seq: 5,
        ts: TS + 4,
        runId: "run-1",
        type: "run.finished",
        payload: {},
      },
    );
    expect(liveBotStatus(finished)).toBe("idle");
    expect(liveBotStatus(initialState())).toBeNull();
  });

  test("each status has the export's dot and its own sub line", () => {
    expect(
      BOT_STATUSES.map((status) => [
        status,
        botDotClass(status),
        botSubLabel(status, "Chief of staff"),
      ]),
    ).toEqual([
      ["working", "pulse", "working"],
      ["attention", "dot on", "needs you"],
      ["failed", "dot ring", "failed"],
      ["idle", "dot", "Chief"],
    ]);
  });
});

describe("the row's status when the record and the stream disagree", () => {
  test("a park in any thread outranks a live run that is still working", () => {
    expect(mergeBotStatus("attention", "working")).toBe("attention");
  });

  test("a live idle wins over a record that still says working", () => {
    expect(mergeBotStatus("working", "idle")).toBe("idle");
  });

  test("a live idle wins over a record that still says failed", () => {
    expect(mergeBotStatus("failed", "idle")).toBe("idle");
  });

  test("with no live word the record's derivation stands", () => {
    expect(mergeBotStatus("attention", null)).toBe("attention");
    expect(mergeBotStatus("failed", null)).toBe("failed");
  });
});

describe("the thread list", () => {
  test("a row carries the thread's own counts and the first thing it was asked", () => {
    const rows = threadRows(
      [thread("thread-1", ["write a note", "again"]), thread("thread-2", [])],
      "thread-1",
    );

    expect(rows).toEqual([
      {
        threadId: "thread-1",
        title: "New conversation",
        detail: "write a note",
        runs: 2,
        selected: true,
      },
      { threadId: "thread-2", title: "New conversation", detail: "", runs: 0, selected: false },
    ]);
  });

  test("a prompt that carries newlines is one line in the row", () => {
    expect(runDetail("write this\nand that")).toBe("write this and that");
    expect(runDetail("  spaced  ")).toBe("spaced");
  });

  test("a long prompt is cut to one row's worth, and the cut is visible", () => {
    const long = "x".repeat(200);
    const detail = runDetail(long);
    expect(detail.length).toBe(60);
    expect(detail.endsWith("…")).toBe(true);
  });
});

describe("the counts and the header", () => {
  test("a count is spelled the way a person reads it", () => {
    expect([runCountLabel(0), runCountLabel(1), runCountLabel(4)]).toEqual([
      "no runs",
      "1 run",
      "4 runs",
    ]);
    expect([threadCountLabel(0), threadCountLabel(1), threadCountLabel(3)]).toEqual([
      "no threads",
      "1 thread",
      "3 threads",
    ]);
  });

  test("the header names the Bot, and the thread when one is open", () => {
    expect(conversationTitle("Local Bot", "New conversation")).toBe("Local Bot · New conversation");
    expect(conversationTitle("Local Bot", null)).toBe("Local Bot");
    expect(conversationTitle(null, null)).toBe("");
  });
});
