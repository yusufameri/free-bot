/**
 * The Docker adapter: the local MVP surface behind `SandboxProvider` (plan 2.6, plan 2.9 item 2).
 *
 * Every container this adapter creates carries the ownership labels `freebot.sandbox=<id>`,
 * `freebot.unit=<unit>` and `freebot.provider=docker` (order 22). Cleanup is label-scoped to those
 * containers and never prunes, so a shared Docker engine can hold other units' work.
 *
 * `docs/sandbox-provider.md` has the per-method semantics, the typed gaps (pause-memory, fork,
 * desktop) and the idle-kill cut.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { Duplex, PassThrough, type Readable, type Writable } from "node:stream";
import { type SupervisorToAgent, splitLines } from "@freebot/sandbox-agent";
import { dockerCli, dockerFailure, dockerOutcome, spawnDockerCli } from "./docker-cli.ts";
import { ensurePinnedImage } from "./image.ts";
import {
  type DetachedExec,
  type ExecOptions,
  type ExecResult,
  type ExecStream,
  type ProviderId,
  type SandboxCapabilities,
  SandboxError,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxSnapshot,
  type SandboxSpec,
  UnsupportedCapabilityError,
  type VncStream,
  validateSandboxSpec,
} from "./interface.ts";

export const SANDBOX_LABEL = "freebot.sandbox";
export const UNIT_LABEL = "freebot.unit";
export const PROVIDER_LABEL = "freebot.provider";
export const CONTAINER_PREFIX = "freebot-sbx-";
export const DEFAULT_STATE_DIR = "/var/freebot";
/** The unit that owns containers this adapter creates; the scheduler follow-up makes this per-Bot. */
export const DEFAULT_UNIT = "u1.2";

const TUNNEL_HANDSHAKE_TIMEOUT_MS = 5000;
const DESKTOP_FOLLOW_UP =
  "the screen channel (Xvfb + noVNC) lands in Phase 2; the interface carries it now so boat and E2B implement it without a redesign";
const FORK_FOLLOW_UP =
  "Phase 2+; today snapshot() plus create({ image: snapshot.ref }) restores the disk state into a new sandbox";

export function containerName(id: string): string {
  return `${CONTAINER_PREFIX}${id}`;
}

/** The ownership labels written on every container (order 22). */
export function freebotLabels(id: string, unit: string): Record<string, string> {
  return { [SANDBOX_LABEL]: id, [UNIT_LABEL]: unit, [PROVIDER_LABEL]: "docker" };
}

/**
 * Byte-transparent stdio <-> TCP bridge, run inside the sandbox by the image's own node. The
 * tunnel and the port forward are both this pipe; nothing above it interprets bytes.
 */
const BRIDGE_SCRIPT =
  'const net = require("node:net"); const socket = net.connect(Number(process.argv[1]), "127.0.0.1"); socket.on("error", (error) => { console.error(String(error)); process.exit(1); }); process.stdin.pipe(socket); socket.pipe(process.stdout); socket.on("close", () => process.exit(0));';

export interface DockerAdapterOptions {
  /** Ownership label for order-22 cleanup. Defaults to `u1.2`. */
  readonly unit?: string;
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

function envFlags(env: Readonly<Record<string, string>> | undefined): string[] {
  return Object.entries(env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

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

function isAttached(value: unknown): value is Extract<SupervisorToAgent, { kind: "attached" }> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { kind?: unknown; acked?: unknown; lastSeq?: unknown };
  return (
    record.kind === "attached" &&
    typeof record.acked === "number" &&
    typeof record.lastSeq === "number"
  );
}

/**
 * `Duplex.from`'s documented object form: reads come from `readable`, writes go to `writable`.
 * @types/node lists only the web stream pair, so the cast covers the type gap; the object form is
 * Node's documented shape and is exercised by this package's Docker integration suite.
 */
function duplexFromPair(readable: Readable, writable: Writable): Duplex {
  return Duplex.from({ readable, writable } as unknown as Parameters<typeof Duplex.from>[0]);
}

/** Resolve on the first complete JSONL line, keeping the remainder for the caller. */
function firstLine(stream: Readable, timeoutMs: number): Promise<{ line: string; rest: string }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      stream.off("data", onData);
    };
    const onData = (chunk: Buffer) => {
      const split = splitLines(buffer, chunk.toString("utf8"));
      buffer = split.rest;
      const line = split.lines[0];
      if (line === undefined) return;
      const rest = [...split.lines.slice(1).map((kept) => `${kept}\n`), split.rest].join("");
      cleanup();
      resolve({ line, rest });
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`no line within ${timeoutMs}ms`));
    }, timeoutMs);
    stream.on("data", onData);
  });
}

