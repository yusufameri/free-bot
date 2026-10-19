#!/usr/bin/env bun
/**
 * The U4.2 evidence driver: Bots and threads as records, over a real server, with a real restart.
 *
 * The peer is the real launcher, spawned the way a person runs it, with no provider flag: the mode
 * is `auto`, so the vault's key makes a real model write the file the per-Bot proof reads back. One
 * bots root of this driver's own holds everything: the registry, each Bot's workspace and each
 * thread's run journal. The page is opened in headless Chrome over CDP and driven the way a person
 * drives it: create a Bot from the sidebar, select a thread, type a prompt, answer the approval
 * card.
 *
 * What makes this evidence rather than a fixture is the restart. The first launch creates two Bots
 * with a thread each and runs two conversations in one of them; the launch is then interrupted for
 * real, and a second launch over the same bots root has to bring every record and every run back.
 * The driver reads the list before the stop and after the start, over the route surface, and
 * compares the two as literal strings.
 *
 * Run from the repo root: bun packages/verify/scripts/bots-and-threads.ts
 */

import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { botWorkspacePath } from "../../../apps/server/src/workspace-files.ts";
import type { ShellFacts } from "../../../packages/ui/src/bots.ts";
import type { FrameFacts } from "../../../packages/ui/src/frames.ts";
import type { LibraryFacts } from "../../../packages/ui/src/library.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const root = fileURLToPath(new URL("../../..", import.meta.url));

/** The label every container this repo's runs carry, which scopes the container census (order 22). */
const UNIT_LABEL = "freebot.unit=u1.7";

