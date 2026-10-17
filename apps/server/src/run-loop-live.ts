#!/usr/bin/env bun
/**
 * The U1.7 evidence run: one run, executed end to end through the landed parts.
 *
 * Real: the pinned sandbox image and a real container from it, the loop, the gate and the grant
 * ledger, the execution of the approved call inside the container, the run store, and the
 * seq-ordered log. Replayed: the model's turns, read out of the committed Pi transcript. This is
 * the recorded half of the run loop's evidence, and it stays recorded on purpose: it proves the
 * gate, the ledger and the container against a fixed turn, which a live model cannot (order 9). The
 * live half is `packages/verify/scripts/keyed-run.ts`, which drives `bun run up` and the page and
 * asserts the model's own turns. The human's two answers are scripted here; the keyed driver answers
 * them from the page's own buttons.
 *
 * Run from the repo root: bun apps/server/src/run-loop-live.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ApprovalAnswer,
  type ApprovalRequest,
  type ProviderToolCall,
  type ProviderTurn,
  RunStore,
  runRunLoop,
  type SeqAudit,
  SeqLog,
} from "@freebot/core";
import { type EventMessage, parseMessage, serializeMessage } from "@freebot/protocol";
import { canonicalActionHash, GrantStore } from "@freebot/review";
import {
  DockerAdapter,
  ensurePinnedImage,
  PINNED_IMAGE,
  type SandboxHandle,
} from "@freebot/sandbox";
import { ReplayProvider, readTranscript, turnForTool, turnsInBlock } from "./replay-provider.ts";
import {
  createLogPort,
  createReviewGate,
  DockerRunSandbox,
  RUN_UNIT,
  runToolDefinitions,
} from "./run-ports.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const RUN_ID = "run-u1.7";
const TRANSCRIPT = join(root, "packages/pi-bridge/fixtures/rpc-handshake.jsonl");
const DECOY_UNIT = "u17-decoy";
const IDLE_TTL_MS = 300_000;

/** The second call. The recording holds one governed call, and the refusal path needs a second. */
const SCRIPTED_DENY_CALL: ProviderToolCall = {
  toolCallId: "u17-call-2",
  toolName: "bash",
  args: { command: "rm -rf /tmp/u17-doomed" },
  destructive: true,
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

/** One docker call, for the proofs that must be read outside the loop. */
function docker(args: readonly string[]): string {
  const proc = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  return `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
}

function containersFor(unit: string): string[] {
  const raw = docker([
    "ps",
    "-a",
    "--filter",
    `label=freebot.unit=${unit}`,
    "--format",
    "{{.Names}}",
  ]);
  return raw === "" ? [] : raw.split("\n").filter((name) => name.length > 0);
}

let clock = Date.UTC(2026, 9, 17, 12, 0, 0);
const now = () => (clock += 1);

say(`run loop evidence, unit ${RUN_UNIT}, ${new Date(clock).toISOString()}`);
say("");

// ---------------------------------------------------------------------------
// The pinned image and the container
// ---------------------------------------------------------------------------

const image = await ensurePinnedImage();
check(
  "the pinned image is present and its layer set is the recorded one",
  {
    ref: image.ref,
    layers: image.layers.length,
  },
  { ref: PINNED_IMAGE.tag, layers: PINNED_IMAGE.layers.length },
);

const adapter = new DockerAdapter({ unit: RUN_UNIT });
const sandbox = new DockerRunSandbox(adapter);

// A decoy this run owns and does not delete until the end: the cleanup proof is that the run's own
// container is gone while a container outside this unit's label is untouched.
const decoyAdapter = new DockerAdapter({ unit: DECOY_UNIT });
let decoy: SandboxHandle | null = null;

const store = new RunStore();
const log = new SeqLog<EventMessage>();
const grants = new GrantStore();
const refusals = new Set<string>();

const logPort = createLogPort({
  log,
  runId: RUN_ID,
  noteSeq: (seq) => void store.noteSeq(RUN_ID, seq),
  now,
});
const gate = createReviewGate(grants, refusals, { now });

// ---------------------------------------------------------------------------
// The model's turns: the recorded call, the scripted refusal, the recorded text
// ---------------------------------------------------------------------------

const transcript = await readTranscript(TRANSCRIPT);
const recorded = turnForTool(transcript, "bash");
if (recorded === undefined) throw new Error("the transcript holds no bash call");
const recordedCall = recorded.calls.find((call) => call.toolName === "bash");
if (recordedCall === undefined) throw new Error("the recorded block holds no bash call");

check(
  "the recorded turn asks for one bash call, verbatim from the committed transcript",
  `${recordedCall.toolName} ${JSON.stringify(recordedCall.args)}`,
  'bash {"command":"echo native-should-not-run"}',
);

say("");
say("the run's turns, in order:");
say(`  1. replayed (transcript): ${recordedCall.toolName} ${JSON.stringify(recordedCall.args)}`);
say(
  `  2. scripted by this run: ${SCRIPTED_DENY_CALL.toolName} ${JSON.stringify(SCRIPTED_DENY_CALL.args)}`,
);
say(`  3. replayed (transcript): the recorded text after the result arrives`);
say("");

const recordedTurns = turnsInBlock(recorded);
const provider = new ReplayProvider([
  recordedTurns[0] as ProviderTurn,
  { text: [], toolCalls: [SCRIPTED_DENY_CALL] },
  recordedTurns[1] as ProviderTurn,
]);

// ---------------------------------------------------------------------------
// The human: allow the first card once, deny the second
// ---------------------------------------------------------------------------

const answers: Array<"allow" | "deny"> = ["allow", "deny"];
const asked: ApprovalRequest[] = [];
const sawContainerMidRun: string[][] = [];

const approvals = {
  async await(request: ApprovalRequest): Promise<ApprovalAnswer> {
    asked.push(request);
    sawContainerMidRun.push(containersFor(RUN_UNIT));
    const decision = answers.shift();
    if (decision === undefined)
      throw new Error("the run asked for more answers than the script holds");
    if (decision === "deny") {
      refusals.add(request.actionHash);
      return { decision: "deny" };
    }
    const grant = grants.issue({
      toolName: request.toolName,
      args: request.args,
      ttlMs: 60_000,
      now: now(),
    });
    return {
      decision: "allow",
      grant: { grantId: grant.id, actionHash: grant.actionHash, expiresAt: grant.expiresAt },
    };
  },
};

decoy = await decoyAdapter.create({ name: "freebot-u17-decoy", idleTtlMs: IDLE_TTL_MS });

const outcome = await runRunLoop(
  { sandbox, provider, gate, approvals, store, log: logPort, now, cancelled: () => false },
  {
    runId: RUN_ID,
    threadId: "thread-u1.7",
    botId: "bot-u1.7",
    prompt: "run one gated command, then stop",
    sandbox: { name: "u17-run", idleTtlMs: IDLE_TTL_MS },
    tools: runToolDefinitions(),
    approvalTtlMs: 60_000,
  },
);

// ---------------------------------------------------------------------------
// What the run proved
// ---------------------------------------------------------------------------

const frames = log.since(0).map((entry) => entry.frame);
const record = store.get(RUN_ID);

say("the run trail (run.status frames, in order):");
for (const frame of frames) {
  if (frame.type === "run.status") say(`  seq ${frame.seq} ${frame.payload.status}`);
}
say("");
say("the decision table, from the log:");
for (const frame of frames) {
  if (frame.type !== "tool_call.decision") continue;
  const payload = frame.payload;
  say(
    `  seq ${frame.seq} ${payload.toolCallId} ${
      payload.allow ? "allow" : `${payload.code} | ${payload.detail}`
    }`,
  );
}
say("");

const statusTrail = frames
  .filter((frame) => frame.type === "run.status")
  .map((frame) => (frame.type === "run.status" ? frame.payload.status : ""));
const decisions = frames
  .filter((frame) => frame.type === "tool_call.decision")
  .map((frame) => {
    if (frame.type !== "tool_call.decision") throw new Error("unreachable");
    return frame.payload.allow
      ? `${frame.payload.toolCallId}: allow`
      : `${frame.payload.toolCallId}: ${frame.payload.code}`;
  });
const audit: SeqAudit = log.audit();
const results = frames.filter((frame) => frame.type === "tool_call.result");

check(
  "the run's final status is done",
  {
    outcome: outcome.status,
    record: record?.status,
    error: record?.error,
  },
  { outcome: "done", record: "done", error: null },
);
check("the status trail is the run's own lifecycle, literal", statusTrail, [
  "running",
  "awaiting_approval",
  "running",
  "awaiting_approval",
  "running",
  "done",
]);
check("two calls, one approved once and one refused by the human", decisions, [
  "call_stub_11: allow",
  "u17-call-2: user_denied",
]);
check("the refusal names the action the human refused", results[1]?.payload, {
  toolCallId: "u17-call-2",
  ok: false,
  denied: true,
  output: `the user denied action ${canonicalActionHash("bash", SCRIPTED_DENY_CALL.args)}`,
  durationMs: null,
});
check(
  "the approved call ran in the container and its output is the container's",
  withoutDuration(results[0]?.payload),
  {
    toolCallId: recordedCall.toolCallId,
    ok: true,
    denied: false,
    output: "native-should-not-run\n",
  },
);
check(
  "the approved call reported a measured duration, which a call that never ran cannot",
  typeof results[0]?.payload.durationMs,
  "number",
);
check(
  "the approved grant was consumed by the call it authorized",
  grants.grants().map((grant) => `${grant.id} ${grant.consumedBy}`),
  ["grant-1 call_stub_11"],
);
check("one refusal is on the ledger behind the gate", refusals.size, 1);
check(
  "the seq audit has no gaps, no duplicates and nothing refused",
  {
    firstSeq: audit.firstSeq,
    lastSeq: audit.lastSeq,
    count: audit.count,
    gaps: audit.gaps,
    duplicates: audit.duplicates,
    rejected: audit.rejected,
    suppressedAtIngest: audit.suppressedAtIngest,
    gapEvents: audit.gapEvents,
  },
  {
    firstSeq: 1,
    lastSeq: frames.length,
    count: frames.length,
    gaps: [],
    duplicates: [],
    rejected: 0,
    suppressedAtIngest: [],
    gapEvents: [],
  },
);
check("the run's durable position is the log's tail", record?.lastSeenSeq, audit.lastSeq);
check(
  "every frame is a v1 message the protocol accepts",
  frames.every((frame) => parseMessage(frame).v === 1),
  true,
);

// The two new wire frames, as they sit in the log.
const statusFrame = frames.find(
  (frame) => frame.type === "run.status" && frame.payload.status === "awaiting_approval",
);
const denialFrame = frames.find(
  (frame) => frame.type === "tool_call.decision" && frame.payload.allow === false,
);
if (statusFrame === undefined || denialFrame === undefined)
  throw new Error("a new frame is missing");
check("the run.status frame in the log, parsed under v1", parsed(statusFrame), {
  v: 1,
  seq: statusFrame.seq,
  ts: statusFrame.ts,
  runId: RUN_ID,
  type: "run.status",
  payload: { runId: RUN_ID, status: "awaiting_approval" },
});
check("the user_denied decision frame in the log, parsed under v1", parsed(denialFrame), {
  v: 1,
  seq: denialFrame.seq,
  ts: denialFrame.ts,
  runId: RUN_ID,
  type: "tool_call.decision",
  payload: {
    toolCallId: "u17-call-2",
    allow: false,
    code: "user_denied",
    detail: `the user denied action ${canonicalActionHash("bash", SCRIPTED_DENY_CALL.args)}`,
  },
});

say("");
say("the two new wire frames, as they appear in the log:");
say(`  ${serializeMessage(statusFrame)}`);
say(`  ${serializeMessage(denialFrame)}`);
say("");

// ---------------------------------------------------------------------------
// The container proof: real during the run, gone after, and scoped to this unit
// ---------------------------------------------------------------------------

const afterRun = containersFor(RUN_UNIT);
const swept = await adapter.sweep();
const decoyAfter = containersFor(DECOY_UNIT);

check(
  "a real container from the pinned image was up while the run was parked",
  {
    midRunContainers: sawContainerMidRun.length,
    named: sawContainerMidRun.every(
      (names) => names.length === 1 && names[0]?.startsWith("freebot-sbx-"),
    ),
  },
  { midRunContainers: 2, named: true },
);
check("the run's container is gone after the run", afterRun, []);
check("the unit's label-scoped sweep finds nothing left to remove", swept, []);
check(
  "a container outside this unit's label survives, so the cleanup is scoped",
  decoyAfter.length,
  1,
);

if (decoy !== null) await decoyAdapter.delete(decoy);
check("the decoy this run created is removed too", containersFor(DECOY_UNIT), []);

say("");
say(`checks: ${checks - failures}/${checks} PASS`);
say(`${failures === 0 ? "PASS" : "FAIL"} run-loop`);

const shortSha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root })
  .stdout.toString()
  .trim();
const dir = join(root, "packages/verify/artifacts/run-loop", shortSha);
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, "assert.txt"),
  [
    `feature: run-loop`,
    `command: bun apps/server/src/run-loop-live.ts`,
    `timestamp: ${new Date().toISOString()}`,
    `git sha: ${Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim()}`,
    `git sha short: ${shortSha}`,
    `branch: ${Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }).stdout.toString().trim()}`,
    `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
    `pinned image: ${image.ref} ${image.imageId}`,
    `transcript: packages/pi-bridge/fixtures/rpc-handshake.jsonl`,
    "",
    ...lines,
    "",
  ].join("\n"),
);

say(`artifact: packages/verify/artifacts/run-loop/${shortSha}/assert.txt`);
process.exitCode = failures === 0 ? 0 : 1;

/** A result payload without its measured duration, for the literal comparison above. */
function withoutDuration(
  payload: { durationMs: number | null } | undefined,
): Omit<{ durationMs: number | null }, "durationMs"> | undefined {
  if (payload === undefined) return undefined;
  const { durationMs: _durationMs, ...rest } = payload;
  return rest;
}

/** The parse the wire is held to; a frame that fails it cannot be in the log. */
function parsed(frame: EventMessage): unknown {
  return parseMessage(JSON.parse(JSON.stringify(frame)));
}
