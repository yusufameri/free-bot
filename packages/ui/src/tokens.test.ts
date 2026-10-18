/**
 * The token table, held to the export's values.
 *
 * Two claims are asserted here. The values are the export's, typed out again as literals so an edit
 * to `tokens.ts` that drifts one fails in CI rather than shipping. And every file with a marked
 * token block is byte-identical to what the emitter writes, so the page and the contract document
 * cannot disagree with the table. `packages/verify/scripts/design-contract.ts` is the third check:
 * it reads the same names out of the live page and out of the export in the same browser, and prints
 * a delta per name.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  HTML_TOKENS,
  spliceTokens,
  TOKEN_SOURCE,
  TOKEN_TARGETS,
  TOKENS,
  tokenValue,
} from "./tokens.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");

/** The export's `:root` block from `freebot-prototype.html` lines 12 to 38, literal. */
const EXPORTED: Readonly<Record<string, string>> = {
  "--bg": "#000000",
  "--surface": "#0a0a0a",
  "--fg": "#ffffff",
  "--muted": "#737373",
  "--border": "#242424",
  "--accent": "#000000",
  "--accent-2": "#0f172a",
  "--hover": "color-mix(in oklch, var(--fg) 7%, transparent)",
  "--hover-2": "color-mix(in oklch, var(--fg) 12%, transparent)",
  "--fg-soft": "color-mix(in oklch, var(--fg) 5%, transparent)",
  "--muted-2": "color-mix(in oklch, var(--muted) 45%, transparent)",
  "--font-display":
    "'Geist', 'Geist Sans', system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  "--font-body":
    "'Geist', 'Geist Sans', system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  "--font-mono": "ui-monospace, 'Geist Mono', 'SF Mono', Menlo, Consolas, monospace",
  "--fs-h1": "clamp(30px, 4.4vw, 46px)",
  "--fs-h2": "24px",
  "--fs-h3": "17px",
  "--fs-body": "15px",
  "--fs-meta": "12.5px",
  "--radius": "8px",
  "--aside-w": "384px",
  "--sb-w": "264px",
};

/** The motion names, which the export does not carry: its durations written literally in rules. */
const DERIVED: Readonly<Record<string, string>> = {
  "--dur-fast": "0.12s",
  "--dur": "0.15s",
  "--dur-slow": "0.18s",
  "--dur-enter": "0.25s",
  "--dur-pulse": "1.5s",
  "--dur-spin": "1s",
  "--ease": "ease",
};

describe("the token table", () => {
  test("carries the export's values, one literal at a time", () => {
    for (const [name, value] of Object.entries(EXPORTED)) {
      expect([name, tokenValue(name)]).toEqual([name, value]);
    }
  });

  test("names the export's values as export tokens and the motion as derived", () => {
    const named = TOKENS.filter((token) => token.origin === "export").map((token) => token.name);
    const derived = TOKENS.filter((token) => token.origin === "derived").map((token) => token.name);
    expect(named.sort()).toEqual(Object.keys(EXPORTED).sort());
    expect(derived.sort()).toEqual(Object.keys(DERIVED).sort());
  });

  test("derives every motion name from a line the export writes", () => {
    for (const [name, value] of Object.entries(DERIVED)) {
      expect([name, tokenValue(name)]).toEqual([name, value]);
    }
    const motion = TOKENS.filter((token) => token.origin === "derived");
    for (const token of motion) {
      expect([token.name, token.source.startsWith("freebot-prototype.html:")]).toEqual([
        token.name,
        true,
      ]);
    }
  });

  test("every token names a line of the export it was read from", () => {
    for (const token of TOKENS) {
      expect([token.name, token.source.startsWith(`${TOKEN_SOURCE}:`)]).toEqual([token.name, true]);
    }
  });

  test("no value can break the Markdown table it is rendered into", () => {
    for (const token of TOKENS) {
      expect([token.name, token.value.includes("|")]).toEqual([token.name, false]);
    }
  });

  test("refuses a name it does not hold", () => {
    expect(() => tokenValue("--not-a-token")).toThrow("no token named --not-a-token");
  });
});

describe("the generated token blocks", () => {
  for (const target of TOKEN_TARGETS) {
    test(`${target.path} matches the table`, () => {
      const text = readFileSync(`${root}/${target.path}`, "utf8");
      const generated = spliceTokens(target, text);
      const firstDrift = text.split("\n").findIndex((line, i) => line !== generated.split("\n")[i]);
      expect([target.path, firstDrift]).toEqual([target.path, -1]);
      expect(spliceTokens(target, generated)).toEqual(generated);
    });
  }

  test("a file with no markers is refused rather than silently accepted", () => {
    expect(() => spliceTokens(HTML_TOKENS, "<style>\n</style>\n")).toThrow(
      `${HTML_TOKENS.path}: no /* tokens:begin ... tokens:end block`,
    );
  });
});
