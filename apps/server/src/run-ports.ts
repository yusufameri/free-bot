/**
 * The wiring: the landed parts, adapted into the loop's ports.
 *
 * Nothing here makes a decision the packages already own. The sandbox port is the landed
 * `DockerAdapter` (label-scoped to this unit, so its cleanup can never touch a container another
 * unit created), the gate port is the landed `packages/review` policy over a landed ledger, and the
 * log port appends into the landed `SeqLog` the stream already serves.
 *
 * One table holds the run's tools. The tool list the model is offered, the runner that executes an
 * approved call, and the list the gate governs all derive from it, so a tool can never be offered
 * without a runner or run without being governed.
 */

import type {
  ApprovalAnswer,
  ApprovalPort,
  ApprovalRequest,
  GatePort,
  LogPort,
  ProviderToolCall,
  SandboxPort,
  SeqLog,
  ToolDefinition,
  ToolOutcome,
} from "@freebot/core";
import type { DenyCode, EventMessage, EventPayloads, EventType } from "@freebot/protocol";
import { canonicalActionHash, createGrantPolicy, type GrantStore } from "@freebot/review";
import type { SandboxHandle, SandboxProvider, SandboxSpec } from "@freebot/sandbox";

/** The unit label every container this unit creates carries, which scopes its cleanup to itself. */
export const RUN_UNIT = "u1.7";

/** The workspace root a run's filesystem tools address. Mirrors `packages/protocol`'s pin. */
export const RUN_WORKSPACE = "/workspace";

interface RunTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  /** The gate governs this call, so it needs consent before it runs. */
  readonly destructive: boolean;
  /** The argv one approved call becomes inside the sandbox. */
  readonly argv: (args: unknown) => readonly string[];
}

function readCommand(args: unknown): string {
  if (typeof args === "object" && args !== null) {
    const command = (args as { command?: unknown }).command;
    if (typeof command === "string" && command.length > 0) return command;
  }
  throw new Error(`malformed bash call: ${JSON.stringify(args)}`);
}

/**
 * The run's tools, and the only place a tool is declared. `bash` is the terminal surface Phase 1
 * needs; a filesystem tool joins this table as one more entry, with its own argv.
 */
export const RUN_TOOLS: readonly RunTool[] = [
  {
    name: "bash",
    description: "Run a shell command inside the run's sandbox.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The command line to run." } },
      required: ["command"],
    },
    destructive: true,
    argv: (args) => ["bash", "-lc", readCommand(args)],
  },
];

