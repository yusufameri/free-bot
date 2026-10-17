#!/usr/bin/env node
/**
 * Replay equality check: two transcript files, same pinned image, same script.
 *
 * Normalization (documented in docs/sandbox-image.md): every JSON value is rewritten so object
 * keys are sorted, then keys in DROP_KEYS are removed anywhere they appear. DROP_KEYS covers the
 * values that cannot be identical across processes: correlation and tool call ids, timestamps,
 * the generated session id, and measured durations. Everything else must match exactly.
 *
 * Usage: node /image/compare.mjs /out/replay1.jsonl /out/replay2.jsonl
 */
import { readFileSync } from "node:fs";

const DROP_KEYS = new Set([
  "id",
  "timestamp",
  "durationMs",
  "sessionId",
  "toolCallId",
  "parentToolCallId",
]);

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (DROP_KEYS.has(key)) continue;
      out[key] = normalize(value[key]);
    }
    return out;
  }
  return value;
}

function readTranscript(path) {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  return { header: lines[0], events: lines.slice(1) };
}

const [pathA, pathB] = process.argv.slice(2);
if (!pathA || !pathB) {
  console.error("usage: compare.mjs <replay1.jsonl> <replay2.jsonl>");
  process.exit(2);
}
const a = readTranscript(pathA);
const b = readTranscript(pathB);

const failures = [];
function check(ok, label) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
}

check(a.header.pi_version === "1.3.0", `run1 pi_version is 1.3.0 (${a.header.pi_version})`);
check(b.header.pi_version === "1.3.0", `run2 pi_version is 1.3.0 (${b.header.pi_version})`);
check(
  a.header.image_digest === b.header.image_digest && a.header.image_digest.startsWith("sha256:"),
  `image_digest equal across runs (${a.header.image_digest})`,
);
check(
  JSON.stringify(a.header) === JSON.stringify(b.header),
  "run headers identical (pi version, digest, node, platform, command line)",
);

const eventsA = a.events.map((event) => JSON.stringify(normalize(event)));
const eventsB = b.events.map((event) => JSON.stringify(normalize(event)));
check(
  eventsA.length === eventsB.length,
  `event count equal (run1 ${eventsA.length}, run2 ${eventsB.length})`,
);
let firstDiff = -1;
for (let i = 0; i < Math.max(eventsA.length, eventsB.length); i += 1) {
  if (eventsA[i] !== eventsB[i]) {
    firstDiff = i;
    break;
  }
}
check(firstDiff === -1, `event sequences equal after normalization (${eventsA.length} lines)`);
if (firstDiff !== -1) {
  console.log(`first difference at event ${firstDiff}`);
  console.log(`run1: ${eventsA[firstDiff]}`);
  console.log(`run2: ${eventsB[firstDiff]}`);
}
check(eventsA.length > 0, "transcripts are not empty");

console.log(`RESULT: ${failures.length === 0 ? "PASS" : "FAIL"}`);
process.exit(failures.length === 0 ? 0 : 1);
