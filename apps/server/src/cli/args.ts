/**
 * The `bun run up` command line: one flag set, parsed once at the boundary.
 *
 * Every flag the launcher accepts is here and nowhere else, so the launcher's behavior is a
 * function of this one record. A port defaults to 0, which asks the OS for a free one: two launches
 * then cannot collide, and a port the operator pins that is already taken fails loudly instead of
 * silently moving somewhere they did not ask for.
 *
 * `--live` and `--replay` decide the model, and neither carries a secret: `live` demands the vault's
 * key and refuses to start without one, `replay` records, and the default `auto` follows the vault.
 * The mode is the one flag an evidence driver may need to pin, because a driver that asserts a
 * recorded turn needs the recorded provider (order 9), so `FREEBOT_PROVIDER` sets the default for
 * anything that spawns the launcher without a flag.
 *
 * `--sandbox` and `FREEBOT_SANDBOX` name the sandbox backend the same way, one flag set and the
 * flag winning over the environment: `docker`, `microsandbox`, or `auto`, which is the default and
 * probes the two in order. An evidence driver that must run on one backend pins it here rather than
 * around the launcher, which is what makes the boot line the driver's own evidence.
 */

import { nanoPerToken, type TokenPrices, usdToNano } from "@freebot/core";
import type { ProviderMode } from "../provider.ts";
import {
  envSandboxBackend,
  parseSandboxBackendValue,
  type SandboxBackendRequest,
  type SandboxSource,
} from "./sandbox-backend.ts";

export interface UpArgs {
  /** The page and its stream. 0 asks the OS for a free port. */
  readonly apiPort: number;
  /** The tunnel leg. 0 asks the OS for a free port. */
  readonly tunnelPort: number;
  /** Open the printed URL in the operator's browser. */
  readonly open: boolean;
  /** How the run's model is chosen. */
  readonly providerMode: ProviderMode;
  /** Which sandbox backend to run on: one by name, or the auto-detection. */
  readonly sandbox: SandboxBackendRequest;
  /** What named `sandbox`, so the boot line says why this backend and not another. */
  readonly sandboxSource: SandboxSource;
  /** The transcript a keyless run replays, or null for the committed one. */
  readonly transcript: string | null;
  /** The file the person's connector records live in, or null for `connectors.json` under the home. */
  readonly connectors: string | null;
  /** The directory that holds the Bot registry and one workspace per Bot, or null for the default. */
  readonly workspace: string | null;
  /** The per-run spend ceiling in integer nano-USD, or null when the environment sets none. */
  readonly spendCapNanoUsd: number | null;
  /** The token prices the keyed adapter prices a turn with, or null when none are configured. */
  readonly prices: TokenPrices | null;
  /** Print the usage and exit. */
  readonly help: boolean;
}

