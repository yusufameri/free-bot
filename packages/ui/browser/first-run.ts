/**
 * The first-run screen's DOM: the three panes that take a name, a purpose and a starting job, and
 * the provider pane a person may test before they are through.
 *
 * It decides nothing. `packages/ui/src/first-run.ts` owns the step machine and the words that move
 * with it; the panes' standing copy (their titles, hints and field labels) is this page's own
 * markup, exactly as the export writes it inline in its HTML. `packages/ui/src/provider.ts` owns the
 * provider pane's vocabulary. Nothing here reads a record: it turns decisions into nodes and reads
 * them back for the evidence harness, the same split `shell.ts` and `library.ts` keep.
 *
 * The provider pane is the second entry point into page 1's route rather than a second test: it is
 * `mountProvider` mounted again with `surface: "first-run"`, so the smoke call, the four outcome
 * states and the capability flags are page 1's own code and page 1's own arm.
 *
 * The screen makes the Bot when the name pane's Continue is pressed, through the call the host
 * hands it, which is the same arm a person's click in the sidebar uses. Nothing here mints a Bot
 * before then, and Skip never writes a connection: a person who skips the provider pane lands in the
 * app with the vault untouched, which is what makes their runs replay.
 */

import type { ProviderConfigInput, ProviderConnection, ProviderState } from "@freebot/protocol";
import {
  chosenJob,
  EMPTY_DRAFT,
  FIRST_RUN_JOBS,
  type FirstRunDraft,
  type FirstRunFacts,
  type FirstRunStep,
  nextStep,
  paneValid,
  primaryLabel,
  purposeLine,
  SKIP_LABEL,
  STEP_CAPTIONS,
} from "../src/first-run.ts";
import type { ProviderFacts } from "../src/provider.ts";
import { mountProvider, type ProviderHandle } from "./provider.ts";

/** The calls the screen makes, with the operator token already applied by the host. */
export interface FirstRunCalls {
  /** Make the Bot a person just named, the way the sidebar's own control makes one. Its id back. */
  readonly createBot: (name: string) => Promise<string>;
  /** Give that Bot the role and the purpose the second pane asked for. */
  readonly updateBot: (botId: string, role: string, purpose: string) => Promise<void>;
  readonly readProvider: () => Promise<ProviderState>;
  readonly connect: (input: ProviderConfigInput) => Promise<ProviderConnection>;
}

/** What the screen was left with: the Bot a person named, and the job they picked. */
export interface FirstRunOutcome {
  /** The Bot the name pane made, or null when the person skipped before naming one. */
  readonly botId: string | null;
  /** The prompt the chosen job prefills, or null. */
  readonly task: string | null;
}

export interface FirstRunHandle {
  /** Read the vault the provider pane shows, and paint every pane. */
  load(): Promise<void>;
  /** Give the first-run screen the page. */
  show(): void;
  /** Give the page back to the conversation. */
  hide(): void;
  shown(): boolean;
  facts(): FirstRunFacts;
}

declare global {
  interface Window {
    /** Live first-run facts, read from the DOM, for the CDP harness. */
    __firstRunFacts?: () => FirstRunFacts;
  }
}

