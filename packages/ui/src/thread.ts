/**
 * The thread model over the v1 event stream, shared by every surface (plan 2.7: `ui/` holds the
 * shared UI core, `apps/web` is the thin host that mounts it).
 *
 * It consumes `@freebot/protocol` messages and nothing else: one thread, ordered by the dense
 * `seq` the origin mints. The ordering rules are the ones U0.10 proved and docs/web-stream-spike.md
 * states: a gap throws, a seq already applied is counted and dropped. The model keeps the display
 * strings so a surface and the evidence harness read the same words.
 */

import type { EventMessage, Message, StreamMessage } from "@freebot/protocol";

/** What a tool-call card can be showing. `requested` is a call nothing has been said about yet. */
export type ToolCardStatus = "requested" | "running" | "awaiting approval" | "done" | "denied";

/** The gate's verdict on one call, once `tool_call.decision` arrives. */
export interface ToolDecision {
  allow: boolean;
  /** The `packages/review` denial code, verbatim. Null on an allow. */
  code: string | null;
  detail: string | null;
}

export interface ToolCard {
  toolCallId: string;
  toolName: string;
  /** `toolName` plus its JSON args, the literal string the user is asked to trust. */
  command: string;
  destructive: boolean;
  status: ToolCardStatus;
  /** Literal tool output; null while the call has not produced one. Never the denial text. */
  output: string | null;
  durationMs: number | null;
  decision: ToolDecision | null;
  callSeq: number;
  resultSeq: number | null;
}

export interface ApprovalCard {
  approvalId: string;
  toolCallId: string;
  command: string;
  actionHash: string;
  expiresAt: number;
  decision: "allow" | "deny" | null;
  resolution: string | null;
  requestSeq: number;
  resolvedSeq: number | null;
}

export interface GrantRecord {
  grantId: string;
  actionHash: string;
  state: string;
  detail: string;
}

/** One turn's assistant text, accumulated from `message.text.delta` as the tokens arrive. */
export interface TextRun {
  turn: number;
  text: string;
}

export interface ThreadState {
  runId: string | null;
  prompt: string | null;
  lastSeq: number;
  /** Messages applied, duplicates excluded. */
  applied: number;
  duplicatesIgnored: number;
  seen: ReadonlySet<number>;
  turns: number;
  text: TextRun[];
  toolCards: ToolCard[];
  approvals: ApprovalCard[];
  grants: GrantRecord[];
  /** The approval whose card is waiting for an answer. */
  awaiting: string | null;
  /** The run's last `run.status` payload, so a surface can name its terminal state. */
  runStatus: string | null;
  done: boolean;
  failed: string | null;
  /** The run ended at the taxonomy's `cancelled`, which carries no `run.finished` frame. */
  cancelled: boolean;
  error: string | null;
  resumedFrom: number | null;
}

export function initialState(): ThreadState {
  return {
    runId: null,
    prompt: null,
    lastSeq: 0,
    applied: 0,
    duplicatesIgnored: 0,
    seen: new Set(),
    turns: 0,
    text: [],
    toolCards: [],
    approvals: [],
    grants: [],
    awaiting: null,
    runStatus: null,
    done: false,
    failed: null,
    cancelled: false,
    error: null,
    resumedFrom: null,
  };
}

/** Whether a run is on screen and has not reached one of the three terminal states. */
export function runInFlight(state: ThreadState): boolean {
  return state.runId !== null && !state.done && state.failed === null && !state.cancelled;
}

export function markResumed(state: ThreadState, fromSeq: number): ThreadState {
  return { ...state, resumedFrom: fromSeq };
}

export function markError(state: ThreadState, message: string): ThreadState {
  return { ...state, error: message };
}

function withToolCard(
  state: ThreadState,
  toolCallId: string,
  patch: Partial<ToolCard>,
): ToolCard[] {
  return state.toolCards.map((card) =>
    card.toolCallId === toolCallId ? { ...card, ...patch } : card,
  );
}

function withApproval(
  state: ThreadState,
  approvalId: string,
  patch: Partial<ApprovalCard>,
): ApprovalCard[] {
  return state.approvals.map((card) =>
    card.approvalId === approvalId ? { ...card, ...patch } : card,
  );
}

/** The card a resolution or a result belongs to, by the approval's or the result's own id. */
function cardForApproval(state: ThreadState, approvalId: string): ToolCard | undefined {
  const approval = state.approvals.find((card) => card.approvalId === approvalId);
  if (approval === undefined) return undefined;
  return state.toolCards.find((card) => card.toolCallId === approval.toolCallId);
}

function applyStream(state: ThreadState, message: StreamMessage): ThreadState {
  switch (message.type) {
    case "stream.resumed":
      return markResumed(state, message.payload.fromSeq);
    case "stream.gap":
      return markError(
        state,
        `gap: expected seq ${message.payload.expected}, got ${message.payload.got}`,
      );
    default:
      return state;
  }
}

