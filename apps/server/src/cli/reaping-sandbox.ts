/**
 * The launch's sandboxes, and the record of the sandboxes they created.
 *
 * The loop destroys its sandbox on every path it can reach, and a Ctrl-C reaches none of them: the
 * process dies mid-run and the sandbox survives with no process left to remove it
 * (docs/one-run-path.md, "What remains"). `LaunchSandboxes` hands each run its own port, keeps the
 * name of every sandbox those ports asked the chosen backend for, and `reap()` asks the landed
 * adapter to `delete` exactly those names. It never sweeps by label or name pattern, so a sandbox
 * another launch or another unit created is never in scope (order 22). One port per run is also
 * what keeps two concurrent runs off each other's sandbox, which one shared port would not.
 *
 * The backend is the launcher's own choice (`sandbox-backend.ts`), so this class names no engine at
 * all: `holds` is the chosen backend's answer to "does the engine still know this sandbox", and
 * `capabilities()` stays the adapter's.
 *
 * `reap()` is idempotent. A sandbox counts as removed only after the engine no longer holds it, so
 * a second call reports nothing and a sandbox that refused to go is named, not counted as gone.
 */

import type { ProviderToolCall, SandboxPort, ToolOutcome } from "@freebot/core";
import type { SandboxSpec } from "@freebot/sandbox";
import { DockerRunSandbox } from "../run-ports.ts";
import type { SandboxBackend } from "./sandbox-backend.ts";

/**
 * How long a sandbox that is on its way out is allowed to take. A run's own `destroy` runs as the
 * run settles, which can be a moment after the page renders its last frame, so a launch that reaps
 * in between would find the sandbox still listed and report a leak that is not one.
 */
const REAP_ATTEMPTS = 8;
const REAP_BACKOFF_MS = 250;

export interface ReapResult {
  /** Sandbox names this launch created and removed, as the run's spec named them. */
  readonly removed: readonly string[];
  /** Sandbox names this launch created that the engine still holds. Non-empty is a failure. */
  readonly surviving: readonly string[];
}

/** One run's sandbox, remembering the name it asked the backend for. */
class TrackedSandbox implements SandboxPort {
  readonly #inner: DockerRunSandbox;
  readonly #names = new Set<string>();

  constructor(backend: SandboxBackend) {
    this.#inner = new DockerRunSandbox(backend.provider);
  }

  async create(spec: SandboxSpec): Promise<void> {
    this.#names.add(spec.name);
    await this.#inner.create(spec);
  }

  execute(call: ProviderToolCall): Promise<ToolOutcome> {
    return this.#inner.execute(call);
  }

  destroy(): Promise<void> {
    return this.#inner.destroy();
  }

  names(): string[] {
    return [...this.#names];
  }

  /** Forget a sandbox the engine no longer holds. */
  forget(name: string): void {
    this.#names.delete(name);
  }
}

export class LaunchSandboxes {
  readonly #backend: SandboxBackend;
  readonly #ports: TrackedSandbox[] = [];

  constructor(backend: SandboxBackend) {
    this.#backend = backend;
  }

  /** A sandbox for one run. The launcher passes this to the service as its sandbox factory. */
  port(): SandboxPort {
    const port = new TrackedSandbox(this.#backend);
    this.#ports.push(port);
    return port;
  }

  async reap(): Promise<ReapResult> {
    const removed: string[] = [];
    const surviving: string[] = [];
    for (const port of this.#ports) {
      for (const name of port.names()) {
        if (await this.#backend.holds(name)) {
          try {
            await this.#backend.provider.delete({ provider: this.#backend.id, id: name });
          } catch {
            // Whether it is really gone is the check below, not the CLI's exit code.
          }
        }
        if (await stillThere(this.#backend, name)) surviving.push(name);
        else {
          removed.push(name);
          port.forget(name);
        }
      }
    }
    return { removed, surviving };
  }
}

/**
 * Whether the engine still holds the sandbox named for this run.
 *
 * A sandbox the run itself is removing is listed for a moment after its last usage, so "still
 * there" is only a leak once it stays there. A sandbox that really is wedged is reported after
 * this bounded wait, so the check stays truthful in both directions.
 */
async function stillThere(backend: SandboxBackend, name: string): Promise<boolean> {
  for (let attempt = 0; attempt < REAP_ATTEMPTS; attempt++) {
    if (!(await backend.holds(name))) return false;
    await Bun.sleep(REAP_BACKOFF_MS);
  }
  return await backend.holds(name);
}
