/**
 * Usage and spend: integer nano-USD in, integer nano-USD out.
 *
 * Every amount here is an integer count of 1e-9 USD, so `1 USD = 1_000_000_000` and the arithmetic
 * is exact while a total stays under about $9M (the safe-integer ceiling), which no single run
 * reaches. Prices arrive as the decimal strings providers publish and are parsed into nano-USD at
 * that boundary; nothing downstream multiplies or divides a float. A price finer than one nano-USD
 * per token is refused rather than rounded, because rounding money silently is how a spend cap
 * stops meaning what it says.
 *
 * `UsageEvent` is the `usage_event` shape of plan 2.8: one call's tokens and cost, named by provider
 * and model. Totals are a fold over events, so the same events always produce the same totals and a
 * replayed event is refused by its `usageId` rather than added twice (see `RunStore.recordUsage`).
 */

/** One model call's usage. `usageId` is the identity that makes a replay a no-op. */
export interface UsageEvent {
  usageId: string;
  provider: string;
  model: string;
  tokens: TokenCounts;
  /** Integer nano-USD for this call. */
  costNanoUsd: number;
}

export interface ModelUsage {
  provider: string;
  model: string;
  tokens: TokenCounts;
  costNanoUsd: number;
  calls: number;
}

export interface UsageTotals {
  tokens: TokenCounts;
  costNanoUsd: number;
  /** Keyed `provider/model`, keys sorted so a snapshot is byte-stable. */
  byModel: Record<string, ModelUsage>;
}

export const NANO_USD_PER_USD = 1_000_000_000;

const USD_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,9}))?$/;

/** Parse a USD decimal string into integer nano-USD. The one place a money string is accepted. */
export function usdToNano(usd: string): number {
  const match = USD_PATTERN.exec(usd);
  if (match === null) {
    throw new Error(`not a USD amount: ${JSON.stringify(usd)}`);
  }
  const whole = Number(match[1] ?? "");
  const wholeNano = whole * NANO_USD_PER_USD;
  if (!Number.isSafeInteger(wholeNano)) {
    throw new Error(`USD amount out of exact range: ${usd}`);
  }
  return wholeNano + Number((match[2] ?? "").padEnd(9, "0"));
}

/** Render integer nano-USD as a USD string with at least two decimals. Formats, never rounds. */
export function nanoToUsd(nano: number): string {
  if (!Number.isSafeInteger(nano)) {
    throw new Error(`not an integer nano-USD amount: ${nano}`);
  }
  const sign = nano < 0 ? "-" : "";
  const abs = Math.abs(nano);
  const whole = Math.floor(abs / NANO_USD_PER_USD);
  const fraction = String(abs % NANO_USD_PER_USD)
    .padStart(9, "0")
    .replace(/0+$/, "");
  const shown = fraction.length >= 2 ? fraction : fraction.padEnd(2, "0");
  return `${sign}${whole}.${shown}`;
}

/** USD per million tokens, as a provider publishes it (for example `"3.00"`). */
export interface TokenPrices {
  inputPerMTok: string;
  outputPerMTok: string;
  cacheReadPerMTok: string;
  cacheWritePerMTok: string;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function noTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Integer nano-USD for one token at a per-million price. Refuses a price finer than one nano. */
export function nanoPerToken(priceUsdPerMTok: string): number {
  const perMTok = usdToNano(priceUsdPerMTok);
  if (perMTok % 1_000_000 !== 0) {
    throw new Error(`price is finer than one nanoUSD per token: ${priceUsdPerMTok}`);
  }
  return perMTok / 1_000_000;
}

/** What one call cost at these prices, in integer nano-USD. */
export function costNanoUsd(prices: TokenPrices, tokens: TokenCounts): number {
  return (
    tokens.input * nanoPerToken(prices.inputPerMTok) +
    tokens.output * nanoPerToken(prices.outputPerMTok) +
    tokens.cacheRead * nanoPerToken(prices.cacheReadPerMTok) +
    tokens.cacheWrite * nanoPerToken(prices.cacheWritePerMTok)
  );
}

export function emptyUsage(): UsageTotals {
  return { tokens: noTokens(), costNanoUsd: 0, byModel: {} };
}

function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** `provider/model`. A provider name may not contain a slash, so the first slash splits the key. */
export function usageKey(provider: string, model: string): string {
  if (provider.includes("/")) {
    throw new Error(`provider name may not contain a slash: ${JSON.stringify(provider)}`);
  }
  return `${provider}/${model}`;
}

/** Add one call's usage, returning new totals with deterministically ordered keys. */
export function addUsage(totals: UsageTotals, event: UsageEvent): UsageTotals {
  const key = usageKey(event.provider, event.model);
  const existing = totals.byModel[key];
  const forModel: ModelUsage =
    existing === undefined
      ? {
          provider: event.provider,
          model: event.model,
          tokens: addTokens(noTokens(), event.tokens),
          costNanoUsd: event.costNanoUsd,
          calls: 1,
        }
      : {
          provider: existing.provider,
          model: existing.model,
          tokens: addTokens(existing.tokens, event.tokens),
          costNanoUsd: existing.costNanoUsd + event.costNanoUsd,
          calls: existing.calls + 1,
        };
  const byModel: Record<string, ModelUsage> = {};
  for (const name of [...Object.keys(totals.byModel), key].sort()) {
    const found = name === key ? forModel : totals.byModel[name];
    if (found !== undefined) {
      byModel[name] = found;
    }
  }
  return {
    tokens: addTokens(totals.tokens, event.tokens),
    costNanoUsd: totals.costNanoUsd + event.costNanoUsd,
    byModel,
  };
}

export interface SpendCheck {
  ok: boolean;
  spentNanoUsd: number;
  capNanoUsd: number;
  remainingNanoUsd: number;
  overByNanoUsd: number;
}

/** The threshold compare the run loop consults before each turn. Pure: it holds no budget. */
export function checkSpendCap(totals: UsageTotals, capNanoUsd: number): SpendCheck {
  if (!Number.isSafeInteger(capNanoUsd) || capNanoUsd < 0) {
    throw new Error(`not a spend cap in integer nano-USD: ${capNanoUsd}`);
  }
  const over = totals.costNanoUsd > capNanoUsd;
  return {
    ok: !over,
    spentNanoUsd: totals.costNanoUsd,
    capNanoUsd,
    remainingNanoUsd: over ? 0 : capNanoUsd - totals.costNanoUsd,
    overByNanoUsd: over ? totals.costNanoUsd - capNanoUsd : 0,
  };
}
