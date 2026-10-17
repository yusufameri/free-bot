#!/usr/bin/env bun

/**
 * `freebot doctor`: the five local facts a run cannot start without, each a literal PASS or FAIL.
 *
 * It lives in apps/server because that app owns the local control-plane runtime (the tunnel server
 * and the health endpoint) and already imports packages/core; plan 2.7's layout has no CLI app, and
 * adding one to hold five checks would be scaffolding this unit does not need.
 *
 * The store check writes, not just stats: a probe run is started, cancelled, and read back through
 * a reopened journal. Both operations are idempotent, so a hundred doctor runs leave exactly one
 * settled `doctor-probe` record behind.
 *
 * Run: bun apps/server/src/cli/doctor.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RunStore } from "@freebot/core";

const BUN_FLOOR = "1.2.0";
const PINNED_IMAGE = "freebot-sandbox:u0.6";
const PROBE_RUN_ID = "doctor-probe";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

function shell(
  command: [string, ...string[]],
  timeoutMs = 10_000,
): { ok: boolean; output: string } {
  const [binary, ...args] = command;
  const proc = spawnSync(binary, args, {
    timeout: timeoutMs,
    encoding: "utf8",
  });
  const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`.trim();
  return { ok: proc.status === 0, output };
}

function atLeastBun(actual: string, floor: string): boolean {
  const parts = (version: string): number[] =>
    version.split(".").map((piece) => Number.parseInt(piece, 10) || 0);
  const [aMajor = 0, aMinor = 0, aPatch = 0] = parts(actual);
  const [fMajor = 0, fMinor = 0, fPatch = 0] = parts(floor);
  if (aMajor !== fMajor) return aMajor > fMajor;
  if (aMinor !== fMinor) return aMinor > fMinor;
  return aPatch >= fPatch;
}

export function storeRoot(): string {
  return Bun.env.FREEBOT_HOME ?? join(homedir(), ".freebot");
}

function providerKeyPath(): string {
  return Bun.env.FREEBOT_PROVIDER_KEY_FILE ?? join(storeRoot(), "provider.key");
}

function checkBun(): CheckResult {
  const version = Bun.version;
  const ok = atLeastBun(version, BUN_FLOOR);
  return { name: "bun", ok, detail: `${version} (floor ${BUN_FLOOR})` };
}

function checkDocker(): CheckResult {
  const info = shell(["docker", "info", "--format", "{{.ServerVersion}}"]);
  if (!info.ok) {
    const first = info.output.split("\n")[0] ?? "";
    return { name: "docker daemon", ok: false, detail: `unreachable: ${first}` };
  }
  return { name: "docker daemon", ok: true, detail: `server ${info.output.split("\n")[0] ?? ""}` };
}

function checkImage(): CheckResult {
  const inspect = shell([
    "docker",
    "image",
    "inspect",
    PINNED_IMAGE,
    "--format",
    '{{index .Config.Labels "org.freebot.sandbox.node-base-digest"}}',
  ]);
  if (!inspect.ok) {
    return { name: "pinned image", ok: false, detail: `${PINNED_IMAGE} not present` };
  }
  const digest = inspect.output.split("\n")[0]?.trim() ?? "";
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    return {
      name: "pinned image",
      ok: false,
      detail: `${PINNED_IMAGE} carries no base digest label`,
    };
  }
  return { name: "pinned image", ok: true, detail: `${PINNED_IMAGE} base ${digest}` };
}

function checkStore(): CheckResult {
  const file = join(storeRoot(), "runs.jsonl");
  try {
    const store = new RunStore({ file });
    const started = store.start({
      id: PROBE_RUN_ID,
      threadId: "doctor",
      botId: "doctor",
      prompt: "freebot doctor writability probe",
    });
    if (started.record.status === "queued") store.begin(PROBE_RUN_ID);
    const settled = store.cancel(PROBE_RUN_ID);
    store.close();
    const reopened = new RunStore({ file });
    const reloaded = reopened.reload();
    reopened.close();
    if (settled.status !== "cancelled" || reloaded.converged !== true) {
      return { name: "run store", ok: false, detail: `${file}: probe settled ${settled.status}` };
    }
    return {
      name: "run store",
      ok: true,
      detail: `${file}: probe ${PROBE_RUN_ID} ${settled.status}, reopen converged, created ${started.created}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "run store", ok: false, detail: `${file}: ${message}` };
  }
}

/** Presence only: the value is never read, printed, or hashed. */
function checkProviderKey(): CheckResult {
  const path = providerKeyPath();
  if (!existsSync(path)) {
    return { name: "provider key", ok: false, detail: `no key file at ${path} (value never read)` };
  }
  const bytes = statSync(path).size;
  return {
    name: "provider key",
    ok: true,
    detail: `${path} present, ${bytes} bytes (value never read)`,
  };
}

export function runChecks(): CheckResult[] {
  return [checkBun(), checkDocker(), checkImage(), checkStore(), checkProviderKey()];
}

if (import.meta.main) {
  const checks = runChecks();
  const failed = checks.filter((check) => !check.ok);
  console.log("freebot doctor");
  console.log(`store: ${storeRoot()}`);
  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`freebot doctor: ${checks.length - failed.length}/${checks.length} checks pass`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
