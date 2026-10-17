/**
 * The run lifecycle: seven states and the transitions between them.
 *
 * `RUN_TRANSITIONS` is the only authority on legality, and `RunStore` exposes one named operation
 * per move instead of a status setter, so an illegal transition has no call site rather than a
 * comment asking callers not to make one. The one call site that can still be reached in a state it
 * does not handle (`park` on a queued run) refuses through `assertTransition` and surfaces as the
 * taxonomy's `internal_invariant`.
 *
 * The seven states are the lifecycle the MVP smoke exercised end to end: start, park at a gated
 * call, answer it, lose the sandbox mid-task, rejoin, finish. `awaiting_approval` and `paused` both
 * return to `running` because both are waits inside a run, not endings of one. `queued` can fail
 * without ever running, because a sandbox that will not start fails a run before its first turn.
 */

export const RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "paused",
  "done",
  "failed",
  "cancelled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_STATUSES = ["done", "failed", "cancelled"] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export const RUN_TRANSITIONS = {
  queued: ["running", "failed", "cancelled"],
  running: ["awaiting_approval", "paused", "done", "failed", "cancelled"],
  awaiting_approval: ["running", "failed", "cancelled"],
  paused: ["running", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<RunStatus, readonly RunStatus[]>;

/** The operation that attempted a move; part of every refusal's message. */
export type RunOperation =
  | "start"
  | "begin"
  | "park"
  | "resolve"
  | "pause"
  | "resume"
  | "finish"
  | "fail";

export class RunTransitionError extends Error {
  readonly from: RunStatus;
  readonly to: RunStatus;
  readonly via: RunOperation;

  constructor(from: RunStatus, to: RunStatus, via: RunOperation) {
    super(`${via}: ${from} -> ${to} is not a legal run transition`);
    this.name = "RunTransitionError";
    this.from = from;
    this.to = to;
    this.via = via;
  }
}

export function isTerminal(status: RunStatus): status is TerminalStatus {
  return TERMINAL_STATUSES.some((terminal) => terminal === status);
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  const allowed: readonly RunStatus[] = RUN_TRANSITIONS[from];
  return allowed.some((candidate) => candidate === to);
}

export function assertTransition(from: RunStatus, to: RunStatus, via: RunOperation): void {
  if (!canTransition(from, to)) throw new RunTransitionError(from, to, via);
}

/** Every legal pair in status order; the transition table the evidence artifact prints. */
export function transitionPairs(): Array<{ from: RunStatus; to: RunStatus }> {
  return RUN_STATUSES.flatMap((from) => {
    const allowed: readonly RunStatus[] = RUN_TRANSITIONS[from];
    return allowed.map((to) => ({ from, to }));
  });
}
