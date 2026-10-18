/**
 * The microsandbox conformance subject: the shipped adapter, the pinned engine-cached image, and the
 * ownership port answered through `msb`. It is glue and nothing else, so the suite's assertions stay
 * in one place and this backend is a pass or a failure rather than a second suite.
 *
 * `unit` is this run's own label value, which is what keeps `sweep()` scoped to this run on a shared
 * engine (order 22). The decoys are the sandboxes the sweep must not touch: another unit's label, a
 * sibling run of this suite, and one carrying no ownership marking at all.
 */

import type { ConformanceDecoy, ConformanceSubject, OwnerFact } from "./conformance.ts";
import { DEFAULT_UNIT } from "./docker.ts";
import { ensureMicrosandboxImage, MicrosandboxAdapter, MSB_STATE_DIR } from "./microsandbox.ts";
import { msbCli, msbOutcome } from "./msb-cli.ts";
import { PROVIDER_LABEL, SANDBOX_LABEL, UNIT_LABEL } from "./ownership.ts";

/** A sandbox this run created and must not sweep. `unit` null means it carries no ownership label. */
export interface MicrosandboxDecoySpec {
  readonly name: string;
  readonly unit: string | null;
  readonly why: string;
}

export interface MicrosandboxConformanceOptions {
  /** This run's token. */
  readonly token: string;
  /** The sandboxes the sweep must not touch. */
  readonly decoys: readonly MicrosandboxDecoySpec[];
}

/** One sandbox's liveness and ownership labels, read from the engine's own JSON. */
async function inspectSandbox(id: string): Promise<OwnerFact | null> {
  const outcome = await msbOutcome(["inspect", id, "--format", "json"]);
  if (outcome.exitCode !== 0) return null;
  let parsed: {
    status?: unknown;
    active_config?: { labels?: Record<string, string> };
    config?: { labels?: Record<string, string> };
  };
  try {
    parsed = JSON.parse(outcome.stdout.toString("utf8")) as typeof parsed;
  } catch {
    return null;
  }
  const status = typeof parsed.status === "string" ? parsed.status : "";
  const labels = parsed.active_config?.labels ?? parsed.config?.labels ?? {};
  return { id, running: status.trim().toLowerCase() === "running", labels };
}

export function microsandboxConformanceSubject(
  options: MicrosandboxConformanceOptions,
): ConformanceSubject {
  const unit = `${DEFAULT_UNIT}-run-${options.token}`;
  const adapter = new MicrosandboxAdapter({ unit });
  const decoys: readonly ConformanceDecoy[] = options.decoys.map(({ name, why }) => ({
    name,
    why,
  }));
  return {
    id: options.token,
    stateDir: MSB_STATE_DIR,
    provider: adapter,
    image: async () => {
      const pinned = await ensureMicrosandboxImage();
      return { ref: pinned.ref, identity: pinned.identity };
    },
    ownership: {
      unit,
      sweep: () => adapter.sweep(),
      inspect: inspectSandbox,
      addDecoys: async () => {
        const image = (await ensureMicrosandboxImage()).ref;
        for (const spec of options.decoys) {
          const labels =
            spec.unit === null
              ? []
              : [
                  "--label",
                  `${UNIT_LABEL}=${spec.unit}`,
                  "--label",
                  `${SANDBOX_LABEL}=${spec.name}`,
                  "--label",
                  `${PROVIDER_LABEL}=microsandbox`,
                ];
          await msbCli(["create", "-n", spec.name, ...labels, image], 300_000);
        }
        return decoys;
      },
      observeDecoy: async (decoy) => {
        const outcome = await msbOutcome(["inspect", decoy.name, "--format", "json"]);
        // Absence is a census fact rather than a CLI failure, so a swept decoy reads as `gone`
        // beside the fact it had before.
        if (outcome.exitCode !== 0) return `${decoy.name}=gone`;
        const fact = await inspectSandbox(decoy.name);
        return `${decoy.name}=${fact === null ? "gone" : fact.running ? "running" : "stopped"}`;
      },
      removeDecoys: async (toRemove) => {
        for (const decoy of toRemove) await msbCli(["rm", "-f", decoy.name]);
      },
    },
  };
}
