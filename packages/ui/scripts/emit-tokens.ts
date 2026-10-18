#!/usr/bin/env bun
/**
 * The token lever: write every file's marked token block from `packages/ui/src/tokens.ts`, or check
 * that they already match it.
 *
 * `tokens.test.ts` runs the same comparison as `--check`, so a drifted block fails `bun run test`.
 * This script is the other half: the command a person runs to fix the drift rather than edit tokens
 * by hand.
 *
 * Run from the repo root: `bun packages/ui/scripts/emit-tokens.ts --check`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spliceTokens, TOKEN_TARGETS } from "../src/tokens.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const write = process.argv.includes("--write");

let failed = 0;
for (const target of TOKEN_TARGETS) {
  const path = join(root, target.path);
  const current = readFileSync(path, "utf8");
  const generated = spliceTokens(target, current);
  if (generated === current) {
    console.log(`ok   ${target.path}: matches packages/ui/src/tokens.ts`);
    continue;
  }
  if (write) {
    writeFileSync(path, generated);
    console.log(`wrote ${target.path}`);
    continue;
  }
  failed += 1;
  console.log(`FAIL ${target.path}: differs from packages/ui/src/tokens.ts`);
  for (const line of firstDifference(current, generated)) console.log(line);
}

if (!write) {
  console.log(failed === 0 ? "PASS design-tokens" : `FAIL design-tokens (${failed})`);
}
process.exitCode = failed === 0 ? 0 : 1;

/** The first few lines the two texts disagree on, so the drift names itself. */
function firstDifference(current: string, generated: string): string[] {
  const a = current.split("\n");
  const b = generated.split("\n");
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < 6; i++) {
    if (a[i] === b[i]) continue;
    out.push(`  line ${i + 1}:`);
    out.push(`    file:      ${JSON.stringify(a[i] ?? "<missing>")}`);
    out.push(`    generated: ${JSON.stringify(b[i] ?? "<missing>")}`);
  }
  return out;
}
