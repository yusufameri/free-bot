/**
 * The oRPC surface over the one run authority: `start_run` begins a run that the loop actually
 * executes, and the frames it produces arrive on `subscribe_events`.
 *
 * Nothing here is a promise about the future: every assertion reads the frames a client received on
 * a real WebSocket, after the loop appended them. The sandbox and the provider are fakes, so no
 * Docker and no model take part; the gate, the grant ledger, the run store and the log are real.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderPort, SandboxPort } from "@freebot/core";
import { type apiContract, type EventMessage, safeParseMessage } from "@freebot/protocol";
import { createORPCClient } from "@orpc/client";
import { RPCLink as FetchLink } from "@orpc/client/fetch";
import { RPCLink as WebSocketLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import { type ApiServer, startApiServer } from "./api-server.ts";
import { createRunService, type RunService } from "./run-service.ts";

type ApiClient = ContractRouterClient<typeof apiContract>;

const AT = 1_700_000_000_000;
const TOKEN = "verify-one-run-path";

const running: ApiServer[] = [];
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of running.splice(0)) server.stop();
});

/** A sandbox that records which calls reached it and reports the container's own output. */
function fakeSandbox(ran: string[]): SandboxPort {
  return {
    async create() {},
    async execute(call) {
      ran.push(call.toolCallId);
      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        ok: true,
        denied: false,
        output: "one\n",
        durationMs: 2,
      };
    },
    async destroy() {},
  };
}

/** One governed call on turn 1, then the text that ends the run. */
const provider: ProviderPort = {
  async next(input) {
    if (input.turn === 1) {
      return {
        text: ["checking"],
        toolCalls: [
          {
            toolCallId: "call_1",
            toolName: "bash",
            args: { command: "echo one" },
            destructive: true,
          },
        ],
      };
    }
    return { text: ["done"], toolCalls: [] };
  },
};

interface Harness {
  server: ApiServer;
  service: RunService;
  client: ApiClient;
  received: EventMessage[];
  /** Resolves with the received frame list once `predicate` holds over it. */
  until: (predicate: (frames: EventMessage[]) => boolean, what: string) => Promise<void>;
  stop: () => Promise<void>;
}

