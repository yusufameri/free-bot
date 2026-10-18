/**
 * The microsandbox adapter: a local microVM backend with no account and no Docker under it
 * (order 34, plan Part 12). It implements the frozen `SandboxProvider` and answers the conformance
 * suite's ownership port through its own engine, so a machine with no Docker runs the same runs.
 *
 * Every sandbox this adapter creates carries the order-22 ownership labels `freebot.sandbox`,
 * `freebot.unit` and `freebot.provider=microsandbox`, and `sweep()` removes only the sandboxes
 * carrying this adapter's own unit label, so a shared engine can hold other units' work.
 *
 * microsandbox is beta software with breaking changes expected, and that label travels with the
 * adapter: into `docs/microsandbox.md`, into `capabilities()`, and into any surface that renders
 * the backend's own words.
 *
 * The engine's boundary is the `msb` CLI. The pinned image is an OCI image the engine caches;
 * `ensureMicrosandboxImage` imports it once and never invokes Docker.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { type Duplex, PassThrough } from "node:stream";
import { DEFAULT_STATE_DIR, DEFAULT_UNIT } from "./docker.ts";
import { PINNED_IMAGE } from "./image.ts";
import {
  type DetachedExec,
  type ExecOptions,
  type ExecResult,
  type ExecStream,
  type ProviderId,
  type SandboxCapabilities,
  SandboxError,
  type SandboxHandle,
  type SandboxMount,
  type SandboxProvider,
  type SandboxSnapshot,
  type SandboxSpec,
  UnsupportedCapabilityError,
  type VncStream,
  validateSandboxSpec,
} from "./interface.ts";
import { BRIDGE_SCRIPT, duplexFromPair, firstLine, isAttached } from "./link-bridge.ts";
import {
  collectMsbOutcome,
  MSB_CLI_TIMEOUT_MS,
  MSB_SANDBOX_TIMEOUT_MS,
  type MsbOutcome,
  msbCli,
  msbFailure,
  msbOutcome,
  spawnMsb,
} from "./msb-cli.ts";
import { PROVIDER_LABEL, SANDBOX_LABEL, UNIT_LABEL } from "./ownership.ts";

export const MICROSANDBOX_ID: ProviderId = "microsandbox";
export const MSB_STATE_DIR = DEFAULT_STATE_DIR;
/** The engine's group-name prefix for a snapshot, which is also how `create` recognises one. */
export const SNAPSHOT_GROUP_PREFIX = "freebot-snapshot-";
/** The suite's own tag shape for a snapshot; the human-readable half of `snapshot.ref`. */
export const SNAPSHOT_TAG_PREFIX = "freebot-snapshot/";
/** A snapshot member name: what the engine's own naming rule allows, minus the colon and dot ends. */
export const MSB_SNAPSHOT_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

const TUNNEL_HANDSHAKE_TIMEOUT_MS = 5000;
/** How long a lifecycle postcondition may take to become true in the engine's own account. */
const MSB_LIFECYCLE_TIMEOUT_MS = 10_000;
const DESKTOP_FOLLOW_UP =
  "the screen channel (Xvfb + noVNC) lands in Phase 2; the interface carries it now so boat and E2B implement it without a redesign";

function envFlags(env: Readonly<Record<string, string>> | undefined): string[] {
  return Object.entries(env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

/**
 * The engine refuses a bind-mount host path that goes through a symlink (`/var` on this Mac is one),
 * so a mount's host path is resolved before it is handed over. A path that does not exist yet is
 * passed through unchanged, and the engine's own error names it.
 */
export function resolvedHostPath(host: string): string {
  try {
    return realpathSync(host);
  } catch {
    return host;
  }
}

function mountFlags(mounts: readonly SandboxMount[]): string[] {
  return mounts.flatMap((mount) => [
    "-v",
    `${resolvedHostPath(mount.host)}:${mount.container}${mount.readOnly === true ? ":ro" : ""}`,
  ]);
}

/** Buffered collection for the stream path, which is caller-owned and deliberately unbounded. */
function collect(child: ChildProcessWithoutNullStreams): Promise<ExecResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }),
    );
  });
}

function timestampTag(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}

function requireAbsoluteRemote(remotePath: string, what: string): void {
  if (!remotePath.startsWith("/")) {
    throw new SandboxError("invalid_spec", `${what} needs an absolute remote path: ${remotePath}`);
  }
}