/** The name of the second Bot this driver creates, and the line the model is asked to write. */
const FIRST_BOT_NAME = "Local Bot";
const SECOND_BOT_NAME = "Research";
const LINE = `freebot-u4.2 ${randomBytes(6).toString("hex")}`;

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
  /** What the page's own console and errors said, so a page that never loaded says why. */
  readonly console: string[] = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as CdpReply & {
        params?: { args?: Array<{ value?: unknown; description?: string }> };
      };
      if (typeof msg.id === "number") {
        const pending = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error !== undefined) pending?.reject(new Error(msg.error.message));
        else pending?.resolve((msg.result ?? {}) as Record<string, unknown>);
        return;
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        this.console.push(
          (msg.params?.args ?? [])
            .map((arg) => String(arg.value ?? arg.description ?? ""))
            .join(" "),
        );
      }
      if (msg.method === "Runtime.exceptionThrown") {
        this.console.push(`EXCEPTION ${JSON.stringify(msg.params)}`);
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
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evalJson<boolean>(cdp, sessionId, expression)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${desc}`);
}

// ---------------------------------------------------------------------------
// The three fact hooks, one per surface
// ---------------------------------------------------------------------------

const SHELL_FN = "window.__shellFacts";
const SHELL = "window.__shellFacts()";
const THREAD = "window.__threadFacts()";
const LIB = "window.__libraryFacts()";

interface PageFacts {
  readonly shell: ShellFacts;
  readonly thread: FrameFacts;
  readonly library: LibraryFacts;
  /** The page's error banner, or null while it is hidden. The stream failing lands here. */
  readonly error: string | null;
  /** How many runs this thread's transcript shows a terminal marker for. */
  readonly runEnds: number;
  /** How many prompts the transcript shows, which is one per run the thread has taken. */
  readonly prompts: number;
}

function factsOf(cdp: Cdp, sessionId: string): Promise<PageFacts> {
  return evalJson<PageFacts>(
    cdp,
    sessionId,
    `({
      shell: ${SHELL},
      thread: ${THREAD},
      library: ${LIB},
      error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      runEnds: document.querySelectorAll('#thread .run-finished, #thread .run-failed').length,
      prompts: document.querySelectorAll('#thread .message.user .prompt').length,
    })`,
  );
}

/** The facts a caption's claims are evaluated against, as one comparable string. */
function factsKey(facts: PageFacts): string {
  return JSON.stringify(facts);
}

/** A short description of a captured state, for the artifact's frame index. */
function describeFacts(facts: PageFacts): string {
  return [
    `bots=[${facts.shell.bots.map((bot) => `${bot.name}${bot.selected ? "*" : ""}:${bot.threadCount}`).join(" ")}]`,
    `threads=[${facts.shell.threads.map((row) => `${row.threadId}${row.selected ? "*" : ""}:${row.runs}`).join(" ")}]`,
    `selected=${facts.shell.selectedThreadId ?? "(none)"}`,
    `frames=${facts.thread.frameCount}`,
    `prompts=${facts.prompts}`,
    `library=${facts.library.state}`,
  ].join(" ");
}

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

interface FrameSpec {
  readonly name: string;
  readonly caption: string;
  readonly visible: string;
  readonly claims: ReadonlyArray<{ label: string; holds: (facts: PageFacts) => boolean }>;
}

const SPECS: readonly FrameSpec[] = [
  {
    name: "01-sidebar-first-bot",
    caption:
      "The sidebar on a server that held no Bots: this driver made `Local Bot` and its first thread over the route a page uses, and the conversation is empty behind it.",
    claims: [
      { label: "one Bot is listed", holds: (f) => f.shell.bots.length === 1 },
      {
        label: "the Bot is the one this driver made",
        holds: (f) =>
          f.shell.bots[0]?.name === FIRST_BOT_NAME && f.shell.bots[0]?.selected === true,
      },
      {
        label: "its thread is selected and holds no runs",
        holds: (f) =>
          f.shell.threads.length === 1 &&
          f.shell.threads[0]?.runs === 0 &&
          f.shell.threads[0]?.selected === true,
      },
      { label: "the transcript is empty", holds: (f) => f.thread.frameCount === 0 },
      { label: "the header names the Bot", holds: (f) => f.shell.title.startsWith(FIRST_BOT_NAME) },
    ],
    visible: "#bot-list",
  },
  {
    name: "02-bot-created",
    caption:
      "A Bot created from the sidebar's own control: the list holds two Bots, the new one is selected, and it already has a thread to talk in.",
    claims: [
      { label: "two Bots are listed", holds: (f) => f.shell.bots.length === 2 },
      {
        label: "the new Bot is the selected one",
        holds: (f) =>
          f.shell.bots.some((bot) => bot.name === SECOND_BOT_NAME && bot.selected === true),
      },
      {
        label: "its thread list is its own and holds one empty thread",
        holds: (f) => f.shell.threads.length === 1 && f.shell.threads[0]?.runs === 0,
      },
      { label: "the transcript is empty for the new Bot", holds: (f) => f.thread.frameCount === 0 },
    ],
    visible: "#bot-list",
  },
  {
    name: "03-thread-run",
    caption:
      "A run in the first Bot's thread: the model's write call was answered, the card closed as done, and the file it wrote is in this Bot's workspace.",
    claims: [
      { label: "the thread is the one that ran", holds: (f) => f.shell.threads[0]?.runs === 1 },
      { label: "the run reached its end", holds: (f) => f.thread.done === true },
      {
        label: "the governed call is done, on the card that parked it",
        holds: (f) =>
          f.thread.cards.length > 0 && f.thread.cards.every(([, status]) => status === "done"),
      },
      { label: "the approval was answered", holds: (f) => f.thread.approvals.includes("allow") },
      {
        label: "the model's own closing sentence is on the page",
        holds: (f) => f.thread.deltas.length > 0,
      },
      { label: "no refusal is on the page", holds: (f) => f.error === null },
    ],
    visible: "#thread .tool-card",
  },
  {
    name: "04-second-run",
    caption:
      "A second run in the same thread: the conversation appends to the one that was there, and the thread's own count is two.",
    claims: [
      { label: "the thread holds two runs", holds: (f) => f.shell.threads[0]?.runs === 2 },
      { label: "the transcript shows both prompts", holds: (f) => f.prompts === 2 },
      { label: "both runs left their terminal marker", holds: (f) => f.runEnds === 2 },
      { label: "the second run's text is on the page", holds: (f) => f.thread.deltas.length > 1 },
    ],
    visible: "#thread .message.user",
  },
  {
    name: "05-other-thread",
    caption:
      "A second thread in the same Bot: the list holds both, the new one is selected, and its transcript is empty rather than the other thread's.",
    claims: [
      { label: "the Bot holds two threads", holds: (f) => f.shell.threads.length === 2 },
      {
        label: "the empty one is selected and the ran one is not",
        holds: (f) =>
          f.shell.threads.filter((row) => row.selected)[0]?.runs === 0 &&
          f.shell.threads.some((row) => row.runs === 2),
      },
      { label: "the transcript is empty for it", holds: (f) => f.thread.frameCount === 0 },
      {
        label: "the header names the Bot and its thread",
        holds: (f) => f.shell.title.includes("·"),
      },
    ],
    visible: "#thread-list",
  },
  {
    name: "06-other-bot-library",
    caption:
      "The second Bot's Library, with the first Bot's workspace holding the file the model wrote: this Bot's workspace is its own and holds nothing.",
    claims: [
      { label: "the Library tab is open", holds: (f) => f.library.tab === "library" },
      {
        label: "the other Bot is the selected one",
        holds: (f) =>
          f.shell.bots.some((bot) => bot.name === SECOND_BOT_NAME && bot.selected === true),
      },
      { label: "its workspace is empty", holds: (f) => f.library.state === "empty" },
      {
        label: "no entry is listed and nothing was refused",
        holds: (f) => f.library.entries.length === 0 && f.library.refused === null,
      },
    ],
    visible: "#library-list",
  },
  {
    name: "07-after-restart",
    caption:
      "A second launch over the same bots root: both Bots are still listed with their threads, and the thread that ran still holds its two runs.",
    claims: [
      { label: "both Bots came back", holds: (f) => f.shell.bots.length === 2 },
      {
        label: "the second Bot is still there",
        holds: (f) => f.shell.bots.some((bot) => bot.name === SECOND_BOT_NAME),
      },
      {
        label: "the selected Bot's threads came back with their runs",
        holds: (f) => f.shell.threads.some((row) => row.runs === 2),
      },
      {
        label: "the header still names the Bot that is open",
        holds: (f) => f.shell.title.startsWith(FIRST_BOT_NAME),
      },
    ],
    visible: "#thread-list",
  },
];

function specFor(name: string): FrameSpec {
  const spec = SPECS.find((entry) => entry.name === name);
  if (spec === undefined) throw new Error(`no frame spec named ${name}`);
  return spec;
}

let artifactsDir = "";

async function capture(cdp: Cdp, sessionId: string, name: string, log: Log): Promise<PageFacts> {
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
  for (const claim of spec.claims) {
    log.check(`frame ${name}: claim - ${claim.label}`, claim.holds(after), true);
  }
  log.note(
    `frame ${name}: ${file} (${buffer.byteLength} bytes, sha256 ${createHash("sha256").update(buffer).digest("hex")}) - ${describeFacts(after)}`,
  );
  return after;
}

// ---------------------------------------------------------------------------
// The launched command
// ---------------------------------------------------------------------------

/**
 * A Bot and a thread of this driver's own, made the way a page makes them. A store with no Bot opens
 * the first-run screen now, and this driver's subject is the shell over a bots root it made, so the
 * two records are made here before any page opens.
 */
async function makeFirstBot(
  launch: Launched,
  name: string,
): Promise<{ botId: string; threadId: string }> {
  const botAnswer = await post(launch, "create_bot", { name });
  const botId = (JSON.parse(botAnswer.body) as { json: { botId: string } }).json.botId;
  const threadAnswer = await post(launch, "create_thread", { botId });
  const threadId = (JSON.parse(threadAnswer.body) as { json: { threadId: string } }).json.threadId;
  return { botId, threadId };
}

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

/** `bun run up --no-open`, as a person runs it, over the bots root this driver made. */
async function launch(botsRoot: string): Promise<Launched> {
  const proc = Bun.spawn(["bun", "run", "up", "--no-open"], {
    cwd: root,
    env: { ...process.env, FREEBOT_WORKSPACE: botsRoot },
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
  return dockerNames([`label=${UNIT_LABEL}`, "label=freebot.provider=docker"]);
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

// ---------------------------------------------------------------------------
// The page
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
  try {
    await waitTrue(cdp, sessionId, "the shell hook", `typeof ${SHELL_FN} === 'function'`, 30_000);
  } catch (error) {
    // A page whose module never ran says so through the console, not through the DOM.
    console.error(`the page never exposed its shell hook; console: ${cdp.console.join(" | ")}`);
    console.error(
      `readyState ${await evalJson<string>(cdp, sessionId, "document.readyState")}, hooks ${JSON.stringify(
        await evalJson<unknown>(
          cdp,
          sessionId,
          `({ shell: typeof window.__shellFacts, thread: typeof window.__threadFacts, library: typeof window.__libraryFacts })`,
        ),
      )}`,
    );
    throw error;
  }
  return sessionId;
}

function clickSelector(cdp: Cdp, sessionId: string, selector: string): Promise<void> {
  return evalJson(cdp, sessionId, `document.querySelector(${JSON.stringify(selector)}).click()`);
}

function clickExpression(cdp: Cdp, sessionId: string, expression: string): Promise<void> {
  return evalJson(cdp, sessionId, `${expression}.click()`);
}

/**
 * The end of one run, counted rather than observed: a thread that has already run holds a finished
 * marker, so "a run ended" is an increment over the count this run started from, not a marker's
 * presence. Without the count a second run in one thread looks settled the moment it starts.
 */
const ENDS = `#thread .run-finished, #thread .run-failed`;

function endedAfter(baseline: number): string {
  return `document.querySelectorAll(${JSON.stringify(ENDS)}).length > ${baseline}`;
}

async function ends(cdp: Cdp, page: string): Promise<number> {
  return await evalJson<number>(
    cdp,
    page,
    `document.querySelectorAll(${JSON.stringify(ENDS)}).length`,
  );
}
const CONNECTED = `document.querySelector('#conn').textContent === 'connected'`;

/**
 * A selection the page has finished making. The Bot row's click handler is asynchronous, so the
 * ids and the open socket are the only things that say the move is done: `#conn` reads `connecting`
 * from the moment the new socket is made until it opens, and the mirror the page sends runs from
 * reads the same selection.
 */
function settledOn(botId: string, threadId: string): string {
  return `${SHELL}.selectedBotId === ${JSON.stringify(botId)} && ${SHELL}.selectedThreadId === ${JSON.stringify(threadId)} && ${CONNECTED}`;
}
const WAITING = `[...document.querySelectorAll('#thread .approval-card')].filter((card) => (card.dataset.decision ?? null) === null)`;

/** Answer every card the run parks on, one at a time, until it settles. */
async function answerUntilSettled(
  cdp: Cdp,
  log: Log,
  page: string,
  decision: "allow" | "deny",
  baseline: number,
  timeoutMs = 180_000,
): Promise<string[]> {
  const sent: string[] = [];
  const settled = endedAfter(baseline);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evalJson<boolean>(cdp, page, settled)) break;
    const approvalId = await evalJson<string | null>(
      cdp,
      page,
      `(() => { const card = ${WAITING}[0]; return card === undefined ? null : card.dataset.approval; })()`,
    );
    if (approvalId !== null) {
      await clickExpression(
        cdp,
        page,
        `${WAITING}[0].querySelector(${JSON.stringify(decision === "allow" ? ".allow-once" : ".deny")})`,
      );
      sent.push(approvalId);
      log.note(`answered ${approvalId} with ${decision}`);
    }
    await sleep(150);
  }
  await waitTrue(cdp, page, "the answered run to settle", settled);
  return sent;
}

