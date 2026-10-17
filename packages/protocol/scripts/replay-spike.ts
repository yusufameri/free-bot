#!/usr/bin/env bun
/**
 * The replay demo: the recorded U0.10 session, mapped to v1, ingested through packages/core's
 * SeqLog exactly as the control plane would ingest it.
 *
 * It proves four things the contract claims and cannot enforce on its own:
 *   - every mapped message survives a v1 round trip before ingest (the protocol boundary);
 *   - ingest is dense and idempotent: a replayed frame is suppressed, not stored twice;
 *   - a forward-skipping frame is refused and heals by resend, so no hole reaches the log;
 *   - a frame the schema refuses never touches the log: it counts as `rejected`;
 *   - what ingest persists: parsed v1 envelopes, so an additive v1.x field is stripped before the
 *     log holds it (docs/protocol.md names that boundary and the raw-bytes alternative).
 *
 * It writes `replay-audit.txt` beside assert.txt and exits non-zero unless the audit reports
 * gaps [] and duplicates [].
 *
 * Run from the repo root: bun packages/protocol/scripts/replay-spike.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SeqLog } from "@freebot/core";
import type { DisplayFrame } from "../../../spikes/web-stream/envelope.ts";
import { type EventMessage, parseMessage, serializeMessage } from "../src/index.ts";
import { mapSpikeSession, spikeActionHash } from "./spike-map.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURE = "packages/protocol/fixtures/spike-display-frames-a.jsonl";
const GATED_CALL = "call_spike_2";
const ECHO_SEQ = 30;
const GAP_SKIP = 31;
const GAP_GOT = 32;

function shortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root });
  return proc.stdout.toString().trim();
}

function readFixture(): DisplayFrame[] {
  return readFileSync(join(root, FIXTURE), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DisplayFrame);
}

function actionHash(frames: readonly DisplayFrame[]): string {
  const call = frames.find(
    (frame) => frame.type === "tool_call" && frame.payload.toolCallId === GATED_CALL,
  );
  if (call === undefined || call.type !== "tool_call") {
    throw new Error(`fixture has no tool_call for ${GATED_CALL}`);
  }
  return spikeActionHash(call.payload.command, call.payload.toolName);
}

const lines: string[] = [];
const say = (line: string): void => {
  lines.push(line);
  console.log(line);
};

const frames = readFixture();
const mapping = mapSpikeSession(frames, {
  runId: "run-spike-a",
  prompt: "spike: the recorded three-step task",
  startTs: 1_792_221_550_000,
  stepMs: 5,
  answerWindowMs: 60_000,
  grantWindowMs: 60_000,
  actionHash: actionHash(frames),
  answer: "allow",
});

say(`replay demo: ${FIXTURE} through the v1 schemas and @freebot/core SeqLog`);
say(
  `frames: ${frames.length}; mapped messages: ${mapping.messages.length} (run.started synthesized, one answered placeholder resolved)`,
);
say("");

// Through the v1 boundary: serialize, reparse, ingest what the schema accepted.
const log = new SeqLog<EventMessage>();
const parsed: EventMessage[] = [];
let refusedBeforeIngest = 0;
for (const message of mapping.messages) {
  const wire = JSON.parse(serializeMessage(message)) as unknown;
  const accepted = parseMessage(wire);
  if (!("seq" in accepted)) throw new Error(`a stream marker reached the log: ${accepted.type}`);
  parsed.push(accepted);
}

const bySeq = new Map(parsed.map((message) => [message.seq, message]));
const outcomes: Record<string, number> = { appended: 0, duplicate: 0, gap: 0, rejected: 0 };
const append = (message: EventMessage): string => {
  const outcome = log.append(message.seq, message);
  outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  return outcome;
};

for (const message of parsed) {
  if (message.seq === GAP_SKIP) continue;
  if (message.seq === GAP_GOT) {
    const refused = append(message);
    say(
      `  seq ${GAP_SKIP} never arrived: seq ${GAP_GOT} -> ${refused} (expected ${log.lastSeq + 1}, got ${message.seq})`,
    );
    const healed = bySeq.get(GAP_SKIP);
    if (healed === undefined) throw new Error(`no message at seq ${GAP_SKIP}`);
    say(`  resend from ${log.lastSeq + 1}: seq ${GAP_SKIP} -> ${append(healed)}`);
    say(`  seq ${GAP_GOT} again -> ${append(message)}`);
    continue;
  }
  if (message.seq === ECHO_SEQ) {
    say(`  seq ${ECHO_SEQ} -> ${append(message)}`);
    say(`  seq ${ECHO_SEQ} replayed (echo_last=1) -> ${append(message)}`);
    continue;
  }
  append(message);
}

// A frame the schema refuses never reaches the log.
const poison = {
  v: 1,
  seq: 999,
  ts: 1,
  runId: "run-spike-a",
  type: "tool_execution_start",
  payload: {},
};
try {
  parseMessage(poison);
} catch {
  log.reject();
  refusedBeforeIngest += 1;
}

say("");
say(`ingest outcomes: ${JSON.stringify(outcomes)}`);
say(`frames refused by the v1 schema before ingest: ${refusedBeforeIngest}`);

// What this demo persists: the parsed envelope, so the additive v1.x key is gone before the log
// holds it. SeqLog is generic over its frame, so the ingest path owns this choice;
// docs/protocol.md states the boundary and records the raw-bytes alternative as a follow-up.
const opener = parsed[0];
if (opener === undefined) throw new Error("the mapping produced no messages");
const wireWithFuture = JSON.parse(serializeMessage(opener)) as { payload: Record<string, unknown> };
wireWithFuture.payload.futureField = 1;
const stripped = parseMessage(wireWithFuture);
if (!("seq" in stripped)) throw new Error(`a stream marker reached the log: ${stripped.type}`);
say(
  `log holds the parsed envelope (strip before persist): wire payload {${Object.keys(wireWithFuture.payload).join(", ")}} -> appended payload keys {${Object.keys(stripped.payload).join(", ")}}`,
);

// The rejoin contract: exactly the frames after a client's watermark.
const resumeFrom = ECHO_SEQ;
const rejoined = log.since(resumeFrom);
say(
  `resume from last_seen_seq=${resumeFrom}: ${rejoined.length} messages, seq ${rejoined[0]?.seq}..${rejoined.at(-1)?.seq}`,
);

const audit = log.audit();
say("");
say("seq audit (packages/core SeqLog, recomputed from the stored entries):");
say(`  frames logged: ${audit.count} (seq ${audit.firstSeq}..${audit.lastSeq})`);
say(`  gaps: ${audit.gaps.length} [${audit.gaps.join(", ")}]`);
say(`  duplicates: ${audit.duplicates.length} [${audit.duplicates.join(", ")}]`);
say(
  `  suppressed at ingest (replayed frames the log already held): ${audit.suppressedAtIngest.length} [${audit.suppressedAtIngest.join(", ")}]`,
);
say(
  `  gap events (refused, healed by resend): ${audit.gapEvents.length} [${audit.gapEvents.map((event) => `${event.expected}<-${event.got}`).join(", ")}]`,
);
say(`  rejected payloads: ${audit.rejected}`);
say(
  `  observer counts: appended ${outcomes.appended}, duplicate ${outcomes.duplicate}, gap ${outcomes.gap}`,
);
say(
  `  audit invariant: ${audit.gaps.length === 0 && audit.duplicates.length === 0 ? "OK" : "VIOLATED"} (zero gaps, zero duplicates)`,
);

const ok =
  audit.gaps.length === 0 &&
  audit.duplicates.length === 0 &&
  audit.count === mapping.messages.length &&
  outcomes.duplicate === 1 &&
  outcomes.gap === 1 &&
  audit.suppressedAtIngest.length === 1 &&
  audit.gapEvents.length === 1 &&
  audit.rejected === 1 &&
  rejoined.length === mapping.messages.length - resumeFrom;
say("");
say(
  `${ok ? "PASS" : "FAIL"} replay: ${audit.count} frames ingested, ${outcomes.duplicate} duplicate suppressed, ${outcomes.gap} gap refused and healed, ${audit.rejected} rejected`,
);

const dir = join(root, "packages", "verify", "artifacts", "protocol", shortSha());
mkdirSync(dir, { recursive: true });
const report = [
  `feature: protocol`,
  `command: bun packages/protocol/scripts/replay-spike.ts`,
  `timestamp: ${new Date().toISOString()}`,
  `git sha short: ${shortSha()}`,
  `fixture: ${FIXTURE}`,
  "",
  ...lines.slice(1),
  "",
].join("\n");
writeFileSync(join(dir, "replay-audit.txt"), report);
console.log(`artifact: packages/verify/artifacts/protocol/${shortSha()}/replay-audit.txt`);
process.exitCode = ok ? 0 : 1;
