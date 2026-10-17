// CDP driver for the web-stream spike: runs the allow and deny flows headlessly and
// writes the assertion log plus timestamped frame captures under
// packages/verify/artifacts/web-stream/<short-sha>/. Exits nonzero on any failed check.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DESTRUCTIVE_TOOL_CALL_ID } from "./map.ts";
import { startStubServer } from "./stub-server.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FIXTURE = new URL(
  "../../packages/verify/artifacts/tunnel/bf0a4e6/transcript.jsonl",
  import.meta.url,
).pathname;
const EXPECTED_FRAMES = 84;
const EXPECTED_TURNS = 4;
const DROP_AT = 30;
const PAUSE_SEQ = 53;
const RESOLVED_SEQ = 54;
const RESULT_SEQ = 55;
const DESTRUCTIVE = DEFAULT_DESTRUCTIVE_TOOL_CALL_ID;

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

  once(predicate: (msg: CdpReply) => boolean, desc: string, timeoutMs = 15_000): Promise<CdpReply> {
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

  get failed(): number {
    return this.#failed;
  }

  get passed(): number {
    return this.#passed;
  }

  result(): string {
    const total = this.#passed + this.#failed;
    return `RESULT: ${this.#failed === 0 ? "PASS" : "FAIL"} (${this.#passed}/${total})`;
  }
}

type PageState = {
  lastSeq: number;
  frameCount: number;
  duplicatesIgnored: number;
  resumedFrom: number | null;
  awaitingApproval: boolean;
  done: boolean;
  error: string | null;
};

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

async function pageState(cdp: Cdp, sessionId: string): Promise<PageState> {
  return evalJson<PageState>(cdp, sessionId, "window.__webStreamState()");
}

async function waitTrue(
  cdp: Cdp,
  sessionId: string,
  desc: string,
  expression: string,
  timeoutMs = 25_000,
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
  return sessionId;
}

async function shot(
  cdp: Cdp,
  sessionId: string,
  framesDir: string,
  name: string,
  prep?: string,
): Promise<{ file: string; bytes: number }> {
  if (prep !== undefined) await evalJson(cdp, sessionId, prep);
  const { data } = await cdp.send<{ data: string }>(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: true },
    sessionId,
  );
  const buffer = Buffer.from(data, "base64");
  const file = `${name}-${Date.now()}.png`;
  writeFileSync(join(framesDir, file), buffer);
  return { file, bytes: buffer.byteLength };
}

async function seqsAndState(
  cdp: Cdp,
  sessionId: string,
): Promise<{ seqs: number[]; state: PageState }> {
  const out = await evalJson<{ seqs: number[]; state: PageState }>(
    cdp,
    sessionId,
    `({ seqs: [...document.querySelectorAll('.frame[data-seq]')].map((e) => Number(e.dataset.seq)), state: window.__webStreamState() })`,
  );
  return out;
}

