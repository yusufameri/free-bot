/**
 * The page-error passthrough for two drivers that still carried their own evaluate copy. A page
 * exception has to report the page's own message, not the CDP summary and not the expression.
 */

import { describe, expect, test } from "bun:test";
import { evalJson as keyedRunEval } from "./keyed-run.ts";
import { evalJson as launchEval } from "./launch.ts";

type KeyedRunCdp = Parameters<typeof keyedRunEval>[0];
type LaunchCdp = Parameters<typeof launchEval>[0];

function page(result: Record<string, unknown>): { send: () => Promise<unknown> } {
  return { send: async () => result };
}

const ILLEGAL_INVOCATION = {
  result: {},
  exceptionDetails: {
    text: "Uncaught",
    exception: {
      description: "Error: Illegal invocation\n    at <anonymous>:1:37\n    at <anonymous>:1:1",
    },
  },
};

describe("the keyed run driver's page errors", () => {
  test("a page exception's own message reaches the error, with the driver and expression named", async () => {
    const cdp = page(ILLEGAL_INVOCATION) as unknown as KeyedRunCdp;

    const error = await keyedRunEval(cdp, "session-1", "window.__threadFacts()").catch(
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toBe(
      "keyed-run: evaluate failed: Error: Illegal invocation :: window.__threadFacts()",
    );
  });

  test("a value the page returns comes back unchanged", async () => {
    const cdp = page({ result: { value: { done: true } } }) as unknown as KeyedRunCdp;

    expect(
      await keyedRunEval<{ done: boolean }>(cdp, "session-1", "window.__threadFacts()"),
    ).toEqual({ done: true });
  });
});

describe("the launch driver's page errors", () => {
  test("a page exception's own message reaches the error, with the driver and expression named", async () => {
    const cdp = page(ILLEGAL_INVOCATION) as unknown as LaunchCdp;

    const error = await launchEval(cdp, "session-1", "window.__shellFacts()").catch(
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toBe(
      "launch: evaluate failed: Error: Illegal invocation :: window.__shellFacts()",
    );
  });
});
