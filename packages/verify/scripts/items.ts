#!/usr/bin/env bun
/**
 * The U6.5 evidence driver: the conversation's items and the Bot row's real status.
 *
 * The peer is the real launcher, spawned the way a person runs it:
 * `bun run up --no-open --replay` over a temporary `FREEBOT_HOME` and bots root of this driver's
 * own, so no Bot, run or provider a person holds is touched. The model's turns are a Pi transcript
 * this driver writes: three `bash` calls and the text that follows them. Every call executes in a
 * real container from the pinned image, and every approval is answered on the page's own card.
 *
 * The run reaches, by real transitions rather than by a label:
 *
 * - approval pending, allowed, denied, and expired (a real 120s window nobody answered);
 * - a tool call running, done, denied, and failed (a command that exits 7);
 * - the turn marker thinking, working, and waiting;
 * - the Bot row working, needs you, failed, and idle, each read beside its own run record.
 *
 * One PNG per state is written under `packages/verify/artifacts/items/<short-sha>/`, and
 * `assert.txt` records the literal DOM facts and the run record for every one of them.
 *
 * Run from the repo root: bun packages/verify/scripts/items.ts
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunSummary } from "@freebot/protocol";
import {
  botDotClass,
  botSubLabel,
  deriveBotStatus,
  type ShellFacts,
} from "../../../packages/ui/src/bots.ts";
import {
  BOT_ITEM_SPECS,
  describeFacts,
  describeItems,
  type FrameFacts,
  ITEM_SPECS,
  unmetClaims,
} from "../../../packages/ui/src/frames.ts";
import {
  type Cdp,
  evaluate,
  launchChrome,
  openPage,
  screenshot,
  settle,
  setViewport,
  sleep,
  waitFor,
} from "../src/cdp.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));

const FIRST_BOT_NAME = "Items";
const SECOND_BOT_NAME = "Bystander";

type Wire = {
  readonly request: string;
  readonly status: number;
  readonly body: string;
};

interface Launched {
  readonly url: string;
  readonly apiPort: number;
  readonly token: string;
  stdout(): string;
  stderr(): string;
  interrupt(): void;
  exited(): Promise<number>;
}

const live: Launched[] = [];

async function waitForMatch(read: () => string, match: RegExp, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = match.exec(read());
    if (found?.[1] !== undefined) return found[1];
    await sleep(25);
  }
  throw new Error(`no line matching ${match} within ${timeoutMs}ms; saw:\n${read().slice(-1500)}`);
}

/**
 * The transcript this run replays. `readTranscript` picks the first prompt block that asks for one
 * of the run's tools; the three calls in that block run in order. The first sleeps long enough for
 * the running state to be photographed; the second exits 7, which is a failure rather than a
 * denial; the third is the one this driver denies.
 */
function writeTranscript(home: string): string {
  const path = join(home, "items-transcript.jsonl");
  const frames: unknown[] = [
    {
      dir: "header",
      generator: "packages/verify/scripts/items.ts",
      note: "a scripted Pi transcript: three bash calls and the text after them",
    },
    {
      dir: "bridge->pi",
      id: "items-turn",
      type: "prompt",
      message: "items: run the three scripted calls",
    },
    {
      dir: "pi->bridge",
      type: "tool_execution_start",
      toolCallId: "items-call-1",
      toolName: "bash",
      args: { command: "sleep 8; printf 'alpha\\n'" },
    },
    {
      dir: "pi->bridge",
      type: "tool_execution_start",
      toolCallId: "items-call-2",
      toolName: "bash",
      args: { command: "printf 'boom\\n' >&2; exit 7" },
    },
    {
      dir: "pi->bridge",
      type: "tool_execution_start",
      toolCallId: "items-call-3",
      toolName: "bash",
      args: { command: "printf 'never\\n'" },
    },
    {
      dir: "pi->bridge",
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "The scripted calls are finished." },
    },
  ];
  writeFileSync(path, `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);
  return path;
}

/** `bun run up --no-open --replay` over this driver's home and bots root. */
async function launch(home: string, transcript: string): Promise<Launched> {
  // The vault entry is three lines in this driver's temporary home and the model mode is replay, so
  // it is read for the page's connection state and never sent anywhere. No value is ever printed.
  writeFileSync(
    join(home, "provider.env"),
    [
      "# items.ts placeholder vault; --replay means no request reads it",
      `FREEBOT_BYOK_KEY=items-${Date.now()}`,
      "FREEBOT_BYOK_BASE_URL=http://127.0.0.1:9/items-not-a-provider",
      "FREEBOT_BYOK_MODEL=items-placeholder",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const proc = Bun.spawn(
    ["bun", "run", "up", "--no-open", "--replay", "--transcript", transcript],
    {
      cwd: root,
      env: {
        ...process.env,
        FREEBOT_HOME: home,
        FREEBOT_WORKSPACE: join(home, "bots"),
        FREEBOT_PROVIDER: "replay",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let out = "";
  let err = "";
  for (const [stream, keep] of [
    [proc.stdout, (text: string) => (out += text)],
    [proc.stderr, (text: string) => (err += text)],
  ] as const) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) keep(decoder.decode(chunk));
    })();
  }
  const launched: Launched = {
    url: "",
    apiPort: 0,
    token: "",
    stdout: () => out,
    stderr: () => err,
    interrupt: () => proc.kill("SIGINT"),
    exited: () => proc.exited,
  };
  live.push(launched);
  const url = await waitForMatch(() => out, /^(http:\/\/127\.0\.0\.1:\d+\/#token=\S+)$/m, 30_000);
  const parsed = new URL(url);
  return {
    ...launched,
    url,
    apiPort: Number(parsed.port),
    token: new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token") ?? "",
  };
}

function redacted(url: string): string {
  return url.replace(/#token=.*$/, "#token=<redacted>");
}

/** One call to the oRPC route surface with the page's own token, with the request line recorded. */
async function post(
  launch: Launched,
  procedure: string,
  input: Record<string, unknown>,
): Promise<Wire> {
  const url = `http://127.0.0.1:${launch.apiPort}/rpc/${procedure}`;
  const body = JSON.stringify({ json: input });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${launch.token}`,
      origin: `http://127.0.0.1:${launch.apiPort}`,
    },
    body,
  });
  return {
    request: `POST /rpc/${procedure} authorization: Bearer <redacted> origin: http://127.0.0.1:${launch.apiPort} body=${body}`,
    status: response.status,
    body: await response.text(),
  };
}

