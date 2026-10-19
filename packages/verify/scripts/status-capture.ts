#!/usr/bin/env bun
/**
 * Order 31's MVP status capture, as a driver rather than a copy of the last pass.
 *
 * The 20-minute readiness routine proves the predicate by booting the app and driving the page.
 * Every pass used to do that with a fresh copy of the last pass's script, so the one instrument in
 * the project with no owner was the script that proved the predicate. At pass 56 a copy still read
 * `#thread .run-status` after U6.5 moved the run state to `#run[data-run-status]`; the selector
 * matched nothing, the empty array read as green, and the capture asserted nothing.
 *
 * This driver is that script, once, with its selectors in one table. Every fact is a `Probe`: a
 * fact name, the subject a person would recognise, one selector, and the expression that reads it.
 * A state names the probes it requires. A probe whose selector matches nothing is an error that
 * names the selector and the subject, so a surface change fails here instead of reading empty.
 *
 * Usage:
 *   bun packages/verify/scripts/status-capture.ts --url <url> --out <directory> [--mode …]
 *
 * `--url` is a live instance's URL, including the `#token=` fragment `bun run up` prints. `--out`
 * is the directory the caller names; the driver writes the labelled PNGs, `facts.jsonl` and
 * `assert.txt` there. `--mode` is `predicate` (the default), `landing`, or `both`.
 *
 * The driver does not boot the app. A pass starts `bun run up --no-open --replay` itself, then calls
 * this. `bun run verify` skips this step by name unless `FREEBOT_STATUS_URL` names an instance, so a
 * machine with nothing running stays green.
 *
 * Run from the repo root, against a live instance:
 *   bun packages/verify/scripts/status-capture.ts --url "$URL" --out reports/pass-1
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Chrome,
  evaluate,
  launchChrome,
  openPage,
  screenshot,
  settle,
  setViewport,
  sleep,
  waitFor,
} from "../src/cdp.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");

/** The profile prefix `.gitignore` covers, so a crashed run leaves nothing for `git status`. */
const PROFILE_PREFIX = ".freebot-chrome-profile-";

/** The two viewports the landing capture has always used. */
const LANDING_VIEWPORTS = [
  { file: "L-landing-1440x900.png", width: 1440, height: 900 },
  { file: "L-landing-430x932.png", width: 430, height: 932 },
] as const;

/** The prompt the replay transcript answers, read by the run's own page composer. */
const PROMPT = "write the word done into /workspace/note.txt then tell me what you did";

type FactValue = string | number | boolean | null | readonly string[];

/** Every fact this capture reads. One probe owns one field, so a read cannot silently collide. */
interface Facts {
  readonly conn: string | null;
  readonly operatorMode: string | null;
  readonly firstRunSkip: string;
  readonly botRow: string;
  readonly prompt: string;
  readonly start: string;
  readonly runId: string | null;
  readonly headerStatus: string | null;
  readonly lastSeq: number;
  readonly idleNote: string | null;
  readonly turns: readonly string[];
  readonly tools: readonly string[];
  readonly toolStatuses: readonly string[];
  readonly approvalState: string | null;
  readonly approvalDecision: string | null;
  readonly approvalResults: readonly string[];
  readonly approvalButtons: readonly string[];
  readonly command: string | null;
  readonly stopLabel: string;
  readonly stopDisabled: boolean;
  readonly stopInFlight: string;
  readonly stopRunId: string | null;
  readonly landingTitle: string;
  readonly landingH1: string;
  readonly landingLinks: readonly string[];
  readonly landingSections: readonly string[];
  readonly scrollWidth: number;
  readonly innerWidth: number;
}

export interface Probe {
  readonly fact: keyof Facts;
  /** What a person calls the thing, used in the error when its selector is gone. */
  readonly subject: string;
  readonly selector: string;
  /** The expression the page evaluates with `node` bound to one element. */
  readonly read: string;
  /** The selector must match at least one node, and the fact is the array of all matches. */
  readonly many?: boolean;
  /** A collection this state expects to be empty; an empty read is the assertion, not a failure. */
  readonly optional?: boolean;
}

