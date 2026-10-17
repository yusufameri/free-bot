#!/usr/bin/env bun
/**
 * Regenerate the committed replay fixtures: `fixtures/smoke-run-allow.jsonl` and
 * `fixtures/smoke-run-deny.jsonl`.
 *
 * The session is the recorded U0.10 smoke, mapped through the protocol package's own adapter
 * (`packages/protocol/scripts/spike-map.ts`), so the surface renders the landed v1 taxonomy rather
 * than a re-invented envelope. The adapter deliberately synthesizes no `tool_call.decision` and no
 * `approval.resolved` (its header says why), so the gate messages a real control plane would emit
 * are added here, once per variant, in the order the gate emits them: consent, verdict, result.
 *
 * `--check` fails if a committed fixture differs from a fresh run, so the surface cannot drift away
 * from the recorded session. Run from the repo root: bun apps/web/scripts/fixture.ts [--check]
 *
 * `--check` also refuses a message the v1 schema rejects, which is the only thing that keeps the
 * hand-written gate messages honest against `packages/protocol`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mapSpikeSession, spikeActionHash } from "../../../packages/protocol/scripts/spike-map.ts";
import {
  type EventMessage,
  type EventType,
  parseMessage,
} from "../../../packages/protocol/src/index.ts";
import type { DisplayFrame } from "../../../spikes/web-stream/envelope.ts";

export const SOURCE = "packages/protocol/fixtures/spike-display-frames-a.jsonl";
export const RUN_ID = "run-smoke-a";
export const PROMPT = "smoke: the recorded three-step task";
export const START_TS = 1_792_221_550_000;
export const STEP_MS = 5;
export const ANSWER_WINDOW_MS = 60_000;
export const GRANT_WINDOW_MS = 60_000;
export const GATED_CALL = "call_spike_2";
export const GATED_APPROVAL = `ap-${GATED_CALL}`;
export const GATED_GRANT = `grant-${GATED_APPROVAL}`;
const DENY_OUTPUT = "denied: user denied approval";

const root = fileURLToPath(new URL("../../..", import.meta.url));

export const FIXTURE_FILES = {
  allow: "apps/web/fixtures/smoke-run-allow.jsonl",
  deny: "apps/web/fixtures/smoke-run-deny.jsonl",
} as const;

export type FixtureVariant = keyof typeof FIXTURE_FILES;

type Draft = { type: EventType; payload: (ts: number) => unknown };

export function readDisplayFrames(): DisplayFrame[] {
  return readFileSync(join(root, SOURCE), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DisplayFrame);
}

/** The canonical hash of the gated call, derived the way the gate derives it. */
export function gatedActionHash(frames: readonly DisplayFrame[]): string {
  const call = frames.find(
    (frame) => frame.type === "tool_call" && frame.payload.toolCallId === GATED_CALL,
  );
  if (call === undefined || call.type !== "tool_call") {
    throw new Error(`the recorded session has no tool_call for ${GATED_CALL}`);
  }
  return spikeActionHash(call.payload.command, call.payload.toolName);
}

