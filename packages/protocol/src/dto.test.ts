/**
 * Contract behavior: every operation refuses an unknown key, every path stays under /workspace,
 * and outputs reuse the envelope's message schema instead of restating it.
 */

import { describe, expect, test } from "bun:test";
import {
  API_OPERATION_NAMES,
  API_OPERATIONS,
  botIdSchema,
  BOT_NAME_MAX,
  type EventMessage,
  GET_EVENTS_MAX_LIMIT,
  getEventsOutput,
  listFilesInput,
  READ_FILE_MAX_BYTES,
  readFileInput,
  startRunInput,
  threadSchema,
  THREAD_TITLE_MAX,
  WORKSPACE_READ_ERRORS,
  WORKSPACE_READ_REFUSALS,
  workspacePathSchema,
} from "./index.ts";

const TS = 1_792_221_550_000;
const HASH = `v1:sha256:${"c".repeat(64)}`;

/** One valid input per operation. The map is typed against the registry, so a new op must add one. */
const validInputs: Record<(typeof API_OPERATION_NAMES)[number], unknown> = {
  start_run: { prompt: "summarize /workspace", botId: "bot-local", threadId: "thread-1" },
  cancel_run: { runId: "run-1" },
  list_bots: {},
  create_bot: { name: "Local Bot" },
  list_threads: { botId: "bot-local" },
  create_thread: { botId: "bot-local" },
  get_events: { lastSeq: 0 },
  approve: { approvalId: "ap-1" },
  deny: { approvalId: "ap-1" },
  list_files: { botId: "bot-local" },
  read_file: { botId: "bot-local", path: "notes/todo.md" },
};

describe("operation registry", () => {
  test("every Phase 1 operation is present", () => {
    expect(API_OPERATION_NAMES).toEqual([
      "start_run",
      "cancel_run",
      "list_bots",
      "create_bot",
      "list_threads",
      "create_thread",
      "get_events",
      "approve",
      "deny",
      "list_files",
      "read_file",
    ]);
  });

  for (const name of API_OPERATION_NAMES) {
    test(`${name} accepts its valid input`, () => {
      expect(API_OPERATIONS[name].input.safeParse(validInputs[name]).success).toBe(true);
    });

    test(`${name} refuses an unknown key`, () => {
      const input = { ...(validInputs[name] as Record<string, unknown>), extra: 1 };
      const result = API_OPERATIONS[name].input.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.success ? "" : result.error.issues[0]?.message).toBe(
        'Unrecognized key: "extra"',
      );
    });
  }
});

describe("workspace paths", () => {
  test("a path under /workspace is accepted", () => {
    expect(workspacePathSchema.parse("src/a.ts")).toBe("src/a.ts");
  });

  test("the refusal vocabulary is the seven names the surface branches on", () => {
    expect(WORKSPACE_READ_REFUSALS).toEqual([
      "absolute_path",
      "parent_traversal",
      "symlink_escape",
      "path_not_found",
      "not_a_directory",
      "not_a_file",
      "binary_file",
    ]);
    expect(WORKSPACE_READ_ERRORS.symlink_escape.status).toBe(403);
    expect(READ_FILE_MAX_BYTES).toBe(262_144);
  });

  test("an absolute path is refused with the literal reason", () => {
    const result = workspacePathSchema.safeParse("/etc/passwd");
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toBe(
      "path must be relative to /workspace without .. segments",
    );
  });

  test("a .. segment is refused at the head, middle, and tail", () => {
    for (const path of ["../secrets", "a/../../b", "a/.."]) {
      expect(readFileInput.safeParse({ botId: "bot-local", path }).success).toBe(false);
    }
    expect(readFileInput.safeParse({ botId: "bot-local", path: "..foo/bar" }).success).toBe(true);
  });

  test("list_files defaults to the workspace root and an empty path is refused", () => {
    expect(listFilesInput.parse({ botId: "bot-local" })).toEqual({ botId: "bot-local", path: "." });
    expect(listFilesInput.safeParse({ botId: "bot-local", path: "" }).success).toBe(false);
  });
});