interface RunRow {
  runId: string;
  prompt: string;
  status: RunSummary["status"];
  startedAt: number;
}

interface ThreadRow {
  threadId: string;
  botId: string;
  title: string;
  runs: RunRow[];
}

async function makeBot(
  launch: Launched,
  name: string,
): Promise<{ botId: string; threadId: string }> {
  const botAnswer = await post(launch, "create_bot", { name });
  const botId = (JSON.parse(botAnswer.body) as { json: { botId: string } }).json.botId;
  const threadAnswer = await post(launch, "create_thread", { botId });
  const threadId = (JSON.parse(threadAnswer.body) as { json: { threadId: string } }).json.threadId;
  return { botId, threadId };
}

async function threadsOf(launch: Launched, botId: string): Promise<ThreadRow[]> {
  const answer = await post(launch, "list_threads", { botId });
  return (JSON.parse(answer.body) as { json: { threads: ThreadRow[] } }).json.threads ?? [];
}

// ---------------------------------------------------------------------------
// The page's facts, read from the DOM
// ---------------------------------------------------------------------------

interface ApprovalDom {
  approval: string | null;
  state: string;
  decision: string | null;
  head: string;
  tag: string;
  dot: string;
  bar: string;
  barClass: string;
  proposal: string;
  disclosure: string;
  expanded: string | null;
  fullHidden: boolean;
  scope: string;
  expiry: string;
  buttons: string[];
  result: string | null;
}

interface ToolDom {
  call: string | null;
  status: string;
  tag: string;
  dot: string;
  command: string;
  copy: boolean;
  outputShown: boolean;
  outputOpen: boolean;
  summary: string;
  output: string;
  hint: string | null;
  finished: string | null;
}

interface TurnDom {
  phase: string;
  text: string;
  pulse: boolean;
}

interface BotDom {
  botId: string | null;
  state: string;
  name: string;
  sub: string;
  dot: string;
  selected: boolean;
  threads: string;
  nameColor: string;
}

interface ItemDom {
  approvals: ApprovalDom[];
  tools: ToolDom[];
  turns: TurnDom[];
  turnsCount: number;
  markers: Record<string, number>;
  bots: BotDom[];
  runEnd: string | null;
  error: string | null;
}

