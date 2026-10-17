import { describe, expect, test } from "bun:test";
import { EVENT_PAYLOADS } from "../../protocol/src/events.ts";
import { RUN_EVENT_KINDS, type RunEventKind, transitionEvent } from "./run-events.ts";
import { type RunStatus, transitionPairs } from "./run-status.ts";

/**
 * The transition-to-kind table, written literally. Six entries are null on purpose: the landed
 * vocabulary has no arm for a cancelled run, a paused run, or a run that rejoined.
 */
const EXPECTED: Array<[RunStatus, RunStatus, RunEventKind | null]> = [
  ["queued", "running", "run.started"],
  ["queued", "failed", "run.failed"],
  ["queued", "cancelled", null],
  ["running", "awaiting_approval", "approval.requested"],
  ["running", "paused", null],
  ["running", "done", "run.finished"],
  ["running", "failed", "run.failed"],
  ["running", "cancelled", null],
  ["awaiting_approval", "running", "approval.resolved"],
  ["awaiting_approval", "failed", "run.failed"],
  ["awaiting_approval", "cancelled", null],
  ["paused", "running", null],
  ["paused", "failed", "run.failed"],
  ["paused", "cancelled", null],
];

describe("the run model against the wire vocabulary", () => {
  test("every kind the run model speaks exists in packages/protocol's registry", () => {
    expect(RUN_EVENT_KINDS).toEqual([
      "run.started",
      "run.finished",
      "run.failed",
      "approval.requested",
      "approval.resolved",
    ]);
    for (const kind of RUN_EVENT_KINDS) {
      expect(Object.keys(EVENT_PAYLOADS)).toContain(kind);
    }
  });

  test("every legal transition names its kind, and the nulls are exactly the gaps", () => {
    for (const [from, to, kind] of EXPECTED) {
      expect(transitionEvent(from, to)).toBe(kind);
    }

    expect(
      EXPECTED.filter(([, , kind]) => kind === null).map(([from, to]) => `${from}->${to}`),
    ).toEqual([
      "queued->cancelled",
      "running->paused",
      "running->cancelled",
      "awaiting_approval->cancelled",
      "paused->running",
      "paused->cancelled",
    ]);
  });

  test("the table covers every legal pair and no others", () => {
    const legal = transitionPairs().map(({ from, to }) => `${from}->${to}`);

    expect(legal.length).toBe(14);
    expect(EXPECTED.map(([from, to]) => `${from}->${to}`)).toEqual(legal);
  });

  test("an illegal pair has no kind", () => {
    expect(transitionEvent("queued", "done")).toBeNull();
    expect(transitionEvent("done", "running")).toBeNull();
  });
});
