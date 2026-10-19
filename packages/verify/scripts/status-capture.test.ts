/**
 * The status capture's guard against the pass-56 defect: a selector that moved must fail by name
 * rather than read as an empty list. The evaluator is injected, so these run without a browser.
 */

import { describe, expect, test } from "bun:test";
import { PROBES, parseArgs, readFacts } from "./status-capture.ts";

describe("the status capture's selector guard", () => {
  test("a selector that matches nothing fails by name, with no empty facts", async () => {
    const run = async () => ({ conn: 0 });

    await expect(readFacts(run, [PROBES.conn])).rejects.toThrow(
      'missing selector "#conn" (the connection state)',
    );
  });

  test("the moved run-status selector fails by its own name, not as an empty list", async () => {
    const run = async () => ({ headerStatus: 0 });

    await expect(readFacts(run, [PROBES.headerStatus])).rejects.toThrow(
      'missing selector "#run[data-run-status]" (the header run status)',
    );
  });

  test("a required collection that matches nothing fails by name rather than reading []", async () => {
    const run = async () => ({ tools: 0 });

    await expect(readFacts(run, [PROBES.tools])).rejects.toThrow(
      'missing selector "#thread .tool-card" (the tool cards)',
    );
  });

  test("an optional collection reads as empty only where the state allows it", async () => {
    const run = async (expression: string) => (expression.startsWith("({") ? { turns: 0 } : []);

    const facts = await readFacts(run, [{ ...PROBES.turns, optional: true }]);

    expect(facts.turns).toEqual([]);
  });

  test("a present selector returns the page's own value", async () => {
    const run = async (expression: string) =>
      expression.startsWith("({") ? { conn: 1 } : "connected";

    const facts = await readFacts(run, [PROBES.conn]);

    expect(facts.conn).toBe("connected");
  });

  test("a required collection reads every match, not the first", async () => {
    const run = async (expression: string) =>
      expression.startsWith("({") ? { toolStatuses: 2 } : ["awaiting approval", "running"];

    const facts = await readFacts(run, [PROBES.toolStatuses]);

    expect(facts.toolStatuses).toEqual(["awaiting approval", "running"]);
  });
});

describe("the status capture's arguments", () => {
  test("a live URL and an output directory are both required", () => {
    expect(() => parseArgs(["--url", "http://127.0.0.1:1/#token=x"])).toThrow("--out is required");
    expect(() => parseArgs(["--out", "reports/pass-1"])).toThrow("--url is required");
  });

  test("the mode names the capture the pass wants", () => {
    expect(
      parseArgs(["--url", "http://127.0.0.1:1/#token=x", "--out", "out", "--mode", "both"]),
    ).toEqual({ url: "http://127.0.0.1:1/#token=x", out: "out", mode: "both" });
  });

  test("an unknown mode or flag fails by name", () => {
    expect(() =>
      parseArgs(["--url", "http://127.0.0.1:1", "--out", "out", "--mode", "screens"]),
    ).toThrow('--mode must be predicate, landing or both, not "screens"');
    expect(() => parseArgs(["--url", "http://127.0.0.1:1", "--out", "out", "--shot"])).toThrow(
      'unknown argument "--shot"',
    );
  });
});