const ITEM_DOM = `(() => {
  const text = (node, selector) => node.querySelector(selector)?.textContent ?? "";
  const dotOf = (node) => node.querySelector(".dot, .pulse")?.className ?? "";
  const approvals = [...document.querySelectorAll("#thread .approval-card")].map((card) => ({
    approval: card.dataset.approval ?? null,
    state: card.dataset.state ?? "pending",
    decision: card.dataset.decision ?? null,
    head: text(card, ".ttl"),
    tag: text(card, ".tag"),
    dot: dotOf(card),
    bar: card.querySelector(".gate-bar")?.style.width ?? "",
    barClass: card.querySelector(".gate-bar")?.className ?? "",
    proposal: text(card, ".proposal"),
    disclosure: text(card, ".disc"),
    expanded: card.querySelector(".disc")?.getAttribute("aria-expanded") ?? null,
    fullHidden: card.querySelector(".codeblock")?.hidden ?? true,
    scope: text(card, ".row-between .hint"),
    expiry: text(card, ".row-between .mono"),
    buttons: [...card.querySelectorAll(".approval-actions button")].map((button) => button.textContent ?? ""),
    result: card.querySelector(".approval-result")?.textContent ?? null,
  }));
  const tools = [...document.querySelectorAll("#thread .tool-card")].map((card) => {
    const details = card.querySelector(".output-details");
    const hint = card.querySelector(".hint");
    return {
      call: card.dataset.toolCall ?? null,
      status: card.dataset.status ?? "",
      tag: text(card, ".tag"),
      dot: dotOf(card),
      command: text(card, ".codeblock .cmd"),
      copy: card.querySelector(".cb-copy") !== null,
      outputShown: details === null ? false : details.hidden === false,
      outputOpen: details === null ? false : details.open === true,
      summary: text(card, ".output-details summary"),
      output: text(card, ".output"),
      hint: hint === null || hint.hidden ? null : hint.textContent ?? "",
      finished: card.dataset.finished ?? null,
    };
  });
  const turns = [...document.querySelectorAll("#thread .tm")].map((marker) => ({
    phase: marker.dataset.phase ?? "thinking",
    text: text(marker, ".txt"),
    pulse: marker.querySelector(".pulse") !== null,
  }));
  const markers = {
    turnTitle: document.querySelectorAll("#thread .turn-title").length,
    turnEnd: document.querySelectorAll("#thread .turn-end").length,
    toolDecision: document.querySelectorAll("#thread .tool-decision").length,
    toolResult: document.querySelectorAll("#thread .tool-result").length,
    approvalResolved: document.querySelectorAll("#thread .approval-resolved").length,
    runStatus: document.querySelectorAll("#thread .run-status").length,
    grantLifecycle: document.querySelectorAll("#thread .grant-lifecycle").length,
  };
  const bots = [...document.querySelectorAll("#bot-list .sb-row")].map((row) => ({
    botId: row.dataset.bot ?? null,
    state: row.dataset.state ?? "",
    name: text(row, ".name"),
    sub: text(row, ".sub"),
    dot: dotOf(row),
    selected: row.dataset.selected === "true",
    threads: row.dataset.threads ?? "",
    nameColor: row.querySelector(".name") === null
      ? ""
      : getComputedStyle(row.querySelector(".name")).color,
  }));
  return {
    approvals,
    tools,
    turns,
    turnsCount: document.querySelectorAll("#thread .turn").length,
    markers,
    bots,
    runEnd:
      document.querySelector("#thread .run-finished")?.textContent ??
      document.querySelector("#thread .run-failed")?.textContent ??
      null,
    error: document.querySelector("#error").hidden ? null : document.querySelector("#error").textContent,
  };
})()`;

interface PageFacts {
  readonly thread: FrameFacts;
  readonly shell: ShellFacts;
  readonly dom: ItemDom;
}

async function factsOf(cdp: Cdp, page: string): Promise<PageFacts> {
  return await evaluate<PageFacts>(
    cdp,
    page,
    `({ thread: window.__threadFacts(), shell: window.__shellFacts(), dom: ${ITEM_DOM} })`,
  );
}

// ---------------------------------------------------------------------------
// The capture specs
// ---------------------------------------------------------------------------

type Check = readonly [string, unknown, unknown];

interface CaptureSpec {
  readonly name: string;
  readonly caption: string;
  readonly visible: string;
  readonly thread?: string;
  readonly bot?: number;
  readonly checks: (dom: ItemDom) => Check[];
}

