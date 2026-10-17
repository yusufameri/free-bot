/**
 * The run loop's behavior, driven through fake ports and the real gate: no Docker, no model, no
 * network. The log port is a real `SeqLog` whose frames are parsed with the real v1 schema, so a
 * frame the loop emits that the protocol would refuse fails the test rather than the stream.
 *
 * The gate is `packages/review`'s real policy over a real ledger, and the approval port mints and
 * records exactly what a live control plane would, so the allow-once path consumes a real grant and
 * the refusal path leaves a real refusal behind.
 */

import { describe, expect, test } from "bun:test";
import {
  type DenyCode,
  type EventPayloads,
  type EventType,
  type Message,
  parseMessage,
} from "@freebot/protocol";
import { canonicalActionHash, createGrantPolicy, GrantStore } from "@freebot/review";
import {
  type ApprovalPort,
  type ApprovalRequest,
  type GatePort,
  type LogPort,
  type ProviderPort,
  type ProviderToolCall,
  type ProviderTurn,
  ProviderTurnError,
  runRunLoop,
  type SandboxPort,
  type ToolOutcome,
  type TurnInput,
} from "./run-loop.ts";
import { RunStore } from "./run-store.ts";
import { SeqLog } from "./seq-log.ts";

const RUN = "run-1";
const AT = 1_700_000_000_000;
const TOOLS = [{ name: "bash", description: "Run a shell command.", parameters: {} }];

function call(toolCallId: string, command: string, destructive = true): ProviderToolCall {
  return { toolCallId, toolName: "bash", args: { command }, destructive };
}

/** What the human says. The port mints the grant, so the script only names the decision. */
type HumanAnswer =
  | { readonly decision: "allow" }
  | { readonly decision: "deny" }
  | { readonly decision: "timeout" };

interface Scenario {
  turns: ProviderTurn[];
  answers?: HumanAnswer[];
  /** Seed the ledger before the run, for the cases that need a grant to exist already. */
  seed?: (grants: GrantStore) => void;
  execute?: (call: ProviderToolCall) => ToolOutcome;
  createThrows?: string;
  providerThrows?: string;
  /** Cancel the run the moment the human answers the first card. */
  cancelOnAnswer?: boolean;
  maxTurns?: number;
}

async function run(scenario: Scenario) {
  const store = new RunStore();
  const seqLog = new SeqLog<Message>();
  const frames: Message[] = [];
  let seq = 0;
  const log: LogPort = {
    append<K extends EventType>(type: K, payload: EventPayloads[K]) {
      const next = seq + 1;
      const parsed = parseMessage({ v: 1, seq: next, ts: AT + next, runId: RUN, type, payload });
      if (seqLog.append(next, parsed) !== "appended") throw new Error(`frame ${next} was refused`);
      seq = next;
      frames.push(parsed);
      store.noteSeq(RUN, next);
      return next;
    },
  };

  const grants = new GrantStore();
  const refusals = new Set<string>();
  scenario.seed?.(grants);
  const policy = createGrantPolicy(grants, { tools: ["bash"], now: () => AT, refusals });
  const gate: GatePort = {
    async decide(candidate) {
      const decision = await policy({
        toolCallId: candidate.toolCallId,
        toolName: candidate.toolName,
        args: candidate.args,
      });
      const actionHash = canonicalActionHash(candidate.toolName, candidate.args);
      if (decision.allow) return { allow: true, actionHash };
      const [code, ...rest] = decision.reason.split(": ");
      return { allow: false, code: code as DenyCode, detail: rest.join(": "), actionHash };
    },
  };

  const executed: ProviderToolCall[] = [];
  let destroys = 0;
  const sandbox: SandboxPort = {
    async create() {
      if (scenario.createThrows !== undefined) throw new Error(scenario.createThrows);
    },
    async execute(candidate) {
      executed.push(candidate);
      if (scenario.execute !== undefined) return scenario.execute(candidate);
      return {
        toolCallId: candidate.toolCallId,
        toolName: candidate.toolName,
        ok: true,
        denied: false,
        output: `<ran ${candidate.toolCallId}>`,
        durationMs: 3,
      };
    },
    async destroy() {
      destroys += 1;
    },
  };

  const turnInputs: TurnInput[] = [];
  const scripted = [...scenario.turns];
  const provider: ProviderPort = {
    async next(input) {
      turnInputs.push(input);
      if (scenario.providerThrows !== undefined) {
        throw new ProviderTurnError("provider_rate_limit", scenario.providerThrows);
      }
      const next = scripted.shift();
      if (next === undefined) throw new Error("the provider ran out of scripted turns");
      return next;
    },
  };

  const asked: ApprovalRequest[] = [];
  const parkedRecords: string[] = [];
  const answers = [...(scenario.answers ?? [])];
  let cancelledFlag = false;
  const approvals: ApprovalPort = {
    async await(request) {
      asked.push(request);
      const record = store.get(RUN);
      parkedRecords.push(`${record?.status} ${record?.approval?.toolCallId ?? "-"}`);
      const answer = answers.shift() ?? { decision: "timeout" };
      if (scenario.cancelOnAnswer === true) cancelledFlag = true;
      if (answer.decision === "allow") {
        const grant = grants.issue({
          toolName: request.toolName,
          args: request.args,
          ttlMs: 60_000,
          now: AT,
        });
        return {
          decision: "allow",
          grant: { grantId: grant.id, actionHash: grant.actionHash, expiresAt: grant.expiresAt },
        };
      }
      if (answer.decision === "deny") {
        refusals.add(request.actionHash);
        return { decision: "deny" };
      }
      return answer;
    },
  };

  const outcome = await runRunLoop(
    {
      sandbox,
      provider,
      gate,
      approvals,
      store,
      log,
      now: () => AT,
      cancelled: () => cancelledFlag,
    },
    {
      runId: RUN,
      threadId: "thread-1",
      botId: "bot-1",
      prompt: "count the files in /workspace",
      sandbox: { name: "u17-test" },
      tools: TOOLS,
      ...(scenario.maxTurns === undefined ? {} : { maxTurns: scenario.maxTurns }),
    },
  );

  return {
    outcome,
    store,
    frames,
    seqLog,
    executed,
    destroys: () => destroys,
    asked,
    parkedRecords,
    grants,
    refusals,
    turnInputs,
  };
}

