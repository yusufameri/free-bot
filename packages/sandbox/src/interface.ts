/**
 * The `SandboxProvider` surface from plan 2.6, frozen against the strictest adapter (boat: screen,
 * suspend, fork) rather than against the easiest one. An adapter implements all of it; a
 * capability a provider does not have is a typed `UnsupportedCapabilityError` at call time, never a
 * silent no-op.
 *
 * `docs/sandbox-provider.md` carries the per-provider table (Docker today, E2B and boat next), the
 * exact Docker semantics, and the error contract.
 */

import type { Duplex, Readable } from "node:stream";

/** Provider ids with an adapter or a committed adapter plan (plan 2.5, plan Part 12). */
export type ProviderId = "docker" | "e2b" | "boat" | "firecracker" | "microsandbox";

/** One sandbox on one provider. Produced by `create`/`fork`, passed back to every other method. */
export interface SandboxHandle {
  readonly provider: ProviderId;
  /** Provider-native id. Docker: the sandbox name, which is also the container name's suffix. */
  readonly id: string;
}

export interface SandboxMount {
  /** Host path. It must be absolute and contain no comma or colon (Docker's CSV mount syntax). */
  readonly host: string;
  readonly container: string;
  readonly readOnly?: boolean;
}

export interface SandboxSpec {
  /** Lowercase letters, digits and dashes, max 48. Becomes the handle id and the container name. */
  readonly name: string;
  /** Image override. Defaults to the pinned image constant (`ensurePinnedImage`). */
  readonly image?: string;
  /** Command that keeps the sandbox alive. Defaults to `["sleep", "infinity"]`. */
  readonly cmd?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly mounts?: readonly SandboxMount[];
  /** Where the in-VM agent keeps its files (`supervisor.port`, `pi.pid`). Defaults to `/var/freebot`. */
  readonly stateDir?: string;
  /** Extra labels. The `freebot.` namespace is reserved for the adapter's ownership labels. */
  readonly labels?: Readonly<Record<string, string>>;
  /**
   * Stop the sandbox after this many ms without an adapter call. This is the Phase 1 honest cut;
   * docs/sandbox-provider.md names what the scheduler follow-up still owns.
   */
  readonly idleTtlMs?: number;
}

export interface ExecOptions {
  /** Return live streams instead of only the buffered outcome. */
  readonly stream?: boolean;
  /** Start and return; output is not captured (`docker exec -d`). */
  readonly detached?: boolean;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ExecResult {
  /** The command's own exit code. The provider only throws when it could not run the command at all. */
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface ExecStream {
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Resolves with the buffered outcome when the process exits. */
  readonly result: Promise<ExecResult>;
}

export interface DetachedExec {
  /** The provider accepted the command. Nothing waits for it and no output is captured. */
  readonly started: true;
}

export interface SandboxSnapshot {
  readonly provider: ProviderId;
  /** The handle the snapshot was taken from. */
  readonly handleId: string;
  /** Caller-supplied name, or null when the tag carries a timestamp instead. */
  readonly name: string | null;
  /** Provider-native reference: the Docker image id (`sha256:...`). */
  readonly ref: string;
  /** Human-readable tag, where the provider has one. */
  readonly tag: string;
  readonly createdAt: string;
}

/** The live screen channel. `wsUrl` speaks noVNC's wire format (websockify). */
export interface VncStream {
  readonly wsUrl: string;
}

export interface SandboxCapabilities {
  /** Stop keeps memory, not just disk (E2B). */
  readonly memoryPause: boolean;
  readonly dockerInVm: boolean;
  readonly kvm: boolean;
  readonly gpu: boolean;
  /** Where sandboxes can run. `"local"` means this host. */
  readonly regions: readonly string[];
}

export interface SandboxProvider {
  readonly id: ProviderId;

  create(spec: SandboxSpec): Promise<SandboxHandle>;

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

  upload(handle: SandboxHandle, localPath: string, remotePath: string): Promise<void>;
  download(handle: SandboxHandle, remotePath: string, localPath: string): Promise<void>;

  snapshot(handle: SandboxHandle, name?: string): Promise<SandboxSnapshot>;
  fork(from: SandboxHandle): Promise<SandboxHandle>;

  stop(handle: SandboxHandle): Promise<void>;
  resume(handle: SandboxHandle): Promise<void>;
  delete(handle: SandboxHandle): Promise<void>;

  /** A host-reachable URL for a port inside the sandbox. */
  exposePort(handle: SandboxHandle, port: number): Promise<string>;
  desktop(handle: SandboxHandle): Promise<VncStream>;
  /** A duplex to the in-VM agent link, speaking `@freebot/sandbox-agent`'s link frames. */
  tunnel(handle: SandboxHandle): Promise<Duplex>;

  capabilities(): SandboxCapabilities;
}

export type SandboxErrorCode =
  | "invalid_spec"
  | "invalid_handle"
  | "invalid_command"
  | "unsupported_capability"
  | "docker_cli"
  | "msb_cli"
  | "link_error";

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode, message: string) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
  }
}