const SPECS: readonly CaptureSpec[] = [
  {
    name: "01-approval-pending",
    caption:
      "An approval card waits: Approval needed, the pending tag, the 2px bar, the plain-word proposal, the disclosure, the scope and expiry row, and both answers.",
    visible: '#thread .approval-card[data-state="pending"]',
    thread: "approval-pending",
    checks: (dom) => {
      const card = dom.approvals.find((entry) => entry.state === "pending");
      return [
        [
          "approval card present once",
          card === undefined
            ? null
            : dom.approvals.filter((entry) => entry.state === "pending").length,
          1,
        ],
        ["head", card?.head, "Approval needed"],
        ["tag", card?.tag, "pending"],
        ["dot", card?.dot, "pulse"],
        ["decision attribute", card?.decision, null],
        ["bar width is set", typeof card?.bar === "string" && card.bar.endsWith("%"), true],
        [
          "proposal is plain words",
          card?.proposal,
          "A shell command that runs on this Bot's computer and can change its workspace.",
        ],
        ["disclosure label", card?.disclosure, "›View the full request"],
        ["disclosure closed by default", card?.expanded, "false"],
        ["full request hidden by default", card?.fullHidden, true],
        ["scope row", card?.scope, "Scope · this Bot's workspace · this command only"],
        ["expiry row", /^expires in \d+s$/.test(card?.expiry ?? ""), true],
        ["answers", card?.buttons, ["Allow once", "Deny"]],
      ];
    },
  },
  {
    name: "02-approval-allowed",
    caption:
      "Allowed once: the head and tag carry the decision, the bar is complete, and the buttons are replaced by the card's own sentence.",
    visible: '#thread .approval-card[data-state="allowed"]',
    thread: "approval-allowed",
    checks: (dom) => {
      const card = dom.approvals.find((entry) => entry.state === "allowed");
      return [
        ["head", card?.head, "Allowed once"],
        ["tag", card?.tag, "allowed"],
        ["dot", card?.dot, "dot on"],
        ["decision attribute", card?.decision, "allow"],
        ["no answers remain", card?.buttons, []],
        ["decision word", card?.result, "allowed once"],
        ["bar complete", card?.bar, "100%"],
      ];
    },
  },
  {
    name: "03-approval-denied",
    caption:
      "Denied: the head and tag carry the refusal, the dot is a ring, and the card says the call did not run.",
    visible: '#thread .approval-card[data-state="denied"]',
    thread: "approval-denied",
    checks: (dom) => {
      const card = dom.approvals.find((entry) => entry.state === "denied");
      return [
        ["head", card?.head, "Denied"],
        ["tag", card?.tag, "denied"],
        ["dot", card?.dot, "dot ring"],
        ["decision attribute", card?.decision, "deny"],
        ["no answers remain", card?.buttons, []],
        ["decision word", card?.result, "denied"],
      ];
    },
  },
  {
    name: "04-approval-expired",
    caption:
      "Expired: a real approval window passed unanswered, the head says Expired, and the card says the run ended before an answer.",
    visible: '#thread .approval-card[data-state="expired"]',
    thread: "approval-expired",
    checks: (dom) => {
      const card = dom.approvals.find((entry) => entry.state === "expired");
      return [
        ["head", card?.head, "Expired"],
        ["tag", card?.tag, "expired"],
        ["dot", card?.dot, "dot ring"],
        ["decision attribute", card?.decision, "expired"],
        ["no answers remain", card?.buttons, []],
        ["the window ran out", card?.expiry, "run ended unanswered"],
        ["the run failed as the timeout", dom.runEnd?.startsWith("run failed:"), true],
      ];
    },
  },
  {
    name: "05-tool-running",
    caption:
      "A tool call runs: the card says Tool call, its tag says pending, the command sits in a code block with a copy control, and no output is offered yet.",
    visible: '#thread .tool-card[data-tool-call="items-call-1"][data-status="running"]',
    thread: "tool-running",
    checks: (dom) => {
      const card = dom.tools.find((entry) => entry.call === "items-call-1");
      return [
        ["status", card?.status, "running"],
        ["tag", card?.tag, "pending"],
        ["dot", card?.dot, "pulse"],
        ["command in the code block", card?.command.includes("sleep 8"), true],
        ["copy control", card?.copy, true],
        ["no output yet", card?.outputShown, false],
      ];
    },
  },
  {
    name: "06-tool-done",
    caption:
      "A tool call finished: the tag says done, the dot is filled, and its output block opened by itself with the container's own bytes.",
    visible: '#thread .tool-card[data-tool-call="items-call-1"][data-status="done"]',
    thread: "tool-done",
    checks: (dom) => {
      const card = dom.tools.find((entry) => entry.call === "items-call-1");
      return [
        ["status", card?.status, "done"],
        ["tag", card?.tag, "done"],
        ["dot", card?.dot, "dot on"],
        ["output disclosure open", card?.outputShown, true],
        ["output block open", card?.outputOpen, true],
        ["output summary", card?.summary, "Output · 1 line"],
        ["output is the command's stdout", card?.output, "alpha\n"],
      ];
    },
  },
  {
    name: "07-tool-denied",
    caption:
      "A tool call was denied: the tag says denied, the dot is a ring, and the card says nothing ran instead of offering an output.",
    visible: '#thread .tool-card[data-tool-call="items-call-3"][data-status="denied"]',
    thread: "tool-denied",
    checks: (dom) => {
      const card = dom.tools.find((entry) => entry.call === "items-call-3");
      return [
        ["status", card?.status, "denied"],
        ["tag", card?.tag, "denied"],
        ["dot", card?.dot, "dot ring"],
        ["no output block", card?.outputShown, false],
        ["the card says nothing ran", card?.hint, "Nothing ran. This call was denied."],
      ];
    },
  },
  {
    name: "08-tool-failed",
    caption:
      "A tool call ran and failed: the command exited 7, the tag says failed, the dot is a ring, and its error output is open.",
    visible: '#thread .tool-card[data-tool-call="items-call-2"][data-status="failed"]',
    thread: "tool-failed",
    checks: (dom) => {
      const card = dom.tools.find((entry) => entry.call === "items-call-2");
      return [
        ["status", card?.status, "failed"],
        ["tag", card?.tag, "failed"],
        ["dot", card?.dot, "dot ring"],
        ["output disclosure open", card?.outputShown, true],
        ["output is the command's stderr", card?.output, "boom\n"],
      ];
    },
  },
  {
    name: "09-turn-thinking",
    caption:
      "The last turn's marker says Thinking it through, with one pulse and no separate turn-title or turn-end line.",
    visible: '#thread .tm[data-phase="thinking"]',
    thread: "turn-thinking",
    checks: (dom) => {
      const marker = dom.turns.find((entry) => entry.phase === "thinking");
      return [
        ["phase", marker?.phase, "thinking"],
        ["text", marker?.text, "Thinking it through"],
        ["pulse", marker?.pulse, true],
        ["one marker per turn", dom.turns.length, dom.turnsCount],
        ["no turn-title marker", dom.markers.turnTitle, 0],
        ["no turn-end marker", dom.markers.turnEnd, 0],
      ];
    },
  },
  {
    name: "10-turn-working",
    caption:
      "The turn marker said Working on your computer while the first call ran in the container.",
    visible: '#thread .tm[data-phase="working"]',
    thread: "turn-working",
    checks: (dom) => {
      const marker = dom.turns.find((entry) => entry.phase === "working");
      return [
        ["phase", marker?.phase, "working"],
        ["text", marker?.text, "Working on your computer"],
        ["pulse", marker?.pulse, true],
      ];
    },
  },
  {
    name: "11-turn-waiting",
    caption:
      "The first turn's marker says Waiting on results after the last call's result landed, and it stays there while the next turn starts its own marker.",
    visible: '#thread .tm[data-phase="waiting"]',
    thread: "turn-waiting",
    checks: (dom) => {
      const marker = dom.turns.find((entry) => entry.phase === "waiting");
      return [
        ["phase", marker?.phase, "waiting"],
        ["text", marker?.text, "Waiting on results"],
        ["pulse", marker?.pulse, true],
        ["one marker per turn", dom.turns.length, dom.turnsCount],
      ];
    },
  },
  {
    name: "12-bot-working",
    caption:
      "The Bot row pulses and says working while its run is in flight; the other Bot's row stays idle, so the status is per Bot.",
    visible: '#bot-list .sb-row[data-bot="{botId}"]',
    bot: 0,
    checks: (dom) => {
      const row = dom.bots.find((entry) => entry.name === FIRST_BOT_NAME);
      const other = dom.bots.find((entry) => entry.name === SECOND_BOT_NAME);
      return [
        ["state", row?.state, "working"],
        ["sub line", row?.sub, "working"],
        ["dot", row?.dot, "pulse"],
        ["the other Bot is idle", other?.state, "idle"],
      ];
    },
  },
  {
    name: "13-bot-needs-you",
    caption:
      "The Bot row's dot is filled and its sub line says needs you while an approval is parked.",
    visible: '#bot-list .sb-row[data-bot="{botId}"]',
    bot: 1,
    checks: (dom) => {
      const row = dom.bots.find((entry) => entry.name === FIRST_BOT_NAME);
      return [
        ["state", row?.state, "attention"],
        ["sub line", row?.sub, "needs you"],
        ["dot", row?.dot, "dot on"],
      ];
    },
  },
  {
    name: "14-bot-failed",
    caption:
      "The Bot row's dot is a ring and its name is muted after its newest run failed at the approval timeout.",
    visible: '#bot-list .sb-row[data-bot="{botId}"]',
    bot: 2,
    checks: (dom) => {
      const row = dom.bots.find((entry) => entry.name === FIRST_BOT_NAME);
      return [
        ["state", row?.state, "failed"],
        ["sub line", row?.sub, "failed"],
        ["dot", row?.dot, "dot ring"],
        ["name is muted", row?.nameColor, "rgb(115, 115, 115)"],
      ];
    },
  },
  {
    name: "15-bot-idle",
    caption:
      "The Bot row's dot is empty and its sub line falls back to the record once its newest run finished.",
    visible: '#bot-list .sb-row[data-bot="{botId}"]',
    bot: 3,
    checks: (dom) => {
      const row = dom.bots.find((entry) => entry.name === FIRST_BOT_NAME);
      return [
        ["state", row?.state, "idle"],
        ["sub line falls back to the role", row?.sub, ""],
        ["dot", row?.dot, "dot"],
      ];
    },
  },
];