export type Evaluator = (expression: string) => Promise<unknown>;

/**
 * The selector table. A surface change migrates this driver by editing a row here, and a rename
 * that misses a row fails by selector rather than passing with an empty read.
 */
export const PROBES = {
  conn: {
    fact: "conn",
    subject: "the connection state",
    selector: "#conn",
    read: "node.dataset.connection ?? null",
  },
  operatorMode: {
    fact: "operatorMode",
    subject: "operator mode, which a URL carrying the launch token turns on",
    selector: '.shell[data-operator="true"]',
    read: "node.dataset.operator ?? null",
  },
  firstRunSkip: {
    fact: "firstRunSkip",
    subject: "the first-run Skip control",
    selector: "#frSkip",
    read: "node.textContent.trim()",
  },
  botRow: {
    fact: "botRow",
    subject: "the Bot row",
    selector: ".bot-row",
    read: "node.textContent.trim()",
  },
  prompt: {
    fact: "prompt",
    subject: "the composer input",
    selector: "#prompt",
    read: "node.id",
  },
  start: {
    fact: "start",
    subject: "the Start run control",
    selector: "#start",
    read: "node.textContent.trim()",
  },
  runId: {
    fact: "runId",
    subject: "the run element's id",
    selector: "#run",
    read: "node.dataset.runId ?? null",
  },
  headerStatus: {
    fact: "headerStatus",
    subject: "the header run status",
    selector: "#run[data-run-status]",
    read: "node.dataset.runStatus ?? null",
  },
  lastSeq: {
    fact: "lastSeq",
    subject: "the last sequence counter",
    selector: "#lastseq",
    read: "Number(node.dataset.lastSeq)",
  },
  idleNote: {
    fact: "idleNote",
    subject: "the empty thread's note",
    selector: "#thread #idle-note",
    read: "node.textContent.trim()",
  },
  turns: {
    fact: "turns",
    subject: "the thread turns",
    selector: "#thread .message, #thread .turn",
    read: "node.textContent.trim().slice(0, 70)",
    many: true,
  },
  tools: {
    fact: "tools",
    subject: "the tool cards",
    selector: "#thread .tool-card",
    read: "node.textContent.trim().slice(0, 70)",
    many: true,
  },
  toolStatuses: {
    fact: "toolStatuses",
    subject: "the tool cards' states",
    selector: "#thread .tool-card",
    read: "node.dataset.status ?? ''",
    many: true,
  },
  approvalState: {
    fact: "approvalState",
    subject: "the approval card's state",
    selector: "#thread .approval-card",
    read: "node.dataset.state ?? null",
  },
  approvalDecision: {
    fact: "approvalDecision",
    subject: "the approval card's decision",
    selector: "#thread .approval-card",
    read: "node.dataset.decision ?? null",
  },
  approvalResults: {
    fact: "approvalResults",
    subject: "the approval card's result",
    selector: "#thread .approval-card .approval-result",
    read: "node.textContent.trim()",
    many: true,
  },
  approvalButtons: {
    fact: "approvalButtons",
    subject: "the approval card's actions",
    selector: "#thread .approval-card .approval-actions button",
    read: "node.textContent.trim()",
    many: true,
  },
  command: {
    fact: "command",
    subject: "the approval card's command",
    selector: "#thread .approval-card .cmd",
    read: "node.textContent.trim()",
  },
  stopLabel: {
    fact: "stopLabel",
    subject: "the Stop run control's label",
    selector: "#stop",
    read: "node.textContent.trim()",
  },
  stopDisabled: {
    fact: "stopDisabled",
    subject: "the Stop run control's enabled state",
    selector: "#stop",
    read: "node.disabled",
  },
  stopInFlight: {
    fact: "stopInFlight",
    subject: "the Stop run control's in-flight flag",
    selector: "#stop",
    read: "node.dataset.inFlight ?? ''",
  },
  stopRunId: {
    fact: "stopRunId",
    subject: "the Stop run control's run id",
    selector: "#stop",
    read: "node.dataset.runId ?? null",
  },
  landingTitle: {
    fact: "landingTitle",
    subject: "the landing document's title",
    selector: "html",
    read: "document.title",
  },
  landingH1: {
    fact: "landingH1",
    subject: "the landing heading",
    selector: "#landing-hero",
    read: "node.textContent.trim()",
  },
  landingLinks: {
    fact: "landingLinks",
    subject: "the landing controls",
    selector: "#landing-controls a",
    read: "node.textContent.trim()",
    many: true,
  },
  landingSections: {
    fact: "landingSections",
    subject: "the landing sections",
    selector: ".landing h2",
    read: "node.textContent.trim()",
    many: true,
  },
  scrollWidth: {
    fact: "scrollWidth",
    subject: "the document's scroll width",
    selector: "html",
    read: "document.documentElement.scrollWidth",
  },
  innerWidth: {
    fact: "innerWidth",
    subject: "the viewport width",
    selector: "html",
    read: "window.innerWidth",
  },
} as const satisfies Record<string, Probe>;

