/**
 * The `msb` CLI is the microsandbox adapter's boundary. Every argument vector is built here and
 * every failure that matters becomes a typed `SandboxError` carrying msb's own stderr, so no caller
 * parses its text. This module is the adapter's only external binary: nothing in the microsandbox
 * path invokes Docker.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { SandboxError } from "./interface.ts";

export function msbBinary(): string {
  return process.env.FREEBOT_MSB_BIN ?? "msb";
}

/**
 * A stuck CLI call must fail loudly rather than hang a caller forever. `msb create` boots a microVM
 * and may pull or restore a disk image, so the default is generous; a caller with a tighter budget
 * passes its own.
 */
export const MSB_CLI_TIMEOUT_MS = 120_000;
export const MSB_SANDBOX_TIMEOUT_MS = 300_000;

export interface MsbOutcome {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  /** The deadline fired and the child was killed; the exit code is this boundary's `-1`. */
  readonly timedOut: boolean;
}

/**
 * Collect a spawned CLI process under a deadline. On expiry the child is killed and the outcome is
 * marked `timedOut`, with the marker appended to stderr so msb's own text stays in the message.
 * Never throws; callers decide which outcomes are failures.
 */
export function collectMsbOutcome(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number = MSB_CLI_TIMEOUT_MS,
): Promise<MsbOutcome> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(-1, `timed out after ${timeoutMs}ms`, true);
    }, timeoutMs);
    const finish = (exitCode: number, tail?: string, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (tail !== undefined) stderr.push(Buffer.from(tail));
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
      });
    };
    child.on("error", (error) => finish(-1, `spawn failed: ${error.message}`));
    child.on("close", (code) => finish(code ?? -1));
  });
}

/** Run the CLI to completion. Never throws; callers decide which exit codes are failures. */
export function msbOutcome(
  args: readonly string[],
  timeoutMs: number = MSB_CLI_TIMEOUT_MS,
): Promise<MsbOutcome> {
  return collectMsbOutcome(spawn(msbBinary(), [...args], { stdio: "pipe" }), timeoutMs);
}

/** Run the CLI and fail loudly on a non-zero exit or a timeout. Returns trimmed stdout. */
export async function msbCli(
  args: readonly string[],
  timeoutMs: number = MSB_CLI_TIMEOUT_MS,
): Promise<string> {
  const outcome = await msbOutcome(args, timeoutMs);
  if (outcome.exitCode !== 0) throw msbFailure(args, outcome);
  return outcome.stdout.toString("utf8").trim();
}

export function msbFailure(args: readonly string[], outcome: MsbOutcome): SandboxError {
  const stderr = outcome.stderr.toString("utf8").trim();
  return new SandboxError(
    "msb_cli",
    `msb ${args.join(" ")} exited ${outcome.exitCode}: ${stderr === "" ? "(no stderr)" : stderr}`,
  );
}

/** Start a long-lived CLI process whose stdio is a byte channel. */
export function spawnMsb(args: readonly string[]): ChildProcessWithoutNullStreams {
  return spawn(msbBinary(), [...args], { stdio: "pipe" });
}

/** Whether `msb` answers at all, so a machine without it skips rather than fails. */
export async function hasMsb(): Promise<boolean> {
  try {
    const outcome = await msbOutcome(["doctor"]);
    return outcome.exitCode === 0;
  } catch {
    return false;
  }
}
