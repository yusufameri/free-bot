#!/usr/bin/env bun
/**
 * The U2.1 evidence driver: one run path, driven from the real page.
 *
 * A really launched `apps/server/src/index.ts` is the peer. The page it serves is opened in
 * headless Chrome over CDP, a run is started from the page's own prompt box, answered at the
 * approval card, and followed to its terminal frame — once answering allow and once answering deny.
 * Every assertion is read out of the running system: the DOM, the server's printed token, the
 * socket handshakes, and `docker ps` for the container the run created and destroyed.
 *
 * Real: the loop, the gate and its grant ledger, the run store, the seq-ordered log, the container
 * from the pinned image, the page, the stream. Replayed: the model's turns, read from the committed
 * Pi transcript, because gate G1 parks the keyed provider. Pinned: the sandbox image.
 *
 * Run from the repo root: bun apps/web/scripts/one-run-path.ts
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 * The four states this unit's page shows, each with the claims its caption makes. A caption is not
 * prose a reader trusts: every claim is a predicate over the facts read from the live DOM.
 *
 * There is no "mid-run" frame. After a decision the loop appends the rest of the run in one
 * synchronous burst and turn 2 asks for no call, so a run started this way reaches its terminal
 * frame within a millisecond of the click. A frame captioned "answered, still running" would race
 * that finish and fail the run as often as it passed, so the decided card and the decision marker
 * are asserted in the terminal frames, where nothing races.
 */
