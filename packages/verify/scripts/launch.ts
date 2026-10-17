#!/usr/bin/env bun
/**
 * The U2.3 evidence driver: one command, one URL, the whole click.
 *
 * The peer is the real launcher, `bun run up --no-open`, spawned exactly as a person runs it. The
 * driver takes the URL the launcher printed, opens that URL in headless Chrome over CDP, and drives
 * the click a person would: type a prompt, start the run, watch the tool-call card, answer the
 * approval card, reach the terminal frame. Nothing about the URL is constructed here, which is what
 * makes this evidence about the printed URL rather than about a URL that happens to work.
 *
 * Then the two things a launcher owes an operator. A second launch while the first is still
 * serving, on its own free port and with its own engine. And Ctrl-C: the driver sends SIGINT while a
 * run is parked with a live container, and asserts the container the launch created is gone, the
 * label's container set is back where it started, and nothing listens on either port.
 *
 * Real: the launcher, both listeners, the gate, the loop, the run store, the log, the container from
 * the pinned image, the page and its stream, the reap. Replayed: the model's turns, from
 * packages/pi-bridge/fixtures/rpc-handshake.jsonl, because gate G1 parks the keyed provider. Pinned:
 * the sandbox image.
 *
 * Run from the repo root: bun packages/verify/scripts/launch.ts
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** The shape the launcher's one stdout line must have. 32 base64url bytes are 43 characters. */
const URL_SHAPE = /^http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]{43}$/;
const HEALTHZ = JSON.stringify({ status: "ok", service: "freebot-server" });
const PROMPT = "run one gated command";
const SECOND_PROMPT = "run one gated command, on the second launch";
const THIRD_PROMPT = "run one gated command, on the third launch";
const COMMAND = 'bash {"command":"echo native-should-not-run"}';
const OUTPUT = "native-should-not-run\n";

