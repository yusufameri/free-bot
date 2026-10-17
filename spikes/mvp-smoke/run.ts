#!/usr/bin/env bun
/**
 * The U0.11 MVP smoke dry run: the whole Phase 0 pipeline, headless, keyless, one command.
 *
 * Composition (docs/mvp-smoke-dry-run.md has the diagram): the pinned sandbox image (Pi 1.3.0
 * under node) plus this spike's supervisor (mints the one seq, carries the gate dialog) and
 * tunnel agent run inside the container; the host runs the composer (U0.7 protocol + U0.8 grant
 * policy + the host->Pi gate dialog path + the page server) and a byte-transparent relay the
 * container dials through; the page is the U0.10 renderer, driven over CDP.
 *
 * The task is scripted by a keyless stub model (spikes/forge-test-a/stub-model.ts): three
 * steps (echo, a gated rm, echo) plus two probe calls (a repeated rm and a second rm the page
 * denies). Every call goes through the real grant gate. Mid-task the harness SIGKILLs the relay
 * and the composer: the agent rejoins with last_seen_seq, the page resumes from its last seq,
 * and the task completes on one gapless, duplicate-free seq log.
 *
 * STUB DISCLOSURE: the stub decision source IS the model this round. Nothing here is
 * live-model traffic; Gate G1 parks the keyed run (U0.12), which replaces only the decision
 * source.
 *
 * README-equivalent: docs/mvp-smoke-dry-run.md. Artifacts: packages/verify/artifacts/mvp-smoke/
 * <short-sha>/. Docker cleanup is name-scoped to the container and images this run created.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type StubModel, startStubModel } from "../forge-test-a/stub-model.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROMPT = "Run the smoke task: call the shell tool exactly as each scripted step names it.";
const TASK_DIR = "/scratch/task";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const STEPS = {
  step1: { callId: "call_step_1", command: "echo one" },
  step2: { callId: "call_step_2", command: "rm -f /scratch/task/doomed.txt" },
  step3: { callId: "call_step_3", command: "sleep 3 && echo two" },
  step4: { callId: "call_step_4", command: "rm -f /scratch/task/doomed.txt" },
  step5: { callId: "call_step_5", command: "rm -f /scratch/task/doomed2.txt" },
} as const;

interface Service {
  port: number;
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  lines: string[];
  stop: () => void;
}

function run(command: string[]): { code: number; out: string } {
  const proc = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode ?? 1,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`.trim(),
  };
}

function docker(args: string[]): { code: number; out: string } {
  return run(["docker", ...args]);
}

function dockerStrict(args: string[], what: string): string {
  const result = docker(args);
  if (result.code !== 0) throw new Error(`docker ${what} failed: ${result.out}`);
  return result.out;
}

function dockerExec(
  container: string,
  command: string,
  detached = false,
): { code: number; out: string } {
  return docker(["exec", ...(detached ? ["-d"] : []), container, "sh", "-c", command]);
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function shellIn(cwd: string, argv: string[], redirectTo?: string): string {
  const line = argv.map(shQuote).join(" ");
  const redirect = redirectTo === undefined ? "" : ` > ${shQuote(redirectTo)} 2>&1`;
  return `cd ${shQuote(cwd)} && exec ${line}${redirect}`;
}

function dockerExecStrict(container: string, command: string, detached = false): string {
  const result = dockerExec(container, command, detached);
  if (result.code !== 0) throw new Error(`docker exec failed: ${result.out}\ncommand: ${command}`);
  return result.out;
}

async function waitForContainer(container: string, timeoutMs: number): Promise<void> {
  await waitFor(
    "container running",
    () => docker(["inspect", "--format", "{{.State.Running}}", container]).out === "true",
    timeoutMs,
  );
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "0.0.0.0", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(label: string, condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timeout: ${label}`);
}

async function waitForAsync(
  label: string,
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timeout: ${label}`);
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value.length > 0) return value;
    } catch {
      // not written yet
    }
    await Bun.sleep(25);
  }
  throw new Error(`timeout: file never appeared: ${path}`);
}

function pumpLines(service: Service): void {
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) service.lines.push(line);
        newline = buffer.indexOf("\n");
      }
    }
  };
  void consume(service.proc.stdout);
  void consume(service.proc.stderr);
}

function sha(): { short: string; full: string; branch: string } {
  return {
    short: run(["git", "rev-parse", "--short", "HEAD"]).out,
    full: run(["git", "rev-parse", "HEAD"]).out,
    branch: run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).out,
  };
}

interface FrameLine {
  seq: number;
  frame: { type: string; toolCallId?: string; [key: string]: unknown };
}

interface DecisionLine {
  requestId: string;
  toolCallId: string;
  toolName: string;
  allow: boolean;
  code: string;
  reason: string;
  via: string;
  grantId: string | null;
}

function jsonl<T>(path: string): T[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

function auditShape(entries: Array<{ seq: number }>): { gaps: number[]; duplicates: number[] } {
  const seen = new Set<number>();
  const gaps: number[] = [];
  const duplicates: number[] = [];
  let previous: number | null = null;
  for (const entry of entries) {
    if (seen.has(entry.seq)) duplicates.push(entry.seq);
    seen.add(entry.seq);
    if (previous !== null && entry.seq !== previous + 1) gaps.push(previous + 1);
    previous = entry.seq;
  }
  return { gaps, duplicates };
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

type CdpReply = {
  id?: number;
  method?: string;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { message: string };
};

// The CDP client is copied-with-attribution from spikes/web-stream/run.ts (U0.10).
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
  timeoutMs = 90_000,
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

async function main(): Promise<number> {
  const { short, full, branch } = sha();
  const artifactDir = join(root, "packages/verify/artifacts/mvp-smoke", short);
  const framesDir = join(artifactDir, "frames");
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  const log = new Log();
  log.note(`# mvp smoke dry run (U0.11) — ${new Date().toISOString()}`);
  log.note(`worktree ${root}  branch ${branch}  head ${short} (${full})`);
  log.note(
    "STUB DISCLOSURE: the decision source in this run is the keyless scripted stub " +
      "spikes/forge-test-a/stub-model.ts. No provider, no BYOK key, no live-model traffic. " +
      "Gate G1 parks the keyed run (U0.12), which replaces only the decision source.",
  );

  log.section("preflight");
  const dockerInfo = docker(["info", "--format", "{{.ServerVersion}}"]);
  log.check("preflight: docker engine reachable", dockerInfo.code, 0);
  log.note(`docker server ${dockerInfo.out}`);
  const piBin = join(root, "node_modules/.bin/pi");
  log.check("preflight: pi binary present", existsSync(piBin), true);
  log.check("preflight: chrome present", existsSync(CHROME), true);
  const spikeTypecheck = run(["bun", "x", "tsc", "-p", "spikes/mvp-smoke/tsconfig.json"]);
  log.check("preflight: spikes/mvp-smoke typecheck", spikeTypecheck.code, 0);
  if (spikeTypecheck.code !== 0) log.note(spikeTypecheck.out);

  log.section("images");
  const baseTag = `freebot-mvp-smoke-base:${short}`;
  const image = `freebot-mvp-smoke:${short}`;
  const baseBuild = docker([
    "build",
    "-f",
    "packages/sandbox/image/Dockerfile",
    "-t",
    baseTag,
    ".",
  ]);
  if (baseBuild.code !== 0) throw new Error(`base image build failed:\n${baseBuild.out}`);
  const derivedBuild = docker([
    "build",
    "-f",
    "spikes/mvp-smoke/Dockerfile",
    "--build-arg",
    `BASE_IMAGE=${baseTag}`,
    "-t",
    image,
    ".",
  ]);
  if (derivedBuild.code !== 0) throw new Error(`derived image build failed:\n${derivedBuild.out}`);
  const baseId = docker(["image", "inspect", "--format", "{{.Id}}", baseTag]).out;
  const derivedId = docker(["image", "inspect", "--format", "{{.Id}}", image]).out;
  const pinnedDigest = docker([
    "image",
    "inspect",
    "--format",
    '{{index .Config.Labels "org.freebot.sandbox.node-base-digest"}}',
    image,
  ]).out;
  log.check(
    "base image is the pinned sandbox image (U0.6 recipe)",
    pinnedDigest,
    "sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5",
  );
  log.note(`base image id ${baseId}`);
  log.note(`derived image id ${derivedId} (spikes/mvp-smoke/Dockerfile)`);

  const scratch = mkdtempSync(join(tmpdir(), "freebot-mvp-smoke-"));
  const hostOnly = mkdtempSync(join(tmpdir(), "freebot-mvp-smoke-host-"));
  const container = `freebot-mvp-smoke-${Date.now()}`;
  const stateDir = join(scratch, "state");
  mkdirSync(join(scratch, "task"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  // Task fixtures the destructive steps act on; the harness re-creates the first one between
  // the approved removal and the repeated call, so a silent re-run would be observable.
  writeFileSync(join(scratch, "task", "doomed.txt"), "doomed-1\n");
  writeFileSync(join(scratch, "task", "doomed2.txt"), "doomed-2\n");

  const framesPath = join(hostOnly, "frames.jsonl");
  const displayPath = join(hostOnly, "display.jsonl");
  const decisionsPath = join(hostOnly, "decisions.jsonl");
  const storePath = join(hostOnly, "grants.jsonl");

  const stub: StubModel = startStubModel();
  const composerPort = await freePort();
  const relayPort = await freePort();

  const startComposer = async (): Promise<Service> => {
    const proc = Bun.spawn(
      [
        "bun",
        "spikes/mvp-smoke/composer.ts",
        "--port",
        String(composerPort),
        "--frames",
        framesPath,
        "--display",
        displayPath,
        "--decisions",
        decisionsPath,
        "--store",
        storePath,
        "--gate-timeout-ms",
        "60000",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const service: Service = { port: composerPort, proc, lines: [], stop: () => proc.kill(9) };
    pumpLines(service);
    await waitForAsync(
      "composer listening",
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${composerPort}/audit`);
          return response.ok;
        } catch {
          return false;
        }
      },
      20_000,
    );
    return service;
  };

  const startRelay = async (): Promise<Service> => {
    const proc = Bun.spawn(
      [
        "bun",
        "spikes/tunnel/tcp-relay.ts",
        "--listen",
        String(relayPort),
        "--forward",
        String(composerPort),
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const service: Service = { port: relayPort, proc, lines: [], stop: () => proc.kill(9) };
    pumpLines(service);
    await waitFor(
      "relay listening",
      () => service.lines.some((line) => line.includes("listening")),
      10_000,
    );
    return service;
  };

  let composer = await startComposer();
  let relay = await startRelay();

  let chromeProc: Bun.Subprocess | null = null;
  let userDataDir: string | null = null;
  let cdp: Cdp | null = null;

  const fetchAudit = async (): Promise<Record<string, unknown>> => {
    const response = await fetch(`http://127.0.0.1:${composerPort}/audit`);
    return (await response.json()) as Record<string, unknown>;
  };

  try {
    // The page comes up first, before anything can mint a frame: the idle
    // section asserts the connected-but-empty state on the real page.
    userDataDir = mkdtempSync(join(tmpdir(), "freebot-mvp-smoke-chrome-"));
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
    await waitForFile(portFile, 15_000);
    const [debugPort = "", wsPath = ""] = readFileSync(portFile, "utf8").split("\n");
    for (let attempt = 0; attempt < 20 && cdp === null; attempt++) {
      try {
        cdp = await Cdp.connect(`ws://127.0.0.1:${debugPort}${wsPath}`);
      } catch {
        await sleep(250);
      }
    }
    if (cdp === null) throw new Error("could not attach CDP to Chrome");
    const version = await cdp.send<{ product: string }>("Browser.getVersion");
    log.note(`chrome ${version.product}`);
    const sessionId = await openPage(cdp, `http://127.0.0.1:${composerPort}/`);

    log.section("idle");
    await waitTrue(
      cdp,
      sessionId,
      "page connected",
      "document.querySelector('#conn').textContent === 'connected'",
      30_000,
    );
    const idle = await pageState(cdp, sessionId);
    log.check("idle: zero frames rendered", idle.frameCount, 0);
    log.check("idle: no resume banner yet", idle.resumedFrom, null);
    const idleShot = await shot(cdp, sessionId, framesDir, "01-idle");
    log.note(`frame 01-idle: ${idleShot.file} (${idleShot.bytes} bytes) — connected, no frames`);

    log.section("container, supervisor, agent");
    dockerStrict(
      [
        "run",
        "-d",
        "--name",
        container,
        "-v",
        `${scratch}:/scratch`,
        "-v",
        `${root}:/work`,
        "-w",
        "/work",
        image,
        "sleep",
        "infinity",
      ],
      "run",
    );
    await waitForContainer(container, 15_000);
    const piVersion = dockerExecStrict(container, "pi --version");
    log.check("in-VM pi version", piVersion, "1.3.0");

    const supervisorCommand = shellIn(
      "/work",
      [
        "bun",
        "spikes/mvp-smoke/supervisor.ts",
        "--state-dir",
        "/scratch/state",
        "--pi-bin",
        "/work/node_modules/.bin/pi",
        "--stub-base-url",
        `http://host.docker.internal:${stub.port}/v1`,
        "--prompt",
        PROMPT,
        "--tools",
        "bash,write",
        "--ext",
        "/work/packages/pi-bridge/extension/tool-gate.ts",
      ],
      "/scratch/state/supervisor.log",
    );
    dockerExecStrict(container, supervisorCommand, true);
    await waitForFile(join(stateDir, "supervisor.port"), 30_000);
    const piPid = await waitForFile(join(stateDir, "pi.pid"), 30_000);
    log.note(`pi pid ${piPid}`);

    // The scripted decision source: one plan per assistant completion, in task order.
    const plan = async (call: { callId: string; command: string }): Promise<void> => {
      const response = await fetch(`http://127.0.0.1:${stub.port}/plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          plan: {
            kind: "tool",
            toolName: "bash",
            args: { command: call.command },
            callId: call.callId,
          },
        }),
      });
      if (!response.ok) throw new Error(`stub plan refused: ${response.status}`);
    };
    for (const step of Object.values(STEPS)) await plan(step);
    await fetch(`http://127.0.0.1:${stub.port}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: { kind: "stop" } }),
    });

    const agentCommand = shellIn(
      "/work",
      [
        "bun",
        "spikes/mvp-smoke/agent.ts",
        "--server",
        `ws://host.docker.internal:${relayPort}/tunnel`,
        "--supervisor-port-file",
        "/scratch/state/supervisor.port",
        "--pid-file",
        "/scratch/state/agent.pid",
      ],
      "/scratch/state/agent.log",
    );
    dockerExec(container, agentCommand, true);
    await waitForFile(join(stateDir, "agent.pid"), 30_000);

    log.section("step 1: harmless call through the real gate");
    await waitTrue(
      cdp,
      sessionId,
      "step 1 done",
      "document.querySelector('.tool-card[data-tool-call=\"call_step_1\"] .status')?.textContent === 'done'",
    );
    log.check(
      "step 1: card command literal",
      await evalJson(
        cdp,
        sessionId,
        "document.querySelector('.tool-card[data-tool-call=\"call_step_1\"] .cmd').textContent",
      ),
      'bash {"command":"echo one"}',
    );
    log.check(
      "step 1: card output literal",
      await evalJson(
        cdp,
        sessionId,
        "document.querySelector('.tool-card[data-tool-call=\"call_step_1\"] .output').textContent",
      ),
      "one\n",
    );
    const step1Decision = jsonl<DecisionLine>(decisionsPath).find(
      (line) => line.toolCallId === STEPS.step1.callId,
    );
    log.check("step 1: gate decision", step1Decision?.code, "allow");
    log.check(
      "step 1: decision came from the auto-grant policy path",
      step1Decision?.via,
      "policy_auto_grant",
    );
    const streamShot = await shot(cdp, sessionId, framesDir, "02-streaming");
    log.note(
      `frame 02-streaming: ${streamShot.file} (${streamShot.bytes} bytes) — turn text, step-1 card done with output "one"`,
    );

    log.section("step 2: destructive call gated on the page's approval");
    await waitTrue(
      cdp,
      sessionId,
      "approval card",
      "document.querySelector('.approval-card') !== null",
    );
    const pending = await pageState(cdp, sessionId);
    log.check("approval: state awaits an answer", pending.awaitingApproval, true);
    log.check(
      "approval: card shows the gated command literal",
      await evalJson(cdp, sessionId, "document.querySelector('.approval-card .cmd').textContent"),
      'bash {"command":"rm -f /scratch/task/doomed.txt"}',
    );
    log.check(
      "approval: buttons literal",
      await evalJson(
        cdp,
        sessionId,
        "[...document.querySelectorAll('.approval-card button')].map((b) => b.textContent)",
      ),
      ["Allow once", "Deny"],
    );
    log.check(
      "approval: the destructive card waits",
      await evalJson(
        cdp,
        sessionId,
        "document.querySelector('.tool-card[data-tool-call=\"call_step_2\"] .status').textContent",
      ),
      "awaiting approval",
    );
    log.check(
      "approval: no decision recorded while the card is pending",
      jsonl<DecisionLine>(decisionsPath).some((line) => line.toolCallId === STEPS.step2.callId),
      false,
    );
    const frozen1 = await pageState(cdp, sessionId);
    await sleep(700);
    const frozen2 = await pageState(cdp, sessionId);
    log.check(
      "approval: stream frozen at the gate seq",
      [frozen1.lastSeq, frozen2.lastSeq],
      [frozen1.lastSeq, frozen1.lastSeq],
    );
    const pendingShot = await shot(
      cdp,
      sessionId,
      framesDir,
      "03-approval-pending",
      "document.querySelector('.approval-card').scrollIntoView({ block: 'center' })",
    );
    log.note(
      `frame 03-approval-pending: ${pendingShot.file} (${pendingShot.bytes} bytes) — destructive card AWAITING APPROVAL, Allow once / Deny, frozen at display seq ${frozen1.lastSeq}`,
    );

    log.section("allow once: the page's answer is the grant");
    await evalJson(cdp, sessionId, "document.querySelector('.approval-card .allow-once').click()");
    await waitTrue(
      cdp,
      sessionId,
      "approval resolved",
      "document.querySelector('.approval-card')?.dataset.decision === 'allow'",
    );
    log.check(
      "resolved: decision text literal",
      await evalJson(
        cdp,
        sessionId,
        "document.querySelector('.approval-card .approval-result').textContent",
      ),
      "allowed once",
    );
    await waitTrue(
      cdp,
      sessionId,
      "step 2 done",
      "document.querySelector('.tool-card[data-tool-call=\"call_step_2\"] .status')?.textContent === 'done'",
    );
    const step2Decision = jsonl<DecisionLine>(decisionsPath).find(
      (line) => line.toolCallId === STEPS.step2.callId,
    );
    log.check("step 2: gate decision", step2Decision?.code, "allow");
    log.check("step 2: allow minted by the page answer", step2Decision?.via, "page_allow_once");
    const auditAfterStep2 = await fetchAudit();
    const grantsAfterStep2 = auditAfterStep2.grants as Array<{
      id: string;
      consumedBy: string | null;
    }>;
    const step2Grant = grantsAfterStep2.find((grant) => grant.id === step2Decision?.grantId);
    log.check(
      "step 2: the grant is consumed exactly once, by call_step_2",
      step2Grant?.consumedBy,
      "call_step_2",
    );
    log.check(
      "step 2: in-VM side effect observed (host read through docker exec)",
      dockerExecStrict(container, `cat ${TASK_DIR}/doomed.txt 2>/dev/null || echo ABSENT`),
      "ABSENT",
    );
    const resolvedShot = await shot(
      cdp,
      sessionId,
      framesDir,
      "04-post-approval",
      "document.querySelector('.approval-card').scrollIntoView({ block: 'center' })",
    );
    log.note(
      `frame 04-post-approval: ${resolvedShot.file} (${resolvedShot.bytes} bytes) — allowed once, step-2 card done, doomed.txt removed in the VM`,
    );

    log.section("kill/rejoin: relay SIGKILLed mid-task, composer restarts with the same logs");
    await waitTrue(
      cdp,
      sessionId,
      "step 3 card visible",
      "document.querySelector('.tool-card[data-tool-call=\"call_step_3\"]') !== null",
    );
    const preKill = await pageState(cdp, sessionId);
    const step3Seq = await evalJson<number>(
      cdp,
      sessionId,
      "Number(document.querySelector('.tool-card[data-tool-call=\"call_step_3\"]').dataset.seq)",
    );
    log.check(
      "kill: the step-3 card is the last display frame (quiet stream at the kill)",
      step3Seq,
      preKill.lastSeq,
    );
    await waitFor(
      "decision for call_step_3 before the kill (no gate in flight)",
      () =>
        jsonl<DecisionLine>(decisionsPath).some((line) => line.toolCallId === STEPS.step3.callId),
      30_000,
    );
    const step3Decision = jsonl<DecisionLine>(decisionsPath).find(
      (line) => line.toolCallId === STEPS.step3.callId,
    );
    log.check("step 3: gate decision before the kill", step3Decision?.code, "allow");
    const framesAtKill = jsonl<FrameLine>(framesPath);
    log.check(
      "kill: the step-3 tool is in flight at the kill",
      framesAtKill.some(
        (entry) =>
          entry.frame.type === "tool_execution_start" &&
          entry.frame.toolCallId === STEPS.step3.callId,
      ) &&
        !framesAtKill.some(
          (entry) =>
            entry.frame.type === "tool_execution_end" &&
            entry.frame.toolCallId === STEPS.step3.callId,
        ),
      true,
    );
    const seqAtKill = framesAtKill.at(-1)?.seq ?? 0;
    log.note(
      `kill point: relay and composer SIGKILLed; pi log last seq ${seqAtKill}; page display last seq ${preKill.lastSeq}`,
    );
    log.note(`pre-kill composer tail: ${composer.lines.slice(-4).join(" | ")}`);
    composer.stop();
    relay.stop();
    await sleep(150);
    relay = await startRelay();
    composer = await startComposer();
    await waitTrue(
      cdp,
      sessionId,
      "page resumed",
      `document.querySelector('#resume')?.dataset.resumedFrom === '${preKill.lastSeq}'`,
      60_000,
    );
    log.check(
      "resume: banner text literal",
      await evalJson(cdp, sessionId, "document.querySelector('#resume').textContent"),
      `resumed from seq ${preKill.lastSeq}`,
    );
    log.check(
      "resume: page state carries the resume point",
      (await pageState(cdp, sessionId)).resumedFrom,
      preKill.lastSeq,
    );
    log.check(
      "resume: no duplicate display frames after rejoin",
      (await pageState(cdp, sessionId)).duplicatesIgnored,
      0,
    );
    const resumeShot = await shot(
      cdp,
      sessionId,
      framesDir,
      "05-kill-rejoin-resumed",
      "document.querySelector('#resume').scrollIntoView({ block: 'center' })",
    );
    log.note(
      `frame 05-kill-rejoin-resumed: ${resumeShot.file} (${resumeShot.bytes} bytes) — "resumed from seq ${preKill.lastSeq}" after the relay+composer SIGKILL, step-3 card in flight`,
    );

    log.section("after rejoin: the task continues on the same log");
    await waitTrue(
      cdp,
      sessionId,
      "step 3 done",
      "document.querySelector('.tool-card[data-tool-call=\"call_step_3\"] .status')?.textContent === 'done'",
    );
    log.check(
      "step 3: card output literal",
      await evalJson(
        cdp,
        sessionId,
        "document.querySelector('.tool-card[data-tool-call=\"call_step_3\"] .output').textContent",
      ),
      "two\n",
    );

    // The repeat: identical args to the approved call, after its grant was consumed.
    writeFileSync(join(scratch, "task", "doomed.txt"), "doomed-again\n");
    await waitTrue(
      cdp,
      sessionId,
      "step 4 denied",
      "document.querySelector('.tool-card[data-tool-call=\"call_step_4\"] .status')?.textContent === 'denied'",
    );
    const step4Decision = jsonl<DecisionLine>(decisionsPath).find(
      (line) => line.toolCallId === STEPS.step4.callId,
    );
    log.check("step 4 repeat: gate decision code", step4Decision?.code, "grant_consumed");
    log.check(
      "step 4 repeat: the denial names the consuming call",
      step4Decision?.reason.includes(`grant ${step2Decision?.grantId} consumed by call_step_2`),
      true,
    );
    log.check(
      "step 4 repeat: no approval card was offered for a ledger denial",
      await evalJson<number>(cdp, sessionId, "document.querySelectorAll('.approval-card').length"),
      1,
    );
    log.check(
      "step 4 repeat: the re-created file is untouched (a silent re-run would have removed it)",
      dockerExecStrict(container, `cat ${TASK_DIR}/doomed.txt 2>/dev/null || echo ABSENT`),
      "doomed-again",
    );

    log.section("page deny path: the human refuses the second destructive call");
    await waitTrue(
      cdp,
      sessionId,
      "second approval card",
      "document.querySelectorAll('.approval-card').length === 2",
    );
    log.check(
      "deny: state awaits the second answer",
      (await pageState(cdp, sessionId)).awaitingApproval,
      true,
    );
    await evalJson(
      cdp,
      sessionId,
      "[...document.querySelectorAll('.approval-card')].at(-1).querySelector('.deny').click()",
    );
    await waitTrue(
      cdp,
      sessionId,
      "second card resolved as denied",
      "document.querySelectorAll('.approval-card')[1]?.dataset.decision === 'deny'",
    );
    log.check(
      "deny: decision text literal",
      await evalJson(
        cdp,
        sessionId,
        "document.querySelectorAll('.approval-card')[1].querySelector('.approval-result').textContent",
      ),
      "denied",
    );
    const step5Decision = jsonl<DecisionLine>(decisionsPath).find(
      (line) => line.toolCallId === STEPS.step5.callId,
    );
    log.check("step 5 deny: gate decision code", step5Decision?.code, "user_denied");
    log.check("step 5 deny: refusal came from the page", step5Decision?.via, "page_deny");
    // Placed before the step-5 tool result and stream end, so this frame
    // documents the denial moment instead of repeating the done capture.
    const deniedShot = await shot(
      cdp,
      sessionId,
      framesDir,
      "06-denied",
      "[...document.querySelectorAll('.approval-card')].at(-1).scrollIntoView({ block: 'center' })",
    );
    log.note(
      `frame 06-denied: ${deniedShot.file} (${deniedShot.bytes} bytes) — the second approval resolved as denied on the page`,
    );
    await waitTrue(
      cdp,
      sessionId,
      "step 5 denied card",
      "document.querySelector('.tool-card[data-tool-call=\"call_step_5\"] .status')?.textContent === 'denied'",
    );
    log.check(
      "step 5 deny: in-VM side effect observed (doomed2.txt intact)",
      dockerExecStrict(container, `cat ${TASK_DIR}/doomed2.txt 2>/dev/null || echo ABSENT`),
      "doomed-2",
    );

    log.section("done");
    await waitTrue(cdp, sessionId, "stream end", "window.__webStreamState().done === true");
    const done = await pageState(cdp, sessionId);
    log.check(
      "done: terminal marker literal",
      await evalJson(cdp, sessionId, "document.querySelector('.stream-end').textContent"),
      "stream complete",
    );
    log.check("done: frame count equals last seq", done.frameCount, done.lastSeq);
    log.check("done: no stream error", done.error, null);
    log.check("done: no duplicate display frames in the whole run", done.duplicatesIgnored, 0);
    log.check(
      "done: tool card statuses literal",
      await evalJson(
        cdp,
        sessionId,
        "[...document.querySelectorAll('.tool-card')].map((c) => [c.dataset.toolCall, c.querySelector('.status').textContent])",
      ),
      [
        ["call_step_1", "done"],
        ["call_step_2", "done"],
        ["call_step_3", "done"],
        ["call_step_4", "denied"],
        ["call_step_5", "denied"],
      ],
    );
    log.check(
      "done: both approvals resolved on the page",
      await evalJson(
        cdp,
        sessionId,
        "[...document.querySelectorAll('.approval-card')].map((c) => c.dataset.decision)",
      ),
      ["allow", "deny"],
    );
    const renderedSeqs = await evalJson<number[]>(
      cdp,
      sessionId,
      "[...document.querySelectorAll('.frame[data-seq]')].map((e) => Number(e.dataset.seq))",
    );
    log.check(
      "done: rendered display seqs are dense 1..N",
      renderedSeqs.map((seq, index) => (seq === index + 1 ? null : seq)).filter((v) => v !== null),
      [],
    );
    const doneShot = await shot(
      cdp,
      sessionId,
      framesDir,
      "07-done",
      "window.scrollTo(0, document.body.scrollHeight)",
    );
    log.note(
      `frame 07-done: ${doneShot.file} (${doneShot.bytes} bytes) — full stream, all turns complete`,
    );

    log.section("seq audit across the kill");
    const summaryPath = join(stateDir, "supervisor-summary.json");
    await waitForFile(summaryPath, 30_000);
    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
      seqMinted: number;
      acked: number;
      gateRequests: number;
      piVersion: string;
    };
    const finalFrames = jsonl<FrameLine>(framesPath);
    const local = auditShape(finalFrames);
    const finalAudit = await fetchAudit();
    const piAudit = finalAudit.pi as {
      firstSeq: number | null;
      lastSeq: number;
      count: number;
      gaps: number[];
      duplicates: number[];
      suppressedAtIngest: number[];
      rejected: number;
    };
    const displayAudit = finalAudit.display as {
      lastSeq: number;
      count: number;
      gaps: number[];
      duplicates: number[];
    };
    log.check("audit: frame log starts at seq 1", piAudit.firstSeq, 1);
    log.check(
      "audit: the display log ends at the page's last seq",
      displayAudit.lastSeq,
      done.lastSeq,
    );
    log.check("audit: gaps in the pi frame log", piAudit.gaps, []);
    log.check("audit: duplicates in the pi frame log", piAudit.duplicates, []);
    log.check("audit: gaps in local re-read of frames.jsonl", local.gaps, []);
    log.check("audit: duplicates in local re-read of frames.jsonl", local.duplicates, []);
    log.check("audit: gaps in the display log", displayAudit.gaps, []);
    log.check("audit: duplicates in the display log", displayAudit.duplicates, []);
    log.check(
      "audit: every minted pi seq reached the durable log",
      [summary.seqMinted, piAudit.count],
      [piAudit.count, piAudit.count],
    );
    log.note(
      `minted ${summary.seqMinted}, logged ${piAudit.count} (seq 1..${piAudit.lastSeq}); suppressed at ingest ${JSON.stringify(piAudit.suppressedAtIngest)} (lost-ack window after the rejoin); rejected ${piAudit.rejected}; display ${displayAudit.count} frames (seq 1..${displayAudit.lastSeq})`,
    );
    log.note(
      `in-VM pi version at the summary: ${summary.piVersion}; gate requests ${summary.gateRequests}`,
    );

    const agentLog = readFileSync(join(stateDir, "agent.log"), "utf8");
    const opens = agentLog.split("\n").filter((line) => line.includes("[agent] tunnel open"));
    log.check("kill: the agent reopened the tunnel after the SIGKILL", opens.length >= 2, true);
    const rejoin = opens.at(-1) ?? "";
    log.check("kill: the rejoin named a last_seen_seq", /last_seen_seq=\d+/.test(rejoin), true);
    log.check("kill: the rejoin was not the first attach", /reconnects=[1-9]/.test(rejoin), true);
    log.note(`agent rejoin line: ${rejoin.trim()}`);
    const replayLine = agentLog.split("\n").find((line) => line.includes("unconfirmed frames"));
    log.note(`agent replay after rejoin: ${replayLine?.trim() ?? "(none)"}`);

    log.section("decision table");
    const decisions = jsonl<DecisionLine>(decisionsPath);
    for (const line of decisions) {
      log.note(
        `${line.toolCallId} tool=${line.toolName} code=${line.code} via=${line.via} grant=${line.grantId ?? "-"} reason=${line.reason === "" ? "-" : line.reason}`,
      );
    }
    log.check(
      "decisions: one gate decision per scripted call, in order",
      decisions.map((line) => [line.toolCallId, line.code]),
      [
        ["call_step_1", "allow"],
        ["call_step_2", "allow"],
        ["call_step_3", "allow"],
        ["call_step_4", "grant_consumed"],
        ["call_step_5", "user_denied"],
      ],
    );
    const finalGrants = (finalAudit.grants as Array<{ id: string; consumedBy: string | null }>).map(
      (grant) => ({ id: grant.id, consumedBy: grant.consumedBy }),
    );
    log.check("grants: one grant per allowed call, each consumed exactly once", finalGrants, [
      { id: step1Decision?.grantId, consumedBy: "call_step_1" },
      { id: step2Decision?.grantId, consumedBy: "call_step_2" },
      { id: step3Decision?.grantId, consumedBy: "call_step_3" },
    ]);

    writeFileSync(
      join(artifactDir, "decision-table.txt"),
      `${decisions
        .map(
          (line) =>
            `${line.toolCallId}\t${line.toolName}\t${line.code}\tvia=${line.via}\tgrant=${line.grantId ?? "-"}\t${line.reason}`,
        )
        .join("\n")}\n`,
    );
    writeFileSync(
      join(artifactDir, "seq-audit.txt"),
      `${JSON.stringify({ pi: piAudit, display: displayAudit, minted: summary.seqMinted }, null, 2)}\n`,
    );
    writeFileSync(join(artifactDir, "decisions.jsonl"), readFileSync(decisionsPath, "utf8"));
    writeFileSync(join(artifactDir, "frames.jsonl"), readFileSync(framesPath, "utf8"));
    writeFileSync(join(artifactDir, "display.jsonl"), readFileSync(displayPath, "utf8"));
    writeFileSync(
      join(artifactDir, "logs.txt"),
      [
        "## supervisor.log",
        readFileSync(join(stateDir, "supervisor.log"), "utf8"),
        "## agent.log",
        agentLog,
        "## composer.log",
        composer.lines.join("\n"),
        "## relay.log",
        relay.lines.join("\n"),
      ].join("\n"),
    );

    const frames = readdirSync(framesDir).sort();
    for (const file of frames) {
      log.lines.push(
        `frame artifact: frames/${file} (${statSync(join(framesDir, file)).size} bytes)`,
      );
    }
    if (frames.length === 0) log.check("frame captures", "none", "at least one PNG");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.check("harness completed without a crash", message, "no crash");
  } finally {
    cdp?.close();
    chromeProc?.kill();
    if (userDataDir !== null) rmSync(userDataDir, { recursive: true, force: true });
    composer.stop();
    relay.stop();
    stub.stop();
    docker(["rm", "-f", container]);
    docker(["image", "rm", "-f", image, baseTag]);
  }

  log.lines.push(log.result());
  writeFileSync(join(artifactDir, "assert.txt"), `${log.lines.join("\n")}\n`);
  console.log(
    log.lines.filter((line) => line.includes("RESULT") || line.startsWith("FAIL")).join("\n"),
  );
  console.log(`assert.txt: ${join(artifactDir, "assert.txt")}`);
  return log.failed === 0 ? 0 : 1;
}

try {
  process.exit(await main());
} catch (err) {
  console.error(`mvp-smoke crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