export const UP_USAGE = [
  "usage: bun run up [flags]",
  "",
  "Boots the server and the page it serves, then prints one URL to open.",
  "The operator token is already in that URL's fragment, so the page is armed when it loads.",
  "",
  "flags:",
  "  --no-open          print the URL, do not open a browser",
  "  --live             use the key in ~/.freebot/provider.env, and refuse to start without one",
  "  --replay           replay the committed transcript instead of calling a model",
  "  --sandbox <id>     the sandbox backend: docker, microsandbox, or auto (default auto)",
  "  --transcript <p>   the transcript a keyless run replays (default packages/pi-bridge's)",
  "  --connectors <p>   the file the person's connector records live in (default connectors.json)",
  "  --api-port <n>     the page and its stream (default 0, a free port)",
  "  --tunnel-port <n>  the tunnel leg (default 0, a free port)",
  "  -h, --help         print this",
  "",
  "The model defaults to the vault: a key there makes every run call a real model, and no key",
  "replays the transcript. FREEBOT_PROVIDER=live|replay|auto sets that default for a started",
  "process, which is how an evidence driver pins the recorded provider. FREEBOT_TRANSCRIPT and",
  "FREEBOT_CONNECTORS set the two paths the same way.",
  "",
  "The sandbox backend defaults to auto: the Docker daemon if it answers, otherwise microsandbox",
  "if `msb doctor` answers, and a failure naming both install paths when neither is there. Every",
  "backend it can pick is free and needs no account. FREEBOT_SANDBOX=docker|microsandbox|auto sets",
  "that default for a started process; --sandbox sets it for one launch. The chosen backend is",
  "printed at boot. docs/RUNNING.md carries the Docker side and docs/microsandbox.md the other.",
  "",
  "A connectors file lists the connectors this install may call, each with the endpoint its own",
  "server answers at. It is the non-secret half: what those servers need as a credential lives in",
  "the vault beside it, `connectors.env` at mode 600, and reaches one request header. No route,",
  "log line or artifact carries a header value. connectors.json under the freebot home is read by",
  "default, the vault beside it is derived from it, and the absence of both is the no-connectors",
  "machine.",
  "",
  "The Bot's workspace is a host directory, mounted into every run at /workspace, so the files a",
  "run writes outlive it. Every Bot has one of its own, and the Bot records live beside them.",
  "They default to ~/.freebot/bots and FREEBOT_WORKSPACE moves the whole set, which is how an",
  "evidence driver starts from no Bots at all.",
  "",
  "The run loop consults a per-run spend cap before every provider turn. FREEBOT_SPEND_CAP_USD",
  "sets it (default 5.00). Cost comes from the provider's token usage priced by four variables,",
  "FREEBOT_PRICE_INPUT_PER_MTOK, FREEBOT_PRICE_OUTPUT_PER_MTOK, FREEBOT_PRICE_CACHE_READ_PER_MTOK",
  "and FREEBOT_PRICE_CACHE_WRITE_PER_MTOK; setting them all makes a keyed run cap-able, and with",
  "none set the adapter reports no cost and the cap has nothing to measure.",
  "",
  "Ctrl-C stops the servers and removes the sandboxes this launch created.",
].join("\n");

/** A caller's own mistake, reported with the usage rather than as a crash. */
export class UpArgError extends Error {}

/** The mode `FREEBOT_PROVIDER` names, or null when it names nothing this launcher knows. */
export function envProviderMode(
  env: Record<string, string | undefined> = process.env,
): ProviderMode | null {
  const value = env.FREEBOT_PROVIDER;
  return value === "auto" || value === "live" || value === "replay" ? value : null;
}

/** The bots root `FREEBOT_WORKSPACE` names, or null for the default under the freebot home. */
export function envWorkspace(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.FREEBOT_WORKSPACE;
  return value === undefined || value === "" ? null : value;
}

/** A path a flag or the environment names, or null for the default. */
function envPath(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const value = env[name];
  return value === undefined || value === "" ? null : value;
}

/** A flag's path argument, refused when it is missing. */
function path(value: string | undefined, flag: string): string {
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new UpArgError(`${flag} needs a path`);
  }
  return value;
}

