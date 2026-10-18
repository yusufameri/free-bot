/**
 * Page 1's model: welcome, then connect a provider.
 *
 * `packages/ui/browser/provider.ts` renders this and decides nothing, the same split `bots.ts` and
 * `library.ts` keep for their surfaces. The copy, the state vocabulary and the flag wording live
 * here so the page and the evidence read the same words.
 *
 * The four states a person moves through are `empty`, `testing`, `capable` and `untested`, with
 * `limited` between the last two for a connection that answers but calls no tool. `testing` is a
 * fact about the page, not about the connection, so it is passed in beside the connection rather
 * than stored in it.
 */

import type {
  ProviderConnection,
  ProviderFlags,
  ProviderRefusal,
  ProviderStatus,
  ProviderVault,
} from "@freebot/protocol";

export const CONNECT_TITLE = "Connect a provider";

export const CONNECT_INTRO =
  "FreeBot ships no subscription. Point it at a model you already pay for: a base URL, a model, and a key.";

export const PROVIDER_BASE_URL_LABEL = "Base URL";
export const PROVIDER_MODEL_LABEL = "Model";
export const PROVIDER_KEY_LABEL = "API key";

export const PROVIDER_BASE_URL_PLACEHOLDER = "https://api.example.com/v1";
export const PROVIDER_MODEL_PLACEHOLDER = "gpt-4o-mini";
export const PROVIDER_KEY_PLACEHOLDER = "never read back, never logged";

export const SAVE_AND_TEST_LABEL = "Save and test";
export const TESTING_LABEL = "Testing the connection...";

export const REPLAY_LABEL = "Run in replay mode";

export const CONTINUE_LABEL = "Continue to your Bots";

export const REPLAY_NOTE =
  "Replay mode records nothing and bills nothing: it runs the committed transcript, so a key is not needed to see the product work.";

/** What the page says about the key, in every state, because that is the promise it makes. */
export const KEY_KEPT_NOTE =
  "The key goes to the vault file at mode 600. It is never sent back to this page, and nothing here logs it.";

export const CAPABLE_HEADLINE = "This connection is capable";
export const LIMITED_HEADLINE = "This connection answers, without a tool call";
export const UNTESTED_HEADLINE = "The connection did not pass its test";

export const CAPABLE_NOTE =
  "The test turn called a tool, so a run can drive this connection directly.";

export const LIMITED_NOTE =
  "The test turn called no tool. Runs will use the structured output fallback, which is weaker: one action may take more turns, and a model that ignores the JSON instruction cannot run at all.";

export const UNTESTED_NOTE =
  "The connection is saved, so a run fails with the provider's own words rather than quietly replaying a recording. Fix the endpoint or the key and save again.";

export const NO_ANSWER_NOTE = "The test turn returned no text.";

export type ProviderPageState = "empty" | "testing" | "capable" | "limited" | "untested";

/**
 * What the page shows, in the shape the evidence reads. Every field is something a reader can see in
 * the DOM, and `keyEmpty` is there to be asserted: a page that held a key back from the vault would
 * fail on it.
 */
export interface ProviderFacts {
  readonly state: ProviderPageState;
  /** Whether page 1 owns the center column right now. */
  readonly shown: boolean;
  readonly vault: ProviderVault;
  readonly fields: { baseUrl: string; model: string; keyEmpty: boolean };
  readonly connection: { baseUrl: string; model: string; status: ProviderStatus } | null;
  /** The request line the page shows, which is what `testing` is a claim about. */
  readonly endpoint: string;
  readonly answer: string | null;
  readonly refusal: ProviderRefusal | null;
  readonly capabilities: string[];
  /** What a save will replace, or null when the machine holds no connection yet. */
  readonly replaced: string | null;
  /** The one line under the form. */
  readonly message: string;
}

export function pageStateOf(
  connection: ProviderConnection | null,
  testing: boolean,
): ProviderPageState {
  if (testing) return "testing";
  return connection === null ? "empty" : connection.status;
}

export function providerHeadline(state: ProviderPageState): string {
  switch (state) {
    case "empty":
      return CONNECT_TITLE;
    case "testing":
      return TESTING_LABEL;
    case "capable":
      return CAPABLE_HEADLINE;
    case "limited":
      return LIMITED_HEADLINE;
    case "untested":
      return UNTESTED_HEADLINE;
  }
}

/** The paragraph under the headline: what this state means for the next run. */
export function resultLine(connection: ProviderConnection | null): string {
  if (connection === null) return CONNECT_INTRO;
  switch (connection.status) {
    case "capable":
      return CAPABLE_NOTE;
    case "limited":
      return LIMITED_NOTE;
    case "untested":
      return UNTESTED_NOTE;
  }
}

/** The provider's refusal as one sentence, with its status code when it gave one. */
export function refusalLine(refusal: ProviderRefusal): string {
  return refusal.status === null
    ? `The test could not reach the provider: ${refusal.message}`
    : `The provider refused the test (${refusal.status}): ${refusal.message}`;
}

/** The flags as a reader checks them, spelled the way the smoke's own report spells them. */
export function capabilityLines(flags: ProviderFlags | null): string[] {
  if (flags === null) return [];
  return [
    `tool calling: ${flags.toolCalling}`,
    `streaming: ${flags.streaming === null ? "unknown" : String(flags.streaming)}`,
    `structured output: ${flags.structuredOutput === null ? "unknown" : String(flags.structuredOutput)}`,
    `context window: ${flags.contextWindow === null ? "unknown" : String(flags.contextWindow)}`,
  ];
}

/** The request the test makes, so the `testing` state shows what it is waiting on. */
export function endpointLine(baseUrl: string, model: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base === "" || model === "" ? "" : `POST ${base}/chat/completions  model ${model}`;
}

/** What the vault file is, without saying anything that is in it. */
export function vaultLine(vault: ProviderVault): string {
  return vault.present
    ? `Vault: ${vault.path} (present, mode ${vault.mode ?? "unknown"})`
    : `Vault: ${vault.path} (nothing written yet)`;
}

/**
 * What a save replaces. The vault holds one connection, so a save overwrites whatever is there, and
 * the page says what that is before the button is pressed rather than after.
 */
export function replacesLine(
  vault: ProviderVault,
  connection: ProviderConnection | null,
): string | null {
  if (connection === null) return null;
  let host = connection.baseUrl;
  try {
    host = new URL(connection.baseUrl).host;
  } catch {
    host = connection.baseUrl;
  }
  return `Saving replaces this machine's connection: ${connection.model} at ${host}, held in ${vault.path}.`;
}

/** The model's own reply from the test turn, or a line saying there was none. */
export function answerLine(connection: ProviderConnection | null): string | null {
  if (connection === null || connection.status === "untested") return null;
  return connection.answer === null || connection.answer.trim() === ""
    ? NO_ANSWER_NOTE
    : connection.answer;
}

/**
 * The sidebar footer's provider row, which is the shell's own addition: an install holds one active
 * connection and its model and capability are worth showing at a glance.
 */
export function providerRowLabel(connection: ProviderConnection | null): string {
  return connection === null ? CONNECT_TITLE : `${connection.model} · ${connection.status}`;
}

/** The state's line under the form, so the panel and the facts hook never disagree. */
export function statusLine(
  state: ProviderPageState,
  endpoint: string,
  error: string | null,
): string {
  if (error !== null) return error;
  switch (state) {
    case "empty":
      return "";
    case "testing":
      return `Waiting for the reply. ${endpoint}`;
    case "capable":
    case "limited":
      return "Saved.";
    case "untested":
      return "Saved, untested.";
  }
}
