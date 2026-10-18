/**
 * Page 1's server side: the save, the test, and the record of what the test found.
 *
 * Two files, each with one job. The key goes to the vault (`provider.env`, mode 600) because that is
 * what the run path reads; everything else about the connection goes to a sibling record
 * (`provider.json`, mode 600) that carries the endpoint, the model, the capability flags and the
 * model's own reply. The record has no key field, so nothing here can hand one back to a client.
 *
 * The save happens before the test, so a connection the provider refuses is still saved and marked
 * `untested`: a person who mistyped a key needs the run after that to fail with the provider's own
 * words rather than to silently replay a recording.
 *
 * A record is only believed while it matches the vault. A vault a person edits by hand changes the
 * endpoint under the record, and a stale `capable` would outlive the connection it was measured on,
 * so a mismatch reads as `untested` and the page says so.
 */

import { join } from "node:path";
import type {
  ProviderConfigInput,
  ProviderConnection,
  ProviderRefusal,
  ProviderState,
  ProviderStatus,
} from "@freebot/protocol";
import { providerConnectionSchema } from "@freebot/protocol";
import {
  type CapabilityFlags,
  type CapabilityTestOptions,
  type CapabilityTurn,
  runCapabilityTest,
} from "@freebot/providers";
import {
  describeVault,
  freebotHome,
  readPrivateFile,
  readVault,
  vaultPath,
  writePrivateFile,
  writeVault,
} from "./vault.ts";

/** The longest provider message the record keeps. A provider's body can be arbitrarily long. */
const REFUSAL_MESSAGE_MAX = 400;

/** The two files page 1 owns. */
export interface ProviderPaths {
  /** The vault: the key and the endpoint the run path reads. */
  readonly vault: string;
  /** The record: what the last test found, and never the key. */
  readonly record: string;
}

export function providerPaths(
  env: Record<string, string | undefined> = process.env,
): ProviderPaths {
  return { vault: vaultPath(env), record: join(freebotHome(env), "provider.json") };
}

/** The status a turn's flags earn. A native call is capable; anything else is the weaker trail. */
export function statusOf(flags: CapabilityFlags): ProviderStatus {
  return flags.toolCalling === "strong" ? "capable" : "limited";
}

/** What the provider said, as a reader sees it: its status code when it gave one, and its message. */
export function refusalOf(error: unknown): ProviderRefusal {
  const status = (error as { status?: unknown }).status;
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: typeof status === "number" ? status : null,
    message: message.slice(0, REFUSAL_MESSAGE_MAX),
  };
}

export interface ProviderSetupOptions {
  readonly paths?: ProviderPaths;
  /** The capability test, injectable so a test drives both outcomes with no network (order 9). */
  readonly test?: (options: CapabilityTestOptions) => Promise<CapabilityTurn>;
  readonly now?: () => number;
}

/** What the last test recorded, parsed at this boundary rather than trusted as a file shape. */
export function readProviderRecord(paths: ProviderPaths): ProviderConnection | null {
  const text = readPrivateFile(paths.record);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const shaped = providerConnectionSchema.safeParse(parsed);
  return shaped.success ? shaped.data : null;
}

export function writeProviderRecord(connection: ProviderConnection, paths: ProviderPaths): void {
  writePrivateFile(paths.record, `${JSON.stringify(connection, null, 2)}\n`);
}

/**
 * Page 1's state: the vault file as a path, a presence and a mode, plus the connection it holds.
 * `connection: null` is the keyless machine.
 */
export function describeProvider(paths: ProviderPaths = providerPaths()): ProviderState {
  const vault = describeVault(paths.vault);
  const entry = readVault(paths.vault);
  if (entry === null) return { vault, connection: null };
  const record = readProviderRecord(paths);
  const measuredHere =
    record !== null && record.baseUrl === entry.baseUrl && record.model === entry.model;
  return {
    vault,
    connection: {
      baseUrl: entry.baseUrl,
      model: entry.model,
      status: measuredHere ? record.status : "untested",
      testedAt: measuredHere ? record.testedAt : null,
      flags: measuredHere ? record.flags : null,
      refusal: measuredHere ? record.refusal : null,
      answer: measuredHere ? record.answer : null,
    },
  };
}

/** Save a connection and test it. The test's outcome is the answer; the save happens either way. */
export async function connectProvider(
  input: ProviderConfigInput,
  options: ProviderSetupOptions = {},
): Promise<ProviderConnection> {
  const paths = options.paths ?? providerPaths();
  const test = options.test ?? runCapabilityTest;
  const now = options.now ?? Date.now;

  writeVault({ key: input.key, baseUrl: input.baseUrl, model: input.model }, paths.vault);

  let connection: ProviderConnection;
  try {
    const turn = await test({ baseUrl: input.baseUrl, model: input.model, apiKey: input.key });
    connection = {
      baseUrl: input.baseUrl,
      model: input.model,
      status: statusOf(turn.flags),
      testedAt: now(),
      flags: turn.flags,
      refusal: null,
      answer: turn.answer,
    };
  } catch (error) {
    connection = {
      baseUrl: input.baseUrl,
      model: input.model,
      status: "untested",
      testedAt: now(),
      flags: null,
      refusal: refusalOf(error),
      answer: null,
    };
  }

  writeProviderRecord(connection, paths);
  return connection;
}

/** The router's two handlers, so a test can hand it a record file and a scripted test. */
export interface ProviderSetup {
  readonly describe: () => ProviderState;
  readonly connect: (input: ProviderConfigInput) => Promise<ProviderConnection>;
}

export function createProviderSetup(options: ProviderSetupOptions = {}): ProviderSetup {
  return {
    describe: () => describeProvider(options.paths),
    connect: (input) => connectProvider(input, options),
  };
}
