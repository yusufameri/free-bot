#!/usr/bin/env bun
/**
 * The keyed evidence driver: `bun run up`, a prompt typed into the page, and a real model's turn.
 *
 * The peer is the real launcher, spawned the way a person runs it, with no provider flag: the mode
 * is `auto`, so the model is the vault's and the driver proves the selection rather than asserting a
 * choice it made itself. The URL it printed is opened in headless Chrome over CDP, a prompt is typed
 * into the page's own box, the model's tool call parks at the gate, and the card is answered once
 * each way.
 *
 * The turn is proved to be the model's rather than a recording's, from three sides. The launcher's
 * request line and the model's own text and tool call are read out of the server's stderr as they
 * arrive, and nothing here composes a command. The container's own stdout is read off the page and
 * has to carry a fact a committed fixture cannot, this run's date. And the recorded transcript's
 * literal command has to be absent from the page.
 *
 * Run from the repo root: bun packages/verify/scripts/keyed-run.ts
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Capture,
  collapsedPairs,
  describeFacts,
  type FrameFacts,
  type FrameSpec,
  factsKey,
  unmetClaims,
} from "../../../packages/ui/src/index.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const root = fileURLToPath(new URL("../../..", import.meta.url));

/** The prompt the operator types. It has to make the model reach for the tool. */
const PROMPT =
  "Use the bash tool to print today's date in the sandbox, then tell me what it printed.";
const SECOND_PROMPT = "Print today's date in the sandbox with bash again, please.";

/** The committed transcript's literal call. Evidence for a live turn must not carry it. */
const RECORDED_COMMAND = "echo native-should-not-run";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type CdpReply = {
  id?: number;
  method?: string;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { message: string };
};

class Cdp {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void }
  >();
  #waiters: Array<{ predicate: (msg: CdpReply) => boolean; resolve: (msg: CdpReply) => void }> = [];
  #version = "";

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as CdpReply;
      if (typeof msg.id === "number") {
        const pending = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error !== undefined) pending?.reject(new Error(msg.error.message));
        else pending?.resolve((msg.result ?? {}) as Record<string, unknown>);
        return;
      }
      this.#waiters = this.#waiters.filter((waiter) => {
        if (!waiter.predicate(msg)) return true;
        waiter.resolve(msg);
        return false;
      });
    };
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`CDP connect failed: ${url}`));
    });
    return new Cdp(ws);
  }

  get version(): string {
    return this.#version;
  }

  async init(): Promise<void> {
    const version = await this.send<{ product: string }>("Browser.getVersion");
    this.#version = version.product;
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const id = this.#nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: Record<string, unknown>) => void, reject });
      this.#ws.send(JSON.stringify(message));
    });
  }

  once(predicate: (msg: CdpReply) => boolean, desc: string, timeoutMs = 20_000): Promise<CdpReply> {
    return new Promise<CdpReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP event timeout: ${desc}`)), timeoutMs);
      this.#waiters.push({
        predicate,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  }

  close(): void {
    this.#ws.close();
  }
}

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

async function evalJson<T>(cdp: Cdp, sessionId: string, expression: string): Promise<T> {
  const res = await cdp.send<{
    result?: { value?: unknown };
    exceptionDetails?: { text?: string };
  }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (res.exceptionDetails !== undefined) {
    throw new Error(`evaluate failed: ${res.exceptionDetails.text} :: ${expression}`);
  }
  return res.result?.value as T;
}

async function waitTrue(
  cdp: Cdp,
  sessionId: string,
  desc: string,
  expression: string,
  timeoutMs = 180_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evalJson<boolean>(cdp, sessionId, expression)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${desc}`);
}

function factsOf(cdp: Cdp, sessionId: string): Promise<FrameFacts> {
  return evalJson<FrameFacts>(cdp, sessionId, "window.__threadFacts()");
}

/** Whether the element a caption is about actually landed inside the captured pixels. */
type VisibleBox = { count: number; offscreen: number };