/** What the page and the server say when a run does not do what the driver asked it to. */
async function dumpState(cdp: Cdp, page: string, launch: Launched | null): Promise<string> {
  const facts = await factsOf(cdp, page).catch(() => null);
  const dom = await evalJson<unknown>(
    cdp,
    page,
    `({
      conn: document.querySelector('#conn').textContent,
      error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
      startDisabled: document.querySelector('#start').disabled,
      frames: document.querySelectorAll('#thread .frame[data-seq]').length,
    })`,
  ).catch(() => null);
  return [
    `shell ${JSON.stringify(facts?.shell ?? null)}`,
    `thread ${JSON.stringify(facts?.thread ?? null)}`,
    `dom ${JSON.stringify(dom)}`,
    `launcher stderr tail: ${launch === null ? "(none)" : launch.stderr().slice(-800)}`,
  ].join("\n  ");
}

/** Type a prompt into the page's own box and wait for the run to reach its end. */
async function runPrompt(
  cdp: Cdp,
  log: Log,
  page: string,
  prompt: string,
  options: {
    answer?: "allow" | null;
    before?: number;
    ends?: number;
    launch?: Launched | null;
  } = {},
): Promise<void> {
  const before = options.before ?? (await factsOf(cdp, page)).thread.frameCount;
  const baseline = options.ends ?? (await ends(cdp, page));
  await evalJson(
    cdp,
    page,
    `(() => {
      const input = document.querySelector('#prompt');
      input.value = ${JSON.stringify(prompt)};
      document.querySelector('#start').click();
    })()`,
  );
  if (options.answer === "allow") {
    // Either the run parks at the gate, which is what this driver answers, or it ends without
    // parking: the second case is a run whose model asked for nothing, and it fails here loudly
    // rather than after a timeout, with the page's own state recorded.
    try {
      await waitTrue(
        cdp,
        page,
        "the parked approval",
        `${WAITING}.length >= 1 || ${endedAfter(baseline)}`,
      );
    } catch (error) {
      log.note(
        `the run never parked; the page said:\n  ${await dumpState(cdp, page, options.launch ?? null)}`,
      );
      throw error;
    }
    if (await evalJson<boolean>(cdp, page, endedAfter(baseline))) {
      const state = await factsOf(cdp, page);
      log.note(
        `the run ended without parking: cards ${JSON.stringify(state.thread.cards)}, text ${JSON.stringify(state.thread.deltas.join(""))}, error ${JSON.stringify(state.error)}`,
      );
      throw new Error("the run reached its end without parking at the gate");
    }
  } else {
    await waitTrue(cdp, page, "the run's first frames", `${THREAD}.frameCount > ${before}`);
  }
  await answerUntilSettled(cdp, log, page, options.answer ?? "allow", baseline);
}