/** One selector this driver drives, separate from the facts it reads. */
interface Control {
  readonly subject: string;
  readonly selector: string;
}

/** Read one state's facts, failing by selector when a required one matches nothing. */
export async function readFacts(run: Evaluator, probes: readonly Probe[]): Promise<Facts> {
  const countsExpression = `({${probes
    .map(
      (probe) =>
        `${JSON.stringify(probe.fact)}:document.querySelectorAll(${JSON.stringify(probe.selector)}).length`,
    )
    .join(",")}})`;
  const counts = (await run(countsExpression)) as Record<string, number>;
  const facts: Record<string, FactValue> = {};

  for (const probe of probes) {
    const count = counts[probe.fact] ?? 0;
    if (count === 0 && probe.optional !== true) {
      throw new Error(`missing selector ${JSON.stringify(probe.selector)} (${probe.subject})`);
    }
    const expression =
      probe.many === true
        ? `[...document.querySelectorAll(${JSON.stringify(probe.selector)})].map((node) => (${probe.read}))`
        : `(() => { const node = document.querySelector(${JSON.stringify(probe.selector)}); return node === null ? null : (${probe.read}); })()`;
    facts[probe.fact] = (await run(expression)) as FactValue;
  }

  return facts as unknown as Facts;
}

/** Click one control, failing by selector when it is not there. */
async function click(run: Evaluator, control: Control): Promise<void> {
  const count = (await run(
    `document.querySelectorAll(${JSON.stringify(control.selector)}).length`,
  )) as number;
  if (count === 0) {
    throw new Error(`missing selector ${JSON.stringify(control.selector)} (${control.subject})`);
  }
  await run(`document.querySelector(${JSON.stringify(control.selector)}).click()`);
}

/** A state's label, file, facts and assertions. */
interface CaptureState {
  readonly label: string;
  readonly file: string;
  readonly probes: readonly Probe[];
  readonly assert: (facts: Facts, earlier: readonly Facts[]) => readonly string[];
}

function compare(failures: string[], label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(
      `${label}: actual ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`,
    );
  }
}

function compareThat(failures: string[], label: string, ok: boolean, detail: unknown): void {
  if (!ok) failures.push(`${label}: ${JSON.stringify(detail)}`);
}

