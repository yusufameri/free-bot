#!/usr/bin/env bun
/**
 * The unit's verify runner: runs every gate, then writes
 * `packages/verify/artifacts/protocol/<short-sha>/assert.txt` with the literal results,
 * including the rejection list and the replay audit.
 *
 * Run from the repo root: bun packages/protocol/scripts/verify.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runRejections } from "./rejections.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const feature = "protocol";

type Outcome = { ok: boolean; output: string };

function run(command: string[]): Outcome {
  const proc = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const output = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
  return { ok: proc.exitCode === 0, output };
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root });
  return proc.stdout.toString().trim();
}

function tail(text: string, max = 12): string {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(-max).join("\n");
}

/** Steps whose output belongs in the report even when they pass. */
const steps: Array<{ name: string; step: () => Outcome; show: boolean }> = [
  { name: "lint", step: () => run(["bun", "run", "lint"]), show: false },
  { name: "typecheck", step: () => run(["bun", "run", "typecheck"]), show: false },
  {
    name: "typecheck-protocol-scripts",
    step: () => run(["bunx", "tsc", "-p", "packages/protocol/tsconfig.json"]),
    show: false,
  },
  { name: "tests", step: () => run(["bun", "test", "packages/protocol"]), show: false },
  {
    name: "spike-compat",
    step: () => run(["bun", "test", "packages/protocol/src/spike-compat.test.ts"]),
    show: true,
  },
  {
    name: "spike-fixture",
    step: () => run(["bun", "packages/protocol/scripts/spike-fixture.ts", "--check"]),
    show: true,
  },
  {
    name: "rejections",
    step: () => run(["bun", "packages/protocol/scripts/rejections.ts"]),
    show: false,
  },
  {
    name: "replay",
    step: () => run(["bun", "packages/protocol/scripts/replay-spike.ts"]),
    show: false,
  },
];

const outcomes: Array<{ name: string; outcome: Outcome; show: boolean }> = [];
for (const { name, step, show } of steps) {
  const outcome = step();
  outcomes.push({ name, outcome, show });
  console.log(`${outcome.ok ? "PASS" : "FAIL"} step ${name}`);
  if (!outcome.ok) console.log(tail(outcome.output, 20));
}

const rows = runRejections();
const rejectionList = rows.flatMap((row) => [
  `${row.ok ? "PASS" : "FAIL"}  ${row.schema.padEnd(10)} ${row.name}`,
  `      ${row.actual}`,
]);

const ok = outcomes.every((entry) => entry.outcome.ok) && rows.every((row) => row.ok);
const sha = git(["rev-parse", "HEAD"]);
const shortSha = git(["rev-parse", "--short", "HEAD"]);
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const replayPath = join(
  root,
  "packages",
  "verify",
  "artifacts",
  feature,
  shortSha,
  "replay-audit.txt",
);
const replay = readFileSync(replayPath, "utf8").trim();

const report = [
  `feature: ${feature}`,
  "command: bun packages/protocol/scripts/verify.ts",
  `timestamp: ${new Date().toISOString()}`,
  `git sha: ${sha}`,
  `git sha short: ${shortSha}`,
  `branch: ${branch}`,
  `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
  "",
  ...outcomes.map((entry) => `step ${entry.name}: ${entry.outcome.ok ? "PASS" : "FAIL"}`),
  ...outcomes
    .filter((entry) => !entry.outcome.ok)
    .flatMap((entry) => ["", `--- failed step ${entry.name} ---`, entry.outcome.output]),
  ...outcomes
    .filter((entry) => entry.show && entry.outcome.ok)
    .flatMap((entry) => [
      "",
      `--- step ${entry.name} (output) ---`,
      "",
      tail(entry.outcome.output, 24),
    ]),
  "",
  `--- rejection list (${rows.length} cases, case + literal first issue) ---`,
  "",
  ...rejectionList,
  "",
  "--- replay demo (packages/protocol/scripts/replay-spike.ts) ---",
  "",
  replay,
  "",
  `${ok ? "PASS" : "FAIL"} ${feature}`,
  "",
].join("\n");

const dir = join(root, "packages", "verify", "artifacts", feature, shortSha);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "assert.txt"), report);

console.log(`artifact: packages/verify/artifacts/${feature}/${shortSha}/assert.txt`);
console.log(`${ok ? "PASS" : "FAIL"} ${feature}`);
process.exitCode = ok ? 0 : 1;