let artifactsDir = "";

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
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evalJson<boolean>(cdp, sessionId, expression)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${desc}`);
}

/** Open the URL the launcher printed, fragment and all, and hand back the CDP session. */
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

function factsOf(cdp: Cdp, sessionId: string): Promise<FrameFacts> {
  return evalJson<FrameFacts>(cdp, sessionId, "window.__threadFacts()");
}

/**
 * The same page, read by the driver through its own selectors instead of the page's hook, so a hook
 * that drifted from the DOM fails the run rather than certifying itself.
 */
type DomFacts = {
  frames: number;
  lastSeq: number;
  statuses: string[];
  outputs: boolean[];
  approvals: Array<string | null>;
};

function domFacts(cdp: Cdp, sessionId: string): Promise<DomFacts> {
  return evalJson<DomFacts>(
    cdp,
    sessionId,
    `({
      frames: document.querySelectorAll('#thread .frame[data-seq]').length,
      lastSeq: Math.max(0, ...[...document.querySelectorAll('#thread .frame[data-seq]')].map((e) => Number(e.dataset.seq))),
      statuses: [...document.querySelectorAll('#thread .tool-card .status')].map((e) => e.textContent),
      outputs: [...document.querySelectorAll('#thread .tool-card')]
        .map((card) => card.querySelector('.output-details')?.hidden === false),
      approvals: [...document.querySelectorAll('#thread .approval-card')].map((card) => card.dataset.decision ?? null),
    })`,
  );
}

/** Whether the element the caption is about actually landed in the captured pixels. */
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

/**
 * The four committed states, each with the claims its caption makes. A caption is not prose a reader
 * trusts: every claim is a predicate over the facts read from the live DOM. The second launch's
 * frame is a denied run rather than its armed page, because the armed page is the same page state
 * `01-armed` already documents, and two frames of one state is not evidence of two states.
 */
const SPECS: readonly FrameSpec[] = [
  {
    name: "01-armed",
    caption:
      "The URL the one command printed, opened: the real engine is connected, the run has not started, and the operator's prompt box is the way in.",
    claims: [
      { label: "no message is rendered", holds: (f) => f.frameCount === 0 },
      { label: "the run has not finished", holds: (f) => !f.done },
      { label: "no approval is pending", holds: (f) => f.approvals.length === 0 },
      { label: "the stream has not started", holds: (f) => f.lastSeq === 0 },
    ],
    visible: "#operator",
  },
  {
    name: "02-parked",
    caption:
      "A run started from the printed URL is parked at the gate: the approval card names the exact command the model asked for, and the tool card waits for the answer.",
    claims: [
      {
        label: "one approval card is waiting",
        holds: (f) => f.approvals.length === 1 && f.approvals[0] === null,
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
      "Allowed once and finished: the card shows the decision, the governed call ran in the container so its output block holds the container's own stdout, and the run reached its terminal frame.",
    claims: [
      {
        label: "the approval card shows the allow decision",
        holds: (f) => f.approvals.includes("allow"),
      },
      {
        label: "the governed card is done with its output open",
        holds: (f) =>
          f.cards.some(([, status]) => status === "done") && f.outputShown.every((s) => s),
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
      "A second launch, denied: the same page and the same engine on a free port of its own, driven through a denial to its own terminal frame.",
    claims: [
      {
        label: "the approval card shows the deny decision",
        holds: (f) => f.approvals.includes("deny"),
      },
      {
        label: "a tool card shows denied with no output",
        holds: (f) =>
          f.cards.some(([, status]) => status === "denied") && f.outputShown.every((s) => !s),
      },
      { label: "the run reported done", holds: (f) => f.done },
      { label: "the terminal marker is rendered", holds: (f) => f.streamEnd === "stream complete" },
      { label: "one rendered message per seq", holds: (f) => f.frameCount === f.lastSeq },
    ],
    visible: "#thread .run-finished",
  },
];

function specFor(name: string): FrameSpec {
  const spec = SPECS.find((entry) => entry.name === name);
  if (spec === undefined) throw new Error(`no frame spec named ${name}`);
  return spec;
}

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
  const sha256 = createHash("sha256").update(buffer).digest("hex");

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
    `frame ${name}: the driver's DOM read agrees with the page's facts hook`,
    [dom.frames, dom.lastSeq, dom.statuses, dom.outputs],
    [after.frameCount, after.lastSeq, after.cards.map(([, status]) => status), after.outputShown],
  );
  for (const claim of spec.claims) {
    log.check(`frame ${name}: claim - ${claim.label}`, claim.holds(after), true);
  }
  log.note(
    `frame ${name}: ${file} (${buffer.byteLength} bytes, sha256 ${sha256}) - ${describeFacts(after)}`,
  );
  return { name, file, bytes: buffer.byteLength, sha256, facts: after };
}

// ---------------------------------------------------------------------------
// The launched command
// ---------------------------------------------------------------------------

interface Launched {
  /** The URL the launcher printed, taken from its stdout rather than built here. */
  readonly url: string;
  readonly apiPort: number;
  readonly tunnelPort: number;
  readonly token: string;
  stdout(): string;
  stderr(): string;
  interrupt(): void;
  exited(): Promise<number>;
  /** The containers the launcher said it removed during shutdown. */
  removed(): string[];
}

async function waitForMatch(read: () => string, match: RegExp, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = match.exec(read());
    if (found?.[1] !== undefined) return found[1];
    await sleep(25);
  }
  throw new Error(`no line matching ${match} within ${timeoutMs}ms; saw:\n${read().slice(-800)}`);
}

/** `bun run up`, exactly as a person types it. */
async function launch(
  extra: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<Launched> {
  const proc = Bun.spawn(["bun", "run", "up", ...extra], {
    cwd: root,
    env: { ...process.env, ...env },
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
    removed: () =>
      [...err.matchAll(/freebot up: removed sandbox container (\S+)/g)].flatMap((match) =>
        match[1] === undefined ? [] : [match[1]],
      ),
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

/** A launch expected to refuse and exit, so nothing waits for a URL it will never print. */
async function launchThatExits(extra: readonly string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["bun", "run", "up", ...extra], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Every launcher this process started, so a crash still stops them and reaps their containers. */
const live: Launched[] = [];

/** The URL with its token replaced by its shape. What the artifact is allowed to hold. */
function redacted(url: string): string {
  return url.replace(/#token=.*$/, "#token=<redacted>");
}

function stdoutLines(launch: Launched): string[] {
  return launch
    .stdout()
    .split("\n")
    .filter((line) => line.trim() !== "");
}

/** One page-stream handshake from Bun, for the two directions the gate must get right. */
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

async function httpStatus(url: string): Promise<number> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return response.status;
  } catch {
    return 0;
  }
}

async function healthz(port: number): Promise<string> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(5_000),
    });
    return JSON.stringify(await response.json());
  } catch (error) {
    return `unreachable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const UNIT_FILTERS = ["label=freebot.unit=u1.7", "label=freebot.provider=docker"];

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

