/**
 * The run loop: one run, executed end to end, as a pure function over injected ports.
 *
 * The loop owns no I/O of its own, so it runs under `bun test` with fake ports and no Docker and no
 * model, and the same code drives a real container and a real provider in production. Three things
 * stay authoritative: `RunStore` is the run's state (the loop only ever reaches it through the named
 * lifecycle operations, so an illegal move has no call site), the `SeqLog` behind `LogPort` is the
 * record (every fact in the order it happened, one seq), and the gate is the only thing that allows
 * a call (the loop never synthesizes a decision).
 *
 * The steps, in order:
 *
 * 1. start and begin: the record exists and is `running` before anything external happens.
 * 2. create the sandbox from the run's spec. A sandbox that will not start fails the run before its
 *    first turn, which is why `queued` has a `failed` transition at all.
 * 3. one provider turn: `turn.started`, the assistant text, then each tool call it asked for.
 * 4. each call goes to the gate. An allow runs it in the sandbox. A denial the control plane can ask
 *    about parks the run for consent; any other denial is fail-closed and the call never runs.
 * 5. a parked call resolves: allow once mints a grant the re-ask consumes, a human denial records a
 *    refusal the re-ask reports as `user_denied`. Both return the run to `running`.
 * 6. the results feed the next turn. A turn with no tool calls finishes the run.
 * 7. the sandbox is destroyed on every path, including failure.
 *
 * A turn ceiling bounds a provider that never settles, and losing the sandbox mid-call pauses the
 * run rather than failing it, because the taxonomy says a lost sandbox is rejoinable.
 */

import type { DenyCode, EventPayloads, EventType } from "@freebot/protocol";
import type { SandboxSpec } from "@freebot/sandbox";
import { failureEntry, type RunFailureCode } from "./run-errors.ts";
import type { RunStatus } from "./run-status.ts";
import type { ParkedApproval, RunStore } from "./run-store.ts";

/** One tool as the provider sees it. Mirrors `packages/providers`' `ToolSpec` structurally. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** One tool call the model asked for. `destructive` marks a call the gate governs. */
export interface ProviderToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly destructive: boolean;
}

/** One model turn: the assistant text it streamed and the calls it asked for. */
export interface ProviderTurn {
  readonly text: readonly string[];
  readonly toolCalls: readonly ProviderToolCall[];
}

/** What a call did, or why it did not run. The same shape the log and the next turn carry. */
export interface ToolOutcome {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly ok: boolean;
  readonly denied: boolean;
  readonly output: string;
  /** Null when the call never ran. Pi reports a duration only for a call that executed. */
  readonly durationMs: number | null;
}

export interface TurnInput {
  readonly turn: number;
  readonly tools: readonly ToolDefinition[];
  /** The previous turn's outcomes, in call order. Empty on the first turn. */
  readonly results: readonly ToolOutcome[];
}

/**
 * The model. A live adapter drives Pi in the sandbox; a replay adapter answers from a committed
 * transcript. Throwing `ProviderTurnError` is how an adapter names a taxonomy code.
 */
export interface ProviderPort {
  next(input: TurnInput): Promise<ProviderTurn>;
}

/**
 * The sandbox for one run. The adapter owns the handle and the tool-to-command table, so the loop
 * never sees a container and never builds a command.
 */
export interface SandboxPort {
  create(spec: SandboxSpec): Promise<void>;
  /** Run one already-approved call and report what it did. */
  execute(call: ProviderToolCall): Promise<ToolOutcome>;
  /**
   * Remove the sandbox. Called on every path, including a `create` that threw, so the adapter must
   * treat "nothing to remove" as a no-op: a run never leaks a container.
   */
  destroy(): Promise<void>;
}

/**
 * The gate's answer. `actionHash` is the canonical hash of this call, which a park binds to so a
 * later grant for different args cannot satisfy it.
 */
