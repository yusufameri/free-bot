#!/usr/bin/env bun
/**
 * The restart evidence driver: a thread's conversation survives `bun run up` stopping and starting.
 *
 * A really launched `bun run up --no-open --replay` is the peer, over a `FREEBOT_HOME` and bots root
 * this driver made, with its own placeholder vault so the page opens on the shell rather than the
 * provider screen. The driver opens the URL the launcher printed in headless Chrome over CDP, types
 * a prompt into the page's own composer, answers the approval card on the page, and watches the run
 * reach its terminal frame. Then it stops the launcher with SIGINT and starts a second one over the
 * same home, and reads the same conversation off the page again: the frames came back from
 * `<botsRoot>/<botId>/threads/<threadId>/transcript.jsonl`, one `{"seq":N,"frame":{...}}` line per
 * frame, and the next run's first frame continues that seq space.
 *
 * The four launches are the four claims. A drives a run to done from the page and leaves a torn last
 * line in the transcript; B replays it (dropping and repairing the torn line, starting run 2 after
 * the hydrated tail) and is stopped while run 2 waits at the gate; C shows that interrupted run as
 * `failed`, at the taxonomy's own `server_restart`, with the card it left behind closed; D boots the
 * same home once more and appends nothing, because the ending is already in the transcript. A fifth
 * launch over a home with no transcript is the negative control: the thread shows the empty state
 * and there is no file, and one run driven from that page writes one.
 *
 * The model is the committed replay transcript, because this driver's subject is the restart and a
 * recorded turn keeps the parked state deterministic (order 9). Nothing is billed, no key is read,
 * and the placeholder vault's fake key is never printed or committed.
 *
 * Run from the repo root: bun packages/verify/scripts/transcript-restart.ts
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRunCommand } from "@freebot/core";
import {
  type Cdp,
  evaluate,
  launchChrome,
  openPage,
  screenshot,
  settle,
  sleep,
  waitFor,
} from "../src/cdp.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const feature = "transcript-restart";

/** The unit label the launcher's containers carry, from `apps/server/src/run-ports.ts`. */
const RUN_UNIT = "u1.7";

const PROMPT = "run one gated command";
const SECOND_PROMPT = "run one gated command, after the restart";
const LIVE_PROMPT = "run one gated command, on a home with no transcript";
const COMMAND = 'bash {"command":"echo native-should-not-run"}';
const OUTPUT = "native-should-not-run\n";
/** The copy the taxonomy carries for `server_restart`, from `packages/core/src/run-errors.ts`. */
const RESTART_COPY = "FreeBot stopped while this run was in flight.";
const EMPTY_NOTE = "Waiting for the run to start.";

let artifactsDir = "";
const lines: string[] = [];
let checks = 0;
let failures = 0;

function say(text: string): void {
  lines.push(text);
  console.log(text);
}

function check(name: string, actual: unknown, expected: unknown): void {
  checks += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  say(
    ok
      ? `PASS ${name}: ${JSON.stringify(actual)}`
      : `FAIL ${name}: ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`,
  );
}

function shell(command: string[]): string {
  const proc = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  return `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
}

function docker(args: string[]): string {
  return shell(["docker", ...args]);
}

function containersWith(filters: string[]): string[] {
  const raw = docker([
    "ps",
    "-a",
    ...filters.flatMap((filter) => ["--filter", filter]),
    "--format",
    "{{.Names}}",
  ]);
  return raw === ""
    ? []
    : raw
        .split("\n")
        .filter((name) => name.length > 0)
        .sort();
}

function runContainers(): string[] {
  return containersWith([`label=freebot.unit=${RUN_UNIT}`, "label=freebot.provider=docker"]);
}

async function settles(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(150);
  }
  return predicate();
}

/** One home this driver made: the vault and the bots root the launches over it share. */
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "freebot-transcript-home-"));
  writeFileSync(
    join(dir, "provider.env"),
    [
      `# This driver's own placeholder vault, in a temporary directory: ${dir}`,
      "# Nothing here is a real credential, and the runs replay so no request is made.",
      `FREEBOT_BYOK_KEY=transcript-${Date.now()}`,
      "FREEBOT_BYOK_BASE_URL=http://127.0.0.1:9/transcript-not-a-provider",
      "FREEBOT_BYOK_MODEL=transcript-placeholder",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return dir;
}

interface Launched {
  readonly url: string;
  readonly apiPort: number;
  readonly token: string;
  readonly home: string;
  /** The bots root the launcher's own line says it opened, so a check can compare it with this one. */
  readonly botsRoot: string;
  stdout(): string;
  stderr(): string;
  interrupt(): void;
  exited(): Promise<number>;
}

async function waitForMatch(read: () => string, match: RegExp, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = match.exec(read());
    if (found?.[1] !== undefined) return found[1];
    await sleep(25);
  }
  throw new Error(`no line matching ${match} within ${timeoutMs}ms; saw:\n${read().slice(-1500)}`);
}

