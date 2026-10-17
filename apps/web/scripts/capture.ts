#!/usr/bin/env bun
/**
 * The evidence driver: runs the surface headlessly through the eight key states and writes
 * `packages/verify/artifacts/web-shell/<short-sha>/assert.txt` plus one PNG per state.
 *
 * Every frame records the facts read from the live DOM, twice (before and after the screenshot, so
 * a capture that lost its race fails the run), and each caption's claims are evaluated against
 * those same facts. Distinctness is pairwise over the facts, so two frames may never document the
 * same page whatever their bytes. Exits nonzero on any failed check.
 *
 * Run from the repo root: bun apps/web/scripts/capture.ts
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
  FRAME_SPECS,
  type FrameFacts,
  factsKey,
  specFor,
  unmetClaims,
} from "../../../packages/ui/src/index.ts";
import { GATED_CALL, loadFixture, seqOf, seqOfToolResult } from "./fixture.ts";
import { startReplayServer } from "./server.ts";

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
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evalJson<boolean>(cdp, sessionId, expression)) return;
    await sleep(40);
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

async function factsOf(cdp: Cdp, sessionId: string): Promise<FrameFacts> {
  return evalJson<FrameFacts>(cdp, sessionId, "window.__threadFacts()");
}

async function release(cdp: Cdp, sessionId: string): Promise<void> {
  await evalJson(cdp, sessionId, "window.__threadSend({ type: 'resume' })");
}

/** The facts read straight from the DOM by the driver, independent of the page's own hook. */
type DomFacts = { frames: number; lastSeq: number; statuses: string[] };

async function domFacts(cdp: Cdp, sessionId: string): Promise<DomFacts> {
  return evalJson<DomFacts>(
    cdp,
    sessionId,
    `({
      frames: document.querySelectorAll('#thread .frame[data-seq]').length,
      lastSeq: Math.max(0, ...[...document.querySelectorAll('#thread .frame[data-seq]')].map((e) => Number(e.dataset.seq))),
      statuses: [...document.querySelectorAll('#thread .tool-card .status')].map((e) => e.textContent),
    })`,
  );
}

/** Whether the element the caption is about actually landed in the captured pixels. */
type VisibleBox = { count: number; offscreen: number };

async function captionElement(cdp: Cdp, sessionId: string, selector: string): Promise<VisibleBox> {
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

async function capture(
  cdp: Cdp,
  sessionId: string,
  framesDir: string,
  name: string,
  log: Log,
  prep: string | null,
): Promise<Capture> {
  const spec = specFor(name);
  if (prep !== null) await evalJson(cdp, sessionId, prep);
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
    [dom.frames, dom.lastSeq, dom.statuses],
    [after.frameCount, after.lastSeq, after.cards.map(([, status]) => status)],
  );
  for (const claim of spec.claims) {
    log.check(`frame ${name}: claim - ${claim.label}`, claim.holds(after), true);
  }
  log.note(
    `frame ${name}: frames/${file} (${buffer.byteLength} bytes, sha256 ${sha256}) — ${describeFacts(after)}${prep === null ? "" : ` — scrolled to ${prep}`}`,
  );
  return { name, file, bytes: buffer.byteLength, sha256, facts: after };
}

type PathResult = { captures: Capture[]; answers: string[]; head: number };