function execFailure(what: string, outcome: MsbOutcome): SandboxError {
  const stderr = outcome.stderr.toString("utf8").trim();
  return new SandboxError(
    "msb_cli",
    `msb ${what} exited ${outcome.exitCode}: ${stderr === "" ? "(no stderr)" : stderr}`,
  );
}

export interface MicrosandboxImage {
  /** The reference the suite passes as `spec.image`. */
  readonly ref: string;
  /** What the engine observed about that image before any sandbox existed. */
  readonly identity: string;
}

/** The repo's export path for the pinned image's OCI archive, under the system temp directory. */
export function defaultImageTar(ref: string): string {
  return join(process.env.TMPDIR ?? "/tmp", `${ref.replaceAll(/[:/]/g, "-")}.tar`);
}

/** One cached image's digest and layer count, as the engine reports them. */
async function describeImage(ref: string): Promise<string> {
  const outcome = await msbOutcome(["image", "inspect", ref, "--format", "json"]);
  if (outcome.exitCode !== 0) return `${ref} is cached`;
  const parsed = JSON.parse(outcome.stdout.toString("utf8")) as {
    digest?: unknown;
    layer_count?: unknown;
  };
  const digest = typeof parsed.digest === "string" ? parsed.digest : "unknown digest";
  const layers = typeof parsed.layer_count === "number" ? parsed.layer_count : 0;
  return `${ref} ${digest} ${layers} OCI layers, imported with msb image load`;
}

/**
 * Resolve the pinned image inside the engine's cache, importing it once when a person has supplied
 * the OCI archive.
 *
 * The image is an OCI artifact, not a Docker image: `msb image load` verifies each layer's digest
 * and never contacts a registry, and the runtime path that follows is `msb` alone. The archive is
 * the OCI artifact the repo's recipe builds; `FREEBOT_MICROSANDBOX_IMAGE_TAR` names its path, and
 * the repo's own export path under the system temp directory is tried otherwise. A machine that has
 * neither is told exactly which two things would close the gap rather than failing with the
 * engine's own words.
 */
export async function ensureMicrosandboxImage(): Promise<MicrosandboxImage> {
  const ref = PINNED_IMAGE.tag;
  const listed = await msbOutcome(["image", "list", "-q"]);
  if (listed.exitCode === 0) {
    const cached = listed.stdout
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim());
    if (cached.includes(ref)) return { ref, identity: await describeImage(ref) };
  }
  const tar = process.env.FREEBOT_MICROSANDBOX_IMAGE_TAR ?? defaultImageTar(ref);
  if (!existsSync(tar)) {
    throw new SandboxError(
      "msb_cli",
      `microsandbox holds no image ${ref} and no OCI archive was found at ${tar}. Import one with \`msb image load -i <archive> --tag ${ref}\`; the archive is the OCI artifact ${PINNED_IMAGE.dockerfile} builds (set FREEBOT_MICROSANDBOX_IMAGE_TAR to its path).`,
    );
  }
  await msbCli(["image", "load", "-i", tar, "--tag", ref]);
  return { ref, identity: await describeImage(ref) };
}

interface LiveEntry {
  readonly stateDir: string;
  /** The TTL `create` was called with; null means no idle-kill for this handle. */
  readonly idleTtlMs: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Open tunnels and port forwards. Non-empty holds the sandbox awake at TTL expiry. */
  readonly resources: Set<() => void>;
  /** Set by stop/delete; clears the intent to re-arm the TTL. */
  disarmed: boolean;
}

function liveKey(handle: SandboxHandle): string {
  return `${handle.provider}:${handle.id}`;
}

export interface MicrosandboxAdapterOptions {
  /** Ownership label for order-22 cleanup. Defaults to `u1.2`. */
  readonly unit?: string;
}

export class MicrosandboxAdapter implements SandboxProvider {
  readonly id: ProviderId = MICROSANDBOX_ID;
  readonly unit: string;
  readonly #live = new Map<string, LiveEntry>();

  constructor(options: MicrosandboxAdapterOptions = {}) {
    this.unit = options.unit ?? DEFAULT_UNIT;
  }