function specFor(name: string): CaptureSpec {
  const spec = SPECS.find((entry) => entry.name === name);
  if (spec === undefined) throw new Error(`no capture spec named ${name}`);
  return spec;
}

function threadSpecFor(name: string): (typeof ITEM_SPECS)[number] {
  const spec = ITEM_SPECS.find((entry) => entry.name === name);
  if (spec === undefined) throw new Error(`no item spec named ${name}`);
  return spec;
}

// ---------------------------------------------------------------------------
// The driver's log and artifact
// ---------------------------------------------------------------------------

class Log {
  readonly lines: string[] = [];
  #passed = 0;
  #failed = 0;

  section(name: string): void {
    this.lines.push("", `## ${name}`);
  }

  note(text: string): void {
    this.lines.push(text);
  }

  check(desc: string, actual: unknown, expected: unknown): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) this.#passed += 1;
    else this.#failed += 1;
    const tail = ok ? "" : ` (expected ${JSON.stringify(expected)})`;
    this.lines.push(`${ok ? "ok" : "FAIL"} - ${desc}: ${JSON.stringify(actual)}${tail}`);
  }

  fail(desc: string, error: unknown): void {
    this.#failed += 1;
    this.lines.push(`FAIL - ${desc}: ${error instanceof Error ? error.message : String(error)}`);
  }

  get passed(): number {
    return this.#passed;
  }

  get failed(): number {
    return this.#failed;
  }

  result(): string {
    const total = this.#passed + this.#failed;
    return `RESULT: ${this.#failed === 0 ? "PASS" : "FAIL"} (${this.#passed}/${total})`;
  }
}

const log = new Log();
let headerLines: string[] = [];
let artifactsDir = "";
const made: string[] = [];

function shortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

/** Write the artifact, refusing one that carries an operator token or a key-shaped literal. */
function writeArtifact(): string | null {
  const text = [...headerLines, ...log.lines, "", log.result(), ""].join("\n");
  for (const launched of live) {
    if (launched.token !== "" && text.includes(launched.token)) {
      console.error("refusing to write an artifact that contains the operator token");
      return null;
    }
  }
  const shaped = /FREEBOT_BYOK_KEY=\S{8,}/.exec(text);
  if (shaped !== null) {
    console.error("refusing to write an artifact that carries a key-shaped literal");
    return null;
  }
  const path = join(artifactsDir, "assert.txt");
  writeFileSync(path, text);
  return path;
}