async function captureAllowPath(cdp: Cdp, framesDir: string, log: Log): Promise<PathResult> {
  const messages = loadFixture("allow");
  const head = messages.at(-1)?.seq ?? 0;
  const streamingHold = seqOf(
    messages,
    "tool_call.requested",
    (message) =>
      message.type === "tool_call.requested" && message.payload.toolCallId === "call_spike_1",
  );
  const runningHold = seqOfToolResult(messages, "call_spike_1");
  const postApprovalHold = seqOfToolResult(messages, GATED_CALL);
  const turn2 = seqOf(
    messages,
    "turn.started",
    (m) => m.type === "turn.started" && m.payload.turn === 2,
  );
  const dropAt = turn2 + 20;
  const resumeHold = dropAt + 1;
  const holds = [streamingHold, runningHold, resumeHold, postApprovalHold];

  const server = await startReplayServer({ variant: "allow", paceMs: 45, initialDelayMs: 1100 });
  const captures: Capture[] = [];
  log.section("path: allow once (with a mid-stream kill and rejoin)");
  log.note(`hold_before ${holds.join(",")}; drop_at ${dropAt}; fixture head ${head}`);
  try {
    const sessionId = await openPage(
      cdp,
      `http://127.0.0.1:${server.port}/?hold_before=${holds.join(",")}&drop_at=${dropAt}&echo_last=1`,
    );

    await waitTrue(
      cdp,
      sessionId,
      "the page connected before the stream started",
      `document.querySelector('#conn').textContent === 'connected' && window.__threadFacts().frameCount === 0`,
    );
    log.check(
      "idle: the connection is live",
      await evalJson(cdp, sessionId, "document.querySelector('#conn').textContent"),
      "connected",
    );
    captures.push(await capture(cdp, sessionId, framesDir, "01-idle", log, null));

    await waitTrue(
      cdp,
      sessionId,
      "the streaming park",
      `window.__threadFacts().lastSeq === ${streamingHold - 1}`,
    );
    captures.push(
      await capture(
        cdp,
        sessionId,
        framesDir,
        "02-streaming",
        log,
        `[...document.querySelectorAll('#thread .delta')].at(-1).scrollIntoView({ block: 'center' })`,
      ),
    );

    await release(cdp, sessionId);
    await waitTrue(
      cdp,
      sessionId,
      "the running-call park",
      `window.__threadFacts().lastSeq === ${runningHold - 1}`,
    );
    log.check(
      "tool-running: the card shows the literal command",
      await evalJson(
        cdp,
        sessionId,
        `document.querySelector('#thread .tool-card .cmd').textContent`,
      ),
      `spike_echo {"note":"one","delay_ms":200}`,
    );
    captures.push(
      await capture(
        cdp,
        sessionId,
        framesDir,
        "03-tool-running",
        log,
        `document.querySelector('#thread .tool-card').scrollIntoView({ block: 'center' })`,
      ),
    );

    await release(cdp, sessionId);
    await waitTrue(
      cdp,
      sessionId,
      "the reconnect banner",
      `document.querySelector('#resume')?.dataset.resumedFrom !== undefined`,
    );
    log.check(
      "resume: the banner names the seq the page had",
      await evalJson(cdp, sessionId, "document.querySelector('#resume').textContent"),
      `resumed from seq ${dropAt}`,
    );
    log.check(
      "resume: exactly one element for the replayed seq",
      await evalJson<number>(
        cdp,
        sessionId,
        `document.querySelectorAll('#thread [data-seq="${dropAt}"]').length`,
      ),
      1,
    );
    log.check(
      "resume: the duplicate was counted and ignored",
      await evalJson(cdp, sessionId, `document.querySelector('#dups').textContent`),
      "duplicates ignored: 1",
    );
    log.check(
      "resume: the frame count still equals the last seq",
      await evalJson<boolean>(
        cdp,
        sessionId,
        `window.__threadFacts().frameCount === window.__threadFacts().lastSeq`,
      ),
      true,
    );
    captures.push(
      await capture(
        cdp,
        sessionId,
        framesDir,
        "04-resumed-after-kill",
        log,
        `document.querySelector('#resume').scrollIntoView({ block: 'center' })`,
      ),
    );

    await release(cdp, sessionId);
    await waitTrue(
      cdp,
      sessionId,
      "the parked approval",
      `document.querySelector('#thread .approval-card') !== null`,
    );
    log.check(
      "approval: the card shows the exact gated command",
      await evalJson(
        cdp,
        sessionId,
        `document.querySelector('#thread .approval-card .cmd').textContent`,
      ),
      `spike_echo {"note":"two","delay_ms":200}`,
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
    captures.push(
      await capture(
        cdp,
        sessionId,
        framesDir,
        "05-approval-pending",
        log,
        `document.querySelector('#thread .approval-card').scrollIntoView({ block: 'center' })`,
      ),
    );

    await evalJson(
      cdp,
      sessionId,
      `document.querySelector('#thread .approval-card .allow-once').click()`,
    );
    await waitTrue(
      cdp,
      sessionId,
      "the allowed decision, parked before the result",
      `document.querySelector('#thread .approval-card').dataset.decision === 'allow' && window.__threadFacts().lastSeq === ${postApprovalHold - 1}`,
    );
    log.check(
      "post-approval: the card renders the decided state",
      await evalJson(
        cdp,
        sessionId,
        `document.querySelector('#thread .approval-card .approval-result').textContent`,
      ),
      "allowed once",
    );
    log.check(
      "post-approval: the grant was issued and recorded",
      await evalJson(
        cdp,
        sessionId,
        `document.querySelector('#thread .grant-lifecycle').textContent`,
      ),
      "grant grant-ap-call_spike_2: issued",
    );
    captures.push(
      await capture(
        cdp,
        sessionId,
        framesDir,
        "06-post-approval",
        log,
        `document.querySelector('#thread .approval-card').scrollIntoView({ block: 'center' })`,
      ),
    );

    await release(cdp, sessionId);
    await waitTrue(cdp, sessionId, "the run to finish", `window.__threadFacts().done === true`);
    const done = await factsOf(cdp, sessionId);
    log.check("done: the page reported the run finished", done.done, true);
    log.check("done: one rendered message per seq", done.frameCount, done.lastSeq);
    log.check("done: the fixture's whole log was rendered", done.lastSeq, head);
    log.check("done: every tool card reached a terminal status", done.cards, [
      ["call_spike_1", "done"],
      ["call_spike_2", "done"],
      ["call_spike_3", "done"],
    ]);
    log.check(
      "done: no stream error",
      await evalJson(cdp, sessionId, "document.querySelector('#error').hidden"),
      true,
    );
    captures.push(
      await capture(
        cdp,
        sessionId,
        framesDir,
        "07-done",
        log,
        `document.querySelector('#thread .run-finished').scrollIntoView({ block: 'center' })`,
      ),
    );
    log.check("the allow path answered the gate once", server.answers, ["allow"]);
  } finally {
    server.stop();
  }
  return { captures, answers: server.answers, head };
}

async function captureDenyPath(cdp: Cdp, framesDir: string, log: Log): Promise<PathResult> {
  const messages = loadFixture("deny");
  const head = messages.at(-1)?.seq ?? 0;
  const hold = seqOfToolResult(messages, GATED_CALL) + 1;

  const server = await startReplayServer({ variant: "deny", paceMs: 45, initialDelayMs: 900 });
  const captures: Capture[] = [];
  log.section("path: deny");
  log.note(`hold_before ${hold}; fixture head ${head}`);
  try {
    const sessionId = await openPage(cdp, `http://127.0.0.1:${server.port}/?hold_before=${hold}`);
    await waitTrue(
      cdp,
      sessionId,
      "the parked approval",
      `document.querySelector('#thread .approval-card') !== null`,
    );
    await evalJson(
      cdp,
      sessionId,
      `document.querySelector('#thread .approval-card .deny').click()`,
    );
    await waitTrue(
      cdp,
      sessionId,
      "the denial to land",
      `window.__threadFacts().lastSeq === ${hold - 1}`,
    );
    log.check(
      "deny: the card renders the decided state",
      await evalJson(
        cdp,
        sessionId,
        `document.querySelector('#thread .approval-card .approval-result').textContent`,
      ),
      "denied",
    );
    log.check(
      "deny: the governed call produced no output",
      await evalJson(
        cdp,
        sessionId,
        `document.querySelector('#thread .tool-card[data-tool-call="${GATED_CALL}"] .output').textContent`,
      ),
      "",
    );
    log.check(
      "deny: the denial reason names the gate code",
      await evalJson(
        cdp,
        sessionId,
        `document.querySelector('#thread .tool-decision[data-tool-call="${GATED_CALL}"]').textContent`,
      ),
      `decision ${GATED_CALL}: deny (no_grant)`,
    );
    log.check("the deny path answered the gate once", server.answers, ["deny"]);
    captures.push(
      await capture(
        cdp,
        sessionId,
        framesDir,
        "08-denied",
        log,
        `document.querySelector('#thread .approval-card').scrollIntoView({ block: 'center' })`,
      ),
    );
  } finally {
    server.stop();
  }
  return { captures, answers: server.answers, head };
}

function shortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

function typecheckWeb(log: Log): void {
  const proc = Bun.spawnSync(["bun", "run", "typecheck"], {
    cwd: join(root, "apps/web"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
  log.check("preflight: apps/web typechecks against its own tsconfig", proc.exitCode, 0);
  if (proc.exitCode !== 0) log.note(output);
}

let chromeProc: Bun.Subprocess | null = null;
let userDataDir: string | null = null;

function cleanup(): void {
  chromeProc?.kill();
  if (userDataDir !== null) rmSync(userDataDir, { recursive: true, force: true });
}

async function main(): Promise<number> {
  const sha = shortSha();
  const artifactsDir = join(root, "packages", "verify", "artifacts", "web-shell", sha);
  const framesDir = join(artifactsDir, "frames");
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  const log = new Log();
  log.note(`# web-shell key-state frames — ${new Date().toISOString()}`);
  log.note(`worktree ${root}  head ${sha}`);
  log.note(
    "DRIVER DISCLOSURE: the surface renders committed fixtures of the recorded U0.10 smoke session. No model, no provider, no key, localhost only (order 9).",
  );
  typecheckWeb(log);

  userDataDir = join(tmpdir(), `freebot-web-shell-${Date.now()}`);
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

  const captures: Capture[] = [];
  for (const [name, runPath] of [
    ["allow", captureAllowPath],
    ["deny", captureDenyPath],
  ] as const) {
    const before = { passed: log.passed, failed: log.failed };
    try {
      const result = await runPath(cdp, framesDir, log);
      captures.push(...result.captures);
    } catch (err) {
      log.fail(`${name} path scenario`, err);
    }
    const passed = log.passed - before.passed;
    const failed = log.failed - before.failed;
    log.lines.push(
      `RESULT: ${failed === 0 ? "PASS" : "FAIL"} (${passed}/${passed + failed}) — ${name} path`,
    );
  }
  cdp.close();

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
  for (const spec of FRAME_SPECS) {
    const found = captures.find((entry) => entry.name === spec.name);
    if (found === undefined) {
      log.fail(`frame index ${spec.name}`, "no capture was taken");
      continue;
    }
    log.note(`${spec.name} → ${found.sha256} → ${describeFacts(found.facts)} → ${spec.caption}`);
    log.note(`  claims: ${spec.claims.map((claim) => claim.label).join("; ")}`);
    log.note(`  unmet claims: ${JSON.stringify(unmetClaims(spec, found.facts))}`);
  }

  const onDisk = readdirSync(framesDir).sort();
  log.check("frames: one committed PNG per key state", onDisk.length, FRAME_SPECS.length);
  for (const file of onDisk) {
    log.note(`frame artifact: frames/${file} (${statSync(join(framesDir, file)).size} bytes)`);
  }

  log.lines.push("");
  log.lines.push(
    `chrome ${cdp.version}; deterministic replay of committed fixtures, localhost only, no model`,
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