/** Containers this repo's runs create, whatever launch made them. Read-only, no cleanup here. */
function runContainers(): string[] {
  return dockerNames(UNIT_FILTERS);
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

/** Poll a predicate of the real system until it holds, so a settle race does not fail the run. */
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
// The paths
// ---------------------------------------------------------------------------

/** Click the operator's Start control with the prompt the operator types. */
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

/** The approval card that is still waiting, which is the one the last run parked on. */
const WAITING_CARD = `[...document.querySelectorAll('#thread .approval-card')]
  .filter((card) => (card.dataset.decision ?? null) === null)[0]`;

/** Open the URL this launch printed and assert the page it lands on is an armed operator page. */
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
      `({
        scheme: location.protocol,
        host: location.host,
        fragmentKey: location.hash.slice(0, 7),
        fragmentLength: location.hash.length,
        search: location.search,
      })`,
    ),
    {
      scheme: "http:",
      host: `127.0.0.1:${launch.apiPort}`,
      fragmentKey: "#token=",
      fragmentLength: 50,
      search: "",
    },
  );
  log.check(
    `${label}: operator mode is on, so the prompt box is the way in`,
    await evalJson(cdp, sessionId, "document.querySelector('#operator').hidden"),
    false,
  );
  log.check(
    `${label}: the connection is live`,
    await evalJson(cdp, sessionId, "document.querySelector('#conn').textContent"),
    "connected",
  );
  return sessionId;
}

/** Start a run from the page and assert the card it parks on. Returns the parked call's id. */
async function assertParked(
  cdp: Cdp,
  log: Log,
  sessionId: string,
  label: string,
  prompt: string,
): Promise<string> {
  await startRun(cdp, sessionId, prompt);
  await waitTrue(cdp, sessionId, `${label}: the parked approval`, `${WAITING_CARD} !== undefined`);
  log.check(
    `${label}: the run is the one the page started`,
    await evalJson(cdp, sessionId, "document.querySelector('#run').textContent"),
    "run run-1",
  );
  log.check(
    `${label}: the prompt the page sent is the run's prompt`,
    await evalJson(
      cdp,
      sessionId,
      `[...document.querySelectorAll('#thread .message.user .prompt')].at(-1).textContent`,
    ),
    prompt,
  );
  log.check(
    `${label}: the card shows the exact command the model asked for`,
    await evalJson(
      cdp,
      sessionId,
      "document.querySelector('#thread .approval-card .cmd').textContent",
    ),
    COMMAND,
  );
  log.check(
    `${label}: the buttons are the two real answers`,
    await evalJson(
      cdp,
      sessionId,
      `[...document.querySelectorAll('#thread .approval-card button')].map((b) => b.textContent)`,
    ),
    ["Allow once", "Deny"],
  );
  log.check(
    `${label}: the run's own status frame is rendered, so a parked run does not look frozen`,
    await evalJson<number>(
      cdp,
      sessionId,
      `document.querySelectorAll('#thread .run-status[data-run-status="awaiting_approval"]').length`,
    ),
    1,
  );
  return await evalJson<string>(
    cdp,
    sessionId,
    `document.querySelector('#thread .tool-card').dataset.toolCall`,
  );
}