/** `bun run up --no-open --replay`, over the home it is given. */
async function launch(where: string): Promise<Launched> {
  const botsRoot = join(where, "bots");
  const proc = Bun.spawn(["bun", "run", "up", "--no-open", "--replay"], {
    cwd: root,
    env: { ...process.env, FREEBOT_HOME: where, FREEBOT_WORKSPACE: botsRoot },
    stdout: "pipe",
    stderr: "pipe",
  });
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
  const url = await waitForMatch(() => out, /^(http:\/\/127\.0\.0\.1:\d+\/#token=\S+)$/m, 30_000);
  const announced = await waitForMatch(() => err, /^freebot up: bots under (.+?);/m, 30_000);
  const parsed = new URL(url);
  return {
    url,
    apiPort: Number(parsed.port),
    token: new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token") ?? "",
    home: where,
    botsRoot: announced,
    stdout: () => out,
    stderr: () => err,
    interrupt: () => {
      proc.kill("SIGINT");
    },
    exited: () => proc.exited,
  };
}

function redacted(url: string): string {
  return url.replace(/#token=.*$/, "#token=<redacted>");
}

async function rpc(
  app: Launched,
  procedure: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${app.apiPort}/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${app.token}`,
      origin: `http://127.0.0.1:${app.apiPort}`,
    },
    body: JSON.stringify({ json: input }),
  });
  return ((await response.json()) as { json: unknown }).json;
}