async function cleanup(): Promise<void> {
  for (const launched of live) launched.interrupt();
  await Promise.race([
    Promise.allSettled(live.map((launched) => launched.exited())),
    sleep(20_000),
  ]);
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
}

type VisibleBox = { count: number; offscreen: number };

function visibleBox(cdp: Cdp, page: string, selector: string): Promise<VisibleBox> {
  return evaluate<VisibleBox>(
    cdp,
    page,
    `(() => {
      const rects = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .map((node) => node.getBoundingClientRect());
      return {
        count: rects.length,
        offscreen: rects.filter((rect) =>
          rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth
        ).length,
      };
    })()`,
  );
}

async function capture(
  cdp: Cdp,
  page: string,
  name: string,
  launch: Launched,
  botId: string,
  botRole: string,
): Promise<void> {
  const spec = specFor(name);
  const visible = spec.visible.replace("{botId}", botId);
  await evaluate(
    cdp,
    page,
    `document.querySelectorAll(${JSON.stringify(visible)})[0]?.scrollIntoView({ block: 'center' })`,
  );
  await settle(cdp, page);
  const before = await factsOf(cdp, page);
  const box = await visibleBox(cdp, page, visible);
  const shot = await screenshot(cdp, page);
  const file = `${name}.png`;
  writeFileSync(join(artifactsDir, file), shot);
  const after = await factsOf(cdp, page);

  log.check(
    `frame ${name}: the page held still across the capture`,
    JSON.stringify(before),
    JSON.stringify(after),
  );
  log.check(
    `frame ${name}: the element the caption is about is inside the captured pixels (${visible})`,
    [box.count > 0, box.offscreen],
    [true, 0],
  );
  if (spec.thread !== undefined) {
    const threadSpec = threadSpecFor(spec.thread);
    for (const claim of unmetClaims(threadSpec, after.thread)) {
      log.check(`frame ${name}: claim - ${claim}`, false, true);
    }
    log.check(`frame ${name}: every item claim holds`, unmetClaims(threadSpec, after.thread), []);
  }
  if (spec.bot !== undefined) {
    const botSpec = BOT_ITEM_SPECS[spec.bot];
    if (botSpec === undefined) throw new Error(`no Bot item spec at ${spec.bot}`);
    log.check(`frame ${name}: claim - ${botSpec.caption}`, botSpec.holds(after.shell, botId), true);
  }
  for (const [label, actual, expected] of spec.checks(after.dom)) {
    log.check(`frame ${name}: ${label}`, actual, expected);
  }
  log.note(
    `frame ${name}: ${file} (${shot.byteLength} bytes, sha256 ${createHash("sha256").update(shot).digest("hex")}) - ${describeFacts(after.thread)} - ${describeItems(after.thread)}`,
  );
  log.note(`  the Bot row: ${JSON.stringify(after.dom.bots)}`);
  log.note(`  the approval cards: ${JSON.stringify(after.dom.approvals)}`);
  log.note(`  the tool cards: ${JSON.stringify(after.dom.tools)}`);

  // The status proof: the run record and the row's DOM are read together, and the derivation the
  // page uses is evaluated on the record. A label would not survive this comparison.
  const threads = await threadsOf(launch, botId);
  const runs = threads.flatMap((thread) => thread.runs);
  const derived = deriveBotStatus(runs);
  const row = after.dom.bots.find((entry) => entry.botId === botId);
  log.note(
    `  status proof: record runs ${JSON.stringify(runs.map((run) => [run.runId, run.status]))} -> ${derived}; row ${JSON.stringify(row)}`,
  );
  log.check(`frame ${name}: the run record derives the row's status`, derived, row?.state);
  log.check(
    `frame ${name}: the row's sub line follows the derivation`,
    row?.sub,
    botSubLabel(derived, botRole),
  );
  log.check(`frame ${name}: the row's dot follows the derivation`, row?.dot, botDotClass(derived));
  log.note(
    `  the status the record derives: ${derived} (${botSubLabel(derived, botRole) || "role fallback"})`,
  );
  log.check(`frame ${name}: the Bot is the one this driver made`, row?.botId, botId);
}

// ---------------------------------------------------------------------------
// The page's controls
// ---------------------------------------------------------------------------

function startRun(cdp: Cdp, page: string, prompt: string): Promise<void> {
  return evaluate(
    cdp,
    page,
    `(() => {
      const input = document.querySelector('#prompt');
      input.value = ${JSON.stringify(prompt)};
      document.querySelector('#start').click();
    })()`,
  );
}

function clickPending(cdp: Cdp, page: string, button: string): Promise<void> {
  return evaluate(
    cdp,
    page,
    `document.querySelector('#thread .approval-card[data-state="pending"] ${button}').click()`,
  );
}

const PENDING = `document.querySelectorAll('#thread .approval-card[data-state="pending"]').length === 1`;

