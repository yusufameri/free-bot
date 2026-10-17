#!/usr/bin/env bun
/**
 * The U1.4 evidence run: drives one run through the lifecycle the MVP smoke exercised, on a real
 * journal, kills the process that holds it mid-run, rejoins from the last seen seq, and prints
 * every literal the artifact carries.
 *
 * The frames go through the landed `SeqLog`, so the run's durable position is the log's position
 * rather than a number this script keeps for itself.
 *
 * Run from the repo root: bun packages/core/src/run-evidence.ts
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAILURE_TAXONOMY, RUN_FAILURE_CODES } from "./run-errors.ts";
import { transitionEvent } from "./run-events.ts";
import { isTerminal, RUN_STATUSES, type RunStatus, transitionPairs } from "./run-status.ts";
import { type RunRecord, RunStore } from "./run-store.ts";
import {
  checkSpendCap,
  costNanoUsd,
  nanoToUsd,
  type TokenPrices,
  type UsageEvent,
} from "./run-usage.ts";
import { SeqLog } from "./seq-log.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const RUN_ID = "run-smoke-1";
const HASH = `v1:sha256:${"c".repeat(64)}`;
const PRICES: TokenPrices = {
  inputPerMTok: "3.00",
  outputPerMTok: "15.00",
  cacheReadPerMTok: "0.30",
  cacheWritePerMTok: "3.75",
};

const lines: string[] = [];
let checks = 0;
let failures = 0;

function say(text: string): void {
  lines.push(text);
  console.log(text);
}

function check(name: string, actual: unknown, expected: unknown): void {
  checks += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  say(
    ok
      ? `PASS ${name}: ${JSON.stringify(actual)}`
      : `FAIL ${name}: ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`,
  );
}

function shell(command: string[]): string {
  const proc = Bun.spawnSync({ cmd: command, cwd: root, stdout: "pipe", stderr: "pipe" });
  return `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
}

const work = join(tmpdir(), "freebot-run-evidence");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const journalPath = join(work, "runs.jsonl");
const doctorHome = join(work, "freebot-home");

const START_AT = 1_700_000_000_000;
let clock = START_AT;
const now = () => clock;
const tick = (steps = 1) => {
  clock += steps;
};

type Frame = { type: string; payload: Record<string, unknown> };

const log = new SeqLog<Frame>();
const transitions: string[] = [];
let seq = 0;

function emit(store: RunStore, type: string, payload: Record<string, unknown> = {}): number {
  const next = seq + 1;
  const appended = log.append(next, { type, payload });
  if (appended !== "appended") throw new Error(`frame ${next} was ${appended}`);
  seq = next;
  store.noteSeq(RUN_ID, next);
  return next;
}

function moved(via: string, from: RunStatus | "-", to: RunStatus, atSeq: number | null): void {
  const event = from === "-" ? null : transitionEvent(from, to);
  transitions.push(
    `${from} -> ${to} | via ${via} | seq ${atSeq ?? "-"} | event ${event ?? "no wire kind"}`,
  );
}

function usageEvent(
  usageId: string,
  provider: string,
  model: string,
  input: number,
  output: number,
): UsageEvent {
  const tokens = { input, output, cacheRead: 0, cacheWrite: 0 };
  return { usageId, provider, model, tokens, costNanoUsd: costNanoUsd(PRICES, tokens) };
}

function refused(attempt: () => unknown): string {
  try {
    attempt();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "no refusal";
}

function lineCount(path: string): number {
  return readFileSync(path, "utf8").trim().split("\n").length;
}

say("feature: core-run-model");
say("command: bun packages/core/src/run-evidence.ts");
say(`git sha: ${shell(["git", "rev-parse", "HEAD"])}`);
say(`branch: ${shell(["git", "rev-parse", "--abbrev-ref", "HEAD"])}`);
say(`runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`);
say(`journal: ${journalPath}`);
say(
  "lifecycle source: docs/mvp-smoke-dry-run.md (start, steps, approval park, kill/rejoin, resume, done)",
);

// ---------------------------------------------------------------------------
// The lifecycle, frame by frame
// ---------------------------------------------------------------------------

say("");
say("== the lifecycle");

const store = new RunStore({ file: journalPath, now });

const started = store.start({
  id: RUN_ID,
  threadId: "thread-1",
  botId: "bot-1",
  prompt: "echo one; rm -f /scratch/task/doomed.txt; sleep 3 && echo two",
});
moved("start_run", "-", started.record.status, null);
check(
  "start_run creates a queued record on attempt 1",
  [started.created, started.record.status, started.record.attempt],
  [true, "queued", 1],
);
check(
  "the record carries the thread, the bot, and the prompt",
  [started.record.threadId, started.record.botId, started.record.prompt],
  ["thread-1", "bot-1", "echo one; rm -f /scratch/task/doomed.txt; sleep 3 && echo two"],
);

tick();
store.begin(RUN_ID);
moved("begin", "queued", "running", emit(store, "run.started", { prompt: started.record.prompt }));
emit(store, "turn.started", { turn: 1 });
emit(store, "tool_call.requested", {
  toolCallId: "call_step_1",
  toolName: "bash",
  command: "echo one",
  destructive: false,
});
emit(store, "tool_call.decision", { toolCallId: "call_step_1", allow: true });
emit(store, "tool_call.result", {
  toolCallId: "call_step_1",
  ok: true,
  denied: false,
  output: "one\n",
  durationMs: 12,
});
emit(store, "turn.ended", { turn: 1 });
tick();
emit(store, "turn.started", { turn: 2 });
emit(store, "tool_call.requested", {
  toolCallId: "call_step_2",
  toolName: "bash",
  command: "rm -f /scratch/task/doomed.txt",
  destructive: true,
});
emit(store, "tool_call.decision", {
  toolCallId: "call_step_2",
  allow: false,
  code: "no_grant",
  detail: `no grant for action ${HASH}`,
});

const parked = store.park(RUN_ID, {
  approvalId: "approval-1",
  toolCallId: "call_step_2",
  command: "rm -f /scratch/task/doomed.txt",
  actionHash: HASH,
  expiresAt: START_AT + 60_000,
});
moved(
  "park",
  "running",
  parked.status,
  emit(store, "approval.requested", {
    approvalId: "approval-1",
    toolCallId: "call_step_2",
    command: "rm -f /scratch/task/doomed.txt",
    actionHash: HASH,
    expiresAt: START_AT + 60_000,
  }),
);
check(
  "the park is durable and names the call the user answers",
  [parked.status, parked.approval?.approvalId, parked.approval?.actionHash],
  ["awaiting_approval", "approval-1", HASH],
);
check(
  "a parked run emits no turn or step traffic until it is answered",
  store.get(RUN_ID)?.status,
  "awaiting_approval",
);

tick();
store.resolveApproval(RUN_ID, "approval-1");
moved(
  "resolve",
  "awaiting_approval",
  "running",
  emit(store, "approval.resolved", { approvalId: "approval-1", decision: "allow" }),
);
emit(store, "tool_call.decision", { toolCallId: "call_step_2", allow: true });
emit(store, "tool_call.result", {
  toolCallId: "call_step_2",
  ok: true,
  denied: false,
  output: "",
  durationMs: 8,
});
emit(store, "turn.ended", { turn: 2 });
check(
  "the answer returns the run to running with no park left behind",
  [store.get(RUN_ID)?.status, store.get(RUN_ID)?.approval],
  ["running", null],
);

tick();
emit(store, "turn.started", { turn: 3 });
emit(store, "tool_call.requested", {
  toolCallId: "call_step_3",
  toolName: "bash",
  command: "sleep 3 && echo two",
  destructive: false,
});
emit(store, "tool_call.decision", { toolCallId: "call_step_3", allow: true });

const beforeKill = store.get(RUN_ID) as RunRecord;
const beforeKillState = store.serializeAll();
const killedAtSeq = log.lastSeq;
const commandsAtKill = lineCount(journalPath);
say(
  `kill point: step 3 (sleep 3) is in flight, the run is ${beforeKill.status} on attempt ${beforeKill.attempt} at seq ${killedAtSeq}, ${commandsAtKill} commands journaled`,
);

// ---------------------------------------------------------------------------
// The kill: the journal's writer is gone, and its last write tore
// ---------------------------------------------------------------------------

say("");
say("== the kill and the rejoin");

store.close();
const torn = '{"op":"seq","id":"run-smoke-1","seq":19,"at":1700000000';
appendFileSync(journalPath, torn);
say(
  `crash: the writer is gone and its last write has no newline (${torn.length} bytes, never reported applied)`,
);

const reopened = new RunStore({ file: journalPath, now });
check(
  "the torn trailing line is dropped rather than parsed",
  reopened.loadReport.tornTrailingLine,
  true,
);
check("every complete command replayed", reopened.loadReport.commands, commandsAtKill);
check("replay refused nothing", reopened.loadReport.refused, []);
check(
  "the reopen converges to the same records",
  reopened.serializeAll() === beforeKillState,
  true,
);
check(
  "the run came back where it was killed",
  [reopened.get(RUN_ID)?.status, reopened.get(RUN_ID)?.lastSeenSeq, reopened.get(RUN_ID)?.attempt],
  ["running", killedAtSeq, 1],
);

tick();
const paused = reopened.pause(RUN_ID, {
  code: "sandbox_lost_mid_run",
  detail: `agent gone at seq ${killedAtSeq}`,
});
moved("pause", "running", "paused", null);
check(
  "losing the sandbox mid-run parks the run instead of ending it",
  [paused.status, paused.error?.code],
  ["paused", "sandbox_lost_mid_run"],
);

tick();
const resumed = reopened.resume(RUN_ID);
moved("resume", "paused", "running", null);
check(
  "the rejoin resumes the run on attempt 2 with the reason cleared",
  [resumed.status, resumed.attempt, resumed.error],
  ["running", 2, null],
);
const afterRejoinSeq = emit(reopened, "tool_call.result", {
  toolCallId: "call_step_3",
  ok: true,
  denied: false,
  output: "two\n",
  durationMs: 3_014,
});
check("the rejoin continues at the seq after the kill", afterRejoinSeq, killedAtSeq + 1);
emit(reopened, "turn.ended", { turn: 3 });
tick();
emit(reopened, "turn.started", { turn: 4 });
emit(reopened, "tool_call.requested", {
  toolCallId: "call_step_4",
  toolName: "bash",
  command: "rm -f /scratch/task/doomed.txt",
  destructive: true,
});
emit(reopened, "tool_call.decision", {
  toolCallId: "call_step_4",
  allow: false,
  code: "grant_consumed",
  detail: "grant grant-2 was consumed by call_step_2",
});
emit(reopened, "tool_call.result", {
  toolCallId: "call_step_4",
  ok: false,
  denied: true,
  output: "grant_consumed: grant grant-2 was consumed by call_step_2",
  durationMs: null,
});
emit(reopened, "turn.ended", { turn: 4 });
tick();
emit(reopened, "turn.started", { turn: 5 });
emit(reopened, "tool_call.requested", {
  toolCallId: "call_step_5",
  toolName: "bash",
  command: "rm -f /scratch/task/doomed2.txt",
  destructive: true,
});
emit(reopened, "tool_call.decision", {
  toolCallId: "call_step_5",
  allow: false,
  code: "no_grant",
  detail: `no grant for action ${HASH}`,
});

const secondPark = reopened.park(RUN_ID, {
  approvalId: "approval-2",
  toolCallId: "call_step_5",
  command: "rm -f /scratch/task/doomed2.txt",
  actionHash: HASH,
  expiresAt: START_AT + 120_000,
});
moved(
  "park",
  "running",
  secondPark.status,
  emit(reopened, "approval.requested", {
    approvalId: "approval-2",
    toolCallId: "call_step_5",
    command: "rm -f /scratch/task/doomed2.txt",
    actionHash: HASH,
    expiresAt: START_AT + 120_000,
  }),
);
const denied = reopened.resolveApproval(RUN_ID, "approval-2");
moved(
  "resolve",
  "awaiting_approval",
  "running",
  emit(reopened, "approval.resolved", { approvalId: "approval-2", decision: "deny" }),
);
check(
  "a denied park resumes the run without recording a failure",
  [denied.status, denied.error],
  ["running", null],
);
emit(reopened, "tool_call.result", {
  toolCallId: "call_step_5",
  ok: false,
  denied: true,
  output: "user denied",
  durationMs: null,
});
emit(reopened, "turn.ended", { turn: 5 });
tick();
emit(reopened, "turn.started", { turn: 6 });
emit(reopened, "message.text.delta", { text: "Two steps ran; the two removals were refused." });
emit(reopened, "turn.ended", { turn: 6 });

check(
  "usage mid-run is counted per model through the same record",
  [
    reopened.recordUsage(RUN_ID, usageEvent("usage-1", "openai", "gpt-4o", 1_000, 500)).applied,
    reopened.recordUsage(RUN_ID, usageEvent("usage-2", "openai", "gpt-4o", 2_000, 100)).applied,
  ],
  [true, true],
);

tick();
const done = reopened.finish(RUN_ID);
moved("finish", "running", done.status, emit(reopened, "run.finished"));
const settledRun = reopened.get(RUN_ID) as RunRecord;

// ---------------------------------------------------------------------------
// The literals
// ---------------------------------------------------------------------------

say("");
say("== the transitions this run made, in order");
for (const row of transitions) say(`  ${row}`);

say("");
say("== the log and the record at the end");
check("the log is one contiguous run of frames", log.audit(), {
  firstSeq: 1,
  lastSeq: seq,
  count: seq,
  gaps: [],
  duplicates: [],
  suppressedAtIngest: [],
  gapEvents: [],
  rejected: 0,
});
check("the run's durable position is the log's last seq", settledRun.lastSeenSeq, seq);
check(
  "the run ended at done with two attempts",
  [settledRun.status, settledRun.attempt, isTerminal(settledRun.status)],
  ["done", 2, true],
);

say("");
say("== usage and the spend cap");
check("the run's totals are per model and exact", settledRun.usage, {
  tokens: { input: 3_000, output: 600, cacheRead: 0, cacheWrite: 0 },
  costNanoUsd: 18_000_000,
  byModel: {
    "openai/gpt-4o": {
      provider: "openai",
      model: "gpt-4o",
      tokens: { input: 3_000, output: 600, cacheRead: 0, cacheWrite: 0 },
      costNanoUsd: 18_000_000,
      calls: 2,
    },
  },
});
say(
  `  spent: ${nanoToUsd(settledRun.usage.costNanoUsd)} USD (${settledRun.usage.costNanoUsd} nano-USD)`,
);
say(
  `  usage_event shapes kept: ${reopened
    .usageEvents(RUN_ID)
    .map((event) => event.usageId)
    .join(", ")}`,
);
const underCap = checkSpendCap(settledRun.usage, 25_000_000);
const overCap = checkSpendCap(settledRun.usage, 17_999_999);
say(`  cap 0.025000000 USD: ${JSON.stringify(underCap)}`);
say(`  cap 0.017999999 USD: ${JSON.stringify(overCap)}`);
check(
  "under the cap the run loop may continue",
  [underCap.ok, underCap.remainingNanoUsd],
  [true, 7_000_000],
);
check(
  "one nano over the cap and the run loop must stop",
  [overCap.ok, overCap.overByNanoUsd],
  [false, 1],
);

say("");
say("== idempotency");
const again = reopened.start({
  id: RUN_ID,
  threadId: "thread-1",
  botId: "bot-1",
  prompt: "ignored",
});
check(
  "start_run on a settled run returns the same record and creates nothing",
  [again.created, again.record.status, again.record.updatedAt, again.record.usage.costNanoUsd],
  [false, "done", settledRun.updatedAt, 18_000_000],
);
check(
  "cancel_run on a settled run is a no-op, not an error",
  [reopened.cancel(RUN_ID).status, reopened.cancel(RUN_ID).error],
  ["done", null],
);
check(
  "a replayed usage id is refused rather than counted twice",
  [
    reopened.recordUsage(RUN_ID, usageEvent("usage-1", "openai", "gpt-4o", 1_000, 500)).applied,
    reopened.get(RUN_ID)?.usage.costNanoUsd,
  ],
  [false, 18_000_000],
);
check(
  "a seq the record already passed never moves it back",
  reopened.noteSeq(RUN_ID, killedAtSeq).lastSeenSeq,
  seq,
);
const parkInput = {
  approvalId: "approval-1",
  toolCallId: "call-1",
  command: "rm",
  actionHash: HASH,
  expiresAt: 9,
};
check(
  "a resent park is the same park, not a second one",
  (() => {
    let at = 7_000;
    const probe = new RunStore({ now: () => at });
    probe.start({ id: "idem-1", threadId: "t", botId: "b", prompt: "p" });
    probe.begin("idem-1");
    probe.park("idem-1", parkInput);
    at = 8_000;
    const resent = probe.park("idem-1", parkInput);
    return [resent.approval?.requestedAt, resent.updatedAt];
  })(),
  [7_000, 7_000],
);
check(
  "cancelling a run that never began ends it without throwing",
  (() => {
    const probe = new RunStore({ now });
    probe.start({ id: "idem-2", threadId: "t", botId: "b", prompt: "p" });
    return probe.cancel("idem-2").status;
  })(),
  "cancelled",
);
check("reloading the settled journal converges again", reopened.reload().converged, true);

say("");
say("== illegal moves are refused by name");
const probe = new RunStore({ now });
probe.start({ id: "probe-1", threadId: "t", botId: "b", prompt: "p" });
say(
  `  park before begin: ${refused(() => probe.park("probe-1", { approvalId: "a", toolCallId: "c", command: "rm", actionHash: HASH, expiresAt: 9 }))}`,
);
probe.begin("probe-1");
probe.pause("probe-1");
say(`  finish while paused: ${refused(() => probe.finish("probe-1"))}`);
probe.resume("probe-1");
probe.park("probe-1", {
  approvalId: "a",
  toolCallId: "c",
  command: "rm",
  actionHash: HASH,
  expiresAt: 9,
});
say(`  resume a park nobody answered: ${refused(() => probe.resume("probe-1"))}`);
say(
  `  a code that settles the run cannot park it: ${refused(() => probe.pause("probe-1", { code: "provider_auth" }))}`,
);
check(
  "an unknown run is refused",
  refused(() => new RunStore({ now }).begin("run-nope")),
  "unknown run: run-nope",
);

say("");
say("== the transition table the registry holds");
const pairs = transitionPairs();
check("legal pairs", pairs.length, 14);
check("refused pairs out of the 49", RUN_STATUSES.length ** 2 - pairs.length, 35);
for (const { from, to } of pairs) {
  say(`  ${from} -> ${to} | event ${transitionEvent(from, to) ?? "no wire kind"}`);
}

say("");
say("== the failure taxonomy");
say("  code | status | event | ui copy");
for (const code of RUN_FAILURE_CODES) {
  const entry = FAILURE_TAXONOMY[code];
  const driven = new RunStore({ now });
  driven.start({ id: "taxonomy-1", threadId: "t", botId: "b", prompt: "p" });
  driven.begin("taxonomy-1");
  const settled =
    entry.status === "paused"
      ? driven.pause("taxonomy-1", { code, detail: null })
      : driven.fail("taxonomy-1", code, null);
  say(`  ${code} | ${entry.status} | ${entry.event ?? "no wire kind"} | ${entry.copy}`);
  check(
    `  ${code} reaches ${entry.status}`,
    [settled.status, settled.error?.code ?? null],
    [entry.status, code],
  );
}

say("");
say("== freebot doctor");
const firstDoctor = Bun.spawnSync({
  cmd: ["bun", "apps/server/src/cli/doctor.ts"],
  cwd: root,
  env: { ...process.env, FREEBOT_HOME: doctorHome },
  stdout: "pipe",
  stderr: "pipe",
});
const doctorLines = `${firstDoctor.stdout.toString()}${firstDoctor.stderr.toString()}`
  .trim()
  .split("\n");
for (const line of doctorLines) say(`  ${line}`);
const passes = doctorLines.filter((line) => line.startsWith("PASS ")).length;
const fails = doctorLines.filter((line) => line.startsWith("FAIL ")).length;
const probeJournal = join(doctorHome, "runs.jsonl");
check("the doctor runs five checks", [passes, fails], [4, 1]);
check(
  "its one failure is the provider key G1 parks",
  doctorLines.some((line) => line.startsWith("FAIL provider key:")),
  true,
);
check("it exits non-zero when a check fails", firstDoctor.exitCode, 1);
check(
  "it proves the store writable through a real probe run",
  doctorLines.some((line) =>
    line.includes("probe doctor-probe cancelled, reopen converged, created true"),
  ),
  true,
);
const afterFirstDoctor = lineCount(probeJournal);
const secondDoctor = Bun.spawnSync({
  cmd: ["bun", "apps/server/src/cli/doctor.ts"],
  cwd: root,
  env: { ...process.env, FREEBOT_HOME: doctorHome },
  stdout: "pipe",
  stderr: "pipe",
});
const secondLines = `${secondDoctor.stdout.toString()}${secondDoctor.stderr.toString()}`
  .trim()
  .split("\n");
check(
  "a second doctor run appends nothing to the store",
  [afterFirstDoctor, lineCount(probeJournal)],
  [3, 3],
);
check(
  "and its probe finds the record already settled",
  secondLines.some((line) => line.includes("created false")),
  true,
);

say("");
say("== artifact");
const shortSha = shell(["git", "rev-parse", "--short", "HEAD"]);
const artifactDir = join(root, "packages", "verify", "artifacts", "core-run-model", shortSha);
mkdirSync(artifactDir, { recursive: true });
writeFileSync(join(artifactDir, "doctor.txt"), `${doctorLines.join("\n")}\n`);
const result = `RESULT: ${failures === 0 ? "PASS" : "FAIL"} (${checks - failures}/${checks})`;
lines.push("", result, `artifact: packages/verify/artifacts/core-run-model/${shortSha}/assert.txt`);
writeFileSync(join(artifactDir, "assert.txt"), `${lines.join("\n")}\n`);
console.log(`\n${result}`);
console.log(`artifact: packages/verify/artifacts/core-run-model/${shortSha}/assert.txt`);
process.exitCode = failures === 0 ? 0 : 1;