function captionElement(cdp: Cdp, sessionId: string, selector: string): Promise<VisibleBox> {
  return evalJson<VisibleBox>(
    cdp,
    sessionId,
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

/** The page's own DOM read, through selectors the driver holds rather than through the page's hook. */
type DomFacts = {
  frames: number;
  lastSeq: number;
  cards: string[];
  approvals: Array<string | null>;
};

function domFacts(cdp: Cdp, sessionId: string): Promise<DomFacts> {
  return evalJson<DomFacts>(
    cdp,
    sessionId,
    `({
      frames: document.querySelectorAll('#thread .frame[data-seq]').length,
      lastSeq: Math.max(0, ...[...document.querySelectorAll('#thread .frame[data-seq]')].map((node) => Number(node.dataset.seq))),
      cards: [...document.querySelectorAll('#thread .tool-card .status')].map((node) => node.textContent),
      approvals: [...document.querySelectorAll('#thread .approval-card')].map((card) => card.dataset.decision ?? null),
    })`,
  );
}

const TEXT = `[...document.querySelectorAll('#thread .delta')].map((node) => node.textContent).join("")`;
const WAITING = `[...document.querySelectorAll('#thread .approval-card')].filter((card) => (card.dataset.decision ?? null) === null)`;
const SETTLED = `window.__threadFacts().done === true || document.querySelector('#thread .run-failed') !== null`;

/**
 * The four committed states. Each caption's claims are predicates over the facts read from the live
 * DOM at capture time, so a caption naming a state the frame does not show fails the run.
 */
const SPECS: readonly FrameSpec[] = [
  {
    name: "01-armed",
    caption:
      "The URL the launcher printed, opened: the real engine is connected, the vault's model is selected, and the prompt box is the way in.",
    claims: [
      { label: "no message is rendered", holds: (f) => f.frameCount === 0 },
      { label: "the run has not finished", holds: (f) => !f.done },
      { label: "no approval is pending", holds: (f) => f.approvals.length === 0 },
    ],
    visible: "#operator",
  },
  {
    name: "02-parked",
    caption:
      "A prompt typed into the page parked at the gate: the approval card names the command the live model asked for, and the governed card waits for the answer.",
    claims: [
      {
        label: "an approval card is waiting",
        holds: (f) => f.approvals.some((decision) => decision === null),
      },
      {
        label: "the governed card waits for the answer",
        holds: (f) => f.cards.some(([, status]) => status === "awaiting approval"),
      },
      { label: "the run has not finished", holds: (f) => !f.done },
      { label: "one rendered message per seq", holds: (f) => f.frameCount === f.lastSeq },
    ],
    visible: "#thread .approval-card",
  },
  {
    name: "03-finished",
    caption:
      "Allowed once, then finished: the card shows the allow, the call ran in the container so its output block holds that container's own stdout, and the model's closing turn is on the page.",
    claims: [
      {
        label: "the approval card shows the allow decision",
        holds: (f) => f.approvals.includes("allow"),
      },
      {
        label: "a tool card is done with its output open",
        holds: (f) =>
          f.cards.some(([, status]) => status === "done") && f.outputShown.every((shown) => shown),
      },
      { label: "the run reported done", holds: (f) => f.done },
      { label: "the terminal marker is rendered", holds: (f) => f.streamEnd === "stream complete" },
      { label: "one rendered message per seq", holds: (f) => f.frameCount === f.lastSeq },
    ],
    visible: "#thread .run-finished",
  },
  {
    name: "04-denied",
    caption:
      "A second launch, denied: the same page and the same engine on a free port of its own, where the refusal is recorded as user_denied and no command runs.",
    claims: [
      {
        label: "the approval card shows the deny decision",
        holds: (f) => f.approvals.includes("deny"),
      },
      {
        label: "a tool card shows denied with no output",
        holds: (f) =>
          f.cards.some(([, status]) => status === "denied") &&
          f.outputShown.every((shown) => !shown),
      },
      { label: "one rendered message per seq", holds: (f) => f.frameCount === f.lastSeq },
    ],
    visible: "#thread .approval-card",
  },
];

function specFor(name: string): FrameSpec {
  const spec = SPECS.find((entry) => entry.name === name);
  if (spec === undefined) throw new Error(`no frame spec named ${name}`);
  return spec;
}

let artifactsDir = "";

async function capture(cdp: Cdp, sessionId: string, name: string, log: Log): Promise<Capture> {
  const spec = specFor(name);
  await evalJson(
    cdp,
    sessionId,
    `document.querySelectorAll(${JSON.stringify(spec.visible)})[0]?.scrollIntoView({ block: 'center' })`,
  );
  const before = await factsOf(cdp, sessionId);
  const box = await captionElement(cdp, sessionId, spec.visible);
  const shot = await cdp.send<{ data: string }>(
    "Page.captureScreenshot",
    { format: "png" },
    sessionId,
  );
  const buffer = Buffer.from(shot.data, "base64");
  const file = `${name}.png`;
  writeFileSync(join(artifactsDir, file), buffer);
  const after = await factsOf(cdp, sessionId);
  const dom = await domFacts(cdp, sessionId);

  log.check(
    `frame ${name}: the page held still across the capture`,
    factsKey(before),
    factsKey(after),
  );
  log.check(
    `frame ${name}: the element the caption is about is inside the captured pixels (${spec.visible})`,
    [box.count > 0, box.offscreen],
    [true, 0],
  );
  log.check(
    `frame ${name}: the driver's own DOM read agrees with the page's facts hook`,
    [dom.frames, dom.lastSeq, dom.cards, dom.approvals],
    [after.frameCount, after.lastSeq, after.cards.map(([, status]) => status), after.approvals],
  );
  for (const claim of spec.claims) {
    log.check(`frame ${name}: claim - ${claim.label}`, claim.holds(after), true);
  }
  log.note(
    `frame ${name}: ${file} (${buffer.byteLength} bytes, sha256 ${createHash("sha256").update(buffer).digest("hex")}) - ${describeFacts(after)}`,
  );
  return { name, file, bytes: buffer.byteLength, sha256: "", facts: after };
}

// ---------------------------------------------------------------------------
// The launched command
// ---------------------------------------------------------------------------

interface Launched {
  readonly url: string;
  readonly apiPort: number;
  readonly tunnelPort: number;
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

/** `bun run up --no-open`, as a person runs it, with no provider flag: the mode is `auto`. */
async function launch(): Promise<Launched> {
  const proc = Bun.spawn(["bun", "run", "up", "--no-open"], {
    cwd: root,
    env: { ...process.env, FREEBOT_WORKSPACE: launchBotsRoot() },
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
  const launched: Launched = {
    url: "",
    apiPort: 0,
    tunnelPort: 0,
    token: "",
    stdout: () => out,
    stderr: () => err,
    interrupt: () => {
      proc.kill("SIGINT");
    },
    exited: () => proc.exited,
  };
  live.push(launched);
  const url = await waitForMatch(() => out, /^(http:\/\/127\.0\.0\.1:\d+\/#token=\S+)$/m, 30_000);
  const parsed = new URL(url);
  const tunnelPort = Number(await waitForMatch(() => err, /tunnel on 127\.0\.0\.1:(\d+)/, 30_000));
  return {
    ...launched,
    url,
    apiPort: Number(parsed.port),
    tunnelPort,
    token: new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token") ?? "",
  };
}

function redacted(url: string): string {
  return url.replace(/#token=.*$/, "#token=<redacted>");
}

/** One page-stream handshake, so the artifact shows the stream was gated and then allowed. */
/** One call to the route surface with the launch's own token, for the records a stream needs. */
async function rpc(
  launch: Launched,
  procedure: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${launch.apiPort}/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${launch.token}`,
      origin: `http://127.0.0.1:${launch.apiPort}`,
    },
    body: JSON.stringify({ json: input }),
  });
  return ((await response.json()) as { json: unknown }).json;
}

/** A Bot and a thread of this launch's own, made the way a page makes them. */
async function streamTarget(launch: Launched): Promise<string> {
  const bot = (await rpc(launch, "create_bot", { name: "Stream Check" })) as { botId: string };
  const thread = (await rpc(launch, "create_thread", { botId: bot.botId })) as {
    threadId: string;
  };
  return thread.threadId;
}

async function handshake(url: string): Promise<"open" | "refused"> {
  const socket = new WebSocket(url);
  const outcome = await new Promise<"open" | "refused">((resolve) => {
    socket.addEventListener("open", () => resolve("open"));
    socket.addEventListener("error", () => resolve("refused"));
    socket.addEventListener("close", () => resolve("refused"));
    setTimeout(() => resolve("refused"), 5_000);
  });
  if (outcome === "open") socket.close();
  return outcome;
}

// ---------------------------------------------------------------------------
// Docker, read-only, label-scoped to the containers this repo's runs create
// ---------------------------------------------------------------------------

function dockerNames(filters: readonly string[]): string[] {
  const proc = Bun.spawnSync([
    "docker",
    "ps",
    "-a",
    ...filters.flatMap((filter) => ["--filter", filter]),
    "--format",
    "{{.Names}}",
  ]);
  const raw = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
  return raw === ""
    ? []
    : raw
        .split("\n")
        .filter((name) => name !== "")
        .sort();
}

function runContainers(): string[] {
  return dockerNames(["label=freebot.unit=u1.7", "label=freebot.provider=docker"]);
}

function containersNamed(name: string): string[] {
  return dockerNames([`name=^${name}$`]);
}

function listeners(port: number): string[] {
  const proc = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  const raw = proc.stdout.toString().trim();
  return raw === ""
    ? []
    : raw
        .split("\n")
        .slice(1)
        .map((line) => line.split(/\s+/)[0] ?? "");
}

function shortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

async function settles(predicate: () => boolean, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(200);
  }
  return predicate();
}

const added = (before: readonly string[], after: readonly string[]): string[] =>
  after.filter((name) => !before.includes(name));

// ---------------------------------------------------------------------------
// The click
// ---------------------------------------------------------------------------

async function openPage(cdp: Cdp, url: string): Promise<string> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  const loaded = cdp.once(
    (msg) => msg.sessionId === sessionId && msg.method === "Page.loadEventFired",
    "page load",
  );
  await cdp.send("Page.navigate", { url }, sessionId);
  await loaded;
  await waitTrue(cdp, sessionId, "the thread hook", `typeof window.__threadFacts === 'function'`);
  return sessionId;
}

async function startRun(cdp: Cdp, sessionId: string, prompt: string): Promise<void> {
  await evalJson(
    cdp,
    sessionId,
    `(() => {
      const input = document.querySelector('#prompt');
      input.value = ${JSON.stringify(prompt)};
      document.querySelector('#start').click();
    })()`,
  );
}

/** Open the URL a launch printed and assert the page it lands on is an armed operator page. */
async function openArmed(cdp: Cdp, log: Log, launch: Launched, label: string): Promise<string> {
  const sessionId = await openPage(cdp, launch.url);
  await waitTrue(
    cdp,
    sessionId,
    `${label}: the page to connect`,
    `document.querySelector('#conn').textContent === 'connected' && window.__threadFacts().frameCount === 0`,
  );
  log.check(
    `${label}: the page is the URL the launcher printed, token in the fragment and never sent to a server`,
    await evalJson(
      cdp,
      sessionId,
      `({ scheme: location.protocol, host: location.host, fragmentKey: location.hash.slice(0, 7), search: location.search })`,
    ),
    { scheme: "http:", host: `127.0.0.1:${launch.apiPort}`, fragmentKey: "#token=", search: "" },
  );
  log.check(
    `${label}: operator mode is on, so the prompt box is the way in`,
    await evalJson(cdp, sessionId, "document.querySelector('#operator').hidden"),
    false,
  );
  return sessionId;
}

/** What the page shows for the parked call, read off the DOM. */
interface ParkedView {
  /** The tool call the approval is about, which is the page's own id for it. */
  readonly callId: string;
  /** `bash ` plus the model's own arguments, as the card renders them. */
  readonly command: string;
  readonly buttons: string[];
  readonly statusFrames: number;
  /** The assistant text on the page when the run parked. */
  readonly text: string;
}

/** Type the prompt, wait for the park, and read what the page says about it. */
async function parkRun(
  cdp: Cdp,
  log: Log,
  page: string,
  label: string,
  prompt: string,
): Promise<ParkedView> {
  await startRun(cdp, page, prompt);
  await waitTrue(cdp, page, `${label}: the parked approval`, `${WAITING}.length >= 1`);
  const view = await evalJson<ParkedView>(
    cdp,
    page,
    `(() => {
      const card = ${WAITING}[0];
      const callId = card.dataset.approval.replace(/^.*:/, '');
      const tool = document.querySelector('#thread .tool-card[data-tool-call="' + callId + '"]');
      return {
        callId,
        command: tool.querySelector('.cmd').textContent,
        buttons: [...card.querySelectorAll('button')].map((button) => button.textContent),
        statusFrames: document.querySelectorAll('#thread .run-status[data-run-status="awaiting_approval"]').length,
        text: ${TEXT},
      };
    })()`,
  );

  log.check(`${label}: the run is the one the page started`, await runIdOf(cdp, page), "run run-1");
  log.check(
    `${label}: the prompt the page sent is the run's prompt`,
    await evalJson(
      cdp,
      page,
      `[...document.querySelectorAll('#thread .message.user .prompt')].at(-1).textContent`,
    ),
    prompt,
  );
  log.check(`${label}: the buttons are the two real answers`, view.buttons, ["Allow once", "Deny"]);
  log.check(
    `${label}: the run's own status frame is rendered, so a parked run does not look frozen`,
    view.statusFrames,
    1,
  );
  log.check(
    `${label}: the parked command is a bash call and is not the committed transcript's`,
    [view.command.startsWith("bash "), view.command.includes(RECORDED_COMMAND)],
    [true, false],
  );
  log.note(`${label}: the card's command, read off the page: ${view.command}`);
  log.note(`${label}: the assistant text before the park: ${JSON.stringify(view.text)}`);
  return view;
}

function runIdOf(cdp: Cdp, page: string): Promise<string> {
  return evalJson<string>(cdp, page, "document.querySelector('#run').textContent");
}

/** Answer every card the run parks on, one at a time, until it settles. */
async function answerUntilSettled(
  cdp: Cdp,
  log: Log,
  page: string,
  label: string,
  decision: "allow" | "deny",
  timeoutMs = 180_000,
): Promise<string[]> {
  const sent: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evalJson<boolean>(cdp, page, SETTLED)) break;
    const approvalId = await evalJson<string | null>(
      cdp,
      page,
      `(() => { const card = ${WAITING}[0]; return card === undefined ? null : card.dataset.approval; })()`,
    );
    if (approvalId !== null) {
      await evalJson(
        cdp,
        page,
        `${WAITING}[0].querySelector(${JSON.stringify(decision === "allow" ? ".allow-once" : ".deny")}).click()`,
      );
      sent.push(approvalId);
      log.note(`${label}: answered ${approvalId} with ${decision}`);
    }
    await sleep(150);
  }
  await waitTrue(cdp, page, `${label}: the answered run to settle`, SETTLED);
  return sent;
}

/** What the page shows once the run settled, read off the DOM rather than from the log. */
interface SettledView {
  readonly result: string;
  readonly output: string;
  readonly text: string;
  readonly decisions: string[];
  readonly runFrames: string[];
  readonly failed: string | null;
  readonly error: string | null;
}

function settledView(cdp: Cdp, page: string): Promise<SettledView> {
  return evalJson<SettledView>(
    cdp,
    page,
    `(() => {
      const last = [...document.querySelectorAll('#thread .tool-card')].at(-1);
      return {
        result: document.querySelector('#thread .approval-card .approval-result')?.textContent ?? "",
        output: last?.querySelector('.output')?.textContent ?? "",
        text: ${TEXT},
        decisions: [...document.querySelectorAll('#thread .tool-decision')].map((node) => node.textContent),
        runFrames: [...document.querySelectorAll('#thread .run-status')].map((node) => node.textContent),
        failed: document.querySelector('#thread .run-failed')?.textContent ?? null,
        error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      };
    })()`,
  );
}

// ---------------------------------------------------------------------------
// The model's own lines, out of the server's stderr
// ---------------------------------------------------------------------------

function providerLines(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("freebot provider:"));
}

