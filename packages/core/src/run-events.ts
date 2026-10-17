/**
 * Which wire kind each run transition puts in the log.
 *
 * The run model speaks the landed twelve-kind vocabulary (`packages/protocol/src/events.ts`);
 * `TRANSITION_EVENTS` is the whole of that binding, and `run-events.test.ts` checks every name here
 * against that package's real `EVENT_PAYLOADS` registry so a renamed kind fails the build rather
 * than the stream.
 *
 * A null is a wire gap, not an oversight. The landed vocabulary has no arm that means "this run is
 * parked", "this run is paused", "this run was cancelled", or "this run rejoined", and the only
 * kind left is `run.failed`, whose payload means the run ended without completing. The record is
 * authoritative for those states; the stream needs one run-status kind, which is a follow-up
 * because `packages/protocol/src/envelope.test.ts` pins the kind list literally and that test
 * belongs to packages/protocol. See packages/core/runs.md.
 */

import { RUN_STATUSES, type RunStatus } from "./run-status.ts";

/** The kinds the run lifecycle emits, a subset of the landed twelve. */
export const RUN_EVENT_KINDS = [
  "run.started",
  "run.finished",
  "run.failed",
  "approval.requested",
  "approval.resolved",
] as const;

export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

export type TransitionKey = `${RunStatus}->${RunStatus}`;

/** The moves that do put a kind in the log. Every other pair is null in `TRANSITION_EVENTS`. */
const DECLARED: Partial<Record<TransitionKey, RunEventKind>> = {
  "queued->running": "run.started",
  "queued->failed": "run.failed",
  "running->awaiting_approval": "approval.requested",
  "awaiting_approval->running": "approval.resolved",
  "running->done": "run.finished",
  "running->failed": "run.failed",
  "awaiting_approval->failed": "run.failed",
  "paused->failed": "run.failed",
};

function buildTransitionEvents(): Record<TransitionKey, RunEventKind | null> {
  const events = {} as Record<TransitionKey, RunEventKind | null>;
  for (const from of RUN_STATUSES) {
    for (const to of RUN_STATUSES) {
      events[`${from}->${to}`] = DECLARED[`${from}->${to}`] ?? null;
    }
  }
  return events;
}

export const TRANSITION_EVENTS: Record<TransitionKey, RunEventKind | null> =
  buildTransitionEvents();

/** The kind a move emits, or null when the landed vocabulary has no arm for it. */
export function transitionEvent(from: RunStatus, to: RunStatus): RunEventKind | null {
  return TRANSITION_EVENTS[`${from}->${to}`];
}
