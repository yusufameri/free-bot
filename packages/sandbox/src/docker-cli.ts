/**
 * The Docker CLI is this adapter's boundary. Every argument vector is built by the adapter and
 * every failure that matters is turned into a typed `SandboxError` carrying docker's own stderr, so
 * no caller has to parse docker's text.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { SandboxError } from "./interface.ts";

export interface DockerOutcome {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export function dockerBinary(): string {
  return process.env.FREEBOT_DOCKER_BIN ?? "docker";
}

/**
 * A stuck CLI call must fail loudly rather than hang a caller forever. Commands that legitimately
 * run long (a first image build) pass their own timeout.
 */
export const DOCKER_CLI_TIMEOUT_MS = 120_000;
export const DOCKER_BUILD_TIMEOUT_MS = 600_000;

/** Run the CLI to completion. Never throws; callers decide which exit codes are failures. */
export function dockerOutcome(
  args: readonly string[],
  timeoutMs: number = DOCKER_CLI_TIMEOUT_MS,
): Promise<DockerOutcome> {
  const child = spawn(dockerBinary(), [...args], { stdio: "pipe" });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(-1, `timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    const finish = (exitCode: number, tail?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (tail !== undefined) stderr.push(Buffer.from(tail));
      resolve({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    child.on("error", (error) => finish(-1, `spawn failed: ${error.message}`));
    child.on("close", (code) => finish(code ?? -1));
  });
}

/** Run the CLI and fail loudly on a non-zero exit or a timeout. Returns trimmed stdout. */
export async function dockerCli(
  args: readonly string[],
  timeoutMs: number = DOCKER_CLI_TIMEOUT_MS,
): Promise<string> {
  const outcome = await dockerOutcome(args, timeoutMs);
  if (outcome.exitCode !== 0) throw dockerFailure(args, outcome);
  return outcome.stdout.toString("utf8").trim();
}

export function dockerFailure(args: readonly string[], outcome: DockerOutcome): SandboxError {
  const stderr = outcome.stderr.toString("utf8").trim();
  return new SandboxError(
    "docker_cli",
    `docker ${args.join(" ")} exited ${outcome.exitCode}: ${stderr === "" ? "(no stderr)" : stderr}`,
  );
}

/** Start a long-lived CLI process whose stdio is a byte channel. */
export function spawnDockerCli(args: readonly string[]): ChildProcessWithoutNullStreams {
  return spawn(dockerBinary(), [...args], { stdio: "pipe" });
}

export async function hasDockerDaemon(): Promise<boolean> {
  try {
    const outcome = await dockerOutcome(["version", "--format", "{{.Server.Version}}"]);
    return outcome.exitCode === 0 && outcome.stdout.toString("utf8").trim() !== "";
  } catch {
    return false;
  }
}