/** What the model is offered. */
export function runToolDefinitions(): ToolDefinition[] {
  return RUN_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/** What the gate governs: every tool the run can offer. */
export function governedTools(): string[] {
  return RUN_TOOLS.map((tool) => tool.name);
}

/**
 * The sandbox port over the landed Docker adapter. One container per run, from the pinned image,
 * destroyed on every path. `delete` on a handle this port never created is a no-op here, because
 * the loop calls `destroy` even when `create` threw.
 */
export class DockerRunSandbox implements SandboxPort {
  readonly #adapter: SandboxProvider;
  #handle: SandboxHandle | null = null;

  constructor(adapter: SandboxProvider) {
    this.#adapter = adapter;
  }

  async create(spec: SandboxSpec): Promise<void> {
    this.#handle = await this.#adapter.create(spec);
  }

  async execute(call: ProviderToolCall): Promise<ToolOutcome> {
    const handle = this.#handle;
    if (handle === null) throw new Error("no sandbox to execute in");
    const tool = RUN_TOOLS.find((candidate) => candidate.name === call.toolName);
    if (tool === undefined) throw new Error(`${call.toolName} has no runner`);
    const started = Date.now();
    const result = await this.#adapter.exec(handle, tool.argv(call.args));
    const output = `${result.stdout.toString("utf8")}${result.stderr.toString("utf8")}`;
    return {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      ok: result.exitCode === 0,
      denied: false,
      output,
      durationMs: Date.now() - started,
    };
  }

  async destroy(): Promise<void> {
    const handle = this.#handle;
    this.#handle = null;
    if (handle === null) return;
    await this.#adapter.delete(handle);
  }
}

/** The gate port over the landed policy and ledger. */
export function createReviewGate(
  grants: GrantStore,
  refusals: ReadonlySet<string>,
  options: { readonly now?: () => number } = {},
): GatePort {
  const policy = createGrantPolicy(grants, {
    tools: governedTools(),
    refusals,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    async decide(call) {
      const decision = await policy({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        args: call.args,
      });
      const actionHash = canonicalActionHash(call.toolName, call.args);
      if (decision.allow) return { allow: true, actionHash };
      // The gate's combined reason is split once, here at the producer, exactly as v1 requires.
      const [code, ...rest] = decision.reason.split(": ");
      return { allow: false, code: code as DenyCode, detail: rest.join(": "), actionHash };
    },
  };
}

/**
 * The log port over one `SeqLog`. The seq, the timestamp and the run id are stamped here, at the one
 * place that appends, so no second counter exists and the run's durable position always equals the
 * log's tail.
 *
 * The seq is read from the log at append time rather than seeded from it when the port is built.
 * One service serves every run from one log, so two runs that start in the same tick would otherwise
 * both hold a counter starting at the same slot, and the log would refuse the second one's frames as
 * duplicates. The log's own `lastSeq` is the only counter there is. See `run-service.test.ts`.
 */
export function createLogPort(options: {
  readonly log: SeqLog<EventMessage>;
  readonly runId: string;
  readonly noteSeq: (seq: number) => void;
  readonly now?: () => number;
  /** Fired after an append lands, so a reader waiting on the log can wake. */
  readonly onAppend?: () => void;
}): LogPort {
  const now = options.now ?? Date.now;

  return {
    append<K extends EventType>(type: K, payload: EventPayloads[K]): number {
      const next = options.log.lastSeq + 1;
      const message = {
        v: 1,
        seq: next,
        ts: now(),
        runId: options.runId,
        type,
        payload,
      } as EventMessage;
      const outcome = options.log.append(next, message);
      if (outcome !== "appended") {
        throw new Error(`the log refused frame ${next}: ${outcome}`);
      }
      options.noteSeq(next);
      options.onAppend?.();
      return next;
    },
  };
}

/** The consent port for a server that answers approvals over its own routes: a park waits on a
 * pending map, and `approve` / `deny` resolve it. An unanswered park resolves as a timeout.
 */
export interface PendingApprovals extends ApprovalPort {
  /** Answer a parked call. An allow mints the grant the re-ask consumes; a deny records the refusal. */
  answer(input: {
    readonly approvalId: string;
    readonly decision: "allow" | "deny";
    readonly grants: GrantStore;
    readonly refusals: Set<string>;
    readonly ttlMs?: number;
  }): boolean;
  /** The approvals still waiting, for a surface that renders the cards. */
  pending(): string[];
}

export function createPendingApprovals(
  options: { readonly ttlMs?: number; readonly now?: () => number } = {},
): PendingApprovals {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 120_000;
  const waiting = new Map<
    string,
    { request: ApprovalRequest; resolve: (answer: ApprovalAnswer) => void }
  >();

  return {
    async await(request) {
      return await new Promise<ApprovalAnswer>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(request.approvalId);
          resolve({ decision: "timeout" });
        }, ttlMs);
        waiting.set(request.approvalId, {
          request,
          resolve: (answer) => {
            clearTimeout(timer);
            resolve(answer);
          },
        });
      });
    },
    answer(input) {
      const entry = waiting.get(input.approvalId);
      if (entry === undefined) return false;
      waiting.delete(input.approvalId);
      if (input.decision === "deny") {
        input.refusals.add(entry.request.actionHash);
        entry.resolve({ decision: "deny" });
        return true;
      }
      const grant = input.grants.issue({
        toolName: entry.request.toolName,
        args: entry.request.args,
        ttlMs: input.ttlMs ?? ttlMs,
        now: now(),
      });
      entry.resolve({
        decision: "allow",
        grant: { grantId: grant.id, actionHash: grant.actionHash, expiresAt: grant.expiresAt },
      });
      return true;
    },
    pending: () => [...waiting.keys()],
  };
}

/** The adapter type, re-exported so the wiring's callers name one thing. */
export type { SandboxProvider };