async function harness(ran: string[]): Promise<Harness> {
  const service = createRunService({
    sandbox: fakeSandbox(ran),
    provider: () => provider,
    now: () => AT,
  });
  const server = startApiServer({ port: 0, token: TOKEN, service });
  running.push(server);

  const client = createORPCClient<ApiClient>(
    new FetchLink({
      url: `http://127.0.0.1:${server.port}/rpc`,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: `http://127.0.0.1:${server.port}`,
      },
    }),
  );

  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc-ws?token=${TOKEN}`);
  sockets.push(socket);
  const streamed = createORPCClient<ApiClient>(new WebSocketLink({ websocket: socket }));

  const received: EventMessage[] = [];
  const iterator = await streamed.subscribe_events({ lastSeq: 0 });
  const pump = (async () => {
    try {
      for await (const message of iterator) received.push(message);
    } catch {
      // The client's iterator aborts when its socket closes; that is the drain's end.
    }
  })();

  return {
    server,
    service,
    client,
    received,
    until: async (predicate, what) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (predicate(received)) return;
        await Bun.sleep(10);
      }
      throw new Error(
        `timed out waiting for ${what}; saw ${received.map((m) => m.type).join(",")}`,
      );
    },
    stop: async () => {
      socket.close();
      await pump;
    },
  };
}

function types(frames: EventMessage[]): string[] {
  return frames.map((frame) => frame.type);
}

describe("a run started over start_run", () => {
  test("executes the loop, and its frames arrive on subscribe_events", async () => {
    const ran: string[] = [];
    const h = await harness(ran);

    const started = await h.client.start_run({ prompt: "echo one" });
    expect(started.runId).toBe("run-1");

    await h.until((frames) => frames.some((f) => f.type === "approval.requested"), "the park");
    const parked = h.received.find((f) => f.type === "approval.requested");
    if (parked === undefined || parked.type !== "approval.requested") throw new Error("no park");
    expect(parked.payload.command).toBe('bash {"command":"echo one"}');
    // The gate has not issued consent, so the call is parked rather than run.
    expect(ran).toEqual([]);

    expect(h.service.answer(parked.payload.approvalId, "allow")).toBe(true);
    await h.until((frames) => frames.some((f) => f.type === "run.finished"), "the finish");

    expect(types(h.received)).toEqual([
      "run.started",
      "run.status",
      "turn.started",
      "message.text.delta",
      "tool_call.requested",
      "approval.requested",
      "run.status",
      "approval.resolved",
      "run.status",
      "tool_call.decision",
      "tool_call.result",
      "turn.ended",
      "turn.started",
      "message.text.delta",
      "turn.ended",
      "run.finished",
      "run.status",
    ]);
    expect(h.received.every((frame, index) => frame.seq === index + 1)).toBe(true);
    expect(h.received.every((frame) => safeParseMessage(frame).success)).toBe(true);

    // The loop ran the approved call in the sandbox and logged the container's own output.
    expect(ran).toEqual(["call_1"]);
    const result = h.received.find((f) => f.type === "tool_call.result");
    expect(result?.payload).toEqual({
      toolCallId: "call_1",
      ok: true,
      denied: false,
      output: "one\n",
      durationMs: 2,
    });

    expect(await h.client.get_run({ runId: started.runId })).toMatchObject({
      runId: "run-1",
      status: "finished",
      prompt: "echo one",
      startedAt: expect.any(Number),
      endedAt: expect.any(Number),
    });

    await h.stop();
  });

  test("a denied park reaches user_denied and the governed call never runs", async () => {
    const ran: string[] = [];
    const h = await harness(ran);

    await h.client.start_run({ prompt: "echo one" });
    await h.until((frames) => frames.some((f) => f.type === "approval.requested"), "the park");
    const parked = h.received.find((f) => f.type === "approval.requested");
    if (parked === undefined || parked.type !== "approval.requested") throw new Error("no park");

    expect(h.service.answer(parked.payload.approvalId, "deny")).toBe(true);
    await h.until((frames) => frames.some((f) => f.type === "run.finished"), "the finish");

    expect(h.received.find((f) => f.type === "tool_call.decision")?.payload).toEqual({
      toolCallId: "call_1",
      allow: false,
      code: "user_denied",
      detail: expect.stringContaining("the user denied action v1:sha256:"),
    });
    expect(
      h.received.some((f) => f.type === "approval.resolved" && f.payload.decision === "deny"),
    ).toBe(true);

    await h.stop();
  });

  test("cancel_run ends the run the caller just started", async () => {
    const ran: string[] = [];
    // Hold the sandbox's create until the cancel has landed, so the loop's own cancel check is
    // what ends the run rather than a coin flip on which side of it the request arrived.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createRunService({
      sandbox: {
        async create() {
          await held;
        },
        async execute(call) {
          ran.push(call.toolCallId);
          return {
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            ok: true,
            denied: false,
            output: "one\n",
            durationMs: 2,
          };
        },
        async destroy() {},
      },
      provider: () => provider,
      now: () => AT,
    });
    const server = startApiServer({ port: 0, token: TOKEN, service });
    running.push(server);
    const client = createORPCClient<ApiClient>(
      new FetchLink({
        url: `http://127.0.0.1:${server.port}/rpc`,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          origin: `http://127.0.0.1:${server.port}`,
        },
      }),
    );

    const started = await client.start_run({ prompt: "stop me" });
    expect(await client.cancel_run({ runId: started.runId })).toEqual({ runId: "run-1" });
    release();
    await service.idle();

    const run = await client.get_run({ runId: started.runId });
    expect(run.status).toBe("failed");
    expect(ran).toEqual([]);
    expect(
      service.log
        .since(0)
        .some(
          (entry) =>
            entry.frame.type === "run.status" && entry.frame.payload.status === "cancelled",
        ),
    ).toBe(true);
  });
});