/** Answer the waiting card once, then assert the allowed run's terminal frame. */
async function answerAllow(
  cdp: Cdp,
  log: Log,
  sessionId: string,
  label: string,
  callId: string,
): Promise<void> {
  await evalJson(
    cdp,
    sessionId,
    `document.querySelector('#thread .approval-card .allow-once').click()`,
  );
  await waitTrue(
    cdp,
    sessionId,
    `${label}: the allowed run to finish`,
    `${WAITING_CARD} === undefined &&
     document.querySelector('#thread .tool-card[data-tool-call="${callId}"] .status').textContent === 'done' &&
     window.__threadFacts().done === true`,
  );
  log.check(
    `${label}: the card renders the decided state`,
    await evalJson(
      cdp,
      sessionId,
      "document.querySelector('#thread .approval-card .approval-result').textContent",
    ),
    "allowed once",
  );
  log.check(
    `${label}: the decision marker names the allow`,
    await evalJson(
      cdp,
      sessionId,
      `document.querySelector('#thread .tool-decision[data-tool-call="${callId}"]').textContent`,
    ),
    `decision ${callId}: allow`,
  );
  // The container's own stdout, which no replayed frame could carry.
  log.check(
    `${label}: the output is the container's, not a replayed string`,
    await evalJson(
      cdp,
      sessionId,
      `document.querySelector('#thread .tool-card[data-tool-call="${callId}"] .output').textContent`,
    ),
    OUTPUT,
  );
  log.check(
    `${label}: the run's terminal status frame is rendered`,
    await evalJson<number>(
      cdp,
      sessionId,
      `document.querySelectorAll('#thread .run-status[data-run-status="done"]').length`,
    ),
    1,
  );
  log.check(
    `${label}: the run finished with no stream error`,
    await evalJson(cdp, sessionId, "document.querySelector('#error').hidden"),
    true,
  );
}

/** Deny the waiting card, then assert the denied run's terminal frame. */
async function answerDeny(
  cdp: Cdp,
  log: Log,
  sessionId: string,
  label: string,
  callId: string,
): Promise<void> {
  await evalJson(cdp, sessionId, `document.querySelector('#thread .approval-card .deny').click()`);
  await waitTrue(
    cdp,
    sessionId,
    `${label}: the denied run to finish`,
    `${WAITING_CARD} === undefined &&
     document.querySelector('#thread .tool-card[data-tool-call="${callId}"] .status').textContent === 'denied' &&
     window.__threadFacts().done === true`,
  );
  log.check(
    `${label}: the card renders the decided state`,
    await evalJson(
      cdp,
      sessionId,
      "document.querySelector('#thread .approval-card .approval-result').textContent",
    ),
    "denied",
  );
  log.check(
    `${label}: the refusal is named user_denied`,
    await evalJson(
      cdp,
      sessionId,
      `document.querySelector('#thread .tool-decision[data-tool-call="${callId}"]').textContent`,
    ),
    `decision ${callId}: deny (user_denied)`,
  );
  log.check(
    `${label}: the governed call produced no output`,
    await evalJson(
      cdp,
      sessionId,
      `document.querySelector('#thread .tool-card[data-tool-call="${callId}"] .output').textContent`,
    ),
    "",
  );
  log.check(
    `${label}: the denied run still reached the terminal frame`,
    await evalJson(cdp, sessionId, "document.querySelector('#thread .run-finished').textContent"),
    "stream complete",
  );
  log.check(
    `${label}: the run's terminal status frame is rendered`,
    await evalJson<number>(
      cdp,
      sessionId,
      `document.querySelectorAll('#thread .run-status[data-run-status="done"]').length`,
    ),
    1,
  );
}

/** SIGINT a launcher and assert the shutdown contract. Returns the containers it said it removed. */
async function interruptAndCheck(log: Log, launch: Launched, label: string): Promise<string[]> {
  launch.interrupt();
  const code = await launch.exited();
  await sleep(200);
  log.check(`${label}: exits zero on SIGINT`, code, 0);
  log.check(
    `${label}: reported that it stopped`,
    launch.stderr().includes("freebot up: stopped"),
    true,
  );
  const named = launch.removed();
  log.check(
    `${label}: every container it says it removed is gone from Docker`,
    named.flatMap((name) => containersNamed(name)),
    [],
  );
  log.check(`${label}: nothing listens on its page port afterwards`, listeners(launch.apiPort), []);
  return named;
}

let chromeProc: Bun.Subprocess | null = null;
let userDataDir: string | null = null;

/**
 * A stand-in for the platform's browser opener, so the default launch's one external act is
 * observable without opening a real window: it records the single argument it was handed.
 */