export class DockerAdapter implements SandboxProvider {
  readonly id: ProviderId = "docker";
  readonly unit: string;
  readonly #live = new Map<string, LiveEntry>();

  constructor(options: DockerAdapterOptions = {}) {
    this.unit = options.unit ?? DEFAULT_UNIT;
  }

  capabilities(): SandboxCapabilities {
    return { memoryPause: false, dockerInVm: false, kvm: false, gpu: false, regions: ["local"] };
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    validateSandboxSpec(spec);
    const handle: SandboxHandle = { provider: this.id, id: spec.name };
    const container = containerName(spec.name);
    const image = spec.image ?? (await ensurePinnedImage()).ref;
    const stateDir = spec.stateDir ?? DEFAULT_STATE_DIR;
    const mounts = (spec.mounts ?? []).flatMap((mount) => [
      "--mount",
      `type=bind,src=${mount.host},dst=${mount.container}${mount.readOnly === true ? ",readonly" : ""}`,
    ]);
    const labels = Object.entries({
      ...freebotLabels(spec.name, this.unit),
      ...(spec.labels ?? {}),
    });
    await dockerCli([
      "run",
      "-d",
      "--name",
      container,
      ...labels.flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      ...envFlags(spec.env),
      ...mounts,
      image,
      ...(spec.cmd ?? ["sleep", "infinity"]),
    ]);
    await dockerCli(["exec", container, "mkdir", "-p", stateDir]);
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
    const args = [
      "exec",
      ...(options.cwd === undefined ? [] : ["-w", options.cwd]),
      ...envFlags(options.env),
      ...(options.detached === true ? ["-d"] : []),
      containerName(handle.id),
      ...cmd,
    ];
    const child = spawnDockerCli(args);
    const result = collect(child);
    if (options.detached === true) {
      const outcome = await result;
      if (outcome.exitCode !== 0) throw dockerFailure(args, outcome);
      return { started: true };
    }
    if (options.stream === true) return { stdout: child.stdout, stderr: child.stderr, result };
    return result;
  }

  async upload(handle: SandboxHandle, localPath: string, remotePath: string): Promise<void> {
    this.#require(handle);
    if (!remotePath.startsWith("/")) {
      throw new SandboxError("invalid_spec", `upload needs an absolute remote path: ${remotePath}`);
    }
    this.#touch(handle);
    await dockerCli(["cp", localPath, `${containerName(handle.id)}:${remotePath}`]);
  }

  async download(handle: SandboxHandle, remotePath: string, localPath: string): Promise<void> {
    this.#require(handle);
    if (!remotePath.startsWith("/")) {
      throw new SandboxError(
        "invalid_spec",
        `download needs an absolute remote path: ${remotePath}`,
      );
    }
    this.#touch(handle);
    await dockerCli(["cp", `${containerName(handle.id)}:${remotePath}`, localPath]);
  }

  /** Manual, disk-only `docker commit`; memory is not captured (see capabilities()). */
  async snapshot(handle: SandboxHandle, name?: string): Promise<SandboxSnapshot> {
    this.#require(handle);
    if (name !== undefined && !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(name)) {
      throw new SandboxError("invalid_spec", `invalid snapshot name: ${JSON.stringify(name)}`);
    }
    this.#touch(handle);
    const tag = `freebot-snapshot/${handle.id}:${name ?? timestampTag()}`;
    await dockerCli(["commit", containerName(handle.id), tag]);
    const fields = (
      await dockerCli(["image", "inspect", "--format", "{{.Id}} {{.Created}}", tag])
    ).split(" ");
    const ref = fields[0];
    const createdAt = fields[1];
    if (ref === undefined || createdAt === undefined) {
      throw new SandboxError(
        "docker_cli",
        `docker image inspect ${tag} returned an unexpected shape`,
      );
    }
    return { provider: this.id, handleId: handle.id, name: name ?? null, ref, tag, createdAt };
  }