/**
 * A provider does not implement the capability. Typed and always thrown, so callers can branch on
 * it (`error instanceof UnsupportedCapabilityError`) and tests can assert it, rather than
 * discovering a silent no-op later.
 */
export class UnsupportedCapabilityError extends SandboxError {
  readonly capability: string;
  readonly provider: ProviderId;

  constructor(provider: ProviderId, capability: string, followUp: string) {
    super("unsupported_capability", `${provider} does not support ${capability}: ${followUp}`);
    this.name = "UnsupportedCapabilityError";
    this.capability = capability;
    this.provider = provider;
  }
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Boundary validation for `create`. Every rejection carries a literal, assertable message. */
export function validateSandboxSpec(spec: SandboxSpec): void {
  if (!NAME_PATTERN.test(spec.name)) {
    throw new SandboxError(
      "invalid_spec",
      `invalid sandbox name: ${JSON.stringify(spec.name)} (lowercase letters, digits and dashes, max 48 chars)`,
    );
  }
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    if (!ENV_KEY_PATTERN.test(key))
      throw new SandboxError("invalid_spec", `invalid env key: ${key}`);
    if (value.includes("\n"))
      throw new SandboxError("invalid_spec", `env value has a newline: ${key}`);
  }
  for (const mount of spec.mounts ?? []) {
    if (!mount.host.startsWith("/")) {
      throw new SandboxError(
        "invalid_spec",
        `invalid mount host (must be absolute): ${mount.host}`,
      );
    }
    if (!mount.container.startsWith("/")) {
      throw new SandboxError(
        "invalid_spec",
        `invalid mount container path (must be absolute): ${mount.container}`,
      );
    }
    for (const path of [mount.host, mount.container]) {
      if (path.includes(",") || path.includes(":")) {
        throw new SandboxError(
          "invalid_spec",
          `mount paths cannot contain a comma or colon: ${path}`,
        );
      }
    }
  }
  if (spec.stateDir !== undefined && !spec.stateDir.startsWith("/")) {
    throw new SandboxError("invalid_spec", `invalid stateDir (must be absolute): ${spec.stateDir}`);
  }
  if (spec.idleTtlMs !== undefined && (!Number.isInteger(spec.idleTtlMs) || spec.idleTtlMs <= 0)) {
    throw new SandboxError(
      "invalid_spec",
      `invalid idleTtlMs (must be a positive integer): ${spec.idleTtlMs}`,
    );
  }
  for (const key of Object.keys(spec.labels ?? {})) {
    if (key.length === 0) throw new SandboxError("invalid_spec", "label keys cannot be empty");
    if (key.startsWith("freebot.")) {
      throw new SandboxError("invalid_spec", `labels must not use the freebot namespace: ${key}`);
    }
  }
}