// ---------------------------------------------------------------------------
// The records, over the route surface itself
// ---------------------------------------------------------------------------

interface Wire {
  readonly request: string;
  readonly status: number;
  readonly body: string;
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
    request: `POST /rpc/${procedure} content-type: application/json authorization: Bearer <redacted> origin: http://127.0.0.1:${launch.apiPort} body=${body}`,
    status: response.status,
    body: await response.text(),
  };
}

interface BotRow {
  botId: string;
  name: string;
  threadCount: number;
}

interface ThreadRow {
  threadId: string;
  botId: string;
  title: string;
  runs: Array<{ runId: string; prompt: string; status: string }>;
}

/**
 * The list the restart proof compares: every Bot with every one of its threads and every run in
 * them, read over the wire. Ids are left in, because the same records must come back with the same
 * ids for the workspaces and the journals to still line up.
 */
async function records(launch: Launched, log: Log): Promise<string> {
  const bots = await post(launch, "list_bots", {});
  log.note(`the request: ${bots.request}`);
  log.note(`the answer: ${bots.status} ${bots.body}`);
  const listed = ((JSON.parse(bots.body) as { json: { bots: BotRow[] } }).json.bots ?? []).map(
    (bot) => ({ botId: bot.botId, name: bot.name, threadCount: bot.threadCount }),
  );
  const threads: Array<Record<string, unknown>> = [];
  for (const bot of listed) {
    const answer = await post(launch, "list_threads", { botId: bot.botId });
    const rows = (JSON.parse(answer.body) as { json: { threads: ThreadRow[] } }).json.threads ?? [];
    for (const row of rows) {
      threads.push({
        threadId: row.threadId,
        botId: row.botId,
        title: row.title,
        runs: row.runs.map((run) => ({
          runId: run.runId,
          prompt: run.prompt,
          status: run.status,
        })),
      });
    }
  }
  return JSON.stringify({ bots: listed, threads }, null, 2);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const log = new Log();
let headerLines: string[] = [];
let chromeProc: Bun.Subprocess | null = null;
let userDataDir: string | null = null;
const made: string[] = [];

/** Write the artifact, refusing one that carries an operator token or a key-shaped literal. */
function writeArtifact(): string | null {
  const text = [...headerLines, ...log.lines, ""].join("\n");
  for (const launched of live) {
    if (launched.token !== "" && text.includes(launched.token)) {
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

async function cleanup(): Promise<void> {
  for (const launched of live) launched.interrupt();
  await Promise.race([
    Promise.allSettled(live.map((launched) => launched.exited())),
    sleep(20_000),
  ]);
  chromeProc?.kill();
  if (userDataDir !== null) rmSync(userDataDir, { recursive: true, force: true });
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
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
  artifactsDir = join(root, "packages", "verify", "artifacts", "bots-and-threads", sha);
  rmSync(artifactsDir, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });

  // One bots root of this driver's own: the registry, every Bot's workspace and every thread's run
  // journal live under it, so nothing here touches a Bot a person has run and the restart reads the
  // same files the first launch wrote.
  const botsRoot = realpathSync(mkdtempSync(join(tmpdir(), "freebot-bots-and-threads-")));
  made.push(botsRoot);

  headerLines = [
    "feature: bots-and-threads",
    "command: bun packages/verify/scripts/bots-and-threads.ts",
    `timestamp: ${new Date().toISOString()}`,
    `git sha: ${full}`,
    `git sha short: ${sha}`,
    `branch: ${branch}`,
    `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
    `the line the model was asked to write: ${LINE}`,
    `the bots root this driver made: ${botsRoot}`,
    "",
  ];
  log.note("# bots-and-threads live-ui frames");
  log.note(
    "DRIVER DISCLOSURE: the launcher is spawned as `bun run up --no-open` with FREEBOT_WORKSPACE pointing at a fresh directory, so the server starts with no Bots at all and no Bot a person has run is touched. The provider mode is `auto`, so the model is whatever the vault selects; every prompt is typed into the page's own box and every approval card is answered on the page. The restart is a real SIGINT of the first launch and a second launch over the same directory.",
  );

  const baseline = runContainers();
  log.note(
    `containers before the run (label ${UNIT_LABEL}): ${baseline.length}${baseline.length === 0 ? "" : ` (${baseline.join(", ")})`}`,
  );

  log.section("the first launch, and the bots root it holds");
  const first = await launch(botsRoot);
  log.note(`the printed URL, redacted: ${redacted(first.url)}`);
  const botsLine = await waitForMatch(
    () => first.stderr(),
    /^(freebot up: bots under .*)$/m,
    30_000,
  );
  log.note(`the launcher's line: ${botsLine}`);
  log.check(
    "the launcher is holding the bots root this driver made, with one workspace per Bot",
    botsLine,
    `freebot up: bots under ${botsRoot}; each Bot's workspace is mounted at /workspace and kept across runs`,
  );
  const choiceLine = await waitForMatch(
    () => first.stderr(),
    /^(freebot up: model mode .*)$/m,
    30_000,
  );
  log.note(`the launcher's line: ${choiceLine}`);
  log.check(
    "the launcher selected the keyed path from the vault, so the file the run writes is a real model's",
    [choiceLine.includes("model mode auto"), choiceLine.includes("(key from the vault)")],
    [true, true],
  );
  log.check(
    "and named the vault's endpoint and model, never the key's name or value",
    [
      choiceLine.includes("via api.commandcode.ai"),
      choiceLine.includes("model deepseek/"),
      choiceLine.includes("FREEBOT_BYOK_KEY"),
    ],
    [true, true, false],
  );

  userDataDir = join(tmpdir(), `freebot-bots-${Date.now()}`);
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
      "--window-size=1280,1500",
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
  log.note(`cdp: ${cdp.version}, headless, DevToolsActivePort file (dynamic)`);

  const captured: PageFacts[] = [];

  log.section("the first Bot, made the way a page makes one, on a server that holds none");
  const madeFirst = await makeFirstBot(first, FIRST_BOT_NAME);
  log.note(`the Bot this driver made over the route a page uses: ${JSON.stringify(madeFirst)}`);
  const page = await openPage(cdp, first.url);
  await waitTrue(
    cdp,
    page,
    "the page to connect",
    `document.querySelector('#conn').textContent === 'connected'`,
  );
  await waitTrue(cdp, page, "the shell to read its Bots", `${SHELL}.bots.length >= 1`);
  log.check(
    "the page is the URL the launcher printed, token in the fragment and never sent to a server",
    await evalJson(
      cdp,
      page,
      `({ fragmentKey: location.hash.slice(0, 7), search: location.search })`,
    ),
    { fragmentKey: "#token=", search: "" },
  );
  const created = await factsOf(cdp, page);
  log.check(
    "the server held no Bot, and this driver made one through the same arm a person's click uses",
    [created.shell.bots.length, created.shell.bots[0]?.name, created.shell.threads.length],
    [1, FIRST_BOT_NAME, 1],
  );
  log.check(
    "the Bot's id is the one the single-Bot app used, so a machine that already ran it keeps its files",
    created.shell.bots[0]?.botId,
    "bot-local",
  );
  captured.push(await capture(cdp, page, "01-sidebar-first-bot", log));

  log.section("a second Bot, created from the sidebar's own control");
  await evalJson(
    cdp,
    page,
    `(() => {
      document.querySelector('#new-bot-name').value = ${JSON.stringify(SECOND_BOT_NAME)};
      document.querySelector('#new-bot').click();
    })()`,
  );
  await waitTrue(cdp, page, "the second Bot", `${SHELL}.bots.length === 2`);
  await waitTrue(
    cdp,
    page,
    "the new Bot's own thread",
    `${SHELL}.threads.length === 1 && ${SHELL}.bots.some((b) => b.name === ${JSON.stringify(SECOND_BOT_NAME)} && b.selected)`,
  );
  captured.push(await capture(cdp, page, "02-bot-created", log));
  const twoBots = await factsOf(cdp, page);
  const firstBotId = created.shell.bots[0]?.botId ?? "";
  const firstThreadId = created.shell.threads[0]?.threadId ?? "";
  const secondBotId = twoBots.shell.bots.find((bot) => bot.name === SECOND_BOT_NAME)?.botId ?? "";
  const secondThreadId = twoBots.shell.threads[0]?.threadId ?? "";
  log.note(`the two Bot ids: ${firstBotId}, ${secondBotId}`);
  log.check(
    "two ids, two workspace directories, neither of them the other's",
    [
      firstBotId === secondBotId,
      botWorkspacePath(botsRoot, firstBotId) === botWorkspacePath(botsRoot, secondBotId),
    ],
    [false, false],
  );

  log.section("a run in the first Bot's thread, asked to write a file with this run's nonce");
  await clickExpression(
    cdp,
    page,
    `[...document.querySelectorAll('.bot-row')].find((row) => row.dataset.bot === ${JSON.stringify(firstBotId)})`,
  );
  await waitTrue(
    cdp,
    page,
    "the first Bot's thread to be the page's selection",
    settledOn(firstBotId, firstThreadId),
  );
  const writePrompt = `Use the bash tool to write exactly this, and nothing else, into the file /workspace/note.txt: '${LINE}' followed by a newline. Create no other file and read nothing. Then reply with one short sentence.`;
  await runPrompt(cdp, log, page, writePrompt, { answer: "allow", launch: first });
  await waitTrue(cdp, page, "the thread's own count", `${SHELL}.threads[0].runs === 1`);
  captured.push(await capture(cdp, page, "03-thread-run", log));

  log.section("a second run in the same thread");
  await runPrompt(cdp, log, page, "Reply with the single word: second.", {
    answer: null,
    launch: first,
  });
  await waitTrue(cdp, page, "the second run's count", `${SHELL}.threads[0].runs === 2`);
  captured.push(await capture(cdp, page, "04-second-run", log));

  log.section("the file, on the host, in this Bot's workspace and nowhere else");
  const onDisk = await Bun.file(join(botWorkspacePath(botsRoot, firstBotId), "note.txt"))
    .text()
    .catch(() => null);
  log.note(
    `the first Bot's workspace, read by the driver from the host: ${JSON.stringify(onDisk)}`,
  );
  log.check(
    "the file the container wrote carries the nonce this run minted",
    onDisk?.includes(LINE) === true,
    true,
  );
  const firstList = await post(first, "list_files", { botId: firstBotId, path: "." });
  log.note(`the request: ${firstList.request}`);
  log.note(`the answer: ${firstList.status} ${firstList.body}`);
  log.check(
    "the listing of the Bot that ran holds the file, with the bytes it wrote",
    (
      JSON.parse(firstList.body) as {
        json: { entries: Array<{ name: string; path: string; kind: string; size: number }> };
      }
    ).json.entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      kind: entry.kind,
      size: entry.size,
    })),
    [{ name: "note.txt", path: "note.txt", kind: "file", size: onDisk?.length ?? 0 }],
  );
  const secondList = await post(first, "list_files", { botId: secondBotId, path: "." });
  log.note(`the request: ${secondList.request}`);
  log.note(`the answer: ${secondList.status} ${secondList.body}`);
  log.check(
    "the listing of the other Bot is empty, so the file one Bot wrote is absent from the other",
    (JSON.parse(secondList.body) as { json: { entries: unknown[] } }).json.entries,
    [],
  );
  const firstRead = await post(first, "read_file", { botId: firstBotId, path: "note.txt" });
  log.note(`the request: ${firstRead.request}`);
  log.note(`the answer: ${firstRead.status} ${JSON.stringify(firstRead.body)}`);
  log.check(
    "the bytes the route surface returns for the first Bot carry the nonce",
    (JSON.parse(firstRead.body) as { json: { text: string } }).json.text.includes(LINE),
    true,
  );
  const secondRead = await post(first, "read_file", { botId: secondBotId, path: "note.txt" });
  log.note(`the request: ${secondRead.request}`);
  log.note(`the answer: ${secondRead.status} ${secondRead.body}`);
  log.check(
    "the same path in the other Bot's workspace is refused as not there",
    [secondRead.status, (JSON.parse(secondRead.body) as { json: { code: string } }).json.code],
    [404, "path_not_found"],
  );
  const unknownRead = await post(first, "read_file", { botId: "bot-nowhere", path: "note.txt" });
  log.check(
    "a Bot the server does not hold is refused by name",
    [unknownRead.status, (JSON.parse(unknownRead.body) as { json: { code: string } }).json.code],
    [404, "bot_not_found"],
  );
  const refusal = await post(first, "start_run", {
    prompt: "into a thread that is not there",
    botId: firstBotId,
    threadId: "thread-9",
  });
  log.note(`the request: ${refusal.request}`);
  log.note(`the answer: ${refusal.status} ${refusal.body}`);
  log.check(
    "a run in a thread the server does not hold is refused by name rather than silently landing elsewhere",
    [refusal.status, (JSON.parse(refusal.body) as { json: { code: string } }).json.code],
    [404, "thread_not_found"],
  );

  log.section("a second thread in the same Bot, and the transcript follows the selection");
  await clickSelector(cdp, page, "#new-thread");
  await waitTrue(cdp, page, "the second thread", `${SHELL}.threads.length === 2`);
  await waitTrue(
    cdp,
    page,
    "the new thread to be the page's selection, with an empty transcript",
    `${SHELL}.threads.filter((row) => row.selected)[0].runs === 0 && ${THREAD}.frameCount === 0 && ${CONNECTED}`,
  );
  captured.push(await capture(cdp, page, "05-other-thread", log));
  const ranThreadId = (await factsOf(cdp, page)).shell.threads.find(
    (row) => row.runs === 2,
  )?.threadId;
  await clickExpression(
    cdp,
    page,
    `[...document.querySelectorAll('.thread-row')].find((row) => row.dataset.thread === ${JSON.stringify(ranThreadId)})`,
  );
  await waitTrue(
    cdp,
    page,
    "the ran thread to be the page's selection",
    settledOn(firstBotId, ranThreadId ?? ""),
  );
  await waitTrue(
    cdp,
    page,
    "the ran thread's frames, replayed from its own log",
    `${THREAD}.frameCount > 6`,
  );
  log.check(
    "selecting the thread that ran brings its frames back from that thread's own log",
    (await factsOf(cdp, page)).shell.selectedThreadId,
    ranThreadId,
  );

  log.section("the other Bot's Library, while the first Bot's workspace holds the file");
  await clickExpression(
    cdp,
    page,
    `[...document.querySelectorAll('.bot-row')].find((row) => row.dataset.bot === ${JSON.stringify(secondBotId)})`,
  );
  await waitTrue(
    cdp,
    page,
    "the second Bot's thread to be the page's selection",
    settledOn(secondBotId, secondThreadId),
  );
  await clickSelector(cdp, page, "#tab-library");
  await waitTrue(cdp, page, "the other Bot's Library", `${LIB}.state === 'empty'`);
  captured.push(await capture(cdp, page, "06-other-bot-library", log));

  log.section("the two workspaces on the host, one file in one of them");
  const firstWorkspace = botWorkspacePath(botsRoot, firstBotId);
  const secondWorkspace = botWorkspacePath(botsRoot, secondBotId);
  log.note(`the first Bot's directory: ${firstWorkspace}`);
  log.note(`the second Bot's directory: ${secondWorkspace}`);
  log.check(
    "the file the run wrote is in the first Bot's directory, and nowhere near the second's",
    [
      readdirSync(firstWorkspace).sort(),
      await Bun.file(join(secondWorkspace, "note.txt")).exists(),
      firstWorkspace === secondWorkspace,
    ],
    [["note.txt"], false, false],
  );

  log.section("the records before the restart");
  const before = await records(first, log);
  log.note("the before list:");
  for (const line of before.split("\n")) log.note(`  ${line}`);

  log.section("the restart");
  const parked = runContainers();
  log.note(`containers while the first launch is up: ${parked.length} (${parked.join(", ")})`);
  first.interrupt();
  const code = await first.exited();
  log.check("the first launch exits zero on SIGINT", code, 0);
  log.check("nothing listens on the first launch's page port", listeners(first.apiPort), []);
  log.check(
    "and the containers it created are gone, by name",
    await settles(() => JSON.stringify(runContainers()) === JSON.stringify(baseline)),
    true,
  );
  const second = await launch(botsRoot);
  log.note(`the second printed URL, redacted: ${redacted(second.url)}`);
  const secondBotsLine = await waitForMatch(
    () => second.stderr(),
    /^(freebot up: bots under .*)$/m,
    30_000,
  );
  log.check(
    "the second launch holds the same bots root",
    secondBotsLine,
    `freebot up: bots under ${botsRoot}; each Bot's workspace is mounted at /workspace and kept across runs`,
  );
  const after = await records(second, log);
  log.note("the after list:");
  for (const line of after.split("\n")) log.note(`  ${line}`);
  log.check("the after list is the before list, character for character", after, before);
  log.check(
    "both Bots and both threads came back with their conversations",
    JSON.parse(after) as { bots: BotRow[]; threads: ThreadRow[] },
    {
      bots: [
        { botId: firstBotId, name: FIRST_BOT_NAME, threadCount: 2 },
        { botId: secondBotId, name: SECOND_BOT_NAME, threadCount: 1 },
      ],
      threads: [
        {
          threadId: (JSON.parse(before) as { threads: Array<{ threadId: string }> }).threads[0]
            ?.threadId,
          botId: firstBotId,
          title: "New conversation",
          runs: [
            { runId: "run-1", prompt: writePrompt, status: "done" },
            { runId: "run-2", prompt: "Reply with the single word: second.", status: "done" },
          ],
        },
        {
          threadId: (JSON.parse(before) as { threads: Array<{ threadId: string }> }).threads[1]
            ?.threadId,
          botId: firstBotId,
          title: "New conversation",
          runs: [],
        },
        {
          threadId: (JSON.parse(before) as { threads: Array<{ threadId: string }> }).threads[2]
            ?.threadId,
          botId: secondBotId,
          title: "New conversation",
          runs: [],
        },
      ],
    },
  );

  log.section("the page after the restart");
  const secondPage = await openPage(cdp, second.url);
  await waitTrue(
    cdp,
    secondPage,
    "the restarted page to connect",
    `document.querySelector('#conn').textContent === 'connected'`,
  );
  await waitTrue(cdp, secondPage, "the shell to read its Bots", `${SHELL}.bots.length === 2`);
  await waitTrue(
    cdp,
    secondPage,
    "the threads the last process recorded",
    `${SHELL}.threads.some((row) => row.runs === 2)`,
  );
  log.check(
    "the restarted page lists the Bot that ran first, with its two threads",
    await evalJson<unknown>(
      cdp,
      secondPage,
      `${SHELL}.bots.map((bot) => [bot.name, bot.threadCount])`,
    ),
    [
      [FIRST_BOT_NAME, 2],
      [SECOND_BOT_NAME, 1],
    ],
  );
  log.check(
    "its transcript is empty, because the frames are the live log and the runs are the record",
    await evalJson<number>(cdp, secondPage, `${THREAD}.frameCount`),
    0,
  );
  captured.push(await capture(cdp, secondPage, "07-after-restart", log));

  log.section("shutdown, and the containers this driver created");
  second.interrupt();
  const secondCode = await second.exited();
  log.check("the second launch exits zero on SIGINT", secondCode, 0);
  log.check("nothing listens on the second launch's page port", listeners(second.apiPort), []);
  log.check(
    "the label's container set is back where it started",
    await settles(() => JSON.stringify(runContainers()) === JSON.stringify(baseline)),
    true,
  );
  log.check(
    "and every container the launches said they removed is gone from Docker",
    [...first.stderr().matchAll(/removed sandbox (\S+) \(/g)].flatMap((match) =>
      match[1] === undefined ? [] : containersNamed(match[1]),
    ),
    [],
  );

  cdp.close();
  chromeProc.kill();

  log.section("pairwise distinctness of the committed frames");
  const keys = captured.map(factsKey);
  log.check(
    "frames: every committed frame differs from every other in its page facts",
    keys.flatMap((key, index) =>
      keys
        .slice(index + 1)
        .filter((other) => other === key)
        .map(() => key),
    ),
    [],
  );

  log.section("frame index");
  log.note("name -> asserted facts -> caption");
  for (const spec of SPECS) {
    const found = captured[SPECS.indexOf(spec)];
    if (found === undefined) {
      log.fail(`frame index ${spec.name}`, "no capture was taken");
      continue;
    }
    log.note(`${spec.name} -> ${describeFacts(found)} -> ${spec.caption}`);
    log.note(
      `  unmet claims: ${JSON.stringify(spec.claims.filter((claim) => !claim.holds(found)).map((claim) => claim.label))}`,
    );
  }

  log.section("the committed artifact carries no token and no key");
  const files = readdirSync(artifactsDir).sort();
  log.check("frames: one committed PNG per key state", files.length, SPECS.length);
  for (const file of files) {
    log.note(`artifact: ${file} (${statSync(join(artifactsDir, file)).size} bytes)`);
  }
  const report = log.lines.join("\n");
  log.check(
    "no committed line carries the launch's operator token",
    report.includes(first.token),
    false,
  );
  log.check(
    "no committed line carries a key-shaped literal",
    /FREEBOT_BYOK_KEY=\S{8,}/.test(report),
    false,
  );

  log.lines.push("");
  log.lines.push(
    `chrome ${CHROME.split("/").at(-1)} over CDP; two really launched \`bun run up --no-open\` processes over one bots root, the first SIGINTed before the second; the model is the vault's keyed provider`,
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
