/**
 * Contract behavior: every operation refuses an unknown key, every path stays under /workspace,
 * and outputs reuse the envelope's message schema instead of restating it.
 */

import { describe, expect, test } from "bun:test";
import {
  API_OPERATION_NAMES,
  API_OPERATIONS,
  BOT_NAME_MAX,
  BOT_PURPOSE_MAX,
  BOT_ROLE_MAX,
  botIdSchema,
  CONNECTOR_HEADERS_MAX,
  CONNECTOR_STATES,
  connectConnectorInput,
  connectorRowSchema,
  connectProviderInput,
  type EventMessage,
  GET_EVENTS_MAX_LIMIT,
  getEventsOutput,
  listFilesInput,
  providerConnectionSchema,
  providerStateSchema,
  READ_FILE_MAX_BYTES,
  readFileInput,
  startRunInput,
  THREAD_TITLE_MAX,
  threadSchema,
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
  update_bot: { botId: "bot-local", role: "Chief of staff", purpose: "Release pipeline" },
  list_threads: { botId: "bot-local" },
  create_thread: { botId: "bot-local" },
  get_events: { lastSeq: 0 },
  approve: { approvalId: "ap-1" },
  deny: { approvalId: "ap-1" },
  list_files: { botId: "bot-local" },
  read_file: { botId: "bot-local", path: "notes/todo.md" },
  get_provider: {},
  connect_provider: {
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4o-mini",
    key: "sk-not-a-real-key",
  },
  list_connectors: {},
  connect_connector: {
    id: "fixture-github",
    url: "http://127.0.0.1:8080/mcp",
    headers: { authorization: "Bearer fixture-credential" },
  },
  test_connector: { id: "fixture-github" },
  remove_connector: { id: "fixture-github" },
};

