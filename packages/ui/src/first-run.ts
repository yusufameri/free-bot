/**
 * The first-run screen's model: three panes, one question each, and the draft they fill in.
 *
 * `packages/ui/browser/first-run.ts` renders this and decides nothing, the same split `bots.ts`,
 * `library.ts` and `provider.ts` keep for their surfaces. What lives here is what the step decides:
 * the step caption, the primary's label, whether the pane on screen can be left, and the four
 * suggested jobs the chips are rendered from. The panes' standing copy (their titles, their hints
 * and their field labels) is the page's own markup, exactly as the export writes it inline in its
 * HTML, and the evidence reads it off the live DOM.
 *
 * Every string here is the export's, copied from
 * `design/prototype-84c6b185/freebot-prototype.html` at the line named beside it, because the export
 * governs the visuals and the copy a person reads. The two export files disagree on this screen, and
 * the fuller file wins where they do: it asks for a name, a label and a purpose, and the v1 file
 * asks only for a purpose.
 *
 * What a step's Continue *does* is the host's business, because writing a Bot and writing a purpose
 * are the server's arms rather than this module's.
 */

/** The three panes, in the export's order: name, then purpose, then a starting job. */
export const FIRST_RUN_STEPS = 3;

export type FirstRunStep = 1 | 2 | 3;

/** The step caption above the panes: `freebot-prototype.html:2219`, read off `renderFirstRun`. */
export const STEP_CAPTIONS: Record<FirstRunStep, string> = {
  1: "01 / 03 — NAME",
  2: "02 / 03 — PURPOSE",
  3: "03 / 03 — FIRST TASK",
};

/** One suggested first job: the chip's label and the prompt it prefills. `:644-647`. */
export interface FirstRunJob {
  readonly label: string;
  readonly task: string;
}

export const FIRST_RUN_JOBS: readonly FirstRunJob[] = [
  {
    label: "Audit for committed secrets",
    task: "Audit the repo for committed secrets and draft the cleanup.",
  },
  {
    label: "Draft this week's changelog",
    task: "Draft this week's changelog from merged PRs.",
  },
  {
    label: "Sweep dependencies",
    task: "Sweep dependencies and report what is stale, with a plan.",
  },
  {
    label: "Summarise since last release",
    task: "Summarise what changed in main since the last release.",
  },
];

/** The footer's two controls and the last pane's primary: `freebot-prototype.html:663-664`, `:2220`. */
export const CONTINUE_LABEL = "Continue";
export const START_LABEL = "Start working";
export const SKIP_LABEL = "Skip";

/** What the person has typed, and the chip they picked, while the screen is up. */
export interface FirstRunDraft {
  readonly name: string;
  readonly role: string;
  readonly purpose: string;
  /** The chosen job, or null while nothing is picked. */
  readonly jobIndex: number | null;
}

export const EMPTY_DRAFT: FirstRunDraft = { name: "", role: "", purpose: "", jobIndex: null };

/**
 * Whether the pane on screen can be left. The export ships one disabled state, the provisioning
 * button at `:2227`, and the base styles carry the treatment for it (`:133`); the name and the
 * purpose are what its two questions ask for, so a blank answer holds the button down. A label and
 * a job are both optional, because the export's own text says a job may be skipped and its fallback
 * for an empty label is a name rather than a refusal.
 */
export function paneValid(step: FirstRunStep, draft: FirstRunDraft): boolean {
  switch (step) {
    case 1:
      return draft.name.trim().length > 0;
    case 2:
      return draft.purpose.trim().length > 0;
    case 3:
      return true;
  }
}

/** The footer's primary for a step: `Continue` until the last pane, then `Start working`. */
export function primaryLabel(step: FirstRunStep): string {
  return step === FIRST_RUN_STEPS ? START_LABEL : CONTINUE_LABEL;
}

/** Where Continue lands: the next pane, or nothing left to ask. */
export function nextStep(step: FirstRunStep): FirstRunStep | null {
  switch (step) {
    case 1:
      return 2;
    case 2:
      return 3;
    case 3:
      return null;
  }
}

/** The job a person picked, or null. */
export function chosenJob(draft: FirstRunDraft): FirstRunJob | null {
  const index = draft.jobIndex;
  return index === null ? null : (FIRST_RUN_JOBS[index] ?? null);
}

/** The purpose line as the record carries it: one line, no surrounding space. */
export function purposeLine(draft: FirstRunDraft): string {
  return draft.purpose.replace(/\s+/g, " ").trim();
}

/**
 * What the screen shows, in the shape the evidence reads. Every field is something a reader can see
 * in the DOM, and `botId` is the record this screen made, which is null until the person asks for
 * one.
 */
export interface FirstRunFacts {
  readonly step: FirstRunStep;
  readonly caption: string;
  readonly shown: boolean;
  /** The title of the pane the DOM is holding, which is the one the step says it should be. */
  readonly paneTitle: string;
  readonly fields: { name: string; role: string; purpose: string };
  readonly primary: string;
  readonly primaryDisabled: boolean;
  readonly skip: string;
  readonly jobs: Array<{ label: string; chosen: boolean }>;
  /** The id of the Bot the name pane made, or null. */
  readonly botId: string | null;
  /** The provider pane's own facts, read from the pane the first-run screen holds. */
  readonly provider: unknown;
}