function buildDrafts(variant: FixtureVariant): Draft[] {
  const frames = readDisplayFrames();
  const actionHash = gatedActionHash(frames);
  const mapping = mapSpikeSession(frames, {
    runId: RUN_ID,
    prompt: PROMPT,
    startTs: START_TS,
    stepMs: STEP_MS,
    answerWindowMs: ANSWER_WINDOW_MS,
    grantWindowMs: GRANT_WINDOW_MS,
    actionHash,
    answer: undefined,
  });
  if (mapping.pendingCount !== 1) {
    throw new Error(`expected one parked approval in the session, got ${mapping.pendingCount}`);
  }

  const drafts: Draft[] = [];
  const push = (type: EventType, payload: (ts: number) => unknown): void => {
    drafts.push({ type, payload });
  };
  const allow = variant === "allow";

  for (const message of mapping.messages) {
    if (message.type === "tool_call.requested" && message.payload.toolCallId === GATED_CALL) {
      push("tool_call.requested", () => message.payload);
      continue;
    }
    if (message.type === "approval.requested" && message.payload.toolCallId === GATED_CALL) {
      push("approval.requested", (ts) => ({
        approvalId: GATED_APPROVAL,
        toolCallId: GATED_CALL,
        command: message.payload.command,
        actionHash: message.payload.actionHash,
        expiresAt: ts + ANSWER_WINDOW_MS,
      }));
      push("approval.resolved", (ts) =>
        allow
          ? {
              approvalId: GATED_APPROVAL,
              decision: "allow",
              grant: {
                grantId: GATED_GRANT,
                actionHash: message.payload.actionHash,
                expiresAt: ts + GRANT_WINDOW_MS,
                state: "issued",
              },
            }
          : { approvalId: GATED_APPROVAL, decision: "deny" },
      );
      if (allow) {
        push("grant.lifecycle", (ts) => ({
          state: "issued",
          grantId: GATED_GRANT,
          actionHash: message.payload.actionHash,
          expiresAt: ts + GRANT_WINDOW_MS,
        }));
      }
      push("tool_call.decision", () =>
        allow
          ? { toolCallId: GATED_CALL, allow: true }
          : {
              toolCallId: GATED_CALL,
              allow: false,
              code: "no_grant",
              detail: "no grant: the approval card was denied",
            },
      );
      continue;
    }
    if (message.type === "tool_call.result" && message.payload.toolCallId === GATED_CALL) {
      push("tool_call.result", () =>
        allow
          ? message.payload
          : {
              toolCallId: GATED_CALL,
              ok: false,
              denied: true,
              output: DENY_OUTPUT,
              durationMs: null,
            },
      );
      if (allow) {
        push("grant.lifecycle", (ts) => ({
          state: "consumed",
          grantId: GATED_GRANT,
          actionHash,
          consumedBy: GATED_CALL,
          at: ts,
        }));
      }
      continue;
    }
    push(message.type, () => message.payload);
    if (message.type === "tool_call.requested") {
      push("tool_call.decision", () => ({ toolCallId: message.payload.toolCallId, allow: true }));
    }
  }
  return drafts;
}

/** One variant as JSONL, dense in seq from 1 with a strictly increasing clock. */
export function renderFixture(variant: FixtureVariant): string {
  const drafts = buildDrafts(variant);
  const lines = drafts.map((draft, index) => {
    const ts = START_TS + index * STEP_MS;
    return JSON.stringify({
      v: 1,
      seq: index + 1,
      ts,
      runId: RUN_ID,
      type: draft.type,
      payload: draft.payload(ts),
    });
  });
  return `${lines.join("\n")}\n`;
}

/** Every fixture line parsed and checked against the wire schema before it is written. */
export function buildFixtures(): Record<FixtureVariant, string> {
  const built = {
    allow: renderFixture("allow"),
    deny: renderFixture("deny"),
  } as Record<FixtureVariant, string>;
  for (const [variant, text] of Object.entries(built)) {
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      const parsed = parseMessage(JSON.parse(line) as unknown);
      if (!("seq" in parsed)) throw new Error(`${variant}: a stream marker reached the fixture`);
    }
  }
  return built;
}

/** Read one fixture back as messages, the way the replay server and the harness read it. */
export function loadFixture(variant: FixtureVariant): EventMessage[] {
  return readFileSync(join(root, FIXTURE_FILES[variant]), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parsed = parseMessage(JSON.parse(line) as unknown);
      if (!("seq" in parsed)) throw new Error(`${variant}: a stream marker reached the fixture`);
      return parsed;
    });
}

/** The seq of the first message of `type`, so the harness holds at a point it did not hardcode. */
export function seqOf(
  messages: readonly EventMessage[],
  type: EventType,
  pick: (message: EventMessage) => boolean = () => true,
): number {
  const found = messages.find((message) => message.type === type && pick(message));
  if (found === undefined) throw new Error(`fixture has no ${type}`);
  return found.seq;
}

export function seqOfToolResult(messages: readonly EventMessage[], toolCallId: string): number {
  return seqOf(
    messages,
    "tool_call.result",
    (message) => message.type === "tool_call.result" && message.payload.toolCallId === toolCallId,
  );
}

/** The decision of the parked approval, which the page's answer must match. */
export function fixtureDecision(variant: FixtureVariant): "allow" | "deny" {
  return variant === "allow" ? "allow" : "deny";
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const fixtures = buildFixtures();
  let ok = true;
  for (const [variant, text] of Object.entries(fixtures) as Array<[FixtureVariant, string]>) {
    const path = join(root, FIXTURE_FILES[variant]);
    const count = text.split("\n").length - 1;
    if (check) {
      const committed = readFileSync(path, "utf8");
      const same = committed === text;
      ok &&= same;
      console.log(
        `${same ? "PASS" : "FAIL"}  ${FIXTURE_FILES[variant]} matches a fresh run (${count} messages)`,
      );
    } else {
      writeFileSync(path, text);
      console.log(`wrote ${FIXTURE_FILES[variant]}: ${count} messages`);
    }
  }
  process.exitCode = ok ? 0 : 1;
}
