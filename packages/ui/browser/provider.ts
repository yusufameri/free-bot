/**
 * Page 1's DOM: the welcome page that gets an install to a running model.
 *
 * It decides nothing. `packages/ui/src/provider.ts` owns the copy, the state vocabulary and the flag
 * wording; this module turns those decisions into nodes and reads them back for the evidence
 * harness, the same split `shell.ts` and `library.ts` keep for their surfaces.
 *
 * The two calls arrive as `calls`, already carrying the operator token, so nothing here knows what a
 * transport is. The page never reads a key back: the field is cleared the moment the save answers,
 * and no fact this module exposes can carry one.
 *
 * `Run in replay mode` writes nothing. It is the quiet control for anyone who wants to see the
 * product work before holding a key, and it moves to the conversation with the vault still absent,
 * which is what makes every run in it replay.
 */

import type {
  ProviderConfigInput,
  ProviderConnection,
  ProviderState,
} from "@freebot/protocol";
import {
  answerLine,
  capabilityLines,
  CONNECT_INTRO,
  CONTINUE_LABEL,
  endpointLine,
  KEY_KEPT_NOTE,
  pageStateOf,
  PROVIDER_BASE_URL_LABEL,
  PROVIDER_BASE_URL_PLACEHOLDER,
  PROVIDER_KEY_LABEL,
  PROVIDER_KEY_PLACEHOLDER,
  PROVIDER_MODEL_LABEL,
  PROVIDER_MODEL_PLACEHOLDER,
  type ProviderFacts,
  type ProviderPageState,
  providerHeadline,
  refusalLine,
  replacesLine,
  REPLAY_LABEL,
  REPLAY_NOTE,
  resultLine,
  SAVE_AND_TEST_LABEL,
  statusLine,
  TESTING_LABEL,
  vaultLine,
} from "../src/provider.ts";

/** The two calls page 1 needs, with the token already applied. */
export interface ProviderCalls {
  readonly read: () => Promise<ProviderState>;
  readonly connect: (input: ProviderConfigInput) => Promise<ProviderConnection>;
}

export interface ProviderHandle {
  /** Read the vault and the saved connection, and paint the state they describe. */
  load(): Promise<ProviderState>;
  /** Give page 1 the center column. */
  show(): void;
  /** Give the center column back to the conversation. */
  hide(): void;
  /** Whether page 1 owns the center column right now. */
  shown(): boolean;
  state(): ProviderPageState;
  connection(): ProviderConnection | null;
  facts(): ProviderFacts;
}

declare global {
  interface Window {
    /** Live page 1 facts, read from the DOM, for the CDP harness. */
    __providerFacts?: () => ProviderFacts;
  }
}

function must<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`missing element ${selector}`);
  return found;
}

