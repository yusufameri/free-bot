/**
 * The status capture's guard against the pass-56 defect: a selector that moved must fail by name
 * rather than read as an empty list. The evaluator is injected, so these run without a browser.
 */

import { describe, expect, test } from "bun:test";
import { type Cdp, evaluate } from "../src/cdp.ts";
import { PROBES, parseArgs, readFacts, writeComposer } from "./status-capture.ts";

/** A page that reports one tag name for the composer, and records what the driver sends it. */
function composerPage(tagName: string | null): {
  readonly expressions: string[];
  readonly run: (expression: string) => Promise<unknown>;
} {
  const expressions: string[] = [];
  return {
    expressions,
    run: async (expression: string) => {
      expressions.push(expression);
      return expression.includes("tagName") ? tagName : undefined;
    },
  };
}

describe("the status capture's composer", () => {
  test("an input composer is written through the input prototype", async () => {
    const page = composerPage("INPUT");

    await writeComposer(page.run, "hello");

    expect(page.expressions[0]).toContain('.querySelector("#prompt")');
    expect(page.expressions[1]).toContain(
      "Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call",
    );
    expect(page.expressions[1]).not.toContain("HTMLTextAreaElement.prototype");
  });

  test("a textarea composer is written through the textarea prototype", async () => {
    const page = composerPage("TEXTAREA");

    await writeComposer(page.run, "hello");

    expect(page.expressions[1]).toContain(
      "Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call",
    );
    expect(page.expressions[1]).not.toContain("HTMLInputElement.prototype");
  });

  test("a composer that is neither an input nor a textarea fails by selector and tag", async () => {
    const page = composerPage("DIV");

    await expect(writeComposer(page.run, "hello")).rejects.toThrow(
      'the composer "#prompt" must be an <input> or a <textarea>, not <div>',
    );
  });

  test("a composer the page does not render fails by selector", async () => {
    const page = composerPage(null);

    await expect(writeComposer(page.run, "hello")).rejects.toThrow(
      'missing selector "#prompt" (the composer input)',
    );
  });
});

describe("the status capture's page errors", () => {
  test("a page exception's own message reaches the driver's error", async () => {
    const cdp = {
      send: async () => ({
        exceptionDetails: {
          text: "Uncaught",
          exception: {
            description:
              "Error: Illegal invocation\n    at <anonymous>:1:37\n    at <anonymous>:1:1",
          },
        },
      }),
    } as unknown as Cdp;

    const error = await evaluate(cdp, "session-1", "setComposerValue()").catch(
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toBe("evaluate failed: Error: Illegal invocation");
  });
});

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
