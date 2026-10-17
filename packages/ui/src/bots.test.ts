/**
 * The shell's model, as the page and the evidence read it: the rows a Bot list and a thread list
 * produce from the contract's own records, and the labels they carry.
 */

import { describe, expect, test } from "bun:test";
import type { Bot, Thread } from "@freebot/protocol";
import {
  botRows,
  conversationTitle,
  runCountLabel,
  runDetail,
  threadCountLabel,
  threadRows,
} from "./bots.ts";

const TS = 1_792_221_550_000;

function bot(botId: string, name: string, threadCount: number): Bot {
  return { botId, name, createdAt: TS, threadCount };
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
      { botId: "bot-local", name: "Local Bot", threadCount: 2, selected: false },
      { botId: "bot-2", name: "Research", threadCount: 0, selected: true },
    ]);
  });

  test("nothing selected marks no row, and no record is a row", () => {
    expect(botRows([], null)).toEqual([]);
    expect(botRows([bot("bot-local", "Local Bot", 0)], null)[0]?.selected).toBe(false);
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
    expect(conversationTitle("Local Bot", "New conversation")).toBe(
      "Local Bot · New conversation",
    );
    expect(conversationTitle("Local Bot", null)).toBe("Local Bot");
    expect(conversationTitle(null, null)).toBe("");
  });
});