interface ToolCallLine {
  readonly id: string;
  readonly name: string;
  readonly args: string;
}

/** The first tool call the model asked for, out of the server's own per-turn line. */
function toolCallOf(lines: readonly string[]): ToolCallLine | null {
  for (const line of lines) {
    const match =
      /^freebot provider: turn \d+ tool_call (\S+) (\S+) (.*?)(?: repairs=\[.*\])?$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { id: match[1], name: match[2], args: match[3] ?? "" };
    }
  }
  return null;
}

/** One JSON object as comparable text, so two renderings of the same call compare equal. */
function normalized(json: string): string | null {
  try {
    return JSON.stringify(JSON.parse(json));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const log = new Log();
let headerLines: string[] = [];
let chromeProc: Bun.Subprocess | null = null;
let userDataDir: string | null = null;

/** Write the artifact, refusing one that carries an operator token or a key-shaped literal. */
function writeArtifact(): string | null {
  const text = [...headerLines, ...log.lines, ""].join("\n");
  for (const launch of live) {
    if (launch.token !== "" && text.includes(launch.token)) {
      console.error("refusing to write an artifact that contains the operator token");
      return null;
    }
  }
  const shaped = /FREEBOT_BYOK_KEY=\S{8,}/.exec(text);
  if (shaped !== null) {
    console.error(`refusing to write an artifact that carries a key-shaped literal: ${shaped[0]}`);
    return null;
  }
  const path = join(artifactsDir, "assert.txt");
  writeFileSync(path, text);
  return path;
}

/** Stop every launcher this driver started, so no container outlives it (order 22). */
async function cleanup(): Promise<void> {
  for (const launch of live) launch.interrupt();
  await Promise.race([Promise.allSettled(live.map((launch) => launch.exited())), sleep(20_000)]);
  chromeProc?.kill();
  if (userDataDir !== null) rmSync(userDataDir, { recursive: true, force: true });
  for (const path of botsRoots.splice(0)) rmSync(path, { recursive: true, force: true });
}

/**
 * The bots root one launch runs over: one per launch, so a launch that starts a run starts run-1
 * whatever its siblings are doing, and every root is this driver's own rather than the operator's.
 */
const botsRoots: string[] = [];

function launchBotsRoot(): string {
  const made = mkdtempSync(join(tmpdir(), "freebot-keyed-bots-"));
  botsRoots.push(made);
  return made;
}

function statSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  const sha = shortSha();
  const full = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
  const branch = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    .stdout.toString()
    .trim();
  artifactsDir = join(root, "packages", "verify", "artifacts", "keyed-run", sha);
  rmSync(artifactsDir, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });
  const year = new Date().toISOString().slice(0, 4);

  headerLines = [
    "feature: keyed-run",
    "command: bun packages/verify/scripts/keyed-run.ts",
    `timestamp: ${new Date().toISOString()}`,
    `git sha: ${full}`,
    `git sha short: ${sha}`,
    `branch: ${branch}`,
    `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
    `the year the container's own stdout is asserted to carry: ${year}`,
    "",
  ];
  log.note("# keyed-run live-ui frames");
  log.note(
    "DRIVER DISCLOSURE: the launcher is spawned as `bun run up --no-open`, with no provider flag, so the mode is `auto` and the model is whatever the vault selects. The prompt is typed into the page's own box. The model's request line, its text and its tool call are read out of the server's stderr, and the container's stdout is read off the page.",
  );

  const baseline = runContainers();
  log.note(
    `containers before the first run (label freebot.unit=u1.7): ${baseline.length}${baseline.length === 0 ? "" : ` (${baseline.join(", ")})`}`,
  );

  log.section("the launcher's own provider choice");
  const first = await launch();
  log.note(`the printed URL, redacted: ${redacted(first.url)}`);
  const choiceLine = await waitForMatch(
    () => first.stderr(),
    /^(freebot up: model mode .*)$/m,
    30_000,
  );
  log.note(`the launcher's line: ${choiceLine}`);
  log.check(
    "the launcher selected the keyed path from the vault, with no flag asking for it",
    [choiceLine.includes("model mode auto"), choiceLine.includes("(key from the vault)")],
    [true, true],
  );
  log.check(
    "and named the vault's endpoint and model, and never the key's name or value",
    [
      choiceLine.includes("via api.commandcode.ai"),
      choiceLine.includes("model deepseek/"),
      choiceLine.includes("FREEBOT_BYOK_KEY"),
    ],
    [true, true, false],
  );
  const vaultLine = await waitForMatch(() => first.stderr(), /^(freebot up: vault .*)$/m, 30_000);
  log.note(`the launcher's vault line: ${vaultLine}`);
  log.check(
    "the vault it read is present, so the keyed path is the real one",
    vaultLine.includes("present"),
    true,
  );

  const events = `ws://127.0.0.1:${first.apiPort}/events`;
  const threadId = await streamTarget(first);
  log.note(`the thread the page's stream follows: ${threadId}`);
  log.check("a page stream with no token is refused", await handshake(events), "refused");
  log.check(
    "a page stream with the URL's own token and a real thread is accepted",
    await handshake(`${events}?token=${first.token}&thread_id=${threadId}`),
    "open",
  );

  userDataDir = join(tmpdir(), `freebot-keyed-${Date.now()}`);
  mkdirSync(userDataDir, { recursive: true });
  chromeProc = Bun.spawn(
    [
      CHROME,
      "--headless",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--mute-audio",
      "--hide-scrollbars",
      "--window-size=1280,1400",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const portFile = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 20_000;
  while (!statSafe(portFile)) {
    if (Date.now() > deadline) throw new Error("Chrome did not write DevToolsActivePort");
    await sleep(100);
  }
  const [port = "", wsPath = ""] = (await Bun.file(portFile).text()).split("\n");
  let cdp: Cdp | null = null;
  for (let attempt = 0; attempt < 20 && cdp === null; attempt++) {
    try {
      cdp = await Cdp.connect(`ws://127.0.0.1:${port}${wsPath}`);
    } catch {
      await sleep(250);
    }
  }
  if (cdp === null) throw new Error("could not attach CDP to Chrome");
  await cdp.init();
  log.note(
    `cdp: ${cdp.version}, headless, remote debugging on the DevToolsActivePort file (dynamic)`,
  );

  const captures: Capture[] = [];

  log.section("the prompt typed into the page, parked at the gate");
  const firstPage = await openArmed(cdp, log, first, "first launch");
  captures.push(await capture(cdp, firstPage, "01-armed", log));
  const parked = await parkRun(cdp, log, firstPage, "first launch", PROMPT);
  const parkedSet = runContainers();
  const parkedLive = added(baseline, parkedSet);
  log.check(
    "the parked run holds one live container, this launch's own",
    [parkedLive.length, parkedSet.length],
    [1, baseline.length + 1],
  );
  log.note(`containers while the run is parked: ${parkedSet.length} (${parkedLive.join(", ")})`);
  captures.push(await capture(cdp, firstPage, "02-parked", log));

  log.section("the request the app made, and the model's own answer");
  const turns = providerLines(first.stderr());
  for (const line of turns) log.note(`provider stderr: ${line}`);
  const requestLine = turns.find((line) => line.includes(" request POST "));
  log.check(
    "the app posted to the vault's endpoint with the vault's model id, and never printed the key",
    requestLine === undefined
      ? null
      : {
          endpoint: /request POST (\S+)/.exec(requestLine)?.[1] ?? null,
          model: /model=(\S+)/.exec(requestLine)?.[1] ?? null,
          messages: /messages=(\S+)/.exec(requestLine)?.[1] ?? null,
          tools: /tools=(\S+)/.exec(requestLine)?.[1] ?? null,
          authorization: /authorization="([^"]*)"/.exec(requestLine)?.[1] ?? null,
        },
    {
      endpoint: "https://api.commandcode.ai/provider/v1/chat/completions",
      model: "deepseek/deepseek-v4.1-flash",
      messages: "2",
      tools: "bash",
      authorization: "Bearer <redacted>",
    },
  );
  const call = toolCallOf(turns);
  log.note(
    `the model's own tool call, as the server read it off the wire: ${JSON.stringify(call)}`,
  );
  log.note(
    `the model's own text line: ${turns.find((line) => / turn 1 text /.test(line)) ?? "(the first turn carried no text)"}`,
  );
  log.note(
    `the turn's end, with the provider's own usage: ${turns.find((line) => / turn \d+ done /.test(line)) ?? "(no turn line)"}`,
  );
  log.check(
    "the call the model asked for is a bash call, and it is the call the human was asked about",
    call === null
      ? null
      : [
          call.name,
          normalized(call.args) !== null &&
            normalized(call.args) === normalized(parked.command.slice("bash ".length)),
        ],
    ["bash", true],
  );

  log.section("allowed once: the container's own stdout, and the model's closing turn");
  await answerUntilSettled(cdp, log, firstPage, "first launch", "allow");
  const answered = await settledView(cdp, firstPage);
  const laterTurns = providerLines(first.stderr()).filter((line) => !turns.includes(line));
  for (const line of laterTurns) log.note(`provider stderr after the allow: ${line}`);
  log.check(
    "the model answered the result on the wire with text of its own, in a later turn",
    laterTurns.some((line) => / turn \d+ text /.test(line)),
    true,
  );
  log.note(`the run's status frames: ${JSON.stringify(answered.runFrames)}`);
  log.note(`the decision markers: ${JSON.stringify(answered.decisions)}`);
  log.note(`the governance result on the card: ${JSON.stringify(answered.result)}`);
  log.note(`the container's own stdout: ${JSON.stringify(answered.output)}`);
  log.note(`the assistant text on the page: ${JSON.stringify(answered.text)}`);
  log.check("the allowed run failed nowhere", [answered.failed, answered.error], [null, null]);
  log.check(
    "the run reported done",
    [answered.runFrames.includes("run done"), answered.failed],
    [true, null],
  );
  log.check("the card shows the allow the human gave", answered.result, "allowed once");
  log.check(
    "the governed call ran: its decision is an allow",
    answered.decisions.some((line) => line.endsWith(": allow")),
    true,
  );
  log.check(
    "the output block holds the container's own stdout, and not the committed transcript's",
    [
      answered.output.length > 0,
      answered.output.includes(RECORDED_COMMAND),
      answered.output.includes(year),
    ],
    [true, false, true],
  );
  log.check(
    "the model closed the run with text of its own, which no recording can produce for this run",
    answered.text.length > 0,
    true,
  );
  captures.push(await capture(cdp, firstPage, "03-finished", log));

  log.section("a second launch, denied");
  const second = await launch();
  log.check(
    "the second launch took a page port of its own",
    second.apiPort !== first.apiPort,
    true,
  );
  // A Bot and a thread of this launch's own, over the route a page uses: its bots root is fresh, and
  // a store with no Bot opens the first-run screen rather than the app (U6.2).
  const secondThread = await streamTarget(second);
  log.note(`the second launch's own thread: ${secondThread}`);
  const secondPage = await openArmed(cdp, log, second, "second launch");
  await parkRun(cdp, log, secondPage, "second launch", SECOND_PROMPT);
  await answerUntilSettled(cdp, log, secondPage, "second launch", "deny");
  const denied = await settledView(cdp, secondPage);
  log.note(`the denial's decision markers: ${JSON.stringify(denied.decisions)}`);
  log.note(`the container's stdout for the denied call: ${JSON.stringify(denied.output)}`);
  log.check("the card shows the deny the human gave", denied.result, "denied");
  log.check(
    "the refusal is named user_denied and no command ran",
    [denied.decisions.some((line) => line.endsWith(": deny (user_denied)")), denied.output],
    [true, ""],
  );
  captures.push(await capture(cdp, secondPage, "04-denied", log));

  log.section("shutdown, and the containers this driver created");
  for (const [launch, label] of [
    [second, "the second launch"],
    [first, "the first launch"],
  ] as const) {
    launch.interrupt();
    const code = await launch.exited();
    log.check(`${label}: exits zero on SIGINT`, code, 0);
    const named = [...launch.stderr().matchAll(/removed sandbox (\S+) \(/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );
    log.note(`${label}: removed ${named.length} container(s): ${named.join(", ") || "(none)"}`);
    log.check(
      `${label}: every container it says it removed is gone from Docker`,
      named.flatMap((name) => containersNamed(name)),
      [],
    );
  }
  log.check(
    "the label's container set is back where it started",
    await settles(() => JSON.stringify(runContainers()) === JSON.stringify(baseline)),
    true,
  );
  log.check("nothing listens on the first launch's page port", listeners(first.apiPort), []);

  cdp.close();
  chromeProc.kill();

  log.section("pairwise distinctness of the committed frames");
  log.check(
    "frames: every committed frame differs from every other in its page facts",
    collapsedPairs(captures),
    [],
  );

  log.section("frame index");
  log.note("name -> asserted DOM facts -> caption");
  for (const spec of SPECS) {
    const found = captures.find((entry) => entry.name === spec.name);
    if (found === undefined) {
      log.fail(`frame index ${spec.name}`, "no capture was taken");
      continue;
    }
    log.note(`${spec.name} -> ${describeFacts(found.facts)} -> ${spec.caption}`);
    log.note(`  unmet claims: ${JSON.stringify(unmetClaims(spec, found.facts))}`);
  }

  log.section("the committed artifact carries no token and no key");
  const onDisk = readdirSync(artifactsDir).sort();
  log.check("frames: one committed PNG per key state", onDisk.length, SPECS.length);
  for (const file of onDisk) {
    log.note(`artifact: ${file} (${statSync(join(artifactsDir, file)).size} bytes)`);
  }
  const report = log.lines.join("\n");
  log.check(
    "no committed line carries any launch's operator token",
    [report.includes(first.token), report.includes(second.token)],
    [false, false],
  );
  log.check(
    "no committed line carries a key-shaped literal",
    /FREEBOT_BYOK_KEY=\S{8,}/.test(report),
    false,
  );

  log.lines.push("");
  log.lines.push(
    `chrome ${CHROME.split("/").at(-1)} over CDP; really launched \`bun run up --no-open\`; the model is the vault's keyed provider; containers from the pinned image`,
  );
  log.lines.push(log.result());

  const written = writeArtifact();
  console.log(
    log.lines.filter((line) => line.includes("RESULT") || line.startsWith("FAIL")).join("\n"),
  );
  console.log(`assert.txt: ${written ?? "(refused)"}`);
  console.log(`frames: ${artifactsDir}`);
  return log.failed === 0 ? 0 : 1;
}

try {
  const code = await main();
  await cleanup();
  process.exit(code);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`driver crashed: ${message}`);
  log.fail("driver crashed before the run finished", message);
  if (artifactsDir !== "") {
    const written = writeArtifact();
    if (written !== null) console.error(`assert.txt (partial, crashed): ${written}`);
  }
  await cleanup();
  process.exit(1);
}
