/**
 * Contract behavior: every operation refuses an unknown key, every path stays under /workspace,
 * and outputs reuse the envelope's message schema instead of restating it.
 */

import { describe, expect, test } from "bun:test";
import {
  API_OPERATION_NAMES,
  API_OPERATIONS,
  type EventMessage,
  GET_EVENTS_MAX_LIMIT,
  getEventsOutput,
  listFilesInput,
  readFileInput,
  startRunInput,
  workspacePathSchema,
} from "./index.ts";

const TS = 1_792_221_550_000;
const HASH = `v1:sha256:${"c".repeat(64)}`;

/** One valid input per operation. The map is typed against the registry, so a new op must add one. */
const validInputs: Record<(typeof API_OPERATION_NAMES)[number], unknown> = {
  start_run: { prompt: "summarize /workspace" },
  cancel_run: { runId: "run-1" },
  get_events: { lastSeq: 0 },
  approve: { approvalId: "ap-1" },
  deny: { approvalId: "ap-1" },
  list_files: {},
  read_file: { path: "notes/todo.md" },
};

describe("operation registry", () => {
  test("every Phase 1 operation is present", () => {
    expect(API_OPERATION_NAMES).toEqual([
      "start_run",
      "cancel_run",
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

  test("an absolute path is refused with the literal reason", () => {
    const result = workspacePathSchema.safeParse("/etc/passwd");
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toBe(
      "path must be relative to /workspace without .. segments",
    );
  });

  test("a .. segment is refused at the head, middle, and tail", () => {
    for (const path of ["../secrets", "a/../../b", "a/.."]) {
      expect(readFileInput.safeParse({ path }).success).toBe(false);
    }
    expect(readFileInput.safeParse({ path: "..foo/bar" }).success).toBe(true);
  });

  test("list_files defaults to the workspace root and an empty path is refused", () => {
    expect(listFilesInput.parse({})).toEqual({ path: "." });
    expect(listFilesInput.safeParse({ path: "" }).success).toBe(false);
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
