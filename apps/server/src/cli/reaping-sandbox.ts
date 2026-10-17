/**
 * The launch's sandboxes, and the record of the containers they created.
 *
 * The loop destroys its sandbox on every path it can reach, and a Ctrl-C reaches none of them: the
 * process dies mid-run and the container survives with no process left to remove it
 * (docs/one-run-path.md, "What remains"). `LaunchSandboxes` hands each run its own port, keeps the
 * name of every container those ports handed to Docker, and `reap()` asks the landed adapter to
 * `delete` exactly those names. It never sweeps by label or name pattern, so a container another
 * launch or another unit created is never in scope (order 22). One port per run is also what keeps
 * two concurrent runs off each other's container, which one shared port would not.
 *
 * `reap()` is idempotent. A container counts as removed only after `docker ps -a` no longer knows
 * it, so a second call reports nothing and a container that refused to go is named, not counted as
 * gone.
 */

import type { ProviderToolCall, SandboxPort, ToolOutcome } from "@freebot/core";
import {
  containerName,
  DockerAdapter,
  dockerCli,
  type SandboxHandle,
  type SandboxSpec,
} from "@freebot/sandbox";
import { DockerRunSandbox, RUN_UNIT } from "../run-ports.ts";

export interface ReapResult {
  /** Container names this launch created and removed. */
  readonly removed: readonly string[];
  /** Container names this launch created that Docker still holds. Non-empty is a failure. */
  readonly surviving: readonly string[];
}

/** One run's sandbox, remembering the container it asked Docker for. */
class TrackedSandbox implements SandboxPort {
  readonly #inner = new DockerRunSandbox(new DockerAdapter({ unit: RUN_UNIT }));
  readonly #names = new Set<string>();

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

  /** Forget a container Docker no longer holds. */
  forget(name: string): void {
    this.#names.delete(name);
  }
}

export class LaunchSandboxes {
  readonly #ports: TrackedSandbox[] = [];

  /** A sandbox for one run. The launcher passes this to the service as its sandbox factory. */
  port(): SandboxPort {
    const port = new TrackedSandbox();
    this.#ports.push(port);
    return port;
  }

  async reap(): Promise<ReapResult> {
    const adapter = new DockerAdapter({ unit: RUN_UNIT });
    const removed: string[] = [];
    const surviving: string[] = [];
    for (const port of this.#ports) {
      for (const name of port.names()) {
        if (await exists(name)) {
          const handle: SandboxHandle = { provider: "docker", id: name };
          try {
            await adapter.delete(handle);
          } catch {
            // Whether it is really gone is the check below, not docker's exit code.
          }
        }
        if (await exists(name)) surviving.push(containerName(name));
        else {
          removed.push(containerName(name));
          port.forget(name);
        }
      }
    }
    return { removed, surviving };
  }
}

/** Whether `docker ps -a` still knows the container named for this sandbox. */
async function exists(name: string): Promise<boolean> {
  const listed = await dockerCli([
    "ps",
    "-a",
    "--filter",
    `name=^${containerName(name)}$`,
    "--format",
    "{{.Names}}",
  ]);
  return listed !== "";
}