const SPECS: readonly FrameSpec[] = [
  {
    name: "01-idle",
    caption:
      "The page is connected to the real server, the run has not started, and the operator's prompt box is the way in.",
    claims: [
      { label: "no message is rendered", holds: (f) => f.frameCount === 0 },
      { label: "the run has not finished", holds: (f) => !f.done },
      { label: "no approval is pending", holds: (f) => f.approvals.length === 0 },
    ],
    visible: "#operator",
  },
  {
    name: "02-approval-pending",
    caption:
      "A run started from the page is parked at the gate: the approval card names the exact command the model asked for, and the tool card waits for the answer.",
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
    name: "03-allowed-done",
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
    name: "04-denied-done",
    caption:
      "Denied and still finished: a denial is the call's refusal rather than the run's ending, so the card is denied with no output, the decision marker names user_denied, and the run reaches its terminal frame.",
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

async function capture(
  cdp: Cdp,
  sessionId: string,
  framesDir: string,
  name: string,
  log: Log,
): Promise<Capture> {
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
  const file = `${name}-${Date.now()}.png`;
  writeFileSync(join(framesDir, file), buffer);
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
    `frame ${name}: frames/${file} (${buffer.byteLength} bytes, sha256 ${sha256}) — ${describeFacts(after)}`,
  );
  return { name, file, bytes: buffer.byteLength, sha256, facts: after };
}

// ---------------------------------------------------------------------------
// The launched server
// ---------------------------------------------------------------------------

interface Launched {
  apiPort: number;
  token: string;
  output: () => string;
  stop: () => Promise<void>;
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

async function bootServer(): Promise<Launched> {
  const server = Bun.spawn(["bun", "apps/server/src/index.ts"], {
    cwd: root,
    env: { ...process.env, PORT: "0", API_PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  for (const stream of [server.stdout, server.stderr]) {
    void (async () => {
      for await (const chunk of stream) output += new TextDecoder().decode(chunk);
    })();
  }
  const apiPort = Number(
    await waitForMatch(() => output, /control plane on http:\/\/127\.0\.0\.1:(\d+)/, 20_000),
  );
  const token = await waitForMatch(() => output, /operator token: (\S+)/, 20_000);
  return {
    apiPort,
    token,
    output: () => output,
    stop: async () => {
      server.kill();
      await server.exited;
    },
  };
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

function containersFor(unit: string): string[] {
  const proc = Bun.spawnSync([
    "docker",
    "ps",
    "-a",
    "--filter",
    `label=freebot.unit=${unit}`,
    "--format",
    "{{.Names}}",
  ]);
  const raw = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
  return raw === "" ? [] : raw.split("\n").filter((name) => name.length > 0);
}

function shortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

const PROMPT = "run one gated command";

/** Click the operator's Start control with a real prompt in its input. */
async function startRun(cdp: Cdp, sessionId: string): Promise<void> {
  await evalJson(
    cdp,
    sessionId,
    `(() => {
      const input = document.querySelector('#prompt');
      input.value = ${JSON.stringify(PROMPT)};
      document.querySelector('#start').click();
    })()`,
  );
}

async function driveAllowPath(
  cdp: Cdp,
  framesDir: string,
  log: Log,
  api: Launched,
): Promise<Capture[]> {
  const captures: Capture[] = [];
  log.section("path: allow once, from the page");
  const sessionId = await openPage(cdp, `http://127.0.0.1:${api.apiPort}/#token=${api.token}`);

  await waitTrue(
    cdp,
    sessionId,
    "the page to connect before the run starts",
    `document.querySelector('#conn').textContent === 'connected' && window.__threadFacts().frameCount === 0`,
  );
  log.check(
    "idle: operator mode is on, so the prompt box is the way in",
    await evalJson(cdp, sessionId, `document.querySelector('#operator').hidden`),
    false,
  );
  log.check(
    "idle: the connection is live",
    await evalJson(cdp, sessionId, "document.querySelector('#conn').textContent"),
    "connected",
  );
  captures.push(await capture(cdp, sessionId, framesDir, "01-idle", log));

  await startRun(cdp, sessionId);
  await waitTrue(
    cdp,
    sessionId,
    "the parked approval",
    `document.querySelector('#thread .approval-card') !== null`,
  );
  log.check(
    "approval: the run is the one the page started",
    await evalJson(cdp, sessionId, "document.querySelector('#run').textContent"),
    "run run-1",
  );
  log.check(
    "approval: the prompt the page sent is the run's prompt",
    await evalJson(
      cdp,
      sessionId,
      "document.querySelector('#thread .message.user .prompt').textContent",
    ),
    PROMPT,
  );
  log.check(
    "approval: the card shows the exact command the model asked for",
    await evalJson(
      cdp,
      sessionId,
      "document.querySelector('#thread .approval-card .cmd').textContent",
    ),
    'bash {"command":"echo native-should-not-run"}',
  );
  log.check(
    "approval: the buttons are the two real answers",
    await evalJson(
      cdp,
      sessionId,
      `[...document.querySelectorAll('#thread .approval-card button')].map((b) => b.textContent)`,
    ),
    ["Allow once", "Deny"],
  );
  const callId = await evalJson<string>(
    cdp,
    sessionId,
    `document.querySelector('#thread .tool-card').dataset.toolCall`,
  );
  log.check(
    "approval: the run's own status frame is rendered, so a parked run does not look frozen",
    await evalJson<number>(
      cdp,
      sessionId,
      `document.querySelectorAll('#thread .run-status[data-run-status="awaiting_approval"]').length`,
    ),
    1,
  );
  captures.push(await capture(cdp, sessionId, framesDir, "02-approval-pending", log));

  await evalJson(
    cdp,
    sessionId,
    `document.querySelector('#thread .approval-card .allow-once').click()`,
  );
  await waitTrue(
    cdp,
    sessionId,
    "the allowed run to finish",
    `document.querySelector('#thread .approval-card').dataset.decision === 'allow' &&
     document.querySelector('#thread .tool-card[data-tool-call="${callId}"] .status').textContent === 'done' &&
     window.__threadFacts().done === true`,
  );
  log.check(
    "post-approval: the card renders the decided state",
    await evalJson(
      cdp,
      sessionId,
      "document.querySelector('#thread .approval-card .approval-result').textContent",
    ),
    "allowed once",
  );
  log.check(
    "post-approval: the decision marker names the allow",
    await evalJson(
      cdp,
      sessionId,
      `document.querySelector('#thread .tool-decision[data-tool-call="${callId}"]').textContent`,
    ),
    `decision ${callId}: allow`,
  );
  // The container's own stdout, which no replayed frame could carry.
  log.check(
    "post-approval: the output is the container's, not a replayed string",
    await evalJson(
      cdp,
      sessionId,
      `document.querySelector('#thread .tool-card[data-tool-call="${callId}"] .output').textContent`,
    ),
    "native-should-not-run\n",
  );
  log.check(
    "post-approval: the run's terminal status frame is rendered",
    await evalJson<number>(
      cdp,
      sessionId,
      `document.querySelectorAll('#thread .run-status[data-run-status="done"]').length`,
    ),
    1,
  );
  log.check(
    "post-approval: the run finished with no stream error",
    await evalJson(cdp, sessionId, "document.querySelector('#error').hidden"),
    true,
  );
  captures.push(await capture(cdp, sessionId, framesDir, "03-allowed-done", log));
  return captures;
}

async function driveDenyPath(
  cdp: Cdp,
  framesDir: string,
  log: Log,
  api: Launched,
): Promise<Capture[]> {
  const captures: Capture[] = [];
  log.section("path: deny, from the page");
  const sessionId = await openPage(cdp, `http://127.0.0.1:${api.apiPort}/#token=${api.token}`);

  await waitTrue(
    cdp,
    sessionId,
    "the page to connect before the run starts",
    `document.querySelector('#conn').textContent === 'connected' && window.__threadFacts().frameCount === 0`,
  );
  await startRun(cdp, sessionId);
  await waitTrue(
    cdp,
    sessionId,
    "the parked approval",
    `document.querySelector('#thread .approval-card') !== null`,
  );
  const callId = await evalJson<string>(
    cdp,
    sessionId,
    `document.querySelector('#thread .tool-card').dataset.toolCall`,
  );
  await evalJson(cdp, sessionId, `document.querySelector('#thread .approval-card .deny').click()`);
  await waitTrue(
    cdp,
    sessionId,
    "the denied run to finish",
    `document.querySelector('#thread .approval-card').dataset.decision === 'deny' &&
     document.querySelector('#thread .tool-card[data-tool-call="${callId}"] .status').textContent === 'denied' &&
     window.__threadFacts().done === true`,
  );
  log.check(
    "deny: the card renders the decided state",
    await evalJson(
      cdp,
      sessionId,
      "document.querySelector('#thread .approval-card .approval-result').textContent",
    ),
    "denied",
  );
  log.check(
    "deny: the refusal is named user_denied, which is the code this unit exists for",
    await evalJson(
      cdp,
      sessionId,
      `document.querySelector('#thread .tool-decision[data-tool-call="${callId}"]').textContent`,
    ),
    `decision ${callId}: deny (user_denied)`,
  );
  log.check(
    "deny: the governed call produced no output",
    await evalJson(
      cdp,
      sessionId,
      `document.querySelector('#thread .tool-card[data-tool-call="${callId}"] .output').textContent`,
    ),
    "",
  );
  log.check(
    "deny: the denied run still reached the terminal frame",
    await evalJson(cdp, sessionId, "document.querySelector('#thread .run-finished').textContent"),
    "stream complete",
  );
  log.check(
    "deny: the run's terminal status frame is rendered",
    await evalJson<number>(
      cdp,
      sessionId,
      `document.querySelectorAll('#thread .run-status[data-run-status="done"]').length`,
    ),
    1,
  );
  captures.push(await capture(cdp, sessionId, framesDir, "04-denied-done", log));
  return captures;
}

let chromeProc: Bun.Subprocess | null = null;
let userDataDir: string | null = null;

function cleanup(): void {
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
  const artifactsDir = join(root, "packages", "verify", "artifacts", "one-run-path", sha);
  const framesDir = join(artifactsDir, "frames");
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  const log = new Log();
  log.note(`# one-run-path live-ui frames — ${new Date().toISOString()}`);
  log.note(`worktree ${root}  head ${sha}  branch ${branch}`);
  log.note(
    "DRIVER DISCLOSURE: the model's turns are replayed from packages/pi-bridge/fixtures/rpc-handshake.jsonl (gate G1 parks the keyed provider) and the sandbox is the pinned image. The loop, the gate, the grant ledger, the run store, the log, the container, the server, the stream and the DOM are real.",
  );

  const api = await bootServer();
  log.note(`server: apps/server/src/index.ts, control plane on 127.0.0.1:${api.apiPort}`);
  // Whatever a previous launch left behind is not this run's business. This run's business is that
  // it adds nothing: the set below is compared with itself after both runs have finished.
  const containersBefore = containersFor("u1.7");

  log.section("the page's stream, both directions of the token");
  const base = `ws://127.0.0.1:${api.apiPort}/events`;
  log.check("a page stream with no token is refused", await handshake(base), "refused");
  log.check(
    "a page stream with a wrong token is refused",
    await handshake(`${base}?token=0000`),
    "refused",
  );
  const accepted = new WebSocket(`${base}?token=${api.token}`);
  const hello = await new Promise<string>((resolve) => {
    accepted.addEventListener("message", (event) => resolve(String(event.data)));
    setTimeout(() => resolve("(no message)"), 5_000);
  });
  log.check(
    "a page stream with the printed token is accepted and helloed",
    hello,
    JSON.stringify({ v: 1, type: "stream.hello", payload: { firstSeq: null, lastSeq: 0 } }),
  );
  accepted.close();

  userDataDir = join(tmpdir(), `freebot-one-run-path-${Date.now()}`);
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
  const [port = "", wsPath = ""] = readFileSync(portFile, "utf8").split("\n");
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

  // One server per path, so each page's stream carries exactly one run: the page joins at seq 0 and
  // the log it replays is its own run's.
  const captures: Capture[] = [];
  try {
    captures.push(...(await driveAllowPath(cdp, framesDir, log, api)));
  } finally {
    await api.stop();
  }

  const denyApi = await bootServer();
  log.note(`server: apps/server/src/index.ts, control plane on 127.0.0.1:${denyApi.apiPort}`);
  try {
    captures.push(...(await driveDenyPath(cdp, framesDir, log, denyApi)));
  } finally {
    await denyApi.stop();
  }
  cdp.close();

  log.check(
    "the token appears in the server's output exactly once",
    [api.output().split(api.token).length - 1, denyApi.output().split(denyApi.token).length - 1],
    [1, 1],
  );
  // The loop destroys the sandbox after its last frame, so the container goes away a moment after
  // the run's terminal status, not with it.
  const settlesBy = Date.now() + 30_000;
  while (Date.now() < settlesBy && containersFor("u1.7").length !== containersBefore.length) {
    await sleep(200);
  }
  log.check(
    "the runs added no container: the label's container set is exactly what it was before them",
    [containersBefore, containersFor("u1.7")],
    [containersBefore, containersBefore],
  );

  log.section("pairwise distinctness of the committed frames");
  const collapsed = collapsedPairs(captures);
  log.check(
    "frames: every committed frame differs from every other in its page facts",
    collapsed,
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

  const onDisk = readdirSync(framesDir).sort();
  log.check("frames: one committed PNG per key state", onDisk.length, SPECS.length);
  for (const file of onDisk) {
    log.note(`frame artifact: frames/${file} (${statSync(join(framesDir, file)).size} bytes)`);
  }

  log.lines.push("");
  log.lines.push(
    `chrome ${CHROME.split("/").at(-1)} over CDP; really launched apps/server/src/index.ts; replayed model; pinned sandbox image`,
  );
  log.lines.push(log.result());

  const header = [
    "feature: one-run-path",
    "command: bun apps/web/scripts/one-run-path.ts",
    `timestamp: ${new Date().toISOString()}`,
    `git sha: ${full}`,
    `git sha short: ${sha}`,
    `branch: ${branch}`,
    `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
    `pinned image: freebot-sandbox:u0.6`,
    `transcript: packages/pi-bridge/fixtures/rpc-handshake.jsonl`,
    "",
  ];
  writeFileSync(join(artifactsDir, "assert.txt"), `${[...header, ...log.lines, ""].join("\n")}\n`);
  console.log(
    log.lines.filter((line) => line.includes("RESULT") || line.startsWith("FAIL")).join("\n"),
  );
  console.log(`assert.txt: ${join(artifactsDir, "assert.txt")}`);
  return log.failed === 0 ? 0 : 1;
}

try {
  const code = await main();
  cleanup();
  process.exit(code);
} catch (err) {
  console.error(`driver crashed: ${err instanceof Error ? err.message : String(err)}`);
  cleanup();
  process.exit(1);
}