function applyEvent(state: ThreadState, message: EventMessage): ThreadState {
  const base: ThreadState = {
    ...state,
    lastSeq: message.seq,
    applied: state.applied + 1,
    seen: new Set([...state.seen, message.seq]),
  };
  switch (message.type) {
    case "run.started":
      // A new run in this thread starts a new in-flight period: the previous run's terminal flags
      // belong to the conversation behind it, not to this one.
      return {
        ...base,
        runId: message.runId,
        prompt: message.payload.prompt,
        runStatus: "running",
        done: false,
        failed: null,
        cancelled: false,
      };
    case "run.finished":
      return { ...base, done: true, awaiting: null, runStatus: "done" };
    case "run.failed":
      return { ...base, failed: message.payload.reason, runStatus: "failed" };
    case "run.status":
      return {
        ...base,
        runStatus: message.payload.status,
        cancelled: message.payload.status === "cancelled",
      };
    case "turn.started":
      return {
        ...base,
        turns: Math.max(state.turns, message.payload.turn),
        text: [...state.text, { turn: message.payload.turn, text: "" }],
      };
    case "turn.ended":
      return base;
    case "message.text.delta": {
      const last = state.text.at(-1);
      const text =
        last === undefined
          ? [{ turn: 1, text: message.payload.text }]
          : [...state.text.slice(0, -1), { ...last, text: last.text + message.payload.text }];
      return { ...base, text };
    }
    case "tool_call.requested":
      return {
        ...base,
        toolCards: [
          ...state.toolCards,
          {
            toolCallId: message.payload.toolCallId,
            toolName: message.payload.toolName,
            command: message.payload.command,
            destructive: message.payload.destructive,
            status: message.payload.destructive ? "awaiting approval" : "running",
            output: null,
            durationMs: null,
            decision: null,
            callSeq: message.seq,
            resultSeq: null,
          },
        ],
      };
    case "tool_call.decision":
      return {
        ...base,
        toolCards: withToolCard(state, message.payload.toolCallId, {
          decision: message.payload.allow
            ? { allow: true, code: null, detail: null }
            : { allow: false, code: message.payload.code, detail: message.payload.detail },
          ...(message.payload.allow ? {} : { status: "denied" as const }),
        }),
      };
    case "tool_call.result":
      return {
        ...base,
        toolCards: withToolCard(state, message.payload.toolCallId, {
          status: message.payload.denied ? "denied" : "done",
          output: message.payload.denied ? null : message.payload.output,
          durationMs: message.payload.durationMs,
          resultSeq: message.seq,
        }),
      };
    case "approval.requested":
      return {
        ...base,
        awaiting: message.payload.approvalId,
        approvals: [
          ...state.approvals,
          {
            approvalId: message.payload.approvalId,
            toolCallId: message.payload.toolCallId,
            command: message.payload.command,
            actionHash: message.payload.actionHash,
            expiresAt: message.payload.expiresAt,
            decision: null,
            resolution: null,
            requestSeq: message.seq,
            resolvedSeq: null,
          },
        ],
      };
    case "approval.resolved": {
      const payload = message.payload;
      const card = cardForApproval(state, payload.approvalId);
      return {
        ...base,
        awaiting: null,
        approvals: withApproval(state, payload.approvalId, {
          decision: payload.decision,
          resolution:
            payload.decision === "allow"
              ? `grant ${payload.grant.grantId} issued`
              : "no grant issued",
          resolvedSeq: message.seq,
        }),
        toolCards:
          card === undefined
            ? state.toolCards
            : withToolCard(state, card.toolCallId, {
                status: payload.decision === "allow" ? ("running" as const) : ("denied" as const),
              }),
      };
    }
    case "grant.lifecycle": {
      const payload = message.payload;
      const detail =
        payload.state === "consumed"
          ? `consumed by ${payload.consumedBy}`
          : payload.state === "rewound"
            ? payload.reason
            : payload.state === "expired"
              ? `expired at ${payload.at}`
              : `expires at ${payload.expiresAt}`;
      return {
        ...base,
        grants: [
          ...state.grants,
          {
            grantId: payload.grantId,
            actionHash: payload.actionHash,
            state: payload.state,
            detail,
          },
        ],
      };
    }
    default: {
      const unmapped: never = message;
      throw new Error(`unmapped v1 message: ${JSON.stringify(unmapped)}`);
    }
  }
}

/**
 * Apply one wire message. Throws on a gap so the surface fails loud rather than rendering a
 * transcript with a hole in it; counts and drops a seq it has already applied.
 */
export function applyMessage(state: ThreadState, message: Message): ThreadState {
  if (!("seq" in message)) return applyStream(state, message);
  if (message.seq <= state.lastSeq) {
    if (state.seen.has(message.seq)) {
      return { ...state, duplicatesIgnored: state.duplicatesIgnored + 1 };
    }
    throw new Error(`out of order: seq ${message.seq} already passed but was never seen`);
  }
  if (message.seq !== state.lastSeq + 1) {
    throw new Error(`gap: expected seq ${state.lastSeq + 1}, got ${message.seq}`);
  }
  return applyEvent(state, message);
}

/** The word a card's status renders as. One source for the surface and for the evidence facts. */
export function statusLabel(card: ToolCard): string {
  return card.status;
}

/** The literal output a card renders, or the empty string when the call produced none. */
export function outputText(card: ToolCard): string {
  return card.output ?? "";
}

export function grantLabel(record: GrantRecord): string {
  return `grant ${record.grantId}: ${record.state} (${record.detail})`;
}

export function textOf(state: ThreadState): string {
  return state.text.map((run) => run.text).join("");
}