export type GateVerdict =
  | { readonly allow: true; readonly actionHash: string }
  | {
      readonly allow: false;
      readonly code: DenyCode;
      readonly detail: string;
      readonly actionHash: string;
    };

/** The Gate 1 seam, as the loop needs it: one verdict per call, and nothing else. */
export interface GatePort {
  decide(call: ProviderToolCall): Promise<GateVerdict>;
}

/**
 * What the human said. An allow carries the grant the answer minted, so the loop can put it in the
 * log. The adapter that answers also records the refusal a deny must leave behind.
 */
export type ApprovalAnswer =
  | {
      readonly decision: "allow";
      readonly grant: {
        readonly grantId: string;
        readonly actionHash: string;
        readonly expiresAt: number;
      };
    }
  | { readonly decision: "deny" }
  | { readonly decision: "timeout" };

/** The consent seam. The adapter renders the card and records the answer in the ledger. */
export interface ApprovalRequest extends ParkedApproval {
  readonly runId: string;
  /** The tool the card is about, and its args: what the ledger must be asked to grant. */
  readonly toolName: string;
  readonly args: unknown;
}

export interface ApprovalPort {
  await(request: ApprovalRequest): Promise<ApprovalAnswer>;
}

/** The record. `seq` is owned here, so the loop never keeps a counter of its own. */
export interface LogPort {
  append<K extends EventType>(type: K, payload: EventPayloads[K]): number;
}

export interface RunLoopPorts {
  readonly sandbox: SandboxPort;
  readonly provider: ProviderPort;
  readonly gate: GatePort;
  readonly approvals: ApprovalPort;
  readonly store: RunStore;
  readonly log: LogPort;
  readonly now?: () => number;
  /** Checked between calls and between turns; true cancels the run. */
  readonly cancelled?: () => boolean;
}

export interface RunLoopRequest {
  readonly runId: string;
  readonly threadId: string;
  readonly botId: string;
  readonly prompt: string;
  readonly sandbox: SandboxSpec;
  readonly tools: readonly ToolDefinition[];
  /** How long a parked call waits. Past it the control plane denies, which fails the run. */
  readonly approvalTtlMs?: number;
  /** Ceiling on provider turns, so a provider that never settles cannot spin forever. */
  readonly maxTurns?: number;
}

export interface RunLoopOutcome {
  readonly runId: string;
  readonly status: RunStatus;
  readonly turns: number;
  readonly calls: number;
  readonly allowed: number;
  readonly denied: number;
  readonly parks: number;
  readonly lastSeq: number;
}

/** A provider failure named in the taxonomy, so the loop settles the run the way the model failed. */
export class ProviderTurnError extends Error {
  readonly code: RunFailureCode;
  readonly detail: string;

  constructor(code: RunFailureCode, detail: string) {
    super(`provider turn failed (${code}): ${detail}`);
    this.name = "ProviderTurnError";
    this.code = code;
    this.detail = detail;
  }
}

const DEFAULT_APPROVAL_TTL_MS = 120_000;
const DEFAULT_MAX_TURNS = 32;

/**
 * The denials a human can be asked about. Anything else stays fail-closed: a ledger denial or an
 * ungoverned tool must never become a card, or the gate stops being a gate.
 */
const PARKABLE_CODES: ReadonlySet<string> = new Set(["no_grant", "grant_mismatch"]);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The spike's rendering: the tool name plus its JSON args. */
export function toolCommand(call: ProviderToolCall): string {
  return `${call.toolName} ${JSON.stringify(call.args)}`;
}

/** Either the call ran, or handling it settled the whole run. */
type CallRun =
  | { readonly kind: "ran"; readonly result: ToolOutcome }
  | { readonly kind: "settled"; readonly status: RunStatus };