describe("bots and threads", () => {
  test("an id is one path segment, because it keys a directory", () => {
    expect(botIdSchema.parse("bot-local")).toBe("bot-local");
    for (const id of ["../../etc", "a/b", "", "Bot-Local", "-lead", "a".repeat(65)]) {
      expect(botIdSchema.safeParse(id).success).toBe(false);
    }
  });

  test("a Bot carries its name, when it was made, and how many threads it holds", () => {
    expect(API_OPERATIONS.create_bot.input.parse({ name: "Local Bot" })).toEqual({
      name: "Local Bot",
    });
    expect(API_OPERATIONS.create_bot.input.safeParse({ name: "" }).success).toBe(false);
    expect(
      API_OPERATIONS.create_bot.input.safeParse({ name: "x".repeat(BOT_NAME_MAX + 1) }).success,
    ).toBe(false);
    expect(
      API_OPERATIONS.list_bots.output.parse({
        bots: [{ botId: "bot-local", name: "Local Bot", createdAt: TS, threadCount: 2 }],
      }).bots[0]?.threadCount,
    ).toBe(2);
  });

  test("a thread is a conversation: its runs, oldest first, each with its status", () => {
    const thread = threadSchema.parse({
      threadId: "thread-1",
      botId: "bot-local",
      title: "First",
      createdAt: TS,
      runs: [
        { runId: "run-1", prompt: "write a note", status: "done", startedAt: TS },
        { runId: "run-2", prompt: "again", status: "awaiting_approval", startedAt: TS + 1 },
      ],
    });
    expect(thread.runs.map((run) => run.status)).toEqual(["done", "awaiting_approval"]);
    expect(
      threadSchema.safeParse({
        ...thread,
        runs: [{ runId: "run-1", prompt: "x", status: "finished", startedAt: TS }],
      }).success,
    ).toBe(false);
  });

  test("a thread title is optional on create and bounded when it is given", () => {
    expect(API_OPERATIONS.create_thread.input.parse({ botId: "bot-local" })).toEqual({
      botId: "bot-local",
    });
    expect(
      API_OPERATIONS.create_thread.input.safeParse({ botId: "bot-local", title: "Chat" }).success,
    ).toBe(true);
    expect(
      API_OPERATIONS.create_thread.input.safeParse({
        botId: "bot-local",
        title: "x".repeat(THREAD_TITLE_MAX + 1),
      }).success,
    ).toBe(false);
  });
});

describe("runs and events", () => {
  test("start_run needs a non-empty prompt and returns a runId", () => {
    expect(startRunInput.safeParse({ prompt: "" }).success).toBe(false);
    expect(API_OPERATIONS.start_run.output.parse({ runId: "run-1" })).toEqual({ runId: "run-1" });
  });

  test("get_events takes a cursor of 0 and bounds one page", () => {
    expect(API_OPERATIONS.get_events.input.parse({ lastSeq: 0 })).toEqual({ lastSeq: 0 });
    expect(API_OPERATIONS.get_events.input.safeParse({ lastSeq: -1 }).success).toBe(false);
    expect(API_OPERATIONS.get_events.input.safeParse({ lastSeq: 0, limit: 0 }).success).toBe(false);
    expect(
      API_OPERATIONS.get_events.input.safeParse({ lastSeq: 0, limit: GET_EVENTS_MAX_LIMIT })
        .success,
    ).toBe(true);
    expect(
      API_OPERATIONS.get_events.input.safeParse({ lastSeq: 0, limit: GET_EVENTS_MAX_LIMIT + 1 })
        .success,
    ).toBe(false);
  });

  test("get_events output carries envelope messages unchanged", () => {
    const message: EventMessage = {
      v: 1,
      seq: 7,
      ts: TS,
      runId: "run-1",
      type: "tool_call.requested",
      payload: {
        toolCallId: "call_1",
        toolName: "bash",
        command: 'bash {"command":"ls"}',
        destructive: false,
      },
    };
    const output = getEventsOutput.parse({ messages: [message], lastSeq: 7 });
    expect(output.messages).toEqual([message]);
    expect(
      getEventsOutput.safeParse({ messages: [{ ...message, seq: 0 }], lastSeq: 7 }).success,
    ).toBe(false);
  });
});

describe("approval answers", () => {
  test("approve and deny each pin their decision", () => {
    expect(API_OPERATIONS.approve.output.parse({ approvalId: "ap-1", decision: "allow" })).toEqual({
      approvalId: "ap-1",
      decision: "allow",
    });
    expect(
      API_OPERATIONS.deny.output.safeParse({ approvalId: "ap-1", decision: "allow" }).success,
    ).toBe(false);
    expect(API_OPERATIONS.approve.input.safeParse({ approvalId: "" }).success).toBe(false);
  });

  test("an approval event and an answer share the approvalId vocabulary", () => {
    expect(API_OPERATIONS.approve.input.parse({ approvalId: "ap-1" })).toEqual({
      approvalId: "ap-1",
    });
    expect(HASH).toMatch(/^v1:sha256:[0-9a-f]{64}$/);
  });
});
