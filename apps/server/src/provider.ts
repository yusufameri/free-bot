/**
 * The provider factory: the one place that decides whether a run's model is real or recorded.
 *
 * The decision is a tagged union rather than a boolean plus flags, because the two paths carry
 * different data and only one of them carries a secret. `keyed` holds the connection the client
 * needs; `replay` holds the transcript and the reason the run stayed keyless. A keyed choice without
 * a key cannot be built.
 *
 * `auto` is the launcher's default and follows the vault: a key is there, so the model is real. A
 * caller that demands the keyed path and finds no key fails loudly instead of quietly replaying,
 * because a recording that looks like a live turn is the one failure this module exists to prevent.
 * Evidence drivers pin `replay`, so a golden run never bills a provider and never varies (order 9).
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ProviderPort, ProviderTurnError } from "@freebot/core";
import { KeyedProvider } from "./keyed-provider.ts";
import {
  firstTurnForTools,
  ReplayProvider,
  readTranscript,
  turnsInBlock,
} from "./replay-provider.ts";
import { type VaultEntry, vaultPath } from "./vault.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The committed transcript a keyless run replays. */
export const DEFAULT_TRANSCRIPT = join(ROOT, "packages/pi-bridge/fixtures/rpc-handshake.jsonl");

export type ProviderMode = "auto" | "live" | "replay";

/** Why a run has no model. Both are ordinary states, not failures. */
export type KeylessReason = "no-vault-key" | "asked-for-replay";

export type ProviderChoice =
  | {
      readonly kind: "keyed";
      readonly baseUrl: string;
      readonly model: string;
      /** The vault's value. Never logged, never in an artifact, never in an argv. */
      readonly key: string;
    }
  | {
      readonly kind: "replay";
      readonly transcript: string;
      readonly why: KeylessReason;
    };

/** The facts the choice is a function of, so a test can drive both paths without a vault. */
export interface ChoiceInput {
  readonly mode: ProviderMode;
  readonly vault: VaultEntry | null;
  readonly transcript?: string;
}

/** A caller asked for the vault's key and the vault holds none. */
export class MissingKeyError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`no FREEBOT_BYOK_KEY in the vault at ${path}`);
    this.name = "MissingKeyError";
    this.path = path;
  }
}

/** The choice a mode and a vault produce. `live` throws; `auto` falls back to the replay path. */
export function chooseProvider(input: ChoiceInput): ProviderChoice {
  const transcript = input.transcript ?? DEFAULT_TRANSCRIPT;
  if (input.mode === "replay") return { kind: "replay", transcript, why: "asked-for-replay" };
  if (input.mode === "live") {
    if (input.vault === null) throw new MissingKeyError(vaultPath());
    return {
      kind: "keyed",
      baseUrl: input.vault.baseUrl,
      model: input.vault.model,
      key: input.vault.key,
    };
  }
  if (input.vault === null) return { kind: "replay", transcript, why: "no-vault-key" };
  return {
    kind: "keyed",
    baseUrl: input.vault.baseUrl,
    model: input.vault.model,
    key: input.vault.key,
  };
}

/** What a reader may know about the choice: the endpoint it posts to, the model, no key. */
export interface ChoiceDescription {
  readonly kind: ProviderChoice["kind"];
  readonly endpoint: string;
  readonly model: string | null;
  readonly keyPresent: boolean;
}

export function describeChoice(choice: ProviderChoice): ChoiceDescription {
  if (choice.kind === "replay") {
    return {
      kind: "replay",
      endpoint: choice.transcript,
      model: null,
      keyPresent: false,
    };
  }
  return {
    kind: "keyed",
    endpoint: `${choice.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    model: choice.model,
    keyPresent: choice.key.length > 0,
  };
}

export interface ProviderOptions {
  /** The run's prompt, which is the model's user message. */
  readonly prompt: string;
  /** Where a per-turn line about the real turn goes, so a driver can read it outside the process. */
  readonly note?: (line: string) => void;
  /** The tool the run governs, so a call the model asks for carries the gate's flag. */
  readonly destructive?: (toolName: string) => boolean;
  /** The tools this run offers, so a replay picks the recorded block that asks for one of them. */
  readonly tools?: readonly string[];
  readonly timeoutMs?: number;
}

/** The loop's provider for one run, from the factory's choice. */
export async function createProviderPort(
  choice: ProviderChoice,
  options: ProviderOptions,
): Promise<ProviderPort> {
  if (choice.kind === "keyed") {
    return new KeyedProvider({
      connection: { baseUrl: choice.baseUrl, apiKey: choice.key },
      model: choice.model,
      prompt: options.prompt,
      ...(options.note === undefined ? {} : { note: options.note }),
      ...(options.destructive === undefined ? {} : { destructive: options.destructive }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }
  return await replayProviderFrom(choice.transcript, options.tools);
}

/**
 * The recorded turns for a tool this run offers, or a named failure when the record has none.
 *
 * The block is chosen by the run's own tool names rather than by a name written here, because a
 * transcript is chosen for a run: the landed transcript's tool is `bash` and a connector's is
 * `<connector>__<tool>`, and the run's table is the one place that knows which of those exist. A
 * transcript that holds no turn for any offered tool is a mispairing, so it fails by name.
 */
export async function replayProviderFrom(
  transcript: string,
  tools: readonly string[] = ["bash"],
): Promise<ProviderPort> {
  const turns = await readTranscript(transcript);
  const block = firstTurnForTools(turns, tools);
  if (block === undefined) {
    throw new ProviderTurnError(
      "provider_malformed_tool_call",
      `the replay transcript holds no call to any of ${tools.join(", ")}: ${transcript}`,
    );
  }
  return new ReplayProvider(turnsInBlock(block));
}

export { KeyedProvider };

/** One line naming what a run's model is, for the launcher's diagnostics. Never the key. */
export function providerLine(description: ChoiceDescription): string {
  if (description.kind === "keyed") {
    const host = new URL(description.endpoint).host;
    return `model ${description.model} via ${host} (key from the vault)`;
  }
  return `keyless, replaying ${description.endpoint}`;
}
