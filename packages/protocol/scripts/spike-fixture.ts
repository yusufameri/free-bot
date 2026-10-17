#!/usr/bin/env bun
/**
 * Regenerate `fixtures/spike-display-frames-a.jsonl`: the literal U0.10 display traffic, produced
 * by running the spike's own mapper (`spikes/web-stream/map.ts`, read-only import) over the
 * committed U0.7 transcript. `--check` fails if the committed fixture differs from a fresh run,
 * so the compatibility test keeps quoting real recorded traffic and cannot drift.
 *
 * Run from the repo root: bun packages/protocol/scripts/spike-fixture.ts [--check]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DESTRUCTIVE_TOOL_CALL_ID,
  displayFrames,
  parseTranscript,
} from "../../../spikes/web-stream/map.ts";

export const TRANSCRIPT = "packages/verify/artifacts/tunnel/bf0a4e6/transcript.jsonl";
export const FIXTURE = "packages/protocol/fixtures/spike-display-frames-a.jsonl";

const root = fileURLToPath(new URL("../../..", import.meta.url));

export function spikeFixtureText(): string {
  const lines = parseTranscript(readFileSync(join(root, TRANSCRIPT), "utf8"), "a");
  const frames = [
    ...displayFrames(lines, { destructiveToolCallId: DEFAULT_DESTRUCTIVE_TOOL_CALL_ID }),
  ];
  return `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`;
}

if (import.meta.main) {
  const text = spikeFixtureText();
  const check = process.argv.includes("--check");
  const path = join(root, FIXTURE);
  if (check) {
    const committed = readFileSync(path, "utf8");
    const ok = committed === text;
    console.log(`${ok ? "PASS" : "FAIL"}  fixture matches a fresh run of the spike mapper`);
    console.log(`      ${FIXTURE}: ${text.split("\n").length - 1} frames`);
    process.exitCode = ok ? 0 : 1;
  } else {
    writeFileSync(path, text);
    console.log(`wrote ${FIXTURE}: ${text.split("\n").length - 1} frames`);
  }
}