export function mountFirstRun(config: {
  readonly calls: FirstRunCalls;
  /** Fired with the answer the moment a provider save lands, so the host can show its own row. */
  readonly onSaved?: (connection: ProviderConnection) => void;
  /** Fired once the screen is through, with the Bot it made and the job it holds. */
  readonly onFinish: (outcome: FirstRunOutcome) => void;
  /** Fired with a message when a write the screen asked for failed, so the host can show it. */
  readonly onError?: (message: string) => void;
}): FirstRunHandle {
  function must<T extends Element>(selector: string): T {
    const found = document.querySelector<T>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
  }

  const sectionEl = must<HTMLElement>("#firstrun");
  const stepEl = must<HTMLElement>("#frStep");
  const dots = [...document.querySelectorAll<HTMLElement>("#firstrun .prog i")];
  const panes = [1, 2, 3].map((n) => must<HTMLElement>(`#frPane${n}`));
  const nameEl = must<HTMLInputElement>("#frName");
  const roleEl = must<HTMLInputElement>("#frRole");
  const purposeEl = must<HTMLInputElement>("#frPurpose");
  const chipsEl = must<HTMLElement>("#frChips");
  const nextEl = must<HTMLButtonElement>("#frNext");
  const skipEl = must<HTMLButtonElement>("#frSkip");

  let step: FirstRunStep = 1;
  let botId: string | null = null;
  let jobIndex: number | null = null;
  /** Set while a write is in flight, so a second click cannot make a second Bot. */
  let busy = false;

  const chipNodes = FIRST_RUN_JOBS.map((job, index) => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "chip";
    node.dataset.task = job.task;
    node.textContent = job.label;
    node.addEventListener("click", () => {
      jobIndex = index;
      paint();
    });
    return node;
  });
  chipsEl.replaceChildren(...chipNodes);

  const provider: ProviderHandle = mountProvider({
    surface: "first-run",
    calls: { read: config.calls.readProvider, connect: config.calls.connect },
    onSaved: (connection) => config.onSaved?.(connection),
  });

  function draft(): FirstRunDraft {
    return {
      ...EMPTY_DRAFT,
      name: nameEl.value,
      role: roleEl.value,
      purpose: purposeEl.value,
      jobIndex,
    };
  }

  function paint(): void {
    for (const [index, candidate] of panes.entries()) candidate.hidden = index !== step - 1;
    stepEl.textContent = STEP_CAPTIONS[step];
    for (const [index, dot] of dots.entries()) dot.classList.toggle("on", index < step);
    nextEl.textContent = primaryLabel(step);
    nextEl.disabled = busy || !paneValid(step, draft());
    skipEl.textContent = SKIP_LABEL;
    skipEl.disabled = busy;
    for (const [index, node] of chipNodes.entries()) {
      const chosen = index === jobIndex;
      node.classList.toggle("on", chosen);
      node.setAttribute("aria-pressed", String(chosen));
    }
  }

  /** One pane's own write, then the next pane. The last pane hands the screen over. */
  async function advance(): Promise<void> {
    if (busy || !paneValid(step, draft())) return;
    if (step === 3) {
      const job = chosenJob(draft());
      config.onFinish({ botId, task: job === null ? null : job.task });
      return;
    }
    busy = true;
    paint();
    try {
      if (step === 1) {
        botId = await config.calls.createBot(draft().name.trim());
      } else if (botId !== null) {
        await config.calls.updateBot(botId, draft().role.trim(), purposeLine(draft()));
      }
      const following = nextStep(step);
      if (following !== null) step = following;
    } catch (error) {
      config.onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
      paint();
    }
  }

  nextEl.addEventListener("click", () => void advance());
  // Skip never picks the job up and never touches the vault: it is the way out, and it says so.
  skipEl.addEventListener("click", () => config.onFinish({ botId, task: null }));
  // The name and the purpose are what hold the primary down, so typing in either has to repaint it.
  nameEl.addEventListener("input", () => paint());
  purposeEl.addEventListener("input", () => paint());

  paint();

  return {
    async load() {
      await provider.load();
      paint();
    },
    show() {
      sectionEl.hidden = false;
      sectionEl.dataset.firstRunPage = "true";
      document.body.dataset.page = "first-run";
    },
    hide() {
      sectionEl.hidden = true;
      sectionEl.dataset.firstRunPage = "false";
      document.body.dataset.page = "app";
    },
    shown: () => !sectionEl.hidden,
    facts(): FirstRunFacts {
      return {
        step,
        caption: stepEl.textContent ?? "",
        shown: !sectionEl.hidden,
        paneTitle: panes[step - 1]?.querySelector("h2")?.textContent ?? "",
        fields: { name: nameEl.value, role: roleEl.value, purpose: purposeEl.value },
        primary: nextEl.textContent ?? "",
        primaryDisabled: nextEl.disabled,
        skip: skipEl.textContent ?? "",
        jobs: FIRST_RUN_JOBS.map((job, index) => ({
          label: job.label,
          chosen: index === jobIndex,
        })),
        botId,
        provider: provider.facts() as ProviderFacts,
      };
    },
  };
}

/** Expose the first-run screen's live facts on `window`, so a CDP driver reads the page. */
export function exposeFirstRunFacts(handle: FirstRunHandle): void {
  window.__firstRunFacts = () => handle.facts();
}
