import { describe, expect, test } from "bun:test";
import {
  addUsage,
  checkSpendCap,
  costNanoUsd,
  emptyUsage,
  NANO_USD_PER_USD,
  nanoPerToken,
  nanoToUsd,
  noTokens,
  type TokenPrices,
  type UsageEvent,
  usageKey,
  usdToNano,
} from "./run-usage.ts";

const PRICES: TokenPrices = {
  inputPerMTok: "3.00",
  outputPerMTok: "15.00",
  cacheReadPerMTok: "0.30",
  cacheWritePerMTok: "3.75",
};

function call(
  usageId: string,
  tokens: Partial<UsageEvent["tokens"]>,
  provider = "openai",
  model = "gpt-4o",
): UsageEvent {
  const counts = { ...noTokens(), ...tokens };
  return { usageId, provider, model, tokens: counts, costNanoUsd: costNanoUsd(PRICES, counts) };
}

function refusal(attempt: () => unknown): Error {
  try {
    attempt();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the amount to be refused");
}

describe("integer money", () => {
  test("a USD string parses to nano-USD exactly", () => {
    expect(NANO_USD_PER_USD).toBe(1_000_000_000);
    expect(usdToNano("3.00")).toBe(3_000_000_000);
    expect(usdToNano("0.075")).toBe(75_000_000);
    expect(usdToNano("0.000000001")).toBe(1);
    expect(usdToNano("1.5")).toBe(1_500_000_000);
    expect(usdToNano("0")).toBe(0);
  });

  test("a string that is not an amount is refused, not rounded", () => {
    for (const bad of ["", "abc", "-1", "1.", "01", "1.0000000000", "1e3", " 1"]) {
      expect(refusal(() => usdToNano(bad)).message).toBe(
        `not a USD amount: ${JSON.stringify(bad)}`,
      );
    }
  });

  test("nano-USD renders as USD with at least two decimals", () => {
    expect(nanoToUsd(3_000_000_000)).toBe("3.00");
    expect(nanoToUsd(0)).toBe("0.00");
    expect(nanoToUsd(1)).toBe("0.000000001");
    expect(nanoToUsd(1_500_000_000)).toBe("1.50");
    expect(nanoToUsd(3_702_000)).toBe("0.003702");
  });

  test("render and parse are inverses over a spread of amounts", () => {
    for (const nano of [0, 1, 999, 1_000_000, 3_000_000_000, 9_007_199_254_740_991]) {
      expect(usdToNano(nanoToUsd(nano))).toBe(nano);
    }
  });

  test("a per-million price becomes whole nano-USD per token", () => {
    expect(nanoPerToken("3.00")).toBe(3000);
    expect(nanoPerToken("15.00")).toBe(15_000);
    expect(nanoPerToken("0.15")).toBe(150);
    expect(refusal(() => nanoPerToken("0.0000001")).message).toBe(
      "price is finer than one nanoUSD per token: 0.0000001",
    );
  });

  test("a call's cost is the price times the tokens, in integers", () => {
    expect(
      costNanoUsd(PRICES, { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }),
    ).toBe(18_000_000_000);
    expect(costNanoUsd(PRICES, { input: 1234, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(
      3_702_000,
    );
    expect(costNanoUsd(PRICES, noTokens())).toBe(0);
  });
});

describe("the per-run accumulator", () => {
  test("a fresh run has spent nothing", () => {
    expect(emptyUsage()).toEqual({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costNanoUsd: 0,
      byModel: {},
    });
  });

  test("calls add up per provider and model, with the keys sorted", () => {
    const first = addUsage(emptyUsage(), call("u1", { input: 1_000, output: 500 }));
    const second = addUsage(first, call("u2", { input: 2_000, output: 100 }));
    const third = addUsage(second, call("u3", { input: 4_000, output: 0 }, "anthropic", "claude"));

    expect(third.tokens).toEqual({ input: 7_000, output: 600, cacheRead: 0, cacheWrite: 0 });
    expect(third.costNanoUsd).toBe(30_000_000);
    expect(Object.keys(third.byModel)).toEqual(["anthropic/claude", "openai/gpt-4o"]);
    expect(third.byModel["openai/gpt-4o"]).toEqual({
      provider: "openai",
      model: "gpt-4o",
      tokens: { input: 3_000, output: 600, cacheRead: 0, cacheWrite: 0 },
      costNanoUsd: 18_000_000,
      calls: 2,
    });
    expect(usageKey("openai", "gpt-4o")).toBe("openai/gpt-4o");
    expect(refusal(() => usageKey("open/ai", "gpt-4o")).message).toBe(
      'provider name may not contain a slash: "open/ai"',
    );
  });

  test("the same events always produce the same totals", () => {
    const build = (): string => {
      const totals = addUsage(
        addUsage(emptyUsage(), call("u2", { input: 10, output: 20 }, "anthropic", "claude")),
        call("u1", { input: 1_000, output: 500 }),
      );
      return JSON.stringify(totals);
    };

    expect(build()).toBe(build());
  });
});

describe("the spend cap", () => {
  test("under the cap, the check passes with the remainder named", () => {
    const totals = addUsage(emptyUsage(), call("u1", { input: 1_000_000, output: 0 }));

    expect(checkSpendCap(totals, 5_000_000_000)).toEqual({
      ok: true,
      spentNanoUsd: 3_000_000_000,
      capNanoUsd: 5_000_000_000,
      remainingNanoUsd: 2_000_000_000,
      overByNanoUsd: 0,
    });
  });

  test("spending exactly the cap is still within it", () => {
    const totals = addUsage(emptyUsage(), call("u1", { input: 1_000_000, output: 0 }));

    expect(checkSpendCap(totals, 3_000_000_000)).toEqual({
      ok: true,
      spentNanoUsd: 3_000_000_000,
      capNanoUsd: 3_000_000_000,
      remainingNanoUsd: 0,
      overByNanoUsd: 0,
    });
  });

  test("one nano over the cap fails the check and names the overshoot", () => {
    const totals = addUsage(emptyUsage(), call("u1", { input: 1_000_000, output: 0 }));

    expect(checkSpendCap(totals, 2_999_999_999)).toEqual({
      ok: false,
      spentNanoUsd: 3_000_000_000,
      capNanoUsd: 2_999_999_999,
      remainingNanoUsd: 0,
      overByNanoUsd: 1,
    });
  });

  test("a cap that is not an amount in nano-USD is refused", () => {
    expect(refusal(() => checkSpendCap(emptyUsage(), -1)).message).toBe(
      "not a spend cap in integer nano-USD: -1",
    );
    expect(refusal(() => checkSpendCap(emptyUsage(), 1.5)).message).toBe(
      "not a spend cap in integer nano-USD: 1.5",
    );
  });
});
