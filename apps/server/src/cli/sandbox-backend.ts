/**
 * Which sandbox backend this launch runs on.
 *
 * The launcher used to build the Docker adapter directly, so a run could not boot without Docker
 * even though a second adapter answers the same interface. This is the one place that decides: an
 * explicit value from `--sandbox` or `FREEBOT_SANDBOX`, otherwise auto-detection in the plan's own
 * order (Docker first, then microsandbox), and a typed failure naming both install paths when
 * neither answers. Every entry in the table is free and account-less, so no path this launcher can
 * take is paid (order 34), and a value the table does not hold is refused by name rather than
 * guessed at.
 *
 * A backend here is what a launch needs, not the whole adapter: the provider each run's port wraps,
 * and `holds`, the engine question the reaper asks about a sandbox it created. `up.ts` prints the
 * choice at boot from the `why` these functions return, and the evidence drivers assert that line.
 */

import {
  containerName,
  DockerAdapter,
  dockerOutcome,
  hasDockerDaemon,
  hasMsb,
  MicrosandboxAdapter,
  msbOutcome,
  type SandboxProvider,
} from "@freebot/sandbox";

/** The free backends this launcher can choose, in no particular order (see `DETECTION_ORDER`). */
export const SANDBOX_BACKEND_IDS = ["docker", "microsandbox"] as const;

export type SandboxBackendId = (typeof SANDBOX_BACKEND_IDS)[number];

/** What the person asked for: one backend, or the auto-detection. */
export type SandboxBackendRequest = SandboxBackendId | "auto";

/** What named the request, so the boot line says why this backend and not another. */
export type SandboxSource = "--sandbox" | "FREEBOT_SANDBOX" | "default";

export interface SandboxBackend {
  readonly id: SandboxBackendId;
  /** Open for the whole launch, label-scoped to this unit so its cleanup can never touch another (order 22). */
  readonly provider: SandboxProvider;
  /** Whether this backend's engine still holds a sandbox by that name, running or stopped. */
  holds(name: string): Promise<boolean>;
}

export interface SandboxBackendChoice {
  readonly backend: SandboxBackend;
  /** Why this one, as the boot line prints it. */
  readonly why: string;
}

/** A request this machine cannot answer. The launcher reports it with the way out, and exits 2. */
export class SandboxBackendError extends Error {}

/** The backend a value names, or null when it names nothing this launcher knows. */
export function parseSandboxBackendValue(value: string): SandboxBackendRequest | null {
  if (value === "auto") return "auto";
  return SANDBOX_BACKEND_IDS.find((id) => id === value) ?? null;
}

/**
 * The request `FREEBOT_SANDBOX` names, or null when it sets nothing. A non-empty value that names
 * no backend throws, because auto-detecting past a misspelled request would run somewhere the
 * person did not ask for and print a boot line that does not explain why.
 */
export function envSandboxBackend(
  env: Record<string, string | undefined> = process.env,
): SandboxBackendRequest | null {
  const value = env.FREEBOT_SANDBOX;
  if (value === undefined || value === "") return null;
  const request = parseSandboxBackendValue(value);
  if (request === null) {
    throw new SandboxBackendError(
      `FREEBOT_SANDBOX=${JSON.stringify(value)} names no sandbox backend; use ${[...SANDBOX_BACKEND_IDS, "auto"].join(", ")}`,
    );
  }
  return request;
}

interface BackendEntry {
  readonly id: SandboxBackendId;
  /** Whether this machine can run this backend right now, with the fact that decided it. */
  detect(): Promise<{ readonly present: boolean; readonly detail: string }>;
  open(unit: string): SandboxBackend;
  /** What a person installs, as the failure message names it. */
  readonly install: string;
}

/**
 * The whole set. A `Record` over the id union, so a backend added to the union and forgotten here
 * fails the typecheck instead of becoming unreachable, and adding one is one entry: this table is
 * what U9.3's E2B Embed slot grows into.
 */
const BACKENDS: Readonly<Record<SandboxBackendId, BackendEntry>> = {
  docker: {
    id: "docker",
    detect: async () => {
      const present = await hasDockerDaemon();
      return {
        present,
        detail: present ? "the Docker daemon answered" : "the Docker daemon did not answer",
      };
    },
    open: (unit) => ({
      id: "docker",
      provider: new DockerAdapter({ unit }),
      holds: async (name) => {
        const outcome = await dockerOutcome([
          "ps",
          "-a",
          "--filter",
          `name=^${containerName(name)}$`,
          "--format",
          "{{.Names}}",
        ]);
        return outcome.exitCode === 0 && outcome.stdout.toString("utf8").trim() !== "";
      },
    }),
    install: 'install and start Docker Desktop (docs/RUNNING.md, "What you need")',
  },
  microsandbox: {
    id: "microsandbox",
    detect: async () => {
      const present = await hasMsb();
      return {
        present,
        detail: present ? "msb doctor answered" : "msb doctor did not answer",
      };
    },
    open: (unit) => ({
      id: "microsandbox",
      provider: new MicrosandboxAdapter({ unit }),
      holds: async (name) =>
        (await msbOutcome(["inspect", name, "--format", "json"])).exitCode === 0,
    }),
    install:
      "install microsandbox: `curl -fsSL https://install.microsandbox.dev | sh` (docs/microsandbox.md)",
  },
};

/** Docker first, then microsandbox: plan Part 12's order, so the reference backend wins a tie. */
const DETECTION_ORDER: readonly SandboxBackendId[] = ["docker", "microsandbox"];

async function autoDetect(unit: string): Promise<SandboxBackendChoice> {
  const tried: string[] = [];
  for (const id of DETECTION_ORDER) {
    const probe = await BACKENDS[id].detect();
    tried.push(probe.detail);
    if (probe.present) {
      return { backend: BACKENDS[id].open(unit), why: `chosen by auto: ${tried.join("; ")}` };
    }
  }
  const installs = DETECTION_ORDER.map((id) => BACKENDS[id].install).join(" or ");
  throw new SandboxBackendError(`no sandbox backend: ${tried.join("; ")}; ${installs}`);
}

/**
 * The backend this launch runs on. An explicit request is honoured or fails, never quietly
 * replaced: a launcher that printed one backend while running another would make every artifact
 * that reads that line a lie.
 */
export async function resolveSandboxBackend(
  request: SandboxBackendRequest,
  source: SandboxSource,
  unit: string,
): Promise<SandboxBackendChoice> {
  if (request === "auto") return await autoDetect(unit);
  const probe = await BACKENDS[request].detect();
  if (!probe.present) {
    throw new SandboxBackendError(
      `asked for ${request} by ${source}=${request}, but ${probe.detail}; ${BACKENDS[request].install}`,
    );
  }
  return {
    backend: BACKENDS[request].open(unit),
    why: `chosen by ${source}=${request}; ${probe.detail}`,
  };
}