const PREDICATE_STATES: readonly CaptureState[] = [
  {
    label: "A-shell-with-bot",
    file: "A-shell-with-bot.png",
    probes: [
      PROBES.conn,
      PROBES.operatorMode,
      PROBES.botRow,
      PROBES.prompt,
      PROBES.start,
      PROBES.runId,
      PROBES.lastSeq,
      PROBES.idleNote,
      { ...PROBES.turns, optional: true },
      { ...PROBES.tools, optional: true },
      PROBES.stopLabel,
      PROBES.stopDisabled,
      PROBES.stopInFlight,
    ],
    assert: (facts) => {
      const failures: string[] = [];
      compare(failures, "the page is connected", facts.conn, "connected");
      compare(failures, "the URL turned operator mode on", facts.operatorMode, "true");
      compareThat(failures, "a Bot row is rendered", facts.botRow.length > 0, facts.botRow);
      compare(failures, "the composer input is the page's own", facts.prompt, "prompt");
      compare(failures, "the Start run control's label", facts.start, "Start run");
      compare(failures, "no run has started", facts.runId, null);
      compare(failures, "the sequence counter is at zero", facts.lastSeq, 0);
      compare(failures, "the thread is empty", facts.turns.length, 0);
      compareThat(
        failures,
        "the empty thread says it is waiting rather than reading nothing",
        facts.idleNote === "Waiting for the run to start.",
        facts.idleNote,
      );
      compare(failures, "the Stop run control's label", facts.stopLabel, "Stop run");
      compare(failures, "the Stop run control is disabled", facts.stopDisabled, true);
      compare(
        failures,
        "the Stop run control reports no run in flight",
        facts.stopInFlight,
        "false",
      );
      return failures;
    },
  },
  {
    label: "B-run-streaming",
    file: "B-run-streaming.png",
    probes: [
      PROBES.conn,
      PROBES.runId,
      PROBES.headerStatus,
      PROBES.lastSeq,
      PROBES.turns,
      PROBES.tools,
      PROBES.toolStatuses,
      PROBES.approvalState,
      PROBES.approvalButtons,
      PROBES.command,
      PROBES.stopLabel,
      PROBES.stopDisabled,
      PROBES.stopInFlight,
      PROBES.stopRunId,
    ],
    assert: (facts) => {
      const failures: string[] = [];
      compare(failures, "the page is connected", facts.conn, "connected");
      compareThat(
        failures,
        "a run has an id",
        facts.runId !== null && /^run-\d+$/.test(facts.runId),
        facts.runId,
      );
      compare(
        failures,
        "the header carries the parked run status",
        facts.headerStatus,
        "awaiting_approval",
      );
      compareThat(
        failures,
        "the prompt and the turn arrived",
        facts.turns.length >= 2,
        facts.turns,
      );
      compare(failures, "one tool card is rendered", facts.tools.length, 1);
      compare(failures, "the tool card is waiting on the gate", facts.toolStatuses, [
        "awaiting approval",
      ]);
      compare(failures, "the approval card is pending", facts.approvalState, "pending");
      compareThat(
        failures,
        "the approval card offers Allow once and Deny",
        facts.approvalButtons.includes("Allow once") && facts.approvalButtons.includes("Deny"),
        facts.approvalButtons,
      );
      compareThat(
        failures,
        "the approval card names the command",
        facts.command !== null && facts.command.length > 0,
        facts.command,
      );
      compare(failures, "the Stop run control's label", facts.stopLabel, "Stop run");
      compare(failures, "the Stop run control is enabled", facts.stopDisabled, false);
      compare(failures, "the Stop run control reports a run in flight", facts.stopInFlight, "true");
      compare(failures, "the Stop run control carries the run id", facts.stopRunId, facts.runId);
      return failures;
    },
  },
  {
    label: "C-approval-waiting",
    file: "C-approval-waiting.png",
    probes: [
      PROBES.conn,
      PROBES.runId,
      PROBES.headerStatus,
      PROBES.toolStatuses,
      PROBES.approvalState,
      PROBES.approvalButtons,
      PROBES.command,
      PROBES.stopLabel,
      PROBES.stopDisabled,
      PROBES.stopInFlight,
    ],
    assert: (facts) => {
      const failures: string[] = [];
      compare(failures, "the page is connected", facts.conn, "connected");
      compareThat(failures, "the run is still the parked one", facts.runId !== null, facts.runId);
      compare(
        failures,
        "the header still says the run is awaiting the answer",
        facts.headerStatus,
        "awaiting_approval",
      );
      compare(failures, "the tool card is still waiting", facts.toolStatuses, [
        "awaiting approval",
      ]);
      compare(failures, "the approval card is pending", facts.approvalState, "pending");
      compareThat(
        failures,
        "Allow once is the control this state waits for",
        facts.approvalButtons.includes("Allow once"),
        facts.approvalButtons,
      );
      compareThat(
        failures,
        "the command is still named",
        facts.command !== null && facts.command.length > 0,
        facts.command,
      );
      compare(failures, "the Stop run control is enabled", facts.stopDisabled, false);
      compare(failures, "the Stop run control reports a run in flight", facts.stopInFlight, "true");
      return failures;
    },
  },
  {
    label: "D-after-answer",
    file: "D-after-answer.png",
    probes: [
      PROBES.conn,
      PROBES.runId,
      PROBES.headerStatus,
      PROBES.lastSeq,
      PROBES.tools,
      PROBES.toolStatuses,
      PROBES.approvalState,
      PROBES.approvalDecision,
      PROBES.approvalResults,
      PROBES.command,
    ],
    assert: (facts) => {
      const failures: string[] = [];
      compare(failures, "the page is connected", facts.conn, "connected");
      compareThat(failures, "the answered run has an id", facts.runId !== null, facts.runId);
      compareThat(
        failures,
        "the header carries a live run status",
        facts.headerStatus === "running" || facts.headerStatus === "done",
        facts.headerStatus,
      );
      compare(failures, "the approval decision is allow", facts.approvalDecision, "allow");
      compare(failures, "the approval card is allowed", facts.approvalState, "allowed");
      compare(failures, "the approval result is the page's own word", facts.approvalResults, [
        "allowed once",
      ]);
      compareThat(
        failures,
        "the tool card is running or done",
        facts.toolStatuses.length > 0 &&
          facts.toolStatuses.every((status) => status === "running" || status === "done"),
        facts.toolStatuses,
      );
      compareThat(
        failures,
        "the command is still named after the answer",
        facts.command !== null && facts.command.length > 0,
        facts.command,
      );
      return failures;
    },
  },
  {
    label: "E-settled",
    file: "E-settled.png",
    probes: [
      PROBES.conn,
      PROBES.runId,
      PROBES.headerStatus,
      PROBES.lastSeq,
      PROBES.turns,
      PROBES.tools,
      PROBES.toolStatuses,
      PROBES.approvalState,
      PROBES.approvalDecision,
      PROBES.approvalResults,
      PROBES.stopLabel,
      PROBES.stopDisabled,
      PROBES.stopInFlight,
      PROBES.stopRunId,
    ],
    assert: (facts, earlier) => {
      const failures: string[] = [];
      const streaming = earlier.find((entry) => entry.headerStatus === "awaiting_approval");
      compare(failures, "the page is connected", facts.conn, "connected");
      compareThat(failures, "the settled run has an id", facts.runId !== null, facts.runId);
      compare(failures, "the header says the run is done", facts.headerStatus, "done");
      compare(failures, "the approval decision stays allow", facts.approvalDecision, "allow");
      compare(failures, "the approval card stays allowed", facts.approvalState, "allowed");
      compare(failures, "the approval result stays the page's own word", facts.approvalResults, [
        "allowed once",
      ]);
      compare(failures, "the tool card settles done", facts.toolStatuses, ["done"]);
      compareThat(
        failures,
        "frames arrived after the parked state",
        streaming !== undefined && facts.lastSeq > streaming.lastSeq,
        { settled: facts.lastSeq, streaming: streaming?.lastSeq ?? null },
      );
      compare(failures, "the Stop run control's label", facts.stopLabel, "Stop run");
      compare(failures, "the Stop run control is disabled again", facts.stopDisabled, true);
      compare(
        failures,
        "the Stop run control reports no run in flight",
        facts.stopInFlight,
        "false",
      );
      compare(failures, "the Stop run control keeps the run id", facts.stopRunId, facts.runId);
      return failures;
    },
  },
];