/** The statuses the run.status frames carry, in order. */
function statusTrail(frames: Message[]): string[] {
  return frames
    .filter((frame) => frame.type === "run.status")
    .map((frame) => (frame.type === "run.status" ? frame.payload.status : ""));
}

/** The decision frame for one call, as a literal object. */
function decisionFor(frames: Message[], toolCallId: string): EventPayloads["tool_call.decision"] {
  const frame = frames.find(
    (candidate) =>
      candidate.type === "tool_call.decision" && candidate.payload.toolCallId === toolCallId,
  );
  if (frame === undefined || frame.type !== "tool_call.decision") {
    throw new Error(`no decision frame for ${toolCallId}`);
  }
  return frame.payload;
}

describe("the loop over fake ports", () => {
  test("one approved call, one refused by the human, and the run finishes", async () => {
    const r = await run({
      turns: [
        {
          text: ["working "],
          toolCalls: [call("call_1", "echo one"), call("call_2", "rm -rf /tmp/x")],
        },
        { text: ["done"], toolCalls: [] },
      ],
      answers: [{ decision: "allow" }, { decision: "deny" }],
    });

    expect(r.outcome).toEqual({
      runId: RUN,
      status: "done",
      turns: 2,
      calls: 2,
      allowed: 1,
      denied: 1,
      parks: 2,
      lastSeq: r.frames.length,
    });
    expect(r.store.get(RUN)?.status).toBe("done");
    expect(r.frames.map((frame) => frame.type)).toEqual([
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
    expect(statusTrail(r.frames)).toEqual([
      "running",
      "awaiting_approval",
      "running",
      "awaiting_approval",
      "running",
      "done",
    ]);
  });

  test("the approved call runs in the sandbox and the refused one never does", async () => {
    const r = await run({
      turns: [
        { text: [], toolCalls: [call("call_1", "echo one"), call("call_2", "rm -rf /tmp/x")] },
        { text: [], toolCalls: [] },
      ],
      answers: [{ decision: "allow" }, { decision: "deny" }],
    });
    expect(r.executed.map((entry) => entry.toolCallId)).toEqual(["call_1"]);
    expect(decisionFor(r.frames, "call_1")).toEqual({ toolCallId: "call_1", allow: true });
    expect(decisionFor(r.frames, "call_2")).toEqual({
      toolCallId: "call_2",
      allow: false,
      code: "user_denied",
      detail: `the user denied action ${canonicalActionHash("bash", { command: "rm -rf /tmp/x" })}`,
    });
    expect(r.grants.grants().map((grant) => `${grant.id} ${grant.consumedBy}`)).toEqual([
      "grant-1 call_1",
    ]);
    expect(r.grants.grants()[0]?.actionHash).toBe(
      canonicalActionHash("bash", { command: "echo one" }),
    );
    expect(r.destroys()).toBe(1);
  });

  test("the park is recorded on the run while the run waits, and cleared when it resolves", async () => {
    const r = await run({
      turns: [
        { text: [], toolCalls: [call("call_1", "echo one")] },
        { text: [], toolCalls: [] },
      ],
      answers: [{ decision: "allow" }],
    });
    expect(r.parkedRecords).toEqual(["awaiting_approval call_1"]);
    expect(r.asked.map((request) => request.command)).toEqual(['bash {"command":"echo one"}']);
    expect(r.asked[0]?.approvalId).toBe(`${RUN}:call_1`);
    expect(r.store.get(RUN)?.approval).toBe(null);
  });

  test("the outcomes of one turn are the input to the next", async () => {
    const r = await run({
      turns: [
        { text: [], toolCalls: [call("call_1", "echo one"), call("call_2", "rm -rf /tmp/x")] },
        { text: [], toolCalls: [] },
      ],
      answers: [{ decision: "allow" }, { decision: "deny" }],
    });
    expect(r.turnInputs.map((input) => input.results)).toEqual([
      [],
      [
        {
          toolCallId: "call_1",
          toolName: "bash",
          ok: true,
          denied: false,
          output: "<ran call_1>",
          durationMs: 3,
        },
        {
          toolCallId: "call_2",
          toolName: "bash",
          ok: false,
          denied: true,
          output: `the user denied action ${canonicalActionHash("bash", { command: "rm -rf /tmp/x" })}`,
          durationMs: null,
        },
      ],
    ]);
  });

  test("a ledger denial is fail-closed: no card is offered and the call never runs", async () => {
    const r = await run({
      seed: (grants) => {
        grants.issue({ toolName: "bash", args: { command: "echo one" }, ttlMs: 60_000, now: AT });
      },
      turns: [
        { text: [], toolCalls: [call("call_1", "echo one"), call("call_2", "echo one")] },
        { text: [], toolCalls: [] },
      ],
    });
    expect(r.asked).toEqual([]);
    expect(r.outcome.parks).toBe(0);
    expect(r.executed.map((entry) => entry.toolCallId)).toEqual(["call_1"]);
    expect(decisionFor(r.frames, "call_2")).toMatchObject({
      code: "grant_consumed",
      detail: "grant grant-1 consumed by call_1",
    });
    expect(r.outcome).toMatchObject({ status: "done", allowed: 1, denied: 1 });
  });

  test("an ungoverned tool is refused without a card, and the refusal names the code", async () => {
    const r = await run({
      turns: [
        {
          text: [],
          toolCalls: [{ toolCallId: "call_1", toolName: "web_fetch", args: {}, destructive: true }],
        },
        { text: [], toolCalls: [] },
      ],
    });
    expect(r.asked).toEqual([]);
    expect(decisionFor(r.frames, "call_1")).toMatchObject({ code: "unknown_tool" });
  });

  test("the run's record, the status trail and the audit all agree on one run", async () => {
    const r = await run({
      turns: [
        { text: ["hi"], toolCalls: [call("call_1", "echo one")] },
        { text: [], toolCalls: [] },
      ],
      answers: [{ decision: "allow" }],
    });
    expect(r.seqLog.audit()).toEqual({
      firstSeq: 1,
      lastSeq: r.frames.length,
      count: r.frames.length,
      gaps: [],
      duplicates: [],
      suppressedAtIngest: [],
      gapEvents: [],
      rejected: 0,
    });
    expect(r.store.get(RUN)?.lastSeenSeq).toBe(r.frames.length);
    const runScoped = r.frames.filter((frame) => "runId" in frame);
    expect(runScoped).toHaveLength(r.frames.length);
    expect(runScoped.every((frame) => frame.runId === RUN && frame.v === 1)).toBe(true);
  });

  test("a sandbox that will not start fails the run before its first turn and leaks nothing", async () => {
    const r = await run({ createThrows: "docker daemon is not running", turns: [] });
    expect(r.outcome).toMatchObject({ status: "failed", turns: 0 });
    expect(r.frames.map((frame) => frame.type)).toEqual([
      "run.started",
      "run.status",
      "run.failed",
      "run.status",
    ]);
    expect(r.frames[2]).toMatchObject({ payload: { reason: "docker daemon is not running" } });
    expect(statusTrail(r.frames)).toEqual(["running", "failed"]);
    expect(r.store.get(RUN)?.error?.code).toBe("sandbox_unavailable");
    expect(r.turnInputs).toEqual([]);
    expect(r.destroys()).toBe(1);
  });

  test("losing the sandbox mid-call pauses the run instead of failing it", async () => {
    const r = await run({
      turns: [{ text: [], toolCalls: [call("call_1", "echo one")] }],
      answers: [{ decision: "allow" }],
      execute: () => {
        throw new Error("the container is gone");
      },
    });
    expect(r.outcome.status).toBe("paused");
    expect(statusTrail(r.frames)).toEqual(["running", "awaiting_approval", "running", "paused"]);
    expect(r.store.get(RUN)?.error?.code).toBe("sandbox_lost_mid_run");
    expect(r.frames.some((frame) => frame.type === "tool_call.result")).toBe(false);
    expect(r.destroys()).toBe(1);
  });

  test("an approval nobody answers fails the run with approval_timeout", async () => {
    const r = await run({
      turns: [{ text: [], toolCalls: [call("call_1", "echo one")] }],
      answers: [{ decision: "timeout" }],
    });
    expect(r.outcome.status).toBe("failed");
    expect(r.store.get(RUN)?.error?.code).toBe("approval_timeout");
    expect(statusTrail(r.frames)).toEqual(["running", "awaiting_approval", "failed"]);
    expect(r.executed).toEqual([]);
  });

  test("a cancel between turns settles the run at cancelled and runs no further turn", async () => {
    const r = await run({
      turns: [
        { text: [], toolCalls: [call("call_1", "echo one")] },
        { text: ["never"], toolCalls: [] },
      ],
      answers: [{ decision: "allow" }],
      cancelOnAnswer: true,
    });
    expect(r.outcome.status).toBe("cancelled");
    expect(statusTrail(r.frames)).toEqual(["running", "awaiting_approval", "running", "cancelled"]);
    expect(r.store.get(RUN)?.status).toBe("cancelled");
    expect(r.turnInputs).toHaveLength(1);
    expect(r.frames.some((frame) => frame.type === "run.finished")).toBe(false);
  });

  test("a provider failure settles the run at the code its taxonomy entry names", async () => {
    const r = await run({ turns: [], providerThrows: "429 from the provider" });
    expect(r.outcome.status).toBe("failed");
    expect(r.store.get(RUN)?.error?.code).toBe("provider_rate_limit");
    expect(r.frames[3]).toMatchObject({
      type: "run.failed",
      payload: { reason: "provider turn failed (provider_rate_limit): 429 from the provider" },
    });
  });

  test("a provider that never settles trips the turn ceiling", async () => {
    const r = await run({
      turns: [
        { text: [], toolCalls: [call("call_1", "echo one")] },
        { text: [], toolCalls: [call("call_2", "echo two")] },
      ],
      answers: [{ decision: "allow" }, { decision: "allow" }],
      maxTurns: 2,
    });
    expect(r.outcome.status).toBe("failed");
    expect(r.store.get(RUN)?.error).toMatchObject({
      code: "internal_invariant",
      detail: "turn ceiling 2 reached without the provider settling",
    });
  });

  test("a turn with no calls finishes the run even when an earlier one was refused", async () => {
    const r = await run({
      turns: [
        { text: [], toolCalls: [call("call_1", "rm -rf /tmp/x")] },
        { text: ["nothing left to do"], toolCalls: [] },
      ],
      answers: [{ decision: "deny" }],
    });
    expect(r.outcome).toMatchObject({ status: "done", turns: 2, allowed: 0, denied: 1, parks: 1 });
    expect(r.refusals.size).toBe(1);
  });
});

describe("the loop's shape", () => {
  test("no port is optional: a run needs a sandbox, a provider, a gate, approvals, a store and a log", async () => {
    const r = await run({
      turns: [{ text: [], toolCalls: [] }],
    });
    expect(r.outcome.status).toBe("done");
    expect(r.destroys()).toBe(1);
  });

  test("text deltas land in the log as they stream, empty ones included", async () => {
    const r = await run({ turns: [{ text: ["a", "", "b"], toolCalls: [] }] });
    expect(
      r.frames.filter((frame) => frame.type === "message.text.delta").map((frame) => frame.payload),
    ).toEqual([{ text: "a" }, { text: "" }, { text: "b" }]);
  });
});