async function runPath(
  cdp: Cdp,
  framesDir: string,
  path: "allow" | "deny",
  log: Log,
): Promise<void> {
  const stub = await startStubServer({ transcriptPath: FIXTURE, paceMs: 90, initialDelayMs: 900 });
  log.section(`${path} path`);
  try {
    const sessionId = await openPage(
      cdp,
      `http://127.0.0.1:${stub.port}/?drop_at=${DROP_AT}&echo_last=1`,
    );

    await waitTrue(
      cdp,
      sessionId,
      "page connected before the first frame",
      `document.querySelector('#conn').textContent === 'connected' && window.__webStreamState().frameCount === 0`,
    );
    const idle = await pageState(cdp, sessionId);
    log.check(
      "idle: connection is live",
      await evalJson(cdp, sessionId, "document.querySelector('#conn').textContent"),
      "connected",
    );
    log.check("idle: zero frames rendered", idle.frameCount, 0);
    log.check("idle: no error", idle.error, null);
    const idleShot = await shot(cdp, sessionId, framesDir, `${path}-01-idle`);
    log.note(
      `frame ${path}-01-idle: ${idleShot.file} (${idleShot.bytes} bytes) — page connected, stream not started`,
    );

    await waitTrue(
      cdp,
      sessionId,
      "streaming frames",
      `window.__webStreamState().frameCount >= 8 && window.__webStreamState().resumedFrom === null`,
    );
    const streaming = await seqsAndState(cdp, sessionId);
    const badDense = streaming.seqs
      .map((seq, index) => (seq === index + 1 ? null : seq))
      .filter((v) => v !== null);
    log.check("streaming: every rendered seq is dense from 1", badDense, []);
    log.check(
      "streaming: at least one assistant delta rendered",
      await evalJson(
        cdp,
        sessionId,
        `[...document.querySelectorAll('.delta')].some((e) => e.textContent === 'turn-1-chunk-0 ')`,
      ),
      true,
    );
    const streamShot = await shot(cdp, sessionId, framesDir, `${path}-02-streaming`);
    log.note(
      `frame ${path}-02-streaming: ${streamShot.file} (${streamShot.bytes} bytes) — first turn text streaming, first tool card visible`,
    );

    await waitTrue(
      cdp,
      sessionId,
      "reconnect banner",
      `document.querySelector('#resume')?.dataset.resumedFrom === '${DROP_AT}'`,
    );
    const resumed = await seqsAndState(cdp, sessionId);
    log.check(
      "resume: banner text",
      await evalJson(cdp, sessionId, "document.querySelector('#resume').textContent"),
      `resumed from seq ${DROP_AT}`,
    );
    log.check(
      "resume: exactly one element for the replayed seq",
      await evalJson<number>(
        cdp,
        sessionId,
        `document.querySelectorAll('[data-seq="${DROP_AT}"]').length`,
      ),
      1,
    );
    log.check("resume: duplicate frame counted and ignored", resumed.state.duplicatesIgnored, 1);
    log.check(
      "resume: continued densely past the replay",
      resumed.seqs.map((seq, index) => (seq === index + 1 ? null : seq)).filter((v) => v !== null),
      [],
    );
    log.check(
      "resume: rendered count matches last seq",
      resumed.state.frameCount,
      resumed.state.lastSeq,
    );
    const resumeShot = await shot(cdp, sessionId, framesDir, `${path}-03-reconnect-resume`);
    log.note(
      `frame ${path}-03-reconnect-resume: ${resumeShot.file} (${resumeShot.bytes} bytes) — banner "resumed from seq ${DROP_AT}", replay of seq ${DROP_AT} changed nothing`,
    );

    await waitTrue(
      cdp,
      sessionId,
      "approval card",
      `document.querySelector('.approval-card') !== null`,
    );
    log.check(
      "approval: stream is awaiting an answer",
      (await pageState(cdp, sessionId)).awaitingApproval,
      true,
    );
    log.check(
      "approval: tool card waits",
      await evalJson(
        cdp,
        sessionId,
        `document.querySelector('.tool-card[data-tool-call="${DESTRUCTIVE}"] .status').textContent`,
      ),
      "awaiting approval",
    );
    log.check(
      "approval: card shows the gated command",
      await evalJson(cdp, sessionId, `document.querySelector('.approval-card .cmd').textContent`),
      `spike_echo {"note":"two","delay_ms":200}`,
    );
    log.check(
      "approval: buttons",
      await evalJson(
        cdp,
        sessionId,
        `[...document.querySelectorAll('.approval-card button')].map((b) => b.textContent)`,
      ),
      ["Allow once", "Deny"],
    );
    const frozen1 = await pageState(cdp, sessionId);
    await sleep(700);
    const frozen2 = await pageState(cdp, sessionId);
    log.check(
      "approval: stream frozen at the gate",
      [frozen1.lastSeq, frozen2.lastSeq],
      [PAUSE_SEQ, PAUSE_SEQ],
    );
    const pendingShot = await shot(
      cdp,
      sessionId,
      framesDir,
      `${path}-04-approval-pending`,
      `document.querySelector('.approval-card').scrollIntoView({ block: 'center' })`,
    );
    log.note(
      `frame ${path}-04-approval-pending: ${pendingShot.file} (${pendingShot.bytes} bytes) — approval card with Allow once / Deny, stream paused at seq ${PAUSE_SEQ}`,
    );

    const buttonClass = path === "allow" ? "allow-once" : "deny";
    await evalJson(
      cdp,
      sessionId,
      `document.querySelector('.approval-card .${buttonClass}').click()`,
    );
    await waitTrue(
      cdp,
      sessionId,
      "approval resolution",
      `document.querySelector('.approval-card').dataset.decision === '${path}'`,
    );
    log.check(
      "resolved: card decision",
      await evalJson(cdp, sessionId, `document.querySelector('.approval-card').dataset.decision`),
      path,
    );
    log.check(
      "resolved: decision text",
      await evalJson(
        cdp,
        sessionId,
        `document.querySelector('.approval-card .approval-result').textContent`,
      ),
      path === "allow" ? "allowed once" : "denied",
    );
    log.check(
      `resolved: marker at seq ${RESOLVED_SEQ}`,
      await evalJson(
        cdp,
        sessionId,
        `document.querySelector('.approval-resolved[data-seq="${RESOLVED_SEQ}"]').textContent`,
      ),
      `approval ap-${DESTRUCTIVE}: ${path === "allow" ? "allowed once" : "denied"}`,
    );

    if (path === "allow") {
      await waitTrue(
        cdp,
        sessionId,
        "gated tool result",
        `document.querySelector('.tool-card[data-tool-call="${DESTRUCTIVE}"] .status').textContent === 'done'`,
      );
      log.check(
        "allow: tool card status",
        await evalJson(
          cdp,
          sessionId,
          `document.querySelector('.tool-card[data-tool-call="${DESTRUCTIVE}"] .status').textContent`,
        ),
        "done",
      );
      log.check(
        "allow: tool card output",
        await evalJson(
          cdp,
          sessionId,
          `document.querySelector('.tool-card[data-tool-call="${DESTRUCTIVE}"] .output').textContent`,
        ),
        "echo: two",
      );
      log.check(
        `allow: result marker at seq ${RESULT_SEQ}`,
        await evalJson(
          cdp,
          sessionId,
          `document.querySelector('.tool-result[data-seq="${RESULT_SEQ}"]').textContent`,
        ),
        `result ${DESTRUCTIVE}: done in 211ms`,
      );
    } else {
      await waitTrue(
        cdp,
        sessionId,
        "denied tool result",
        `document.querySelector('.tool-result[data-seq="${RESULT_SEQ}"]') !== null`,
      );
      log.check(
        "deny: tool card status",
        await evalJson(
          cdp,
          sessionId,
          `document.querySelector('.tool-card[data-tool-call="${DESTRUCTIVE}"] .status').textContent`,
        ),
        "denied",
      );
      log.check(
        "deny: tool card has no output",
        await evalJson(
          cdp,
          sessionId,
          `document.querySelector('.tool-card[data-tool-call="${DESTRUCTIVE}"] .output').textContent`,
        ),
        "",
      );
      log.check(
        "deny: no output leaks onto the card",
        await evalJson(
          cdp,
          sessionId,
          `document.querySelector('.tool-card[data-tool-call="${DESTRUCTIVE}"]').textContent.includes('echo: two')`,
        ),
        false,
      );
      log.check(
        `deny: result marker at seq ${RESULT_SEQ}`,
        await evalJson(
          cdp,
          sessionId,
          `document.querySelector('.tool-result[data-seq="${RESULT_SEQ}"]').textContent`,
        ),
        `result ${DESTRUCTIVE}: denied`,
      );
    }
    const resolvedShot = await shot(
      cdp,
      sessionId,
      framesDir,
      `${path}-05-resolved`,
      `document.querySelector('.approval-card').scrollIntoView({ block: 'center' })`,
    );
    log.note(
      `frame ${path}-05-resolved: ${resolvedShot.file} (${resolvedShot.bytes} bytes) — ${path === "allow" ? "allowed once, tool card done with output" : "denied, tool card denied with no output"}`,
    );

    await waitTrue(cdp, sessionId, "stream end", `window.__webStreamState().done === true`);
    const done = await seqsAndState(cdp, sessionId);
    log.check("done: page reported done", done.state.done, true);
    log.check("done: frame count", done.state.frameCount, EXPECTED_FRAMES);
    log.check("done: last seq", done.state.lastSeq, EXPECTED_FRAMES);
    log.check(
      "done: full seq range 1..84 in order",
      done.seqs,
      Array.from({ length: EXPECTED_FRAMES }, (_, i) => i + 1),
    );
    log.check(
      "done: rendered elements",
      await evalJson<number>(
        cdp,
        sessionId,
        `document.querySelectorAll('.frame[data-seq]').length`,
      ),
      EXPECTED_FRAMES,
    );
    log.check(
      "done: turns",
      await evalJson<number>(cdp, sessionId, `document.querySelectorAll('.turn').length`),
      EXPECTED_TURNS,
    );
    log.check(
      "done: tool card statuses",
      await evalJson(
        cdp,
        sessionId,
        `[...document.querySelectorAll('.tool-card')].map((c) => [c.dataset.toolCall, c.querySelector('.status').textContent])`,
      ),
      [
        ["call_spike_1", "done"],
        [DESTRUCTIVE, path === "allow" ? "done" : "denied"],
        ["call_spike_3", "done"],
      ],
    );
    log.check("done: no error", done.state.error, null);
    const doneShot = await shot(
      cdp,
      sessionId,
      framesDir,
      `${path}-06-done`,
      `window.scrollTo(0, document.body.scrollHeight)`,
    );
    log.note(
      `frame ${path}-06-done: ${doneShot.file} (${doneShot.bytes} bytes) — full stream at ${EXPECTED_FRAMES} frames, all turns complete`,
    );
  } finally {
    stub.stop();
  }
}

function shortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

let chromeProc: Bun.Subprocess | null = null;
let userDataDir: string | null = null;

function cleanup(): void {
  chromeProc?.kill();
  if (userDataDir !== null) rmSync(userDataDir, { recursive: true, force: true });
}

async function main(): Promise<number> {
  const root = new URL("../../", import.meta.url).pathname;
  const sha = shortSha();
  const artifactsDir = join(root, "packages/verify/artifacts/web-stream", sha);
  const framesDir = join(artifactsDir, "frames");
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  const log = new Log();
  log.note(`# web-stream spike driver — ${new Date().toISOString()}`);
  log.note(`worktree ${root}  head ${sha}`);
  log.note(`fixture ${FIXTURE}`);

  userDataDir = join(tmpdir(), `freebot-web-stream-${Date.now()}`);
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
      "--window-size=1280,1700",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const portFile = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
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
  const version = await cdp.send<{ product: string }>("Browser.getVersion");
  log.note(`chrome ${version.product}`);

  for (const path of ["allow", "deny"] as const) {
    const before = { passed: log.passed, failed: log.failed };
    try {
      await runPath(cdp, framesDir, path, log);
    } catch (err) {
      log.fail(`${path} path scenario`, err);
    }
    const passed = log.passed - before.passed;
    const failed = log.failed - before.failed;
    log.lines.push(
      `RESULT: ${failed === 0 ? "PASS" : "FAIL"} (${passed}/${passed + failed}) — ${path} path`,
    );
  }
  cdp.close();

  const frames = readdirSync(framesDir).sort();
  for (const file of frames) {
    log.lines.push(
      `frame artifact: frames/${file} (${statSync(join(framesDir, file)).size} bytes)`,
    );
  }
  if (frames.length === 0) log.fail("frame captures", "no PNGs were written");

  log.lines.push(
    `chrome ${version.product}; deterministic replay, both answer paths, localhost only`,
  );
  log.lines.push(log.result());
  writeFileSync(join(artifactsDir, "assert.txt"), `${log.lines.join("\n")}\n`);
  console.log(
    log.lines.filter((line) => line.includes("RESULT") || line.startsWith("FAIL")).join("\n"),
  );
  console.log(`assert.txt: ${join(artifactsDir, "assert.txt")}`);
  return log.failed === 0 ? 0 : 1;
}

function statSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
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
