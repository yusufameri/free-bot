import { describe, expect, test } from "bun:test";
import {
  assertTransition,
  canTransition,
  isTerminal,
  RUN_STATUSES,
  type RunStatus,
  RunTransitionError,
  transitionPairs,
} from "./run-status.ts";

/** The lifecycle as a table of its own, so the registry is checked against this and not itself. */
const LEGAL: Record<RunStatus, RunStatus[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["awaiting_approval", "paused", "done", "failed", "cancelled"],
  awaiting_approval: ["running", "failed", "cancelled"],
  paused: ["running", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

function refusal(attempt: () => unknown): Error {
  try {
    attempt();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the lifecycle to refuse this");
}

describe("the run lifecycle", () => {
  test("the fourteen legal pairs, listed literally", () => {
    expect(transitionPairs()).toEqual([
      { from: "queued", to: "running" },
      { from: "queued", to: "failed" },
      { from: "queued", to: "cancelled" },
      { from: "running", to: "awaiting_approval" },
      { from: "running", to: "paused" },
      { from: "running", to: "done" },
      { from: "running", to: "failed" },
      { from: "running", to: "cancelled" },
      { from: "awaiting_approval", to: "running" },
      { from: "awaiting_approval", to: "failed" },
      { from: "awaiting_approval", to: "cancelled" },
      { from: "paused", to: "running" },
      { from: "paused", to: "failed" },
      { from: "paused", to: "cancelled" },
    ]);
  });

  test("all forty-nine pairs agree with the table, so the other thirty-five are refused", () => {
    const pairs: Array<{ from: RunStatus; to: RunStatus; allowed: boolean }> = [];
    for (const from of RUN_STATUSES) {
      for (const to of RUN_STATUSES) {
        const allowed = (LEGAL[from] as RunStatus[]).includes(to);
        expect(canTransition(from, to)).toBe(allowed);
        pairs.push({ from, to, allowed });
      }
    }

    expect(pairs.length).toBe(49);
    expect(pairs.filter((pair) => pair.allowed).length).toBe(14);
  });

  test("only done, failed, and cancelled are terminal", () => {
    expect(RUN_STATUSES.filter(isTerminal)).toEqual(["done", "failed", "cancelled"]);
  });

  test("a refusal names the move it refused", () => {
    const error = refusal(() => assertTransition("paused", "done", "finish"));

    expect(error).toBeInstanceOf(RunTransitionError);
    expect(error.message).toBe("finish: paused -> done is not a legal run transition");
  });

  test("a legal move passes the assert", () => {
    expect(() => assertTransition("awaiting_approval", "running", "resolve")).not.toThrow();
  });
});