interface Capture {
  readonly state: string;
  readonly file: string;
  readonly facts: Facts;
}

interface Report {
  readonly log: string[];
  readonly captures: Capture[];
  passed: number;
  failed: number;
}

/** Capture one state: the facts first, then the PNG they label, then the assertions. */
async function captureState(
  chrome: Chrome,
  session: string,
  out: string,
  state: CaptureState,
  report: Report,
  earlier: readonly Facts[],
): Promise<Facts> {
  const facts = await readFacts(
    (expression) => evaluate(chrome.cdp, session, expression),
    state.probes,
  );
  const shot = await screenshot(chrome.cdp, session);
  writeFileSync(join(out, state.file), shot);
  const failures = state.assert(facts, earlier);

  report.log.push("", `== ${state.file} ==`, `facts ${JSON.stringify(facts)}`);
  report.captures.push({ state: state.label, file: state.file, facts });
  if (failures.length === 0) {
    report.passed += 1;
    report.log.push(`ok   ${state.label}: ${state.probes.length} selectors read, every fact holds`);
  } else {
    report.failed += failures.length;
    for (const failure of failures) report.log.push(`FAIL ${state.label}: ${failure}`);
  }
  return facts;
}

export type Mode = "predicate" | "landing" | "both";

export interface Options {
  readonly url: string;
  readonly out: string;
  readonly mode: Mode;
}

