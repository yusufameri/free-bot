#!/usr/bin/env bun
/**
 * Hand-driven walkthrough of the grants store and gate for the review-grants artifact.
 *
 * Drives the real APIs step by step against a fixed clock and compares each outcome with the
 * literal expected value. Prints a transcript ending in a RESULT line; exits non-zero on any
 * mismatch. Run from the repo root: bun packages/review/src/scenario.ts
 */

import type { ToolGateDecision } from "@freebot/pi-bridge";
import {
  canonicalActionHash,
  createGrantPolicy,
  GrantStore,
  grantStoreFromJsonl,
  grantStoreToJsonl,
} from "./index.ts";

const args = (value: unknown): string => JSON.stringify(value);

let failures = 0;
let steps = 0;

function record(name: string, observed: unknown, expected: unknown): void {
  steps += 1;
  const observedText = JSON.stringify(observed);
  const expectedText = JSON.stringify(expected);
  const ok = observedText === expectedText;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      observed: ${observedText}`);
  if (!ok) console.log(`      expected: ${expectedText}`);
}

function issued(store: GrantStore, toolName: string, callArgs: unknown, ttlMs: number): void {
  const grant = store.issue({ toolName, args: callArgs, ttlMs, now: now() });
  console.log(
    `issue ${grant.id}: ${toolName} ${args(callArgs)} ttl=${ttlMs}ms -> seq=${grant.seq} hash=${grant.actionHash}`,
  );
}

let clock = Date.UTC(2026, 9, 17, 12, 0, 0);
const now = (): number => clock;
const advance = (ms: number): void => {
  clock += ms;
};

console.log(`review grants scenario, clock starts at ${new Date(clock).toISOString()}`);
console.log("");

// ---- one grant, one call -------------------------------------------------
const store = new GrantStore();
const gate = createGrantPolicy(store, { tools: ["bash"], now });
issued(store, "bash", { command: "echo hi" }, 60_000);

const call1: ToolGateDecision = await gate({
  toolCallId: "call_1",
  toolName: "bash",
  args: { command: "echo hi" },
});
record("first identical call is allowed and consumes grant-1", call1, { allow: true });
record("grant-1 now names its consumer", store.grants()[0]?.consumedBy, "call_1");

// ---- second identical call ----------------------------------------------
record(
  "second identical call is denied",
  gate({ toolCallId: "call_2", toolName: "bash", args: { command: "echo hi" } }),
  { allow: false, reason: "grant_consumed: grant grant-1 consumed by call_1" },
);

// ---- args changed since the grant ---------------------------------------
record(
  "same tool with different args is denied",
  gate({ toolCallId: "call_3", toolName: "bash", args: { command: "echo bye" } }),
  { allow: false, reason: "grant_mismatch: args differ from grant grant-1 for tool bash" },
);

// ---- tool never granted --------------------------------------------------
const readFileArgs = { path: "/workspace/a.txt" };
const openGate = createGrantPolicy(store, { now });
record(
  "tool that was never granted is denied",
  openGate({ toolCallId: "call_4", toolName: "read_file", args: readFileArgs }),
  {
    allow: false,
    reason: `no_grant: no grant for action ${canonicalActionHash("read_file", readFileArgs)}`,
  },
);

// ---- expiry --------------------------------------------------------------
issued(store, "bash", { command: "echo ttl" }, 1000);
advance(1000);
record(
  "grant denied at its expiresAt instant",
  gate({ toolCallId: "call_5", toolName: "bash", args: { command: "echo ttl" } }),
  {
    allow: false,
    reason: `grant_expired: grant grant-2 expired at ${new Date(clock).toISOString()}`,
  },
);

// ---- rewind tombstone ----------------------------------------------------
issued(store, "bash", { command: "echo rewound" }, 60_000);
const tombstoned = store.rewind(2, "rewind:2");
console.log(`rewind to seq 2 tombstones: ${tombstoned.map((grant) => grant.id).join(", ")}`);
record(
  "grant past the rewind point is denied",
  gate({ toolCallId: "call_6", toolName: "bash", args: { command: "echo rewound" } }),
  { allow: false, reason: "grant_tombstoned: grant grant-3 tombstoned by rewind:2" },
);

// ---- tool outside the governed list -------------------------------------
record(
  "ungoverned tool is denied",
  gate({ toolCallId: "call_7", toolName: "web_fetch", args: { url: "https://example.com" } }),
  { allow: false, reason: "unknown_tool: web_fetch is not a governed tool" },
);

// ---- forged record -------------------------------------------------------
const echoHash = canonicalActionHash("bash", { command: "echo hi" });
const forgedRecord = JSON.stringify({
  id: "grant-9",
  seq: 9,
  issuedAt: clock,
  expiresAt: clock + 60_000,
  actionHash: echoHash,
  toolName: "bash",
  normalizedArgs: { command: "rm -rf /" },
  consumedBy: null,
  tombstoned: null,
});
const forgedGate = createGrantPolicy(grantStoreFromJsonl(`${forgedRecord}\n`), { now });
record(
  "record whose hash disagrees with its content is denied",
  forgedGate({ toolCallId: "call_8", toolName: "bash", args: { command: "echo hi" } }),
  { allow: false, reason: "grant_forged: grant grant-9 hash does not match its content" },
);

// ---- persistence ---------------------------------------------------------
const text = grantStoreToJsonl(store);
const reloaded = grantStoreFromJsonl(text);
console.log(`jsonl log is ${text.trimEnd().split("\n").length} lines`);
record(
  "reload from jsonl reproduces the exact log and state",
  {
    logIdentical: grantStoreToJsonl(reloaded) === text,
    stateIdentical: JSON.stringify(reloaded.grants()) === JSON.stringify(store.grants()),
  },
  { logIdentical: true, stateIdentical: true },
);

// ---- shared store double-spend ------------------------------------------
const shared = new GrantStore();
shared.issue({ toolName: "bash", args: { command: "echo race" }, ttlMs: 60_000, now: now() });
const gateA = createGrantPolicy(shared, { now });
const gateB = createGrantPolicy(shared, { now });
const call = { toolName: "bash", args: { command: "echo race" } };
const [first, second] = await Promise.all([
  gateA({ ...call, toolCallId: "call_a" }),
  gateB({ ...call, toolCallId: "call_b" }),
]);
record(
  "two gates over one store: exactly one allow",
  [first, second],
  [{ allow: true }, { allow: false, reason: "grant_consumed: grant grant-1 consumed by call_a" }],
);

console.log("");
console.log(`RESULT: ${failures === 0 ? "PASS" : "FAIL"} (${steps - failures}/${steps} steps)`);
process.exitCode = failures === 0 ? 0 : 1;