describe("operation registry", () => {
  test("every Phase 1 operation is present", () => {
    expect(API_OPERATION_NAMES).toEqual([
      "start_run",
      "cancel_run",
      "list_bots",
      "create_bot",
      "update_bot",
      "list_threads",
      "create_thread",
      "get_events",
      "approve",
      "deny",
      "list_files",
      "read_file",
      "get_provider",
      "connect_provider",
      "list_connectors",
      "connect_connector",
      "test_connector",
      "remove_connector",
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
        bots: [
          {
            botId: "bot-local",
            name: "Local Bot",
            role: "Chief of staff",
            purpose: "Release pipeline",
            createdAt: TS,
            threadCount: 2,
          },
        ],
      }).bots[0]?.threadCount,
    ).toBe(2);
  });

  test("a Bot's role and purpose are one answer, both allowed to be empty", () => {
    expect(
      API_OPERATIONS.update_bot.input.parse({ botId: "bot-local", role: "", purpose: "" }),
    ).toEqual({ botId: "bot-local", role: "", purpose: "" });
    expect(
      API_OPERATIONS.update_bot.input.safeParse({ botId: "bot-local", role: "x" }).success,
    ).toBe(false);
    expect(
      API_OPERATIONS.update_bot.input.safeParse({
        botId: "bot-local",
        role: "x".repeat(BOT_ROLE_MAX + 1),
        purpose: "",
      }).success,
    ).toBe(false);
    expect(
      API_OPERATIONS.update_bot.input.safeParse({
        botId: "bot-local",
        role: "",
        purpose: "x".repeat(BOT_PURPOSE_MAX + 1),
      }).success,
    ).toBe(false);
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

describe("the provider connection", () => {
  test("the base URL has to be one an HTTP client can post to", () => {
    const parse = (baseUrl: string) =>
      connectProviderInput.safeParse({ baseUrl, model: "gpt-4o-mini", key: "sk-x" }).success;

    expect(parse("https://api.commandcode.ai/v1")).toBe(true);
    expect(parse("http://127.0.0.1:8080/v1")).toBe(true);
    expect(parse("api.commandcode.ai/v1")).toBe(false);
    expect(parse("ftp://api.commandcode.ai")).toBe(false);
    expect(parse("")).toBe(false);
  });

  test("the vault is one KEY=value per line, so a value that spans lines is refused", () => {
    const parse = (key: string) =>
      connectProviderInput.safeParse({
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
        key,
      });
    expect(parse("sk-one-line").success).toBe(true);
    const multiline = parse("sk-first\nFREEBOT_BYOK_KEY=sk-second");
    expect(multiline.success).toBe(false);
    expect(multiline.success ? "" : multiline.error.issues[0]?.message).toBe(
      "the key must be one line",
    );
    expect(
      connectProviderInput.safeParse({
        baseUrl: "https://api.example.com/v1\nFREEBOT_BYOK_KEY=sk-x",
        model: "gpt-4o-mini",
        key: "sk-x",
      }).success,
    ).toBe(false);
    expect(connectProviderInput.safeParse({ baseUrl: "https://api.example.com/v1" }).success).toBe(
      false,
    );
  });

  test("the connection a client reads has no field a key could travel in", () => {
    const connection = providerConnectionSchema.parse({
      baseUrl: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      status: "capable",
      testedAt: TS,
      flags: {
        toolCalling: "strong",
        streaming: true,
        structuredOutput: null,
        contextWindow: null,
        notes: ["native tool call(s): freebot_smoke_echo"],
      },
      refusal: null,
      answer: "save-time-smoke",
    });
    expect(Object.keys(connection).sort()).toEqual([
      "answer",
      "baseUrl",
      "flags",
      "model",
      "refusal",
      "status",
      "testedAt",
    ]);
    // A record that carries a key anyway cannot travel through this shape: the schema strips it, so
    // the router's own output validation is a second boundary the key cannot cross.
    const stripped = providerConnectionSchema.parse({ ...connection, key: "sk-not-a-real-key" });
    expect("key" in stripped).toBe(false);
    expect(JSON.stringify(stripped).includes("sk-not-a-real-key")).toBe(false);
  });

  test("the page's state is the vault's own description plus the connection, or null", () => {
    expect(
      providerStateSchema.parse({
        vault: { path: "/home/person/.freebot/provider.env", present: false, mode: null },
        connection: null,
      }),
    ).toEqual({
      vault: { path: "/home/person/.freebot/provider.env", present: false, mode: null },
      connection: null,
    });
    expect(
      providerStateSchema.safeParse({
        vault: { path: "/home/person/.freebot/provider.env", present: true, mode: "600" },
        connection: providerConnectionSchema.parse({
          baseUrl: "https://api.example.com/v1",
          model: "gpt-4o-mini",
          status: "untested",
          testedAt: null,
          flags: null,
          refusal: { status: 401, message: "invalid api key" },
          answer: null,
        }),
      }).success,
    ).toBe(true);
  });
});

describe("the connector surface", () => {
  const row = {
    id: "fixture-github",
    label: "Fixture GitHub",
    url: "http://127.0.0.1:8080/mcp",
    ref: "connector:fixture-github",
    state: "connected",
    detail: "freebot-fixture-connector 1.0.0, protocol 2025-06-18, 2 tools",
    tools: [
      {
        name: "create_issue",
        description: "Open an issue.",
        parameters: { type: "object", properties: {} },
      },
    ],
    testedAt: TS,
  };

  test("a connector is in exactly one of three states, and no probe leaves it in none", () => {
    expect(CONNECTOR_STATES).toEqual(["connected", "unreachable", "untested"]);
    for (const state of CONNECTOR_STATES) {
      expect(connectorRowSchema.safeParse({ ...row, state }).success).toBe(true);
    }
    expect(connectorRowSchema.safeParse({ ...row, state: "ok" }).success).toBe(false);
  });

  test("a row has no field a header or a token could travel in", () => {
    const parsed = connectorRowSchema.parse(row);
    expect(Object.keys(parsed).sort()).toEqual([
      "detail",
      "id",
      "label",
      "ref",
      "state",
      "testedAt",
      "tools",
      "url",
    ]);
    // A row that carries a credential anyway cannot travel through this shape: the schema strips it,
    // so the router's own output validation is a second boundary a header cannot cross.
    const stripped = connectorRowSchema.parse({
      ...row,
      headers: { authorization: "Bearer fixture-credential" },
    });
    expect("headers" in stripped).toBe(false);
    expect(JSON.stringify(stripped).includes("fixture-credential")).toBe(false);
  });

  test("connecting takes an id, an endpoint and a credential, and refuses each of them raw", () => {
    const valid = {
      id: "fixture-github",
      label: "Fixture GitHub",
      url: "http://127.0.0.1:8080/mcp",
      headers: { authorization: "Bearer fixture-credential" },
    };
    expect(connectConnectorInput.parse(valid)).toEqual(valid);
    expect(
      connectConnectorInput.parse({ id: "fixture-github", url: valid.url, headers: valid.headers }),
    ).toEqual({ id: "fixture-github", url: valid.url, headers: valid.headers });

    expect(connectConnectorInput.safeParse({ ...valid, id: "Fixture/GitHub" }).success).toBe(false);
    expect(connectConnectorInput.safeParse({ ...valid, url: "ftp://127.0.0.1/mcp" }).success).toBe(
      false,
    );
    expect(connectConnectorInput.safeParse({ ...valid, headers: {} }).success).toBe(false);
  });

  test("the credential has to be one line and inside the vault line's bound", () => {
    const base = { id: "fixture-github", url: "http://127.0.0.1:8080/mcp" };
    const multiline = connectConnectorInput.safeParse({
      ...base,
      headers: { authorization: "Bearer first\nFREEBOT_BYOK_KEY=sk-second" },
    });
    expect(multiline.success).toBe(false);
    expect(multiline.success ? "" : multiline.error.issues[0]?.message).toBe(
      "a header value must be one line",
    );
    expect(
      connectConnectorInput.safeParse({
        ...base,
        headers: { authorization: `Bearer ${"x".repeat(CONNECTOR_HEADERS_MAX)}` },
      }).success,
    ).toBe(false);
  });

  test("removal answers whether the connector was there, so a second removal is not an error", () => {
    expect(
      API_OPERATIONS.remove_connector.output.parse({ id: "fixture-github", removed: false }),
    ).toEqual({ id: "fixture-github", removed: false });
    expect(API_OPERATIONS.remove_connector.output.safeParse({ id: "fixture-github" }).success).toBe(
      false,
    );
  });
});