/** Stop a launch the way a person stops it, and report what it left behind. */
async function interrupt(app: Launched, label: string): Promise<number> {
  app.interrupt();
  const code = await app.exited();
  const removed = [...app.stderr().matchAll(/removed sandbox (\S+) \(/g)].length;
  say(`${label}: SIGINT, exit ${code}, it announced removing ${removed} sandbox(es)`);
  return code;
}

// ---------------------------------------------------------------------------
// The page's facts, read from the DOM
// ---------------------------------------------------------------------------

interface RestartFacts {
  readonly frameCount: number;
  readonly lastSeq: number;
  readonly duplicatesIgnored: number;
  readonly prompts: string[];
  readonly toolCards: Array<{ call: string; status: string; output: string; shown: boolean }>;
  readonly runStatus: string | null;
  readonly renderedSeqs: number[];
  readonly duplicateSeqs: number[];
  readonly runFailed: string[];
  readonly finished: string | null;
  readonly header: {
    readonly run: string | null;
    readonly runId: string | null;
    readonly status: string | null;
    readonly lastSeq: number;
    readonly dups: string | null;
  };
  readonly approvals: Array<{
    readonly decision: string | null;
    readonly result: string | null;
    readonly buttons: number;
    readonly answerButtons: number;
    readonly disabled: number;
  }>;
  readonly idle: { readonly hidden: boolean; readonly text: string };
  readonly error: string;
  readonly text: string;
}

function facts(cdp: Cdp, page: string): Promise<RestartFacts> {
  return evaluate<RestartFacts>(
    cdp,
    page,
    `(() => {
      const frames = [...document.querySelectorAll('#thread .frame[data-seq]')];
      const run = document.querySelector('#run');
      const idle = document.querySelector('#idle-note');
      const renderedSeqs = frames.map((node) => Number(node.dataset.seq));
      const seen = new Set();
      const duplicateSeqs = [];
      for (const seq of renderedSeqs) {
        if (seen.has(seq)) duplicateSeqs.push(seq);
        else seen.add(seq);
      }
      return {
        frameCount: frames.length,
        lastSeq: Number(document.querySelector('#lastseq').dataset.lastSeq),
        duplicatesIgnored: Number(document.querySelector('#dups').dataset.duplicatesIgnored),
        prompts: [...document.querySelectorAll('#thread .message.user .prompt')].map((node) => node.textContent),
        toolCards: [...document.querySelectorAll('#thread .tool-card')].map((card) => ({
          call: card.querySelector('.cmd')?.textContent ?? '',
          status: card.dataset.status ?? '',
          output: card.querySelector('.output')?.textContent ?? '',
          shown: card.querySelector('.output-details')?.hidden === false,
        })),
        // Old: '#thread .run-status' marker lines. New: '#run[data-run-status]' is the current run's status.
        runStatus: run.dataset.runStatus ?? null,
        renderedSeqs,
        duplicateSeqs,
        runFailed: [...document.querySelectorAll('#thread .run-failed')].map((node) => node.textContent),
        finished: document.querySelector('#thread .run-finished')?.textContent ?? null,
        header: {
          run: run.textContent === '' ? null : run.textContent,
          runId: run.dataset.runId ?? null,
          status: run.dataset.runStatus ?? null,
          lastSeq: Number(document.querySelector('#lastseq').dataset.lastSeq),
          dups: document.querySelector('#dups').textContent,
        },
        approvals: [...document.querySelectorAll('#thread .approval-card')].map((card) => {
          const buttons = [...card.querySelectorAll('button')];
          return {
            decision: card.dataset.decision ?? null,
            result: card.querySelector('.approval-result')?.textContent ?? null,
            buttons: buttons.length,
            answerButtons: card.querySelectorAll('.approval-actions button').length,
            disabled: buttons.filter((button) => button.disabled).length,
          };
        }),
        idle: {
          hidden: idle === null ? true : idle.hidden,
          text: idle?.textContent ?? '',
        },
        error: document.querySelector('#error').hidden ? '' : document.querySelector('#error').textContent,
        text: [...document.querySelectorAll('#thread .delta')].map((node) => node.textContent).join(''),
      };
    })()`,
  );
}

interface Spec {
  readonly name: string;
  readonly caption: string;
  readonly claims: Array<{ readonly label: string; readonly holds: (f: RestartFacts) => boolean }>;
  readonly visible: string;
}

/**
 * The four key states this unit adds. Each caption's claims are predicates over the facts read from
 * the live DOM at capture time, so a caption naming a state the frame does not show fails.
 */
const SPECS: readonly Spec[] = [
  {
    name: "01-finished-run",
    caption:
      "A run driven to done from the page before any restart: the prompt the page sent, the governed call with the container's own stdout, and the terminal frame.",
    claims: [
      { label: "the prompt that was typed is on the page", holds: (f) => f.prompts.length === 1 },
      {
        label: "the governed call ran and its output is shown",
        holds: (f) => f.toolCards.some((card) => card.status === "done" && card.shown),
      },
      {
        label: "the run reached its terminal frame",
        holds: (f) => f.finished === "stream complete",
      },
      { label: "and the page names its status", holds: (f) => f.header.status === "done" },
      {
        // Old: frameCount === lastSeq, one marker per message. New: cards coalesce messages, so every rendered frame is unique and in range.
        label: "every rendered frame has a unique seq within the stream",
        holds: (f) =>
          f.duplicateSeqs.length === 0 &&
          f.renderedSeqs.every((seq) => seq > 0 && seq <= f.lastSeq),
      },
    ],
    visible: "#thread .run-finished",
  },
  {
    name: "02-after-restart",
    caption:
      "A second launch over the same home: the finished run's transcript came back from disk, and the next run's frames continue the same seq space behind them.",
    claims: [
      {
        label: "both prompts are on the page, the hydrated one first",
        holds: (f) => f.prompts.length === 2 && f.prompts[0] === "run one gated command",
      },
      {
        label: "the replayed call kept its output",
        holds: (f) =>
          f.toolCards.length === 2 && f.toolCards[0]?.output === "native-should-not-run\n",
      },
      {
        label: "the streamed run is parked behind the hydrated frames",
        holds: (f) =>
          f.toolCards.some((card) => card.status === "awaiting approval") &&
          f.runStatus === "awaiting_approval",
      },
      {
        // Old: frameCount === lastSeq plus the run-status trail. New: unique rendered frames and the current run's element.
        label: "and its first frame continues the seq space rather than restarting it",
        holds: (f) =>
          f.duplicateSeqs.length === 0 &&
          f.renderedSeqs.every((seq) => seq > 0 && seq <= f.lastSeq) &&
          f.runStatus === "awaiting_approval",
      },
    ],
    visible: "#thread .approval-card",
  },
  {
    name: "03-interrupted-run",
    caption:
      "The third launch over that home: the run the last process left parked is shown failed, at the taxonomy's own code, and the card it left behind is closed.",
    claims: [
      {
        label: "the interrupted run is shown failed",
        holds: (f) => f.header.status === "failed",
      },
      {
        label: "with the taxonomy's own sentence",
        holds: (f) => f.runFailed.some((text) => text === `run failed: ${RESTART_COPY}`),
      },
      {
        label: "and the card that was waiting is no longer answerable",
        holds: (f) =>
          f.approvals.length === 2 &&
          f.approvals[1]?.decision === "expired" &&
          f.approvals[1]?.answerButtons === 0,
      },
      {
        label: "while the finished run the transcript brought back is untouched",
        holds: (f) => f.toolCards[0]?.status === "done" && f.finished === "stream complete",
      },
    ],
    visible: "#thread .run-failed",
  },
  {
    name: "04-empty-home",
    caption:
      "The negative control: a launch over a home with no transcript yet, which is what the page shows before anything was ever recorded.",
    claims: [
      { label: "no frame is rendered", holds: (f) => f.frameCount === 0 },
      {
        label: "the thread says it is waiting for a run",
        holds: (f) => f.idle.hidden === false && f.idle.text === "Waiting for the run to start.",
      },
      { label: "and no run or status is on the page", holds: (f) => f.header.runId === null },
      { label: "with nothing recorded yet", holds: (f) => f.lastSeq === 0 },
    ],
    visible: "#thread .idle",
  },
];

interface Capture {
  readonly name: string;
  readonly facts: RestartFacts;
}

async function capture(cdp: Cdp, page: string, name: string): Promise<Capture> {
  const spec = SPECS.find((entry) => entry.name === name);
  if (spec === undefined) throw new Error(`no frame spec named ${name}`);
  await evaluate(
    cdp,
    page,
    `document.querySelector(${JSON.stringify(spec.visible)})?.scrollIntoView({ block: 'center' })`,
  );
  await settle(cdp, page);
  const before = await facts(cdp, page);
  const box = await evaluate<{ count: number; offscreen: number }>(
    cdp,
    page,
    `(() => {
      const rects = [...document.querySelectorAll(${JSON.stringify(spec.visible)})]
        .map((node) => node.getBoundingClientRect());
      return {
        count: rects.length,
        offscreen: rects.filter((rect) =>
          rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth
        ).length,
      };
    })()`,
  );
  const buffer = await screenshot(cdp, page);
  writeFileSync(join(artifactsDir, `${name}.png`), buffer);
  const after = await facts(cdp, page);

  check(
    `frame ${name}: the page held still across the capture`,
    JSON.stringify(before),
    JSON.stringify(after),
  );
  check(
    `frame ${name}: the element the caption is about is inside the captured pixels (${spec.visible})`,
    [box.count > 0, box.offscreen],
    [true, 0],
  );
  for (const claim of spec.claims) {
    check(`frame ${name}: claim - ${claim.label}`, claim.holds(after), true);
  }
  say(
    `frame ${name}: ${name}.png (${buffer.byteLength} bytes, sha256 ${createHash("sha256").update(buffer).digest("hex")}) - ${spec.caption}`,
  );
  return { name, facts: after };
}

// ---------------------------------------------------------------------------
// The transcript, off the disk
// ---------------------------------------------------------------------------

/** The path the store writes, spelled the way `apps/server/src/run-service.ts` spells it. */
function transcriptPath(botsRoot: string, botId: string, threadId: string): string {
  return join(botsRoot, botId, "threads", threadId, "transcript.jsonl");
}

function transcriptLines(path: string): string[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return text.split("\n").filter((line) => line.length > 0);
}

/** One line of the transcript, as `TranscriptStore` writes it: the seq beside the frame. */
interface StoredLine {
  readonly seq: number;
  readonly frame: {
    readonly v: number;
    readonly seq: number;
    readonly ts: number;
    readonly runId: string;
    readonly type: string;
    readonly payload: Record<string, unknown>;
  };
}

function linesOf(path: string): StoredLine[] {
  return transcriptLines(path).map((line) => JSON.parse(line) as StoredLine);
}

/** A line's frame without its clock: the four fields the store decides plus the frame's own. */
function withoutClock(line: StoredLine | undefined): Record<string, unknown> | null {
  if (line === undefined) return null;
  const { v, seq, runId, type, payload } = line.frame;
  return { v, seq, runId, type, payload };
}

/** The run journal beside the transcript, parsed with the store's own command guard. */
function journalOf(
  botsRoot: string,
  botId: string,
  threadId: string,
): Array<{ op: string; id: string; code?: string }> {
  const path = join(botsRoot, botId, "threads", threadId, "runs.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter(isRunCommand)
    .map((command) => command as { op: string; id: string; code?: string });
}

/** One thread row of `list_threads`, as the route answers it. */
interface ListedThread {
  readonly threadId: string;
  readonly botId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly runs: Array<{
    readonly runId: string;
    readonly prompt: string;
    readonly status: string;
    readonly startedAt: number;
  }>;
}

async function listThreads(app: Launched, botId: string): Promise<ListedThread[]> {
  const answer = (await rpc(app, "list_threads", { botId })) as { threads: ListedThread[] };
  return answer.threads ?? [];
}

/** One Bot and one thread of this driver's own, over the route a page uses. */
async function openHome(app: Launched): Promise<{ botId: string; threadId: string; page: string }> {
  const bot = (await rpc(app, "create_bot", { name: "Restart Check" })) as { botId: string };
  const thread = (await rpc(app, "create_thread", { botId: bot.botId })) as { threadId: string };
  return { botId: bot.botId, threadId: thread.threadId, page: app.url };
}

/** The page of a launch, connected and showing a thread, with the operator composer armed. */
async function openArmed(cdp: Cdp, app: Launched, label: string): Promise<string> {
  const page = await openPage(cdp, app.url);
  await waitFor(
    cdp,
    page,
    "the page to connect",
    "document.querySelector('#conn').textContent === 'connected'",
  );
  await waitFor(
    cdp,
    page,
    `${label}: the operator composer`,
    "document.querySelector('#operator').hidden === false && document.querySelector('#start') !== null",
  );
  await waitFor(
    cdp,
    page,
    `${label}: the shell to open a thread`,
    "document.querySelector('#bot-title').textContent.length > 0",
  );
  return page;
}

async function startRun(cdp: Cdp, page: string, prompt: string): Promise<void> {
  await evaluate(
    cdp,
    page,
    `(() => {
      const input = document.querySelector('#prompt');
      input.value = ${JSON.stringify(prompt)};
      document.querySelector('#start').click();
    })()`,
  );
}

async function answerAllow(cdp: Cdp, page: string): Promise<void> {
  await evaluate(cdp, page, "document.querySelector('#thread .approval-card .allow-once').click()");
}

// ---------------------------------------------------------------------------
// The launches
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const sha = shell(["git", "rev-parse", "--short", "HEAD"]);
  const full = shell(["git", "rev-parse", "HEAD"]);
  const branch = shell(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  artifactsDir = join(root, "packages", "verify", "artifacts", feature, sha);
  rmSync(artifactsDir, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });

  say(`feature: ${feature}`);
  say("command: bun packages/verify/scripts/transcript-restart.ts");
  say(`timestamp: ${new Date().toISOString()}`);
  say(`git sha: ${full}`);
  say(`git sha short: ${sha}`);
  say(`branch: ${branch}`);
  say(`runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`);
  say("");

  if (Bun.spawnSync(["docker", "info"], { stdout: "pipe", stderr: "pipe" }).exitCode !== 0) {
    throw new Error("Docker is not answering; this driver needs the pinned image");
  }
  const baseline = runContainers();
  say(`containers before the runs (label freebot.unit=${RUN_UNIT}): ${baseline.length}`);

  const first = home();
  const second = home();
  /** The two homes every launch in this driver runs over. */
  const homes = [first, second];
  /** The mode the placeholder vault was written at, read while it is still on disk. */
  const vaultMode = statSync(join(first, "provider.env")).mode.toString(8).slice(-3);
  /** Every operator token the launcher printed, so the last check can search the artifact for them. */
  const tokens: string[] = [];
  /** Every file under the two homes, by content, read before `finally` removes them. */
  const scans: Array<{ file: string; text: string }> = [];

  const chrome = await launchChrome({ windowSize: "1280,1400" });
  const captures: Capture[] = [];
  try {
    // -----------------------------------------------------------------------
    // A: one run, driven to done from the page
    // -----------------------------------------------------------------------
    say("");
    say("== launch A: a run driven to done from the page");
    const a = await launch(first);
    tokens.push(a.token);
    say(`the launcher's printed URL, redacted: ${redacted(a.url)}`);
    const aThread = await openHome(a);
    const botsRootA = join(first, "bots");
    const transcript = transcriptPath(botsRootA, aThread.botId, aThread.threadId);
    say(`the transcript this driver asserts, by the path the service writes: ${transcript}`);
    check(
      "the bots root this driver asserts under is the one the launcher's own line named",
      a.botsRoot,
      botsRootA,
    );

    const aPage = await openArmed(chrome.cdp, a, "launch A");
    const empty = await facts(chrome.cdp, aPage);
    check(
      "before the first run the thread is empty and says so",
      [empty.frameCount, empty.idle.hidden, empty.idle.text],
      [0, false, EMPTY_NOTE],
    );
    check("and no transcript is on disk yet", existsSync(transcript), false);

    await startRun(chrome.cdp, aPage, PROMPT);
    await waitFor(
      chrome.cdp,
      aPage,
      "the recorded call to park at the gate",
      "[...document.querySelectorAll('#thread .approval-card')].some((card) => card.dataset.decision === undefined)",
    );
    check(
      "the page parked one governed call, waiting for an answer",
      await evaluate<string[]>(
        chrome.cdp,
        aPage,
        "[...document.querySelectorAll('#thread .tool-card')].map((node) => node.dataset.status)",
      ),
      ["awaiting approval"],
    );
    await answerAllow(chrome.cdp, aPage);
    await waitFor(
      chrome.cdp,
      aPage,
      "the run to reach its terminal status",
      "document.querySelector('#run').dataset.runStatus === 'done'",
    );
    const done = await facts(chrome.cdp, aPage);
    check("the run finished at done", done.header.status, "done");
    check("with one tool card carrying the container's own stdout", done.toolCards, [
      { call: COMMAND, status: "done", output: OUTPUT, shown: true },
    ]);
    check(
      // Old: frameCount === lastSeq, one marker per message. New: unique rendered frames within the stream's own last seq.
      "and every rendered frame is unique and inside the stream the log holds",
      [
        done.duplicateSeqs,
        done.renderedSeqs.every((seq) => seq > 0 && seq <= done.lastSeq),
        done.duplicatesIgnored,
        done.error,
      ],
      [[], true, 0, ""],
    );
    captures.push(await capture(chrome.cdp, aPage, "01-finished-run"));

    const written = linesOf(transcript);
    say(`the transcript A wrote: ${written.length} lines, keyed by botsRoot/botId/threadId`);
    say(`  the first line, verbatim: ${transcriptLines(transcript)[0] ?? "(none)"}`);
    check("the transcript is where the service says it is", existsSync(transcript), true);
    check("one line per message the stream carried", written.length, done.lastSeq);
    check(
      "the lines are one record per seq, in order, each carrying the frame",
      written.map((entry) => entry.seq),
      written.map((_entry, index) => index + 1),
    );
    check(
      "each line is a seq and a frame, and the frame is the five-key envelope the log carries",
      [Object.keys(written[0] ?? {}), Object.keys(written[0]?.frame ?? {})],
      [
        ["seq", "frame"],
        ["v", "seq", "ts", "runId", "type", "payload"],
      ],
    );
    check("the first record is the prompt the page sent", withoutClock(written[0]), {
      v: 1,
      seq: 1,
      runId: "run-1",
      type: "run.started",
      payload: { prompt: PROMPT },
    });
    check("the last record is the run's own terminal status", withoutClock(written.at(-1)), {
      v: 1,
      seq: written.length,
      runId: "run-1",
      type: "run.status",
      payload: { runId: "run-1", status: "done" },
    });
    check(
      "and every frame on the line carries the seq its envelope does",
      written.filter((entry) => entry.frame.seq !== entry.seq).map((entry) => entry.seq),
      [],
    );

    check("the first launch exits zero on SIGINT", await interrupt(a, "launch A"), 0);
    check(
      "and leaves no container under this unit's label",
      await settles(() => JSON.stringify(runContainers()) === JSON.stringify(baseline)),
      true,
    );

    // A half-written record, the shape a process that died mid-append leaves: no trailing newline.
    appendFileSync(transcript, `{"seq":${done.lastSeq + 1},"frame":{"v":1,"seq":`);
    const torn = readFileSync(transcript, "utf8");
    check(
      "the torn last line is on the disk before the next boot",
      [
        torn.endsWith("\n"),
        torn.split("\n").filter((line) => line.length > 0).length,
        torn.trimEnd().endsWith('"seq":'),
      ],
      [false, done.lastSeq + 1, true],
    );

    // -----------------------------------------------------------------------
    // B: the same home, the same conversation off the disk, and run 2 after it
    // -----------------------------------------------------------------------
    say("");
    say("== launch B: the same home, and the next run after the hydrated tail");
    const b = await launch(first);
    tokens.push(b.token);
    const bPage = await openArmed(chrome.cdp, b, "launch B");
    // Wait past the last rendered frame to the stream's final seq: the transcript ends at
    // `done.lastSeq` with the run's own `run.status` frame, which lands after the last card body,
    // so a frame-count wait alone can read the page before that ending has arrived.
    await waitFor(
      chrome.cdp,
      bPage,
      "the conversation to come back",
      `document.querySelectorAll('#thread .frame[data-seq]').length === ${done.frameCount} && Number(document.querySelector('#lastseq').dataset.lastSeq) === ${done.lastSeq} && document.querySelector('#run').dataset.runStatus === ${JSON.stringify(done.header.status)}`,
    );
    const replayed = await facts(chrome.cdp, bPage);
    check(
      "the page after the restart is the page before it, fact for fact",
      JSON.stringify(replayed),
      JSON.stringify(done),
    );
    check(
      "the torn last line was dropped and the file repaired in place",
      [transcriptLines(transcript).length, readFileSync(transcript, "utf8").endsWith("\n")],
      [done.lastSeq, true],
    );
    const exceptions = chrome.cdp.console.filter((entry) => entry.startsWith("EXCEPTION"));
    check("and no page exception was raised while hydrating", exceptions, []);

    await startRun(chrome.cdp, bPage, SECOND_PROMPT);
    await waitFor(
      chrome.cdp,
      bPage,
      "the second run to park at its gate",
      "[...document.querySelectorAll('#thread .approval-card')].filter((card) => card.dataset.decision === undefined).length === 1",
    );
    const streaming = await facts(chrome.cdp, bPage);
    check(
      "the second run's first frame continues the hydrated seq space",
      Number(
        await evaluate<string>(
          chrome.cdp,
          bPage,
          "[...document.querySelectorAll('#thread .message.user')].at(-1).dataset.seq",
        ),
      ),
      done.lastSeq + 1,
    );
    check(
      "so the page holds both runs' frames with nothing skipped and nothing replayed twice",
      [
        streaming.duplicateSeqs.length,
        streaming.renderedSeqs.every((seq) => seq > 0 && seq <= streaming.lastSeq),
        streaming.duplicatesIgnored,
        streaming.prompts,
        streaming.toolCards.map((card) => card.status),
      ],
      [0, true, 0, [PROMPT, SECOND_PROMPT], ["done", "awaiting approval"]],
    );
    check("and the run the page names is the second one", streaming.header.run, "run run-2");
    check(
      "and the file behind the page is still one line per message the stream carried",
      transcriptLines(transcript).length,
      streaming.lastSeq,
    );
    captures.push(await capture(chrome.cdp, bPage, "02-after-restart"));

    check("the second launch exits zero on SIGINT", await interrupt(b, "launch B"), 0);

    // -----------------------------------------------------------------------
    // C: the same home again, and the run B was holding when it stopped
    // -----------------------------------------------------------------------
    say("");
    say("== launch C: the run the last process left parked");
    const c = await launch(first);
    tokens.push(c.token);
    const cPage = await openArmed(chrome.cdp, c, "launch C");
    await waitFor(
      chrome.cdp,
      cPage,
      "the interrupted run to be shown failed",
      "document.querySelector('#run').dataset.runStatus === 'failed'",
    );
    const interrupted = await facts(chrome.cdp, cPage);
    check("the page names the interrupted run", interrupted.header.run, "run run-2");
    check("and shows it failed", interrupted.header.status, "failed");
    check("with the taxonomy's own sentence on the frame", interrupted.runFailed, [
      `run failed: ${RESTART_COPY}`,
    ]);
    check(
      // Old: the '#thread .run-status' trail ending failed. New: '#run[data-run-status]' plus the finished run's card.
      "the run element ends at failed, with the run the first launch finished still done",
      [interrupted.runStatus, interrupted.toolCards[0]?.status],
      ["failed", "done"],
    );
    check(
      // Old: a failed card reading 'run failed' with two disabled buttons. New: the card closes as expired with its word and no buttons.
      "the card the parked run left behind is closed, not allowed and not denied",
      interrupted.approvals,
      [
        { decision: "allow", result: "allowed once", buttons: 1, answerButtons: 0, disabled: 0 },
        { decision: "expired", result: "expired", buttons: 1, answerButtons: 0, disabled: 0 },
      ],
    );
    check(
      "the frames the transcript brought back are still there",
      [
        interrupted.toolCards[0]?.status,
        interrupted.finished,
        interrupted.prompts[0],
        interrupted.duplicateSeqs.length,
      ],
      ["done", "stream complete", PROMPT, 0],
    );
    const settled = linesOf(transcript);
    check(
      "the settlement is on the disk: the last two lines are the ending frames",
      settled.slice(-2).map((entry) => entry.frame.type),
      ["run.failed", "run.status"],
    );
    check(
      "and the ending the frames carry is the taxonomy's own copy for the code",
      settled.at(-2)?.frame.payload,
      { reason: RESTART_COPY },
    );
    check(
      "the code the interrupted run converged to is the taxonomy's, in the run's own journal",
      journalOf(botsRootA, aThread.botId, aThread.threadId)
        .filter((command) => command.code !== undefined)
        .map((command) => [command.op, command.id, command.code]),
      [["fail", "run-2", "server_restart"]],
    );
    check(
      "the records answer that the first run finished and the second did not",
      (await listThreads(c, aThread.botId))[0]?.runs.map((record) => [record.runId, record.status]),
      [
        ["run-1", "done"],
        ["run-2", "failed"],
      ],
    );
    check(
      "and the two prompts the records kept are the two the page sent",
      (await listThreads(c, aThread.botId))[0]?.runs.map((record) => record.prompt),
      [PROMPT, SECOND_PROMPT],
    );
    captures.push(await capture(chrome.cdp, cPage, "03-interrupted-run"));
    check("the third launch exits zero on SIGINT", await interrupt(c, "launch C"), 0);

    // -----------------------------------------------------------------------
    // D: the same home once more, to show the boot pass appends nothing twice
    // -----------------------------------------------------------------------
    say("");
    say("== launch D: a fourth boot over a home that was already settled");
    const before = transcriptLines(transcript).length;
    const d = await launch(first);
    tokens.push(d.token);
    const dPage = await openArmed(chrome.cdp, d, "launch D");
    // The interrupted run's last rendered frame is at seq 23 while its settled ending is the
    // `run.status` frame at `interrupted.lastSeq`; wait for that watermark and the failed status
    // the record already holds before reading the page for the second-boot comparison.
    await waitFor(
      chrome.cdp,
      dPage,
      "the settled conversation to come back",
      `document.querySelectorAll('#thread .frame[data-seq]').length === ${interrupted.frameCount} && Number(document.querySelector('#lastseq').dataset.lastSeq) === ${interrupted.lastSeq} && document.querySelector('#run').dataset.runStatus === ${JSON.stringify(interrupted.header.status)}`,
    );
    const settledAgain = await facts(chrome.cdp, dPage);
    check(
      "a second boot over the same home appends no second ending",
      [
        transcriptLines(transcript).length,
        settledAgain.runFailed.length,
        settledAgain.header.status,
      ],
      [before, 1, "failed"],
    );
    check(
      "and the interrupted run is still shown the same way",
      JSON.stringify(settledAgain),
      JSON.stringify(interrupted),
    );
    check("the fourth launch exits zero on SIGINT", await interrupt(d, "launch D"), 0);

    // -----------------------------------------------------------------------
    // E: the negative control, and live streaming on a home with no transcript
    // -----------------------------------------------------------------------
    say("");
    say("== launch E: a home with no transcript, the control");
    const e = await launch(second);
    tokens.push(e.token);
    const eThread = await openHome(e);
    const botsRootE = join(second, "bots");
    const eTranscript = transcriptPath(botsRootE, eThread.botId, eThread.threadId);
    const ePage = await openArmed(chrome.cdp, e, "launch E");
    const control = await facts(chrome.cdp, ePage);
    check(
      "a home with no transcript shows the empty state, not a replayed conversation",
      [control.frameCount, control.lastSeq, control.idle.hidden, control.idle.text],
      [0, 0, false, EMPTY_NOTE],
    );
    check("and no transcript file was created for reading it", existsSync(eTranscript), false);
    captures.push(await capture(chrome.cdp, ePage, "04-empty-home"));

    await startRun(chrome.cdp, ePage, LIVE_PROMPT);
    await waitFor(
      chrome.cdp,
      ePage,
      "the live run to park at its gate",
      "[...document.querySelectorAll('#thread .approval-card')].some((card) => card.dataset.decision === undefined)",
    );
    await answerAllow(chrome.cdp, ePage);
    await waitFor(
      chrome.cdp,
      ePage,
      "the live run to reach done",
      "document.querySelector('#run').dataset.runStatus === 'done'",
    );
    const live = await facts(chrome.cdp, ePage);
    check(
      "streaming from a page with no history is unchanged: the frames arrive, in order, once",
      [
        live.duplicateSeqs.length,
        live.renderedSeqs.every((seq) => seq > 0 && seq <= live.lastSeq),
        live.duplicatesIgnored,
        live.header.status,
        live.error,
      ],
      [0, true, 0, "done", ""],
    );
    check(
      "and the run the page drove is the one the transcript now holds",
      [transcriptLines(eTranscript).length, withoutClock(linesOf(eTranscript)[0])],
      [
        live.lastSeq,
        {
          v: 1,
          seq: 1,
          runId: "run-1",
          type: "run.started",
          payload: { prompt: LIVE_PROMPT },
        },
      ],
    );
    check("the fifth launch exits zero on SIGINT", await interrupt(e, "launch E"), 0);
    check(
      "no container under this unit's label survived any of the five launches",
      await settles(() => JSON.stringify(runContainers()) === JSON.stringify(baseline)),
      true,
    );

    say("");
    say("== pairwise distinctness of the committed frames");
    const collisions: string[] = [];
    for (let index = 0; index < captures.length; index += 1) {
      for (let other = index + 1; other < captures.length; other += 1) {
        const left = captures[index];
        const right = captures[other];
        if (left === undefined || right === undefined) continue;
        if (JSON.stringify(left.facts) === JSON.stringify(right.facts)) {
          collisions.push(`${left.name}/${right.name}`);
        }
      }
    }
    check(
      "frames: every committed frame differs from every other in its page facts",
      collisions,
      [],
    );
  } finally {
    chrome.stop();
    for (const dir of homes) {
      for (const file of walk(dir)) {
        scans.push({ file, text: readFileSync(file).toString("latin1") });
      }
      rmSync(dir, { recursive: true, force: true });
    }
    say(
      "the real vault at ~/.freebot/provider.env is never read, printed or copied by this driver; the only vaults in play are the placeholders this driver wrote under the two temporary homes, and the scan below names every file that carries one",
    );
  }

  say("");
  say("== the key scan");
  const committed = readdirSync(artifactsDir).sort();
  const scanned: Array<{ file: string; text: string }> = committed.map((file) => ({
    file,
    text: readFileSync(join(artifactsDir, file)).toString("latin1"),
  }));
  say(`scanned ${scanned.length} artifact file(s) and ${scans.length} file(s) under the two homes`);
  const vaults = homes.map((dir) => join(dir, "provider.env"));
  check(
    "the only file under this driver's homes or artifacts carrying its placeholder key is the vault it wrote",
    [...scanned, ...scans]
      .filter((entry) => /FREEBOT_BYOK_KEY=\S{8,}|transcript-\d{10,}/.test(entry.text))
      .map((entry) => entry.file)
      .sort(),
    [...vaults].sort(),
  );
  check(
    "and the store the runs wrote holds no key, and no key-shaped literal at all",
    scans
      .filter(
        (entry) =>
          entry.file.startsWith(`${first}/bots`) || entry.file.startsWith(`${second}/bots`),
      )
      .filter((entry) => /FREEBOT_BYOK_KEY|transcript-\d{10,}/.test(entry.text))
      .map((entry) => entry.file),
    [],
  );
  say(
    `the vault this driver wrote, mode ${vaultMode}, and the bots roots the runs wrote into: ${join(first, "bots")}, ${join(second, "bots")}`,
  );

  say("");
  say("== the committed files");
  for (const file of committed) {
    say(`artifact: ${file} (${statSync(join(artifactsDir, file)).size} bytes)`);
  }
  check(
    "one committed PNG per key state",
    committed.filter((file) => file.endsWith(".png")),
    SPECS.map((spec) => `${spec.name}.png`),
  );
  check(
    "and every launch printed a token, so the search below is not vacuous",
    tokens.map((token) => token.length > 0),
    tokens.map(() => true),
  );
  check(
    "and this run's own lines carry none of them",
    tokens.filter((token) => lines.join("\n").includes(token)).length,
    0,
  );

  say("");
  say(`checks: ${checks - failures}/${checks} PASS`);
  const result = `RESULT: ${failures === 0 ? "PASS" : "FAIL"} (${checks - failures}/${checks})`;
  writeFileSync(join(artifactsDir, "assert.txt"), [...lines, "", result, ""].join("\n"));
  say(`artifact: packages/verify/artifacts/${feature}/${sha}/assert.txt`);
  console.log(result);
  process.exitCode = failures === 0 ? 0 : 1;
}

/** Every file under a directory, for the key scan. */
function walk(dir: string): string[] {
  const found: string[] = [];
  const visit = (current: string): void => {
    let entries: Array<Dirent>;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else found.push(path);
    }
  };
  visit(dir);
  return found;
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  say(`FAIL driver crashed before the run finished: ${message}`);
  if (artifactsDir !== "") {
    const result = `RESULT: FAIL (${checks - failures}/${checks})`;
    writeFileSync(join(artifactsDir, "assert.txt"), [...lines, "", result, ""].join("\n"));
  }
  process.exitCode = 1;
}