  async fork(_from: SandboxHandle): Promise<SandboxHandle> {
    throw new UnsupportedCapabilityError(this.id, "fork", FORK_FOLLOW_UP);
  }

  async stop(handle: SandboxHandle): Promise<void> {
    this.#require(handle);
    const entry = this.#live.get(liveKey(handle));
    if (entry !== undefined) {
      this.#disarm(handle);
      this.#closeResources(entry);
    }
    // `-t 2`: the in-VM supervisor exits on SIGTERM within 250ms; a stopped `sleep infinity`
    // sandbox would otherwise hold the default 10s SIGKILL grace.
    await dockerCli(["stop", "-t", "2", containerName(handle.id)]);
  }

  async resume(handle: SandboxHandle): Promise<void> {
    this.#require(handle);
    await dockerCli(["start", containerName(handle.id)]);
    const key = liveKey(handle);
    const existing = this.#live.get(key);
    if (existing === undefined) {
      this.#live.set(key, {
        stateDir: DEFAULT_STATE_DIR,
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
    await dockerCli(["rm", "-f", containerName(handle.id)]);
  }

  /**
   * A loopback forward: one `docker exec` bridge per accepted connection. Works on Docker Desktop,
   * where a container's own IP is not reachable from the host and `-p` cannot be added after
   * creation. The forward closes with stop/delete, not before.
   */
  async exposePort(handle: SandboxHandle, port: number): Promise<string> {
    this.#require(handle);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SandboxError("invalid_spec", `invalid port: ${port}`);
    }
    this.#touch(handle);
    const container = containerName(handle.id);
    const sockets = new Set<Socket>();
    const server: Server = createServer((socket) => {
      sockets.add(socket);
      const bridge = this.#spawnBridge(container, port);
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
   * Attach where a tunnel agent attaches: the supervisor's loopback link. The duplex carries the
   * link's own JSONL frames (up: `SupervisorToAgent`, down: `AgentToSupervisor`), read with the
   * landed framing in `@freebot/sandbox-agent`, and the supervisor's `attached` handshake is
   * validated here and re-emitted so the caller sees the same first line every agent sees.
   */
  async tunnel(handle: SandboxHandle): Promise<Duplex> {
    this.#require(handle);
    this.#touch(handle);
    const container = containerName(handle.id);
    const stateDir = this.#live.get(liveKey(handle))?.stateDir ?? DEFAULT_STATE_DIR;
    const portFile = `${stateDir}/supervisor.port`;
    const outcome = await dockerOutcome(["exec", container, "cat", portFile]);
    const port = Number(outcome.stdout.toString("utf8").trim());
    if (outcome.exitCode !== 0 || !Number.isSafeInteger(port) || port <= 0) {
      throw new SandboxError(
        "link_error",
        `no supervisor link in ${container}: ${portFile} is not readable (start apps/sandbox-agent's supervisor in the sandbox first), docker said: ${outcome.stderr.toString("utf8").trim() || "nothing"}`,
      );
    }
    const child = spawnDockerCli([
      "exec",
      "-i",
      container,
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
        `the link at ${container}:${port} sent no attached handshake: ${error instanceof Error ? error.message : String(error)}`,
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
        `the link at ${container}:${port} did not open with an attached handshake; first line was ${JSON.stringify(handshake.line)}`,
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
   * Order 22 harness sweep: remove only the containers carrying this adapter's ownership labels.
   * Never prunes, never matches by name pattern, never touches another unit's containers.
   */
  async sweep(): Promise<string[]> {
    const listed = await dockerCli([
      "ps",
      "-aq",
      "--filter",
      `label=${UNIT_LABEL}=${this.unit}`,
      "--filter",
      `label=${PROVIDER_LABEL}=docker`,
    ]);
    const ids = listed.split("\n").filter((line) => line !== "");
    if (ids.length === 0) return [];
    await dockerCli(["rm", "-f", ...ids]);
    return ids;
  }

  #spawnBridge(container: string, containerPort: number): ChildProcessWithoutNullStreams {
    const child = spawnDockerCli([
      "exec",
      "-i",
      container,
      "node",
      "-e",
      BRIDGE_SCRIPT,
      String(containerPort),
    ]);
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[sandbox] bridge: ${chunk}`));
    return child;
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
        // The container was swept or removed elsewhere; the TTL is already spent.
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
