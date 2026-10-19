/**
 * The landing route's behaviour: the one control that does something on this page.
 *
 * The landing is a static document. Its hero's two controls are plain links to `/`, because the
 * app decides for itself what a person meets there: a store with no Bot opens the first-run screen,
 * a keyless machine with a Bot opens the provider page, and a live one opens the shell. Deep-linking
 * into a state the app would not have chosen would be the page claiming to know something it does
 * not.
 *
 * That leaves one interactive element, `Copy`, which puts the real command in the clipboard. It
 * reports what it did in the status line beside it and says so when the clipboard is refused, so the
 * control never claims a copy that did not happen.
 *
 * `__landingFacts` is the hook the evidence driver reads, in the shape every other surface in this
 * app exposes: what the page shows, read out of the DOM rather than out of a variable.
 */

/** The command that copies, and the one the button beside it names. */
const UP_COMMAND = "bun run up";

const COPIED = "Copied. Paste it in a terminal on this computer.";
const COPY_FAILED = "This browser refused the clipboard. Select the command and copy it.";

export interface LandingFacts {
  /** The hero's own heading, which is the export's landing heading. */
  readonly hero: string;
  /** The eyebrow above it. */
  readonly eyebrow: string;
  /** Every section this page carries, in the order it renders them. */
  readonly sections: readonly string[];
  /** The hero's controls: where each one goes and what it says. */
  readonly controls: readonly {
    readonly id: string;
    readonly href: string;
    readonly text: string;
  }[];
  /** The pinned sandbox image the page names, as rendered. */
  readonly image: string;
  /** The commands the page offers, as rendered. */
  readonly commands: readonly string[];
  /** The status line's own text: empty until a copy is attempted. */
  readonly copied: string;
}

declare global {
  interface Window {
    /** Live landing facts, read from the DOM, for the CDP harness. */
    __landingFacts?: () => LandingFacts;
  }
}

const text = (selector: string): string =>
  document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ?? "";

function facts(): LandingFacts {
  return {
    hero: text("#landing-hero"),
    eyebrow: text(".onboard .eyebrow"),
    sections: [...document.querySelectorAll("[data-landing]")].map(
      (node) => (node as HTMLElement).dataset.landing ?? "",
    ),
    controls: [...document.querySelectorAll("#landing-controls a")].map((node) => ({
      id: node.id,
      href: (node as HTMLAnchorElement).getAttribute("href") ?? "",
      text: node.textContent?.replace(/\s+/g, " ").trim() ?? "",
    })),
    image: text("#landing-image"),
    commands: [...document.querySelectorAll(".cmd code")].map(
      (node) => node.textContent?.trim() ?? "",
    ),
    copied: text("#landing-copied"),
  };
}

const button = document.querySelector<HTMLButtonElement>("#landing-copy");
const status = document.querySelector<HTMLElement>("#landing-copied");
const command = document.querySelector<HTMLElement>("#landing-cmd-up");

button?.addEventListener("click", () => {
  const value = command?.textContent?.trim() ?? UP_COMMAND;
  void (async () => {
    try {
      await navigator.clipboard.writeText(value);
      if (status !== null) status.textContent = COPIED;
    } catch {
      // A refused clipboard is a real outcome, and the line says which one happened rather than
      // reporting a copy that did not occur.
      if (status !== null) status.textContent = COPY_FAILED;
    }
  })();
});

window.__landingFacts = facts;