const USAGE =
  "usage: bun packages/verify/scripts/status-capture.ts --url <url> --out <directory> [--mode predicate|landing|both]";

/** Parse the CLI at the boundary, so a typo fails by name before a browser starts. */
export function parseArgs(argv: readonly string[]): Options {
  let url = "";
  let out = "";
  let mode: Mode = "predicate";

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--url":
        if (value === undefined) throw new Error(`--url needs a value\n${USAGE}`);
        url = value;
        index += 1;
        break;
      case "--out":
        if (value === undefined) throw new Error(`--out needs a value\n${USAGE}`);
        out = value;
        index += 1;
        break;
      case "--mode":
        if (value !== "predicate" && value !== "landing" && value !== "both") {
          throw new Error(
            `--mode must be predicate, landing or both, not ${JSON.stringify(value)}\n${USAGE}`,
          );
        }
        mode = value;
        index += 1;
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(flag)}\n${USAGE}`);
    }
  }

  if (url === "") throw new Error(`--url is required\n${USAGE}`);
  if (out === "") throw new Error(`--out is required\n${USAGE}`);
  return { url, out, mode };
}

function shortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

/** Keep the launch token out of every committed surface. */
function redact(url: string): string {
  return url.replace(/#token=.*$/, "#token=<redacted>");
}

function tokenOf(url: string): string {
  return new URLSearchParams(new URL(url).hash.replace(/^#/, "")).get("token") ?? "";
}

function originOf(url: string): string {
  return new URL(url).origin;
}

async function capturePredicate(
  chrome: Chrome,
  url: string,
  out: string,
  report: Report,
): Promise<void> {
  const session = await openPage(chrome.cdp, url);
  const run = (expression: string) => evaluate(chrome.cdp, session, expression);

  // The page connects its stream only once the first-run screen has stood down, so the Skip comes
  // before the connection wait. A page already past first run has the same control mounted.
  await sleep(800);
  await click(run, {
    subject: PROBES.firstRunSkip.subject,
    selector: PROBES.firstRunSkip.selector,
  });
  await waitFor(
    chrome.cdp,
    session,
    "the Bot row (.bot-row) the shell paints after first run",
    `document.querySelector('.bot-row') !== null`,
    20_000,
  );
  await click(run, { subject: PROBES.botRow.subject, selector: PROBES.botRow.selector });
  await waitFor(
    chrome.cdp,
    session,
    "the page's connection state (#conn)",
    `document.querySelector('#conn')?.dataset.connection === 'connected'`,
    30_000,
  );
  await settle(chrome.cdp, session);

  const [shell, streaming, waiting, answered, settled] = PREDICATE_STATES;
  if (
    shell === undefined ||
    streaming === undefined ||
    waiting === undefined ||
    answered === undefined ||
    settled === undefined
  ) {
    throw new Error("the predicate capture is missing a state");
  }

  const earlier: Facts[] = [];
  earlier.push(await captureState(chrome, session, out, shell, report, earlier));

  await run(`(() => {
    const input = document.querySelector('#prompt');
    if (input === null) throw new Error('missing selector "#prompt" (the composer input)');
    const proto = HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${JSON.stringify(PROMPT)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  })()`);
  await click(run, { subject: PROBES.start.subject, selector: PROBES.start.selector });

  await waitFor(
    chrome.cdp,
    session,
    "the tool card (#thread .tool-card)",
    `document.querySelector('#thread .tool-card') !== null`,
    25_000,
  );
  await waitFor(
    chrome.cdp,
    session,
    "the header run status saying the run is parked (#run[data-run-status])",
    `document.querySelector('#run')?.dataset.runStatus === 'awaiting_approval'`,
    25_000,
  );

  earlier.push(await captureState(chrome, session, out, streaming, report, earlier));

  await waitFor(
    chrome.cdp,
    session,
    "the approval card's Allow once control (#thread .approval-card .allow-once)",
    `document.querySelector('#thread .approval-card .allow-once') !== null`,
    25_000,
  );
  await sleep(400);
  await settle(chrome.cdp, session);
  earlier.push(await captureState(chrome, session, out, waiting, report, earlier));

  await click(run, {
    subject: "the approval card's Allow once control",
    selector: "#thread .approval-card .allow-once",
  });
  await waitFor(
    chrome.cdp,
    session,
    "the approval card's allow decision (#thread .approval-card)",
    `document.querySelector('#thread .approval-card')?.dataset.decision === 'allow'`,
    20_000,
  );
  await sleep(400);
  await settle(chrome.cdp, session);
  earlier.push(await captureState(chrome, session, out, answered, report, earlier));

  await waitFor(
    chrome.cdp,
    session,
    "the settled run status (#run[data-run-status])",
    `document.querySelector('#run')?.dataset.runStatus === 'done'`,
    40_000,
  );
  await sleep(800);
  await settle(chrome.cdp, session);
  earlier.push(await captureState(chrome, session, out, settled, report, earlier));
}

async function captureLanding(
  chrome: Chrome,
  base: string,
  out: string,
  report: Report,
): Promise<void> {
  const session = await openPage(chrome.cdp, `${base}/landing`);
  const run = (expression: string) => evaluate(chrome.cdp, session, expression);

  await waitFor(
    chrome.cdp,
    session,
    "the landing heading (#landing-hero)",
    `document.querySelector('#landing-hero') !== null`,
    30_000,
  );

  const probes = [
    PROBES.landingTitle,
    PROBES.landingH1,
    PROBES.landingLinks,
    PROBES.landingSections,
    PROBES.scrollWidth,
    PROBES.innerWidth,
  ] as const;

  for (const viewport of LANDING_VIEWPORTS) {
    await setViewport(chrome.cdp, session, viewport.width, viewport.height);
    await settle(chrome.cdp, session);
    const facts = await readFacts(run, probes);
    const shot = await screenshot(chrome.cdp, session);
    writeFileSync(join(out, viewport.file), shot);

    const failures: string[] = [];
    compare(failures, "the landing document's title", facts.landingTitle, "FreeBot");
    compareThat(
      failures,
      "the landing heading is not empty",
      facts.landingH1.length > 0,
      facts.landingH1,
    );
    compare(failures, "both landing controls render", facts.landingLinks.length, 2);
    compareThat(
      failures,
      "the landing sections render",
      facts.landingSections.length > 0,
      facts.landingSections,
    );
    compareThat(
      failures,
      `no horizontal overflow at ${viewport.width}x${viewport.height}`,
      facts.scrollWidth <= facts.innerWidth,
      { scrollWidth: facts.scrollWidth, innerWidth: facts.innerWidth },
    );

    report.log.push("", `== ${viewport.file} ==`, `facts ${JSON.stringify(facts)}`);
    report.captures.push({ state: viewport.file, file: viewport.file, facts });
    if (failures.length === 0) {
      report.passed += 1;
      report.log.push(`ok   ${viewport.file}: every landing fact holds`);
    } else {
      report.failed += failures.length;
      for (const failure of failures) report.log.push(`FAIL ${viewport.file}: ${failure}`);
    }
  }
}

async function main(): Promise<number> {
  const options = parseArgs(Bun.argv.slice(2));
  mkdirSync(options.out, { recursive: true });

  const profile = join(root, `${PROFILE_PREFIX}${Date.now()}`);
  let chrome: Chrome | null = null;
  const report: Report = {
    log: [
      "MVP status capture driver",
      `command: bun packages/verify/scripts/status-capture.ts --url ${redact(options.url)} --out ${options.out} --mode ${options.mode}`,
      `timestamp: ${new Date().toISOString()}`,
      `git sha: ${git(["rev-parse", "HEAD"])}`,
      `git sha short: ${shortSha()}`,
      `branch: ${git(["rev-parse", "--abbrev-ref", "HEAD"])}`,
      `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
      `mode: ${options.mode}`,
      `url: ${redact(options.url)}`,
      `out: ${options.out}`,
      "",
      "## selectors",
      ...Object.values(PROBES).map(
        (probe) => `${probe.fact}: ${probe.selector} (${probe.subject})`,
      ),
    ],
    captures: [],
    passed: 0,
    failed: 0,
  };

  try {
    chrome = await launchChrome({ windowSize: "1440,900", profileDir: profile });
    if (options.mode === "predicate" || options.mode === "both") {
      await capturePredicate(chrome, options.url, options.out, report);
    }
    if (options.mode === "landing" || options.mode === "both") {
      await captureLanding(chrome, originOf(options.url), options.out, report);
    }
    report.log.push("", `chrome ${chrome.cdp.version}`);
  } finally {
    chrome?.stop();
    rmSync(profile, { recursive: true, force: true });
  }

  report.log.push(
    `artifacts: ${report.captures.map((capture) => capture.file).join(", ")}`,
    "",
    `RESULT: ${report.failed === 0 ? "PASS" : "FAIL"} (${report.passed}/${report.passed + report.failed})`,
  );

  const factsBody = `${report.captures.map((capture) => JSON.stringify(capture)).join("\n")}\n`;
  const logBody = `${report.log.join("\n")}\n`;
  const token = tokenOf(options.url);
  if (token !== "" && `${factsBody}${logBody}`.includes(token)) {
    throw new Error("the capture's output would carry the launch token; refusing to write it");
  }
  writeFileSync(join(options.out, "facts.jsonl"), factsBody);
  writeFileSync(join(options.out, "assert.txt"), logBody);

  console.log(
    report.log.filter((line) => line.startsWith("FAIL") || line.startsWith("RESULT")).join("\n"),
  );
  console.log(`artifact: ${options.out}/assert.txt`);
  return report.failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(
      `status capture failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
