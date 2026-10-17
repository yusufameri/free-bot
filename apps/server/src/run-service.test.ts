/**
 * The run endpoints, driven through the routes with a fake sandbox and a fake provider: no Docker,
 * no model, no key. The gate, the ledger, the run store and the log are the real ones, so the test
 * proves the endpoint wiring and not a stand-in for it.
 */

import { describe, expect, test } from "bun:test";
import type { ProviderPort, SandboxPort } from "@freebot/core";
import type { Message } from "@freebot/protocol";
import { createRunService, runRoutes } from "./run-service.ts";

const AT = 1_700_000_000_000;

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

async function until(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function page(routes: ReturnType<typeof runRoutes>): Promise<Message[]> {
  const response = await routes.request("/runs/events?last_seq=0");
  const body = (await response.json()) as { messages: Message[] };
  return body.messages;
}

describe("the run endpoints", () => {
  test("a run parks, an approval over the route resolves it, and the run finishes", async () => {
    const ran: string[] = [];
    const service = createRunService({
      sandbox: fakeSandbox(ran),
      provider: () => provider,
      now: () => AT,
    });
    const routes = runRoutes(service);

    const started = await routes.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "echo one" }),
    });
    expect(started.status).toBe(202);
    const { runId } = (await started.json()) as { runId: string };
    expect(runId).toBe("run-1");

    await until(
      async () => (await page(routes)).some((message) => message.type === "approval.requested"),
      "the run to park",
    );
    const parked = (await page(routes)).find((message) => message.type === "approval.requested");
    if (parked === undefined || parked.type !== "approval.requested") {
      throw new Error("no approval.requested frame");
    }
    expect(parked.payload.command).toBe('bash {"command":"echo one"}');
    expect(service.approvals.pending()).toEqual([`${runId}:call_1`]);

    const approved = await routes.request(`/approvals/${runId}:call_1/allow`, { method: "POST" });
    expect(approved.status).toBe(202);
    await service.idle();

    expect(ran).toEqual(["call_1"]);
    expect(service.store.get(runId)?.status).toBe("done");
    expect((await page(routes)).map((message) => message.type)).toEqual([
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
  });

  test("a denial over the route records the refusal, and the re-ask reports user_denied", async () => {
    const service = createRunService({
      sandbox: fakeSandbox([]),
      provider: () => provider,
      now: () => AT,
    });
    const routes = runRoutes(service);
    await routes.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "echo one" }),
    });
    await until(
      async () => (await page(routes)).some((message) => message.type === "approval.requested"),
      "the run to park",
    );

    const denied = await routes.request("/approvals/run-1:call_1/deny", { method: "POST" });
    expect(denied.status).toBe(202);
    await service.idle();

    const decisions = (await page(routes))
      .filter((message) => message.type === "tool_call.decision")
      .map((message) => (message.type === "tool_call.decision" ? message.payload : null));
    expect(decisions).toEqual([
      {
        toolCallId: "call_1",
        allow: false,
        code: "user_denied",
        detail: expect.stringContaining("the user denied action v1:sha256:"),
      },
    ]);
    expect(service.store.get("run-1")?.status).toBe("done");
  });

  test("the boundary refuses a bad command and an unknown approval", async () => {
    const service = createRunService({ sandbox: fakeSandbox([]), provider: () => provider });
    const routes = runRoutes(service);
    const bad = await routes.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "", extra: 1 }),
    });
    expect(bad.status).toBe(400);
    expect(await routes.request("/approvals/nope/allow", { method: "POST" })).toHaveProperty(
      "status",
      404,
    );
    expect(await routes.request("/runs/events?last_seq=0")).toHaveProperty("status", 200);
  });

  test("cancelling a run the service never started is refused, not reported as done", async () => {
    const service = createRunService({ sandbox: fakeSandbox([]), provider: () => provider });
    const routes = runRoutes(service);
    const response = await routes.request("/runs/run-nope/cancel", { method: "POST" });
    expect(await response.json()).toEqual({ runId: "run-nope", cancelled: false });
  });
});