function port(value: string | undefined, flag: string): number {
  if (value === undefined) throw new UpArgError(`${flag} needs a port number`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new UpArgError(`${flag} needs an integer port 0..65535, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * The per-run cap `FREEBOT_SPEND_CAP_USD` names, as integer nano-USD. An absent value is null, and a
 * malformed one is refused at boot rather than silently turning the cap off.
 */
export function envSpendCapNanoUsd(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env.FREEBOT_SPEND_CAP_USD;
  if (raw === undefined || raw === "") return null;
  try {
    return usdToNano(raw);
  } catch (error) {
    throw new UpArgError(
      `FREEBOT_SPEND_CAP_USD is not a USD amount: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const PRICE_NAMES = {
  inputPerMTok: "FREEBOT_PRICE_INPUT_PER_MTOK",
  outputPerMTok: "FREEBOT_PRICE_OUTPUT_PER_MTOK",
  cacheReadPerMTok: "FREEBOT_PRICE_CACHE_READ_PER_MTOK",
  cacheWritePerMTok: "FREEBOT_PRICE_CACHE_WRITE_PER_MTOK",
} as const;

/**
 * The four token prices the keyed adapter prices a turn with. All four or none: a partial set is a
 * misspelling, not a policy, and three prices plus one default would silently understate a cost.
 */
export function envTokenPrices(
  env: Record<string, string | undefined> = process.env,
): TokenPrices | null {
  const found = Object.entries(PRICE_NAMES).flatMap(([key, name]) => {
    const value = env[name];
    return value === undefined || value === "" ? [] : [[key, value] as const];
  });
  if (found.length === 0) return null;
  if (found.length !== 4) {
    const missing = Object.entries(PRICE_NAMES)
      .filter(([, name]) => env[name] === undefined || env[name] === "")
      .map(([, name]) => name);
    throw new UpArgError(`token prices are all four or none; missing ${missing.join(", ")}`);
  }
  const prices: TokenPrices = {
    inputPerMTok: env[PRICE_NAMES.inputPerMTok] ?? "",
    outputPerMTok: env[PRICE_NAMES.outputPerMTok] ?? "",
    cacheReadPerMTok: env[PRICE_NAMES.cacheReadPerMTok] ?? "",
    cacheWritePerMTok: env[PRICE_NAMES.cacheWritePerMTok] ?? "",
  };
  try {
    for (const value of Object.values(prices)) nanoPerToken(value);
  } catch (error) {
    throw new UpArgError(
      `a configured token price is unusable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return prices;
}

export function parseUpArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): UpArgs {
  const help = argv.includes("--help") || argv.includes("-h");
  // The flag outranks the environment, and help must print whatever the environment says, so the
  // environment is read only when neither is present: a misspelling in it cannot refuse a launch
  // that asked for a backend by name or only wanted the usage.
  const fromEnv = argv.includes("--sandbox") || help ? null : envSandboxBackend(env);
  const args: UpArgs = {
    apiPort: 0,
    tunnelPort: 0,
    open: true,
    providerMode: envProviderMode(env) ?? "auto",
    sandbox: fromEnv ?? "auto",
    sandboxSource: fromEnv === null ? "default" : "FREEBOT_SANDBOX",
    transcript: envPath("FREEBOT_TRANSCRIPT", env),
    connectors: envPath("FREEBOT_CONNECTORS", env),
    workspace: envWorkspace(env),
    spendCapNanoUsd: help ? null : envSpendCapNanoUsd(env),
    prices: help ? null : envTokenPrices(env),
    help,
  };
  let next: UpArgs = args;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    switch (flag) {
      case "--help":
      case "-h":
        break;
      case "--no-open":
        next = { ...next, open: false };
        break;
      case "--open":
        next = { ...next, open: true };
        break;
      case "--live":
        next = { ...next, providerMode: "live" };
        break;
      case "--replay":
        next = { ...next, providerMode: "replay" };
        break;
      case "--sandbox": {
        const value = argv[index + 1];
        if (value === undefined || value.length === 0 || value.startsWith("--")) {
          throw new UpArgError(`${flag} needs a backend id: docker, microsandbox or auto`);
        }
        const request = parseSandboxBackendValue(value);
        if (request === null) {
          throw new UpArgError(
            `${flag} names no backend: ${JSON.stringify(value)}; use docker, microsandbox or auto`,
          );
        }
        next = { ...next, sandbox: request, sandboxSource: "--sandbox" };
        index += 1;
        break;
      }
      case "--transcript":
        next = { ...next, transcript: path(argv[index + 1], flag) };
        index += 1;
        break;
      case "--connectors":
        next = { ...next, connectors: path(argv[index + 1], flag) };
        index += 1;
        break;
      case "--api-port":
        next = { ...next, apiPort: port(argv[index + 1], flag) };
        index += 1;
        break;
      case "--tunnel-port":
        next = { ...next, tunnelPort: port(argv[index + 1], flag) };
        index += 1;
        break;
      default:
        throw new UpArgError(`unknown flag ${JSON.stringify(flag)}`);
    }
  }
  return next;
}

/**
 * The one URL. The token rides the fragment, which a browser never sends to a server, so the page
 * can only read it locally and no access log or `Referer` ever carries it (docs/one-run-path.md).
 */
export function pageUrl(apiPort: number, token: string): string {
  return `http://127.0.0.1:${apiPort}/#token=${token}`;
}