export function mountProvider(config: {
  readonly calls: ProviderCalls;
  /** Fired with the answer the moment a save lands, so the host can show the shell's provider row. */
  readonly onSaved?: (connection: ProviderConnection) => void;
  /** Fired when the person moves on to the conversation, with a connection in hand. */
  readonly onContinue?: () => void;
  /** Fired when a person takes the replay path, so the host can move on with the vault untouched. */
  readonly onReplay?: () => void;
}): ProviderHandle {
  const sectionEl = must<HTMLElement>("#provider");
  const headlineEl = must<HTMLElement>("#provider-headline");
  const introEl = must<HTMLElement>("#provider-intro");
  const formEl = must<HTMLFormElement>("#provider-form");
  const baseUrlEl = must<HTMLInputElement>("#provider-base-url");
  const modelEl = must<HTMLInputElement>("#provider-model");
  const keyEl = must<HTMLInputElement>("#provider-key");
  const saveEl = must<HTMLButtonElement>("#provider-save");
  const continueEl = must<HTMLButtonElement>("#provider-continue");
  const replayEl = must<HTMLButtonElement>("#provider-replay");
  const replayNoteEl = must<HTMLElement>("#provider-replay-note");
  const vaultEl = must<HTMLElement>("#provider-vault");
  const replacesEl = must<HTMLElement>("#provider-replaces");
  const requestEl = must<HTMLElement>("#provider-request");
  const statusEl = must<HTMLElement>("#provider-status");
  const answerEl = must<HTMLElement>("#provider-answer");
  const refusalEl = must<HTMLElement>("#provider-refusal");
  const capabilitiesEl = must<HTMLElement>("#provider-capabilities");
  const keptEl = must<HTMLElement>("#provider-key-kept");

  for (const [selector, text] of [
    ["#provider-base-url-label", PROVIDER_BASE_URL_LABEL],
    ["#provider-model-label", PROVIDER_MODEL_LABEL],
    ["#provider-key-label", PROVIDER_KEY_LABEL],
  ] as const) {
    must<HTMLElement>(selector).textContent = text;
  }
  baseUrlEl.placeholder = PROVIDER_BASE_URL_PLACEHOLDER;
  modelEl.placeholder = PROVIDER_MODEL_PLACEHOLDER;
  keyEl.placeholder = PROVIDER_KEY_PLACEHOLDER;
  introEl.textContent = CONNECT_INTRO;
  continueEl.textContent = CONTINUE_LABEL;
  replayEl.textContent = REPLAY_LABEL;
  replayNoteEl.textContent = REPLAY_NOTE;
  keptEl.textContent = KEY_KEPT_NOTE;

  let state: ProviderState = { vault: { path: "", present: false, mode: null }, connection: null };
  let connection: ProviderConnection | null = null;
  let testing = false;
  let error: string | null = null;
  /** The endpoint the in-flight test posts to, so `testing` shows what it is waiting on. */
  let pending: { baseUrl: string; model: string } | null = null;

  function endpoint(): string {
    const shown = testing && pending !== null ? pending : { baseUrl: baseUrlEl.value, model: modelEl.value };
    return endpointLine(shown.baseUrl, shown.model);
  }

  function paint(): void {
    const page = pageStateOf(connection, testing);
    sectionEl.dataset.providerState = page;
    headlineEl.textContent = providerHeadline(page);
    introEl.textContent = resultLine(connection);
    vaultEl.textContent = vaultLine(state.vault);

    const replaced = replacesLine(state.vault, connection);
    replacesEl.hidden = replaced === null;
    replacesEl.textContent = replaced ?? "";

    requestEl.textContent = endpoint();
    requestEl.dataset.endpoint = endpoint();
    statusEl.textContent = statusLine(page, endpoint(), error);

    const answer = answerLine(connection);
    answerEl.hidden = answer === null;
    answerEl.textContent = answer === null ? "" : `The model answered: ${answer}`;

    const refusal = connection?.refusal ?? null;
    refusalEl.hidden = refusal === null;
    refusalEl.textContent = refusal === null ? "" : refusalLine(refusal);

    const lines = capabilityLines(connection?.flags ?? null);
    capabilitiesEl.hidden = lines.length === 0;
    capabilitiesEl.replaceChildren(
      ...lines.map((line) => {
        const item = document.createElement("li");
        item.className = "provider-capability";
        item.textContent = line;
        return item;
      }),
    );

    saveEl.disabled = testing;
    saveEl.textContent = testing ? TESTING_LABEL : SAVE_AND_TEST_LABEL;
    continueEl.hidden = connection === null;
  }

  async function save(): Promise<void> {
    const baseUrl = baseUrlEl.value.trim();
    const model = modelEl.value.trim();
    const key = keyEl.value;
    if (baseUrl === "" || model === "" || key === "") {
      error = "A base URL, a model, and a key are all needed before the test can run.";
      paint();
      return;
    }
    pending = { baseUrl, model };
    testing = true;
    error = null;
    paint();
    try {
      const answer = await config.calls.connect({ baseUrl, model, key });
      connection = answer;
      state = { vault: { ...state.vault, present: true }, connection: answer };
      testing = false;
      pending = null;
      // The key's own promise: it leaves this page once, and the field does not keep it.
      keyEl.value = "";
      baseUrlEl.value = answer.baseUrl;
      modelEl.value = answer.model;
      paint();
      try {
        state = await config.calls.read();
        connection = state.connection;
      } catch {
        // The save's own answer is the state until the next read; a failed refresh is not a failure
        // of the save.
      }
      paint();
      config.onSaved?.(answer);
    } catch (thrown) {
      testing = false;
      pending = null;
      keyEl.value = "";
      error = thrown instanceof Error ? thrown.message : String(thrown);
      paint();
    }
  }

  formEl.addEventListener("submit", (event) => {
    event.preventDefault();
    if (testing) return;
    void save();
  });
  for (const field of [baseUrlEl, modelEl]) {
    // The request line follows the fields, because that is the request the button would make.
    field.addEventListener("input", () => {
      if (!testing) paint();
    });
  }
  continueEl.addEventListener("click", () => config.onContinue?.());
  replayEl.addEventListener("click", () => config.onReplay?.());

  paint();

  return {
    async load() {
      state = await config.calls.read();
      connection = state.connection;
      if (connection !== null) {
        baseUrlEl.value = connection.baseUrl;
        modelEl.value = connection.model;
      }
      error = null;
      paint();
      return state;
    },
    show() {
      sectionEl.hidden = false;
      sectionEl.dataset.providerPage = "true";
      document.body.dataset.page = "connect";
    },
    hide() {
      sectionEl.hidden = true;
      sectionEl.dataset.providerPage = "false";
      document.body.dataset.page = "app";
    },
    shown: () => !sectionEl.hidden,
    state: () => pageStateOf(connection, testing),
    connection: () => connection,
    facts() {
      return {
        state: pageStateOf(connection, testing),
        shown: !sectionEl.hidden,
        vault: state.vault,
        fields: {
          baseUrl: baseUrlEl.value,
          model: modelEl.value,
          keyEmpty: keyEl.value === "",
        },
        connection:
          connection === null
            ? null
            : { baseUrl: connection.baseUrl, model: connection.model, status: connection.status },
        endpoint: requestEl.textContent ?? "",
        answer: connection === null ? null : answerLine(connection),
        refusal: connection?.refusal ?? null,
        capabilities: [...capabilitiesEl.querySelectorAll("li")].map((node) => node.textContent ?? ""),
        replaced: replacesEl.hidden ? null : replacesEl.textContent,
        message: statusEl.textContent ?? "",
      };
    },
  };
}

/** Expose page 1's live facts on `window`, so a CDP driver reads the page. */
export function exposeProviderFacts(handle: ProviderHandle): void {
  window.__providerFacts = () => handle.facts();
}
