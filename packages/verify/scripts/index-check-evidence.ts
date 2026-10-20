#!/usr/bin/env bun
/**
 * The index checker's own evidence run.
 *
 * It copies `docs/verification/` to a temp directory, rewrites the launch row's count from 116/116
 * to 114, runs the checker against that record, then runs it against the committed record. The
 * artifact records both outputs and their exit codes: the planted run fails by row name with the
 * two counts it compared, and the committed run passes.
 *
 * Run from the repo root: `bun packages/verify/scripts/index-check-evidence.ts`. It writes
 * `packages/verify/artifacts/index-check/<short-sha>/assert.txt`.
 */

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const feature = "index-check";
const checker = join(repoRoot, "packages/verify/scripts/index-check.ts");

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString().trim()}`);
  return proc.stdout.toString().trim();
}

function run(record: string): { code: number; output: string } {
  const proc = Bun.spawnSync(["bun", checker, "--record", record], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? 1,
    output: `${proc.stdout.toString()}${proc.stderr.toString()}`.trim(),
  };
}

const planted = mkdtempSync(join(tmpdir(), "freebot-record-planted-"));
cpSync(join(repoRoot, "docs", "verification"), planted, { recursive: true });

let plantedFile = "";
for (const name of readdirSync(planted)) {
  if (!name.endsWith(".md") || name === "README.md") continue;
  const path = join(planted, name);
  const text = readFileSync(path, "utf8");
  if (!text.includes("feature: launch (U10.13)\n")) continue;
  writeFileSync(path, text.replace("116/116 checks", "114 checks"));
  plantedFile = name;
}
if (plantedFile === "") throw new Error("the launch (U10.13) row was not found");

const sha = git(["rev-parse", "HEAD"]);
const shortSha = git(["rev-parse", "--short", "HEAD"]);
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const plantedRun = run(planted);
const committedRun = run(join(repoRoot, "docs", "verification"));

const checks: Array<[string, boolean]> = [
  ["the planted record exits 1", plantedRun.code === 1],
  ["the planted run names the launch row", plantedRun.output.includes('row "launch (U10.13)"')],
  ["the planted run quotes the claimed 114", plantedRun.output.includes("claimed 114 checks")],
  [
    "the planted run quotes the artifact's 116/116",
    plantedRun.output.includes("artifact says 116/116"),
  ],
  ["the committed record exits 0", committedRun.code === 0],
  ["the committed run ends PASS", committedRun.output.includes("RESULT: PASS")],
];

const report = [
  `feature: ${feature}`,
  "command: bun packages/verify/scripts/index-check-evidence.ts",
  `timestamp: ${new Date().toISOString()}`,
  `git sha: ${sha}`,
  `git sha short: ${shortSha}`,
  `branch: ${branch}`,
  `planted row: ${plantedFile} (docs/verification/ copied to a temp directory, 116/116 rewritten to 114)`,
  "",
  "== planted mismatch ==",
  `$ bun packages/verify/scripts/index-check.ts --record ${planted}`,
  `exit ${plantedRun.code}`,
  plantedRun.output,
  "",
  "== the committed record ==",
  "$ bun packages/verify/scripts/index-check.ts --record docs/verification",
  `exit ${committedRun.code}`,
  committedRun.output,
  "",
  "== checks ==",
  ...checks.map(([label, ok]) => `${ok ? "PASS" : "FAIL"} ${label}`),
  "",
  `RESULT: ${checks.every(([, ok]) => ok) ? "PASS" : "FAIL"} (${checks.filter(([, ok]) => ok).length}/${checks.length})`,
  "",
].join("\n");

const dir = join(repoRoot, "packages/verify/artifacts", feature, shortSha);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "assert.txt"), report);

console.log(`artifact: packages/verify/artifacts/${feature}/${shortSha}/assert.txt`);
console.log(
  `RESULT: ${checks.every(([, ok]) => ok) ? "PASS" : "FAIL"} (${checks.filter(([, ok]) => ok).length}/${checks.length})`,
);
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