export async function runRunLoop(
  ports: RunLoopPorts,
  request: RunLoopRequest,
): Promise<RunLoopOutcome> {
  const { store, log } = ports;
  const now = ports.now ?? Date.now;
  const approvalTtlMs = request.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const maxTurns = request.maxTurns ?? DEFAULT_MAX_TURNS;
  const cancelled = () => ports.cancelled?.() === true;

  let lastSeq = 0;
  const emit = <K extends EventType>(type: K, payload: EventPayloads[K]): void => {
    lastSeq = log.append(type, payload);
  };

  let turns = 0;
  let calls = 0;
  let allowed = 0;
  let denied = 0;
  let parks = 0;

  const outcome = (status: RunStatus): RunLoopOutcome => ({
    runId: request.runId,
    status,
    turns,
    calls,
    allowed,
    denied,
    parks,
    lastSeq,
  });

  /** Settle the run at the status the taxonomy names, emitting the kind its entry carries. */
  const settle = (code: RunFailureCode, detail: string | null): RunStatus => {
    const entry = failureEntry(code);
    if (entry.status === "paused") {
      store.pause(request.runId, { code, detail });
      emit("run.status", { runId: request.runId, status: "paused" });
      return "paused";
    }
    store.fail(request.runId, code, detail);
    switch (entry.event) {
      case null:
        break;
      case "run.failed":
        emit("run.failed", { reason: detail ?? entry.copy });
        break;
      default:
        // No failure code carries another kind today; a new one adds its arm here.
        break;
    }
    emit("run.status", { runId: request.runId, status: entry.status });
    return entry.status;
  };

  const cancel = (): RunStatus => {
    store.cancel(request.runId);
    emit("run.status", { runId: request.runId, status: "cancelled" });
    return "cancelled";
  };

  /** Run an allowed call and put both frames in the log. */
  const allow = async (call: ProviderToolCall): Promise<CallRun> => {
    emit("tool_call.decision", { toolCallId: call.toolCallId, allow: true });
    allowed += 1;
    let result: ToolOutcome;
    try {
      result = await ports.sandbox.execute(call);
    } catch (error) {
      // A sandbox lost mid-run pauses the run: the taxonomy says it can be rejoined.
      return { kind: "settled", status: settle("sandbox_lost_mid_run", messageOf(error)) };
    }
    emit("tool_call.result", {
      toolCallId: result.toolCallId,
      ok: result.ok,
      denied: result.denied,
      output: result.output,
      durationMs: result.durationMs,
    });
    return { kind: "ran", result };
  };

  /** Refuse a call: the decision frame, the result frame, and the outcome the next turn sees. */
  const refuse = (call: ProviderToolCall, code: DenyCode, detail: string): CallRun => {
    emit("tool_call.decision", { toolCallId: call.toolCallId, allow: false, code, detail });
    denied += 1;
    const result: ToolOutcome = {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      ok: false,
      denied: true,
      output: detail,
      durationMs: null,
    };
    emit("tool_call.result", {
      toolCallId: result.toolCallId,
      ok: result.ok,
      denied: result.denied,
      output: result.output,
      durationMs: result.durationMs,
    });
    return { kind: "ran", result };
  };

  /**
   * Park a call the control plane cannot decide, then resolve it. An allow mints the grant the
   * re-ask consumes; a denial leaves the refusal the re-ask reports as `user_denied`. Either way the
   * decision in the log is the gate's, never one the loop invented.
   */
  const park = async (call: ProviderToolCall, actionHash: string): Promise<CallRun> => {
    parks += 1;
    const parked: ApprovalRequest = {
      runId: request.runId,
      approvalId: `${request.runId}:${call.toolCallId}`,
      toolCallId: call.toolCallId,
      command: toolCommand(call),
      actionHash,
      expiresAt: now() + approvalTtlMs,
      requestedAt: now(),
      toolName: call.toolName,
      args: call.args,
    };
    store.park(request.runId, {
      approvalId: parked.approvalId,
      toolCallId: parked.toolCallId,
      command: parked.command,
      actionHash: parked.actionHash,
      expiresAt: parked.expiresAt,
    });
    emit("approval.requested", {
      approvalId: parked.approvalId,
      toolCallId: parked.toolCallId,
      command: parked.command,
      actionHash: parked.actionHash,
      expiresAt: parked.expiresAt,
    });
    emit("run.status", { runId: request.runId, status: "awaiting_approval" });

    const answer = await ports.approvals.await(parked);

    if (answer.decision === "timeout") {
      return {
        kind: "settled",
        status: settle("approval_timeout", `approval ${parked.approvalId} expired unanswered`),
      };
    }

    if (answer.decision === "allow") {
      emit("approval.resolved", {
        approvalId: parked.approvalId,
        decision: "allow",
        grant: {
          grantId: answer.grant.grantId,
          actionHash: answer.grant.actionHash,
          expiresAt: answer.grant.expiresAt,
          state: "issued",
        },
      });
    } else {
      emit("approval.resolved", { approvalId: parked.approvalId, decision: "deny" });
    }

    store.resolveApproval(request.runId, parked.approvalId);
    emit("run.status", { runId: request.runId, status: "running" });

    const again = await ports.gate.decide(call);
    return again.allow ? await allow(call) : refuse(call, again.code, again.detail);
  };

  /** One tool call, from the gate's verdict to the frame that records what happened. */
  const handleCall = async (call: ProviderToolCall): Promise<CallRun> => {
    calls += 1;
    emit("tool_call.requested", {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      command: toolCommand(call),
      destructive: call.destructive,
    });

    const verdict = await ports.gate.decide(call);
    if (verdict.allow) return await allow(call);
    if (!PARKABLE_CODES.has(verdict.code)) {
      return refuse(call, verdict.code, verdict.detail);
    }
    return await park(call, verdict.actionHash);
  };

  // 1. The record exists, and is running, before anything external happens.
  store.start({
    id: request.runId,
    threadId: request.threadId,
    botId: request.botId,
    prompt: request.prompt,
  });
  emit("run.started", { prompt: request.prompt });
  store.begin(request.runId);
  emit("run.status", { runId: request.runId, status: "running" });

  if (cancelled()) return outcome(cancel());

  // 2. The sandbox. A provider that will not start fails a run that never ran a turn, and destroy
  // runs on every path below, create failure included, so a flag never leaks a container.
  try {
    try {
      await ports.sandbox.create(request.sandbox);
    } catch (error) {
      return outcome(settle("sandbox_unavailable", messageOf(error)));
    }

    let results: ToolOutcome[] = [];

    while (true) {
      if (cancelled()) return outcome(cancel());
      if (turns >= maxTurns) {
        return outcome(
          settle(
            "internal_invariant",
            `turn ceiling ${maxTurns} reached without the provider settling`,
          ),
        );
      }

      turns += 1;
      emit("turn.started", { turn: turns });

      let turn: ProviderTurn;
      try {
        turn = await ports.provider.next({ turn: turns, tools: request.tools, results });
      } catch (error) {
        const code = error instanceof ProviderTurnError ? error.code : "internal_invariant";
        return outcome(settle(code, messageOf(error)));
      }

      for (const delta of turn.text) emit("message.text.delta", { text: delta });

      if (turn.toolCalls.length === 0) {
        emit("turn.ended", { turn: turns });
        store.finish(request.runId);
        emit("run.finished", {});
        emit("run.status", { runId: request.runId, status: "done" });
        return outcome("done");
      }

      const turnResults: ToolOutcome[] = [];
      for (const call of turn.toolCalls) {
        if (cancelled()) return outcome(cancel());
        const handled = await handleCall(call);
        if (handled.kind === "settled") return outcome(handled.status);
        turnResults.push(handled.result);
      }

      emit("turn.ended", { turn: turns });
      results = turnResults;
    }
  } finally {
    await ports.sandbox.destroy();
  }
}