function openShim(): string {
  const dir = join(tmpdir(), `freebot-open-shim-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "open"),
    `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(join(dir, "recorded"))}\n`,
    {
      mode: 0o755,
    },
  );
  return dir;
}
/** The trail, at module scope so a crashed run still leaves what it proved before it died. */
const log = new Log();
let headerLines: string[] = [];

/** Write the artifact, refusing to write one that carries an operator token. Null means refused. */
function writeArtifact(): string | null {
  const text = [...headerLines, ...log.lines, ""].join("\n");
  for (const launch of live) {
    if (launch.token !== "" && text.includes(launch.token)) {
      console.error("refusing to write an artifact that contains the operator token");
      return null;
    }
  }
  const path = join(artifactsDir, "assert.txt");
  writeFileSync(path, text);
  return path;
}

/**
 * Stop whatever is still running. A launcher gets SIGINT, not SIGKILL, so its own reap still runs:
 * a driver that crashes must not leave a container behind that nothing owns (order 22).
 */
async function cleanup(): Promise<void> {
  for (const launch of live) launch.interrupt();
  await Promise.race([Promise.allSettled(live.map((launch) => launch.exited())), sleep(15_000)]);
  chromeProc?.kill();
  if (userDataDir !== null) rmSync(userDataDir, { recursive: true, force: true });
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
  artifactsDir = join(root, "packages", "verify", "artifacts", "launch", sha);
  rmSync(artifactsDir, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });

  headerLines = [
    "feature: launch",
    "command: bun packages/verify/scripts/launch.ts",
    `timestamp: ${new Date().toISOString()}`,
    `git sha: ${full}`,
    `git sha short: ${sha}`,
    `branch: ${branch}`,
    `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
    `pinned image: freebot-sandbox:u0.6`,
    `transcript: packages/pi-bridge/fixtures/rpc-handshake.jsonl`,
    "",
  ];
  log.note(`# launch live-ui frames - ${new Date().toISOString()}`);
  log.note(`worktree ${root}  head ${sha}  branch ${branch}`);
  log.note(
    "DRIVER DISCLOSURE: the model's turns are replayed from packages/pi-bridge/fixtures/rpc-handshake.jsonl (gate G1 parks the keyed provider) and the sandbox is the pinned image. The launcher, both listeners, the gate, the loop, the run store, the log, the container, the page, its stream and the reap are real.",
  );
  log.note(
    "WHY THREE LAUNCHES: a launch parks only its first run. Once a run is allowed, the landed ledger holds that action's grant, and the same call again is refused as grant_consumed rather than parked (packages/review/src/policy.ts). So the parked state that shutdown needs, and the two answered states, are each driven from a launch that has not answered that action yet.",
  );

  const baseline = runContainers();
  log.section("the one command");
  log.note(
    `containers before the first run (label freebot.unit=u1.7): ${baseline.length}${baseline.length === 0 ? "" : ` (${baseline.join(", ")})`}`,
  );

  const first = await launch(["--no-open"]);
  log.check(
    "the launcher printed a URL of the required shape, token in the fragment",
    URL_SHAPE.test(first.url),
    true,
  );
  log.note(`the printed URL, redacted: ${redacted(first.url)}`);
  log.check(
    "and its stdout held exactly one line at that moment, the URL",
    stdoutLines(first).length,
    1,
  );
  log.check(
    "the launcher's own diagnostic names the same page port",
    /page and run on 127\.0\.0\.1:(\d+)/.exec(first.stderr())?.[1],
    String(first.apiPort),
  );
  log.check(
    "the page answers on the URL's port",
    await httpStatus(`http://127.0.0.1:${first.apiPort}/`),
    200,
  );
  log.check("healthz answers on the URL's port", await healthz(first.apiPort), HEALTHZ);
  const events = `ws://127.0.0.1:${first.apiPort}/events`;
  log.check("a page stream with no token is refused", await handshake(events), "refused");
  log.check(
    "a page stream with a wrong token is refused",
    await handshake(`${events}?token=0000`),
    "refused",
  );
  log.check(
    "a page stream with the URL's own token is accepted",
    await handshake(`${events}?token=${first.token}`),
    "open",
  );
  log.check(
    "the token reaches the launch's output once, inside the URL and nowhere else",
    (first.stdout() + first.stderr()).split(first.token).length - 1,
    1,
  );

  userDataDir = join(tmpdir(), `freebot-launch-${Date.now()}`);
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
  log.section("the printed URL, clicked the way a person clicks it");
  const firstPage = await openArmed(cdp, log, first, "first launch");
  captures.push(await capture(cdp, firstPage, "01-armed", log));
  await assertParked(cdp, log, firstPage, "first launch", PROMPT);
  const parkedSet = runContainers();
  const parkedLive = added(baseline, parkedSet);
  log.check(
    "the parked run holds one live container, this launch's own",
    [parkedLive.length, parkedSet.length],
    [1, baseline.length + 1],
  );
  log.note(
    `containers while the first launch's run is parked: ${parkedSet.length} (${parkedLive.join(", ")})`,
  );
  captures.push(await capture(cdp, firstPage, "02-parked", log));

  log.section("a second launch, while the first is parked");
  const second = await launch(["--no-open"]);
  log.check(
    "the second launch took a different page port",
    [second.apiPort !== first.apiPort, second.tunnelPort !== first.tunnelPort],
    [true, true],
  );
  log.check("the second launch's healthz answers", await healthz(second.apiPort), HEALTHZ);
  log.check(
    "the first launch is still answering while the second serves",
    await healthz(first.apiPort),
    HEALTHZ,
  );
  log.note(`the second launch's URL, redacted: ${redacted(second.url)}`);
  const secondPage = await openArmed(cdp, log, second, "second launch");
  const secondCall = await assertParked(cdp, log, secondPage, "second launch", SECOND_PROMPT);
  await answerAllow(cdp, log, secondPage, "second launch", secondCall);
  captures.push(await capture(cdp, secondPage, "03-finished", log));
  const secondRemoved = await interruptAndCheck(log, second, "the second launch");
  log.note(`the second launch announced removing ${secondRemoved.length} container(s)`);
  log.check(
    "the first launch's parked container survived the second launch's shutdown",
    await settles(() => JSON.stringify(runContainers()) === JSON.stringify(parkedSet)),
    true,
  );

  log.section("a third launch, denied");
  const third = await launch(["--no-open"]);
  log.check(
    "the third launch took a page port of its own",
    [third.apiPort !== first.apiPort, third.apiPort !== second.apiPort],
    [true, true],
  );
  const thirdPage = await openArmed(cdp, log, third, "third launch");
  const thirdCall = await assertParked(cdp, log, thirdPage, "third launch", THIRD_PROMPT);
  await answerDeny(cdp, log, thirdPage, "third launch", thirdCall);
  captures.push(await capture(cdp, thirdPage, "04-denied", log));
  const thirdRemoved = await interruptAndCheck(log, third, "the third launch");
  log.note(`the third launch announced removing ${thirdRemoved.length} container(s)`);
  log.check(
    "and the first launch's parked container is still the only one",
    await settles(() => JSON.stringify(runContainers()) === JSON.stringify(parkedSet)),
    true,
  );

  log.section("a pinned port that is already taken");
  const collision = await launchThatExits(["--no-open", "--api-port", String(first.apiPort)]);
  log.check(
    "a launch pinned to the first launch's page port exits nonzero",
    collision.code !== 0,
    true,
  );
  log.check(
    "and says which port it could not take",
    [collision.stderr.includes("cannot listen"), collision.stderr.includes(String(first.apiPort))],
    [true, true],
  );

  log.section("the default launch, which opens the URL it printed");
  const shimDir = openShim();
  const defaulted = await launch([], { PATH: `${shimDir}:${process.env.PATH ?? ""}` });
  await sleep(1_000);
  log.check(
    "the default launch hands the URL it printed to the browser opener, and nothing else",
    (await Bun.file(join(shimDir, "recorded")).text()).trim() === defaulted.url,
    true,
  );
  log.check(
    "and says it opened a browser without printing the token anywhere else",
    defaulted.stderr().includes("opened the URL in your browser"),
    true,
  );
  await interruptAndCheck(log, defaulted, "the default launch");
  rmSync(shimDir, { recursive: true, force: true });

  log.section("shutdown, with the first launch's run still parked");
  log.note(
    `containers before the shutdown, with the run still parked: ${parkedSet.length} (${parkedLive.join(", ")})`,
  );
  const firstRemoved = await interruptAndCheck(log, first, "the first launch");
  log.check("the first launch named the container its parked run held", firstRemoved, parkedLive);
  log.check(
    "that container is gone from Docker by its own name",
    parkedLive.flatMap((name) => containersNamed(name)),
    [],
  );
  const afterShutdown = runContainers();
  log.check("the label's container set is back where it started", afterShutdown, baseline);
  log.note(
    `containers after the shutdown (label freebot.unit=u1.7): ${afterShutdown.length}${afterShutdown.length === 0 ? "" : ` (${afterShutdown.join(", ")})`}`,
  );
  log.check(
    "nothing listens on the first launch's tunnel port afterwards",
    listeners(first.tunnelPort),
    [],
  );
  // The driver's own gate probes above are what put the server's refusal log lines on this stdout;
  // a launch nobody probes writes the URL and nothing else.
  const urlLines = (launch: Launched): string[] =>
    stdoutLines(launch).filter((line) => line.startsWith("http://"));
  log.check(
    "every launch's stdout holds exactly one URL, the one to open",
    [urlLines(first).length, urlLines(second).length, urlLines(third).length],
    [1, 1, 1],
  );
  log.check(
    "and each is that launch's own first line",
    [
      stdoutLines(first)[0] === first.url,
      stdoutLines(second)[0] === second.url,
      stdoutLines(third)[0] === third.url,
    ],
    [true, true, true],
  );
  log.note(
    `the lines after the URL on the first launch's stdout, which the gate probes provoked: ${JSON.stringify(
      stdoutLines(first)
        .slice(1)
        .map((line) =>
          /^\[auth\] refused code=\w+ method=\w+ path=\S+$/.test(line) ? line : "[unexpected line]",
        ),
    )}`,
  );
  log.check(
    "that line is still the URL of the required shape",
    [
      URL_SHAPE.test(stdoutLines(first)[0] ?? ""),
      URL_SHAPE.test(stdoutLines(second)[0] ?? ""),
      URL_SHAPE.test(stdoutLines(third)[0] ?? ""),
    ],
    [true, true, true],
  );

  cdp.close();
  chromeProc.kill();

  log.section("pairwise distinctness of the committed frames");
  log.check(
    "frames: every committed frame differs from every other in its page facts",
    collapsedPairs(captures),
    [],
  );
  log.note(
    `pairs compared: ${(captures.length * (captures.length - 1)) / 2} (${captures.length} frames)`,
  );

  log.section("frame index");
  log.note("name → sha256 → asserted DOM facts → caption");
  for (const spec of SPECS) {
    const found = captures.find((entry) => entry.name === spec.name);
    if (found === undefined) {
      log.fail(`frame index ${spec.name}`, "no capture was taken");
      continue;
    }
    log.note(`${spec.name} → ${found.sha256} → ${describeFacts(found.facts)} → ${spec.caption}`);
    log.note(`  unmet claims: ${JSON.stringify(unmetClaims(spec, found.facts))}`);
  }

  log.section("the committed artifact carries no token");
  const onDisk = readdirSync(artifactsDir).sort();
  log.check("frames: one committed PNG per key state", onDisk.length, SPECS.length);
  for (const file of onDisk) {
    log.note(`artifact: ${file} (${statSync(join(artifactsDir, file)).size} bytes)`);
  }
  const report = log.lines.join("\n");
  log.check(
    "no committed line carries any launch's operator token",
    [report.includes(first.token), report.includes(second.token), report.includes(third.token)],
    [false, false, false],
  );
  log.check(
    "the URL appears only with its token redacted",
    report.includes("#token=<redacted>"),
    true,
  );

  log.lines.push("");
  log.lines.push(
    `chrome ${CHROME.split("/").at(-1)} over CDP; really launched \`bun run up\`; replayed model; pinned sandbox image`,
  );
  log.lines.push(log.result());

  const written = writeArtifact();
  console.log(
    log.lines.filter((line) => line.includes("RESULT") || line.startsWith("FAIL")).join("\n"),
  );
  console.log(`assert.txt: ${written ?? "(refused: a token was in it)"}`);
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
