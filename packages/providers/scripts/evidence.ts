#!/usr/bin/env bun
/**
 * The providers evidence run: every gate, then the literal capability table, the malformed
 * tool-call shapes, the client error shapes, and the fallback's success and failure literals.
 *
 * Writes `packages/verify/artifacts/providers/<short-sha>/assert.txt`. Every observation line is
 * labelled `[replay]` (scripted transport or the committed replay transcript) or `[live]` (a real
 * provider). The gate is deterministic: the smoke step asks for `--replay`, so it takes one path
 * whether or not a key exists. Gate G1 is open, so the artifact reports `live-probe: AVAILABLE` and
 * prints the live command beside the replay result; running the smoke live is a deliberate, separate
 * step and is not part of the gate.
 *
 * Run from the repo root: `bun packages/providers/scripts/evidence.ts`.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactDir } from "@freebot/verify";
import { formatFlags } from "../src/flags.ts";
import { probeReplayFixture } from "../src/probe.ts";
import { errorShapeCases, fallbackCases, malformedToolCallCases, statusCases } from "./cases.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const feature = "providers";
const fixture = join(root, "packages/pi-bridge/fixtures/rpc-handshake.jsonl");
const vaultPath = join(homedir(), ".freebot", "provider.env");

interface Outcome {
  ok: boolean;
  output: string;
  parked?: boolean;
}

function run(command: string[]): Outcome {
  const proc = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const output = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
  return { ok: proc.exitCode === 0, output };
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return proc.stdout.toString().trim();
}

function tail(text: string, max = 12): string {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-max)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

const steps: Array<{ name: string; step: () => Outcome }> = [
  { name: "lint", step: () => run(["bun", "run", "lint"]) },
  { name: "typecheck", step: () => run(["bun", "run", "typecheck"]) },
  {
    name: "typecheck-providers",
    step: () => run(["bunx", "tsc", "--noEmit", "-p", "packages/providers/tsconfig.json"]),
  },
  { name: "tests", step: () => run(["bun", "test", "packages/providers"]) },
  { name: "verify", step: () => run(["bun", "run", "verify"]) },
  // `--replay` pins the path. Without it, a key anywhere on the machine selects live mode, which
  // needs a base URL and a model, so the gate would depend on whether a key exists.
  {
    name: "smoke-replay",
    step: () => run(["bun", "packages/providers/scripts/smoke.ts", "--replay"]),
  },
];

const outcomes: Array<{ name: string; outcome: Outcome }> = [];
for (const { name, step } of steps) {
  let outcome: Outcome;
  try {
    outcome = step();
  } catch (error) {
    outcome = { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
  outcomes.push({ name, outcome });
}

// `bun run verify` writes a scaffold artifact for the current sha. This unit's scope is its own
// artifact directory, so the one this run created is removed again and the removal is reported.
const scaffoldDir = join(
  root,
  "packages/verify/artifacts/scaffold",
  git(["rev-parse", "--short", "HEAD"]),
);
const scaffoldRemoved = existsSync(scaffoldDir);
if (scaffoldRemoved) rmSync(scaffoldDir, { recursive: true, force: true });

// The live half runs on G1. Presence only: no key value is read into this process.
const envKeyPresent = (process.env.FREEBOT_BYOK_KEY ?? "").length > 0;
const vaultKeyPresent =
  existsSync(vaultPath) &&
  Bun.spawnSync(["grep", "-q", "^FREEBOT_BYOK_KEY=", vaultPath]).exitCode === 0;
const liveReady = envKeyPresent || vaultKeyPresent;
const smokeStep = outcomes.find((entry) => entry.name === "smoke-replay");

// ---------------------------------------------------------------------------
// The literal observations
// ---------------------------------------------------------------------------

const probe = await probeReplayFixture(fixture);
const flagLines = formatFlags(probe.flags).map((line) => `[replay] ${line}`);
const noteLines = probe.flags.notes.map((note) => `[replay] note: ${note}`);
const observed = probe.observation;

const rowLines = (
  rows: ReadonlyArray<{ line: string; ok: boolean }>,
): { lines: string[]; ok: boolean } => ({
  lines: rows.map((row) => `[replay] ${row.ok ? "" : "FAIL "}${row.line}`),
  ok: rows.every((row) => row.ok),
});

const malformed = rowLines(malformedToolCallCases());
const errors = rowLines([...statusCases(), ...(await errorShapeCases())]);
const fallback = rowLines(await fallbackCases());

// ---------------------------------------------------------------------------
// Key scan: this artifact and the package source
// ---------------------------------------------------------------------------

const KEY_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "openai-style sk- token", pattern: /sk-[A-Za-z0-9_-]{8,}/g },
  { name: "assigned FREEBOT_BYOK_KEY value", pattern: /FREEBOT_BYOK_KEY=[A-Za-z0-9_-]{8,}/g },
];

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

function sourceHits(): string[] {
  const hits: string[] = [];
  for (const file of walk(join(root, "packages/providers"))) {
    if (file.includes("/node_modules/")) continue;
    const text = readFileSync(file, "utf8");
    for (const { name, pattern } of KEY_PATTERNS) {
      if (pattern.test(text)) hits.push(`${file.replace(`${root}/`, "")}: ${name}`);
      pattern.lastIndex = 0;
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const sha = git(["rev-parse", "HEAD"]);
const shortSha = git(["rev-parse", "--short", "HEAD"]);
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);

const head = [
  `feature: ${feature}`,
  `command: bun packages/providers/scripts/evidence.ts`,
  `timestamp: ${new Date().toISOString()}`,
  `git sha: ${sha}`,
  `git sha short: ${shortSha}`,
  `branch: ${branch}`,
  `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
  "",
  ...outcomes.map((entry) => `step ${entry.name}: ${entry.outcome.ok ? "PASS" : "FAIL"}`),
  `step live-probe: ${liveReady ? "AVAILABLE (G1 BYOK key present; the smoke gate stays on --replay)" : "PARKED (G1 BYOK key absent)"}`,
  `step verify-scope: ${scaffoldRemoved ? "removed the scaffold artifact dir this run wrote (outside this unit's artifact scope)" : "nothing to remove"}`,
  "",
];

const failedOutputs = outcomes
  .filter((entry) => !entry.outcome.ok)
  .flatMap((entry) => [`--- failed step ${entry.name} ---`, tail(entry.outcome.output, 40), ""]);

const sections = [
  "== the gate's smoke step [replay] ==",
  "command: bun packages/providers/scripts/smoke.ts --replay",
  ...(smokeStep?.outcome.output.split("\n") ?? ["(the step did not run)"]),
  "",
  "== capability flags, replay mode [replay] ==",
  `fixture: ${fixture.replace(`${root}/`, "")}`,
  probe.recorded === null
    ? "connection: unrecorded"
    : `connection (from the recording): provider=${probe.recorded.provider} model=${probe.recorded.modelId} baseUrl=${probe.recorded.baseUrl} keyPresent=false`,
  ...flagLines,
  ...noteLines,
  `[replay] observed turn: toolCalls=${observed.toolCallsCompleted} names=${observed.toolNames.join(",")} textDeltas=${observed.textDeltas} toolCallDeltas=${observed.toolCallDeltas} assistantMessages=${observed.assistantMessages} executions=${observed.executions.map((execution) => `${execution.toolName}:${execution.isError ? "error" : "ok"}`).join(",")} settled=${observed.settled}`,
  `[replay] commands written: ${probe.sent.join(" | ")}`,
  "",
  "== malformed tool-call shapes [replay] ==",
  ...malformed.lines,
  "",
  "== client error shapes, scripted transport [replay] ==",
  ...errors.lines,
  "",
  "== structured fallback: prompt and parse [replay] ==",
  ...fallback.lines,
  "",
  "== live probe [live] ==",
  liveReady
    ? "G1 is OPEN and the machine holds a key, so the live half can run. What that changes: the smoke selects live mode by default when a key is present, so the gate's smoke step asks for --replay instead. The gate therefore passes with or without a key, and the live path below is deliberate (presence-only check; no key was read, requested, or logged)."
    : "parked: G1 BYOK key absent (presence-only check; no key was read, requested, or logged)",
  "live command: bun packages/providers/scripts/smoke.ts <baseUrl> <model>",
  "  baseUrl and model come from FREEBOT_BYOK_BASE_URL and FREEBOT_BYOK_MODEL; the key stays in",
  "  ~/.freebot/provider.env and is interpolated by Pi's own !command support (order 8).",
  "",
];

const failures = [
  ...outcomes.filter((entry) => !entry.outcome.ok).map((entry) => entry.name),
  ...(malformed.ok ? [] : ["malformed-tool-call cases"]),
  ...(errors.ok ? [] : ["client error cases"]),
  ...(fallback.ok ? [] : ["fallback cases"]),
];

const scanned = [...head, ...sections].join("\n");
const artifactHits = KEY_PATTERNS.flatMap(({ name, pattern }) =>
  [...scanned.matchAll(pattern)].map(() => `artifact: ${name}`),
);
const hits = [...sourceHits(), ...artifactHits];
if (hits.length > 0) failures.push("key-scan");

const ok = failures.length === 0;
const report = [
  ...head,
  `${ok ? "PASS" : "FAIL"} providers gates${ok ? "" : ` (failed: ${failures.join(", ")})`}`,
  `step key-scan: ${hits.length === 0 ? "PASS (0 key values in this artifact and packages/providers)" : `FAIL (${hits.length} hits: ${hits.join(", ")})`}`,
  "",
  ...failedOutputs,
  ...sections,
].join("\n");

const dir = artifactDir(root, feature, shortSha);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "assert.txt"), report);

for (const { name, outcome } of outcomes) {
  console.log(`${outcome.ok ? "PASS" : "FAIL"} step ${name}`);
  if (!outcome.ok) console.log(tail(outcome.output, 20));
}
console.log(`step live-probe: ${liveReady ? "AVAILABLE" : "PARKED (G1 BYOK key absent)"}`);
console.log(`step key-scan: ${hits.length === 0 ? "PASS (0 hits)" : `FAIL (${hits.length} hits)`}`);
console.log(`artifact: packages/verify/artifacts/${feature}/${shortSha}/assert.txt`);
console.log(`${ok ? "PASS" : "FAIL"} ${feature}`);
process.exitCode = ok ? 0 : 1;