  /**
   * microsandbox is beta software. `memoryPause` is false because the frozen interface models
   * stop/resume, and a stopped microVM keeps its disk but not its memory (the engine's own
   * `pause`/`resume` keep memory, and that is not the pair this interface carries). `kvm` is the
   * host's: false on this Mac, where microsandbox runs on the Hypervisor framework, true on Linux.
   */
  capabilities(): SandboxCapabilities {
    return {
      memoryPause: false,
      dockerInVm: false,
      kvm: process.platform === "linux",
      gpu: false,
      regions: ["local"],
    };
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    validateSandboxSpec(spec);
    const handle: SandboxHandle = { provider: this.id, id: spec.name };
    const image = spec.image ?? (await ensureMicrosandboxImage()).ref;
    const stateDir = spec.stateDir ?? MSB_STATE_DIR;
    const volumes = mountFlags(spec.mounts ?? []);
    if (image.startsWith(SNAPSHOT_GROUP_PREFIX)) {
      // A snapshot reference is what `create` boots from, exactly as the suite uses it. `msb snap
      // restore` has no `--label`, so the ownership labels are applied as its own later step.
      await msbCli(["snap", "restore", image, "-n", spec.name, ...volumes], MSB_SANDBOX_TIMEOUT_MS);
      await this.#label(spec.name);
    } else {
      // The engine's own `--idle-timeout` takes whole seconds and refuses a millisecond value, while
      // this interface's `idleTtlMs` is milliseconds. The TTL is therefore the adapter's own timer,
      // exactly as the Docker adapter keeps its own. `docs/microsandbox.md` records the gap.
      await msbCli(
        [
          "create",
          "-n",
          spec.name,
          "--label",
          `${SANDBOX_LABEL}=${spec.name}`,
          "--label",
          `${UNIT_LABEL}=${this.unit}`,
          "--label",
          `${PROVIDER_LABEL}=${MICROSANDBOX_ID}`,
          ...envFlags(spec.env),
          ...volumes,
          image,
        ],
        MSB_SANDBOX_TIMEOUT_MS,
      );
    }
    await msbCli(["exec", "--no-tty", "--no-stdin", spec.name, "--", "mkdir", "-p", stateDir]);
    this.#live.set(liveKey(handle), {
      stateDir,
      idleTtlMs: spec.idleTtlMs ?? null,
      timer: null,
      resources: new Set(),
      disarmed: false,
    });
    this.#touch(handle);
    return handle;
  }

  exec(
    handle: SandboxHandle,
    cmd: readonly string[],
    options?: ExecOptions & { readonly stream?: false; readonly detached?: false },
  ): Promise<ExecResult>;
  exec(
    handle: SandboxHandle,
    cmd: readonly string[],
    options: ExecOptions & { readonly stream: true; readonly detached?: false },
  ): Promise<ExecStream>;
  exec(
    handle: SandboxHandle,
    cmd: readonly string[],
    options: ExecOptions & { readonly detached: true; readonly stream?: false },
  ): Promise<DetachedExec>;
  async exec(
    handle: SandboxHandle,
    cmd: readonly string[],
    options: ExecOptions = {},
  ): Promise<ExecResult | ExecStream | DetachedExec> {
    this.#require(handle);
    if (cmd.length === 0) throw new SandboxError("invalid_command", "exec needs a command");
    this.#touch(handle);
    const shared = [
      ...(options.cwd === undefined ? [] : ["-w", options.cwd]),
      ...envFlags(options.env),
      handle.id,
      "--",
      ...cmd,
    ];
    if (options.stream === true) {
      const child = spawnMsb(["exec", "--stream", ...shared]);
      return { stdout: child.stdout, stderr: child.stderr, result: collect(child) };
    }
    if (options.detached === true) {
      const outcome = await collectMsbOutcome(
        spawnMsb(["exec", "-d", ...shared]),
        MSB_CLI_TIMEOUT_MS,
      );
      if (outcome.exitCode !== 0) throw execFailure("exec -d", outcome);
      return { started: true };
    }
    const outcome = await collectMsbOutcome(
      spawnMsb(["exec", "--no-tty", "--no-stdin", ...shared]),
      MSB_CLI_TIMEOUT_MS,
    );
    if (outcome.timedOut) throw execFailure("exec", outcome);
    return { exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr };
  }

  async upload(handle: SandboxHandle, localPath: string, remotePath: string): Promise<void> {
    this.#require(handle);
    requireAbsoluteRemote(remotePath, "upload");
    this.#touch(handle);
    await msbCli(["copy", localPath, `${handle.id}:${remotePath}`], MSB_CLI_TIMEOUT_MS);
  }

  async download(handle: SandboxHandle, remotePath: string, localPath: string): Promise<void> {
    this.#require(handle);
    requireAbsoluteRemote(remotePath, "download");
    this.#touch(handle);
    await msbCli(["copy", `${handle.id}:${remotePath}`, localPath], MSB_CLI_TIMEOUT_MS);
  }

  /** Disk-only snapshot; memory is not captured (see capabilities()). */
  async snapshot(handle: SandboxHandle, name?: string): Promise<SandboxSnapshot> {
    this.#require(handle);
    if (name !== undefined && !MSB_SNAPSHOT_NAME.test(name)) {
      throw new SandboxError("invalid_spec", `invalid snapshot name: ${JSON.stringify(name)}`);
    }
    this.#touch(handle);
    const member = name ?? timestampTag();
    const group = `${SNAPSHOT_GROUP_PREFIX}${handle.id}`;
    const ref = `${group}:${member}`;
    await msbCli(
      ["snap", "create", "--sandbox", handle.id, "--group", group, "-n", member],
      MSB_SANDBOX_TIMEOUT_MS,
    );
    return {
      provider: this.id,
      handleId: handle.id,
      name: name ?? null,
      ref,
      tag: `${SNAPSHOT_TAG_PREFIX}${handle.id}:${member}`,
      createdAt: await this.#snapshotCreatedAt(ref),
    };
  }

  /** A live CoW fork of a running sandbox; microsandbox's own `fork`, with an adapter-made name. */
  async fork(from: SandboxHandle): Promise<SandboxHandle> {
    this.#require(from);
    const name = `${from.id}-f${Date.now().toString(36)}`;
    await msbCli(["fork", from.id, "-n", name], MSB_SANDBOX_TIMEOUT_MS);
    await this.#label(name);
    const handle: SandboxHandle = { provider: this.id, id: name };
    this.#live.set(liveKey(handle), {
      stateDir: this.#live.get(liveKey(from))?.stateDir ?? MSB_STATE_DIR,
      idleTtlMs: null,
      timer: null,
      resources: new Set(),
      disarmed: false,
    });
    return handle;
  }

  async stop(handle: SandboxHandle): Promise<void> {
    this.#require(handle);
    const entry = this.#live.get(liveKey(handle));
    if (entry !== undefined) {
      this.#disarm(handle);
      this.#closeResources(entry);
    }
    await this.#lifecycle(["stop", handle.id], /already stopped|not running/i);
    await this.#awaitRunning(handle.id, false, MSB_LIFECYCLE_TIMEOUT_MS);
  }

  async resume(handle: SandboxHandle): Promise<void> {
    this.#require(handle);
    await this.#lifecycle(["start", handle.id], /already running/i);
    await this.#awaitRunning(handle.id, true, MSB_LIFECYCLE_TIMEOUT_MS);
    const key = liveKey(handle);
    const existing = this.#live.get(key);
    if (existing === undefined) {
      this.#live.set(key, {
        stateDir: MSB_STATE_DIR,
        idleTtlMs: null,
        timer: null,
        resources: new Set(),
        disarmed: false,
      });
    } else {
      existing.disarmed = false;
    }
    this.#touch(handle);
  }

  async delete(handle: SandboxHandle): Promise<void> {
    this.#require(handle);
    const entry = this.#live.get(liveKey(handle));
    if (entry !== undefined) {
      this.#disarm(handle);
      this.#closeResources(entry);
      this.#live.delete(liveKey(handle));
    }
    const outcome = await msbOutcome(["rm", "-f", handle.id], MSB_CLI_TIMEOUT_MS);
    if (outcome.exitCode === 0) return;
    // The interface's postcondition is absence, and a run's own `destroy` reaches here on paths
    // where the sandbox is already swept. `docs/sandbox-conformance.md` records that Docker throws
    // here and that converging on absence is the honest reading; this adapter converges.
    const text = `${outcome.stdout.toString("utf8")}${outcome.stderr.toString("utf8")}`;
    if (/not found|no such sandbox/i.test(text)) return;
    throw msbFailure(["rm", "-f", handle.id], outcome);
  }

  /**
   * A host loopback forward: one `msb exec --stream` bridge per accepted connection, the same shape
   * the Docker adapter uses because microsandbox publishes ports only at boot and this must work on
   * a sandbox that already exists. The forward closes with stop/delete, not before.
   */
  async exposePort(handle: SandboxHandle, port: number): Promise<string> {
    this.#require(handle);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SandboxError("invalid_spec", `invalid port: ${port}`);
    }
    this.#touch(handle);
    const sockets = new Set<Socket>();
    const server: Server = createServer((socket) => {
      sockets.add(socket);
      const bridge = spawnMsb([
        "exec",
        "--stream",
        handle.id,
        "--",
        "node",
        "-e",
        BRIDGE_SCRIPT,
        String(port),
      ]);
      socket.pipe(bridge.stdin);
      bridge.stdout.pipe(socket);
      socket.on("close", () => {
        sockets.delete(socket);
        bridge.kill();
      });
      socket.on("error", () => socket.destroy());
      bridge.on("close", () => socket.destroy());
    });
    const hostPort = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
    this.#own(handle, () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    });
    return `http://127.0.0.1:${hostPort}`;
  }

  async desktop(_handle: SandboxHandle): Promise<VncStream> {
    throw new UnsupportedCapabilityError(this.id, "desktop", DESKTOP_FOLLOW_UP);
  }

  /**
   * Attach where a tunnel agent attaches: the guest supervisor's loopback link, read from
   * `<stateDir>/supervisor.port`. The duplex carries the link's own JSONL frames, and the
   * supervisor's `attached` handshake is validated here and re-emitted so the caller sees the same
   * first line every agent sees.
   */
  async tunnel(handle: SandboxHandle): Promise<Duplex> {
    this.#require(handle);
    this.#touch(handle);
    const stateDir = this.#live.get(liveKey(handle))?.stateDir ?? MSB_STATE_DIR;
    const portFile = `${stateDir}/supervisor.port`;
    const outcome = await msbOutcome([
      "exec",
      "--no-tty",
      "--no-stdin",
      handle.id,
      "--",
      "cat",
      portFile,
    ]);
    const port = Number(outcome.stdout.toString("utf8").trim());
    if (outcome.exitCode !== 0 || !Number.isSafeInteger(port) || port <= 0) {
      throw new SandboxError(
        "link_error",
        `no supervisor link in ${handle.id}: ${portFile} is not readable (start apps/sandbox-agent's supervisor in the sandbox first), msb said: ${outcome.stderr.toString("utf8").trim() || "nothing"}`,
      );
    }
    const child = spawnMsb([
      "exec",
      "--stream",
      handle.id,
      "--",
      "node",
      "-e",
      BRIDGE_SCRIPT,
      String(port),
    ]);
    child.stderr.on("data", (chunk: Buffer) =>
      process.stderr.write(`[sandbox] link bridge: ${chunk}`),
    );
    let handshake: { line: string; rest: string };
    try {
      handshake = await firstLine(child.stdout, TUNNEL_HANDSHAKE_TIMEOUT_MS);
    } catch (error) {
      child.kill();
      throw new SandboxError(
        "link_error",
        `the link at ${handle.id}:${port} sent no attached handshake: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(handshake.line);
    } catch {
      parsed = null;
    }
    if (!isAttached(parsed)) {
      child.kill();
      throw new SandboxError(
        "link_error",
        `the link at ${handle.id}:${port} did not open with an attached handshake; first line was ${JSON.stringify(handshake.line)}`,
      );
    }
    const readable = new PassThrough();
    readable.write(`${handshake.line}\n${handshake.rest}`);
    child.stdout.pipe(readable);
    const duplex = duplexFromPair(readable, child.stdin);
    const release = () => {
      duplex.destroy();
      child.kill();
      this.#release(handle, release);
    };
    this.#own(handle, release);
    duplex.on("close", release);
    return duplex;
  }

  /**
   * Order 22 harness sweep: remove only the sandboxes carrying this adapter's ownership labels.
   * Never prunes, never matches by name pattern, never touches another unit's sandboxes.
   */
  async sweep(): Promise<string[]> {
    const listed = await msbCli([
      "ls",
      "--label",
      `${UNIT_LABEL}=${this.unit}`,
      "--label",
      `${PROVIDER_LABEL}=${MICROSANDBOX_ID}`,
      "-q",
    ]);
    const names = listed
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (names.length === 0) return [];
    await msbCli(["rm", "-f", ...names], MSB_CLI_TIMEOUT_MS);
    return names;
  }

  /**
   * Run a lifecycle verb whose postcondition is a state rather than an action. The engine exits
   * non-zero when the sandbox is already in that state ("cannot start ... already running"), and an
   * already-true postcondition is a success; anything else is a failure. The engine can also report a
   * stopped sandbox a moment before its runtime releases it, so the caller waits for the state it
   * asked for rather than for the verb to return.
   */
  async #lifecycle(args: readonly string[], alreadyThere: RegExp): Promise<void> {
    const outcome = await msbOutcome(args, MSB_CLI_TIMEOUT_MS);
    if (outcome.exitCode === 0) return;
    const text = `${outcome.stdout.toString("utf8")}${outcome.stderr.toString("utf8")}`;
    if (alreadyThere.test(text)) return;
    throw msbFailure(args, outcome);
  }

  /** Wait, bounded, for the engine to report a sandbox running (or not), so a postcondition holds. */
  async #awaitRunning(name: string, want: boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const outcome = await msbOutcome(["inspect", name, "--format", "json"]);
      if (outcome.exitCode !== 0) return;
      let status = "";
      try {
        status = (
          (JSON.parse(outcome.stdout.toString("utf8")) as { status?: unknown }).status ?? ""
        )
          .toString()
          .trim()
          .toLowerCase();
      } catch {
        return;
      }
      if (status === "") return;
      if ((status === "running") === want) return;
      await Bun.sleep(100);
    }
  }

  /** Apply this adapter's ownership labels to a sandbox that was not created with them. The engine
   * refuses a label change on a running sandbox without `--restart`, and `--restart` keeps the
   * sandbox's disk, which is what a restored snapshot must do.
   */
  async #label(name: string): Promise<void> {
    await msbCli([
      "modify",
      name,
      "--label",
      `${SANDBOX_LABEL}=${name}`,
      "--label",
      `${UNIT_LABEL}=${this.unit}`,
      "--label",
      `${PROVIDER_LABEL}=${MICROSANDBOX_ID}`,
      "--restart",
    ]);
  }

  async #snapshotCreatedAt(ref: string): Promise<string> {
    const outcome = await msbOutcome(["snap", "inspect", ref, "--format", "json"]);
    if (outcome.exitCode !== 0) return new Date().toISOString();
    try {
      const parsed = JSON.parse(outcome.stdout.toString("utf8")) as { created_at?: unknown };
      return typeof parsed.created_at === "string" ? parsed.created_at : new Date().toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  #require(handle: SandboxHandle): void {
    if (handle.provider !== this.id) {
      throw new SandboxError(
        "invalid_handle",
        `handle belongs to ${handle.provider}, not ${this.id}`,
      );
    }
    if (handle.id === "") throw new SandboxError("invalid_handle", "handle has no id");
  }

  #touch(handle: SandboxHandle): void {
    const entry = this.#live.get(liveKey(handle));
    if (entry === undefined || entry.disarmed || entry.idleTtlMs === null) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      // A live tunnel or forward holds the sandbox awake; its release re-arms this timer.
      if (entry.resources.size > 0) return;
      void this.stop(handle).catch(() => {
        // The sandbox was swept or removed elsewhere; the TTL is already spent.
      });
    }, entry.idleTtlMs);
  }

  #disarm(handle: SandboxHandle): void {
    const entry = this.#live.get(liveKey(handle));
    if (entry === undefined) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    entry.disarmed = true;
  }

  #own(handle: SandboxHandle, release: () => void): void {
    this.#live.get(liveKey(handle))?.resources.add(release);
  }

  #release(handle: SandboxHandle, release: () => void): void {
    const entry = this.#live.get(liveKey(handle));
    if (entry === undefined) return;
    entry.resources.delete(release);
    if (entry.disarmed) return;
    this.#touch(handle);
  }

  #closeResources(entry: LiveEntry): void {
    for (const release of [...entry.resources]) release();
    entry.resources.clear();
  }
}