async function main(): Promise<number> {
  const sha = shortSha();
  const full = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
  const branch = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    .stdout.toString()
    .trim();
  artifactsDir = join(root, "packages", "verify", "artifacts", "items", sha);
  rmSync(artifactsDir, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });

  const home = realpathSync(mkdtempSync(join(tmpdir(), "freebot-items-")));
  made.push(home);
  const transcript = writeTranscript(home);

  headerLines = [
    "feature: items",
    "command: bun packages/verify/scripts/items.ts",
    `timestamp: ${new Date().toISOString()}`,
    `git sha: ${full}`,
    `git sha short: ${sha}`,
    `branch: ${branch}`,
    `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
    `the transcript this run replayed: ${transcript}`,
    `the home and bots root this driver made: ${home}`,
    "",
  ];
  log.note("# items live-ui frames");
  log.note(
    "DRIVER DISCLOSURE: `bun run up --no-open --replay` is spawned over a temporary FREEBOT_HOME and bots root, with a Pi transcript this driver writes. The three `bash` calls in that transcript are the scripted model turns; each executes in a real container from the pinned image. The vault file is a placeholder in the temporary home, and --replay means no request reads it. Both `allow` answers and the `deny` answer are clicked on the page's own approval card. The expired card is a real 120s approval window nobody answered, which fails the run at `approval_timeout`. That state is run under a second launch over the same bots root, because the grant ledger is per process and a consumed grant refuses the same action hash as `grant_consumed` rather than parking it again; the first launch is SIGINTed and its Bots and transcript come back. No key value is read, printed or written to the artifact.",
  );

  const launched = await launch(home, transcript);
  let activeLaunch = launched;
  log.note(`the printed URL, redacted: ${redacted(launched.url)}`);
  const botsLine = await waitForMatch(
    () => launched.stderr(),
    /^(freebot up: bots under .*)$/m,
    30_000,
  );
  log.note(`the launcher's line: ${botsLine}`);
  log.check(
    "the launcher holds this driver's bots root",
    botsLine,
    `freebot up: bots under ${join(home, "bots")}; each Bot's workspace is mounted at /workspace and kept across runs`,
  );
  const modelLine = await waitForMatch(
    () => launched.stderr(),
    /^(freebot up: model mode .*)$/m,
    30_000,
  );
  log.note(`the launcher's line: ${modelLine}`);
  log.check(
    "the launcher is replaying, not billing a provider",
    modelLine.includes("keyless, replaying"),
    true,
  );

  const first = await makeBot(launched, FIRST_BOT_NAME);
  const secondBot = await makeBot(launched, SECOND_BOT_NAME);
  log.note(`the two Bots this driver made: ${JSON.stringify([first, secondBot])}`);

  const chrome = await launchChrome({ windowSize: "1440,900" });
  const cdp = chrome.cdp;
  log.note(`cdp: ${cdp.version}, headless, a dynamic DevToolsActivePort`);

  let page = "";
  try {
    page = await openPage(cdp, launched.url);
    await setViewport(cdp, page, 1440, 900);
    await waitFor(cdp, page, "the shell hook", `typeof window.__shellFacts === 'function'`);
    await waitFor(cdp, page, "the thread hook", `typeof window.__threadFacts === 'function'`);
    await waitFor(
      cdp,
      page,
      "the page to read both Bots and connect",
      `window.__shellFacts().bots.length === 2 && document.querySelector('#conn').textContent === 'connected'`,
    );
    log.note(
      `the page's shell: ${JSON.stringify(await evaluate(cdp, page, "window.__shellFacts()"))}`,
    );

    log.section("the first run: a park, an allow, a done call, a failure, a denial");
    await startRun(
      cdp,
      page,
      "Run the three scripted calls, one after another, and report when they are done.",
    );
    await waitFor(cdp, page, "the first parked approval", PENDING, 60_000);

    // The disclosure is the card's own, and it opens the exact command.
    await evaluate(
      cdp,
      page,
      `document.querySelector('#thread .approval-card[data-state="pending"] .disc').click()`,
    );
    log.check(
      "the disclosure opens the full request",
      await evaluate(
        cdp,
        page,
        `(() => {
          const card = document.querySelector('#thread .approval-card[data-state="pending"]');
          return [card.querySelector('.disc').getAttribute('aria-expanded'), card.querySelector('.codeblock').hidden];
        })()`,
      ),
      ["true", false],
    );
    await evaluate(
      cdp,
      page,
      `document.querySelector('#thread .approval-card[data-state="pending"] .disc').click()`,
    );

    await capture(cdp, page, "01-approval-pending", launched, first.botId, "");
    await capture(cdp, page, "13-bot-needs-you", launched, first.botId, "");

    await clickPending(cdp, page, ".allow-once");
    await waitFor(
      cdp,
      page,
      "the first card allowed and its call running",
      `document.querySelector('#thread .approval-card[data-state="allowed"]') !== null && document.querySelector('#thread .tool-card[data-tool-call="items-call-1"][data-status="running"]') !== null`,
      30_000,
    );
    await capture(cdp, page, "02-approval-allowed", launched, first.botId, "");
    await capture(cdp, page, "05-tool-running", launched, first.botId, "");
    await capture(cdp, page, "10-turn-working", launched, first.botId, "");
    await capture(cdp, page, "12-bot-working", launched, first.botId, "");

    await waitFor(
      cdp,
      page,
      "the first call's result",
      `document.querySelector('#thread .tool-card[data-tool-call="items-call-1"][data-status="done"]') !== null`,
      60_000,
    );
    await capture(cdp, page, "06-tool-done", launched, first.botId, "");

    await waitFor(cdp, page, "the second parked approval", PENDING, 60_000);
    await clickPending(cdp, page, ".allow-once");
    await waitFor(
      cdp,
      page,
      "the second call's failure",
      `document.querySelector('#thread .tool-card[data-tool-call="items-call-2"][data-status="failed"]') !== null`,
      60_000,
    );
    await capture(cdp, page, "08-tool-failed", launched, first.botId, "");

    await waitFor(cdp, page, "the third parked approval", PENDING, 60_000);
    await clickPending(cdp, page, ".deny");
    await waitFor(
      cdp,
      page,
      "the third call's denial and the run's end",
      `document.querySelector('#thread .tool-card[data-tool-call="items-call-3"][data-status="denied"]') !== null && document.querySelector('#thread .run-finished') !== null`,
      60_000,
    );
    await capture(cdp, page, "03-approval-denied", launched, first.botId, "");
    await capture(cdp, page, "07-tool-denied", launched, first.botId, "");
    await waitFor(
      cdp,
      page,
      "the Bot row back to idle from the record",
      `document.querySelector('#bot-list .sb-row[data-bot="${first.botId}"][data-state="idle"]') !== null`,
      30_000,
    );
    await capture(cdp, page, "09-turn-thinking", launched, first.botId, "");
    await capture(cdp, page, "11-turn-waiting", launched, first.botId, "");
    await capture(cdp, page, "15-bot-idle", launched, first.botId, "");

    log.section("a second launch: the same bots root, a fresh grant ledger");
    // A grant is per process and a consumed grant refuses the same action hash with
    // `grant_consumed` rather than parking again. The expired state therefore needs a fresh launch;
    // the Bots, their threads and run-1's transcript come back from the same bots root.
    launched.interrupt();
    const firstCode = await launched.exited();
    log.check("the first launch exits zero on SIGINT", firstCode, 0);
    const second = await launch(home, transcript);
    activeLaunch = second;
    log.note(`the second printed URL, redacted: ${redacted(second.url)}`);
    const secondBotsLine = await waitForMatch(
      () => second.stderr(),
      /^(freebot up: bots under .*)$/m,
      30_000,
    );
    log.check(
      "the second launch holds the same bots root",
      secondBotsLine,
      `freebot up: bots under ${join(home, "bots")}; each Bot's workspace is mounted at /workspace and kept across runs`,
    );
    page = await openPage(cdp, second.url);
    await setViewport(cdp, page, 1440, 900);
    await waitFor(
      cdp,
      page,
      "the restarted shell hook",
      `typeof window.__shellFacts === 'function'`,
    );
    await waitFor(
      cdp,
      page,
      "the restarted page to read both Bots and connect",
      `window.__shellFacts().bots.length === 2 && document.querySelector('#conn').textContent === 'connected'`,
    );
    log.check(
      "the first run came back with the thread",
      (await threadsOf(second, first.botId))
        .flatMap((thread) => thread.runs)
        .map((run) => [run.runId, run.status]),
      [["run-1", "done"]],
    );

    log.section("the second run: a real approval window nobody answers");
    await startRun(
      cdp,
      page,
      "Run the scripted calls again, and leave the first approval unanswered.",
    );
    await waitFor(cdp, page, "the second run's parked approval", PENDING, 60_000);
    await waitFor(
      cdp,
      page,
      "the approval window to expire and the run to fail",
      `document.querySelector('#thread .approval-card[data-state="expired"]') !== null && document.querySelector('#thread .run-failed') !== null`,
      200_000,
    );
    await waitFor(
      cdp,
      page,
      "the Bot row failed from the record",
      `document.querySelector('#bot-list .sb-row[data-bot="${first.botId}"][data-state="failed"]') !== null`,
      30_000,
    );
    await capture(cdp, page, "04-approval-expired", second, first.botId, "");
    await capture(cdp, page, "14-bot-failed", second, first.botId, "");

    const final = await factsOf(cdp, page);
    log.check("every removed marker line is absent from the whole transcript", final.dom.markers, {
      turnTitle: 0,
      turnEnd: 0,
      toolDecision: 0,
      toolResult: 0,
      approvalResolved: 0,
      runStatus: 0,
      grantLifecycle: 0,
    });
    log.check("the page raised no error", final.dom.error, null);
    log.check(
      "both Bots are still listed, with the second untouched by the first's runs",
      final.shell.bots.map((bot) => [bot.name, bot.status]),
      [
        [FIRST_BOT_NAME, "failed"],
        [SECOND_BOT_NAME, "idle"],
      ],
    );
    log.check(
      "the status proof for the other Bot reads its own empty run set",
      deriveBotStatus((await threadsOf(second, secondBot.botId)).flatMap((thread) => thread.runs)),
      "idle",
    );
  } catch (error) {
    log.fail("the driver run", error);
    const failure = await factsOf(cdp, page).catch(() => null);
    log.note(`the page at failure: ${JSON.stringify(failure)}`);
    log.note(`the launcher stderr tail: ${activeLaunch.stderr().slice(-3000)}`);
    console.error(error);
    console.error(`launcher stderr tail:\n${activeLaunch.stderr().slice(-3000)}`);
  } finally {
    chrome.stop();
  }

  const path = writeArtifact();
  if (path !== null) console.log(`artifact: ${path.replace(root, "").replace(/^\//, "")}`);
  console.log(log.result());
  return log.failed === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} finally {
  await cleanup();
}
