#!/usr/bin/env bun
/**
 * The U4.1 evidence driver: the Library tab, over the Bot's workspace a real run wrote.
 *
 * The peer is the real launcher, spawned the way a person runs it, with no provider flag: the mode
 * is `auto`, so a real vault key makes a real model write the file this driver then reads back. The
 * URL the launcher printed is opened in headless Chrome over CDP, and the four states are reached
 * the way a person would: open the Library on a Bot that has written nothing, type a prompt, answer
 * the approval card, open the file the run produced, and open a path that resolves outside the
 * workspace.
 *
 * What makes this evidence rather than a fixture is the content. The prompt asks the model to write
 * a line carrying a nonce this driver minted at start, so the bytes read back cannot have existed
 * before this run. Two further facts are read outside the browser: the file is present in the Bot's
 * own workspace directory on the host, which the container mounted at `/workspace`, and the
 * container is gone from Docker by the time the Library reads it, which is what shows the surface is
 * reading the Bot's computer rather than a live container.
 *
 * The bots root is this driver's own, so the page creates its first Bot there and nothing here
 * touches a Bot a person has run. Every read names that Bot, because the workspace is per Bot.
 *
 * Run from the repo root: bun packages/verify/scripts/files-surface.ts
 */

import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { botWorkspacePath } from "../../../apps/server/src/workspace-files.ts";
import type { LibraryFacts } from "../../../packages/ui/src/library.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const root = fileURLToPath(new URL("../../..", import.meta.url));

/** The label every container this repo's runs carry, which scopes the container census (order 22). */
const UNIT_LABEL = "freebot.unit=u1.7";

/** The line the model is asked to write. The nonce is what no committed fixture can hold. */
const LINE = `freebot-u4.1 ${randomBytes(6).toString("hex")}`;

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
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evalJson<boolean>(cdp, sessionId, expression)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${desc}`);
}

const FACTS = "window.__libraryFacts()";

function factsOf(cdp: Cdp, sessionId: string): Promise<LibraryFacts> {
  return evalJson<LibraryFacts>(cdp, sessionId, FACTS);
}

/** The facts a caption's claims are evaluated against, as one comparable string. */
function factsKey(facts: LibraryFacts): string {
  return JSON.stringify(facts);
}

/** A short description of a captured state, for the artifact's frame index. */
function describeFacts(facts: LibraryFacts): string {
  return [
    `tab=${facts.tab}`,
    `state=${facts.state}`,
    `listPath=${facts.listPath}`,
    `groups=${facts.groups.join("|") || "(none)"}`,
    `entries=${facts.entries.length}`,
    `open=${facts.openPath ?? "(none)"}`,
    `refused=${facts.refused ?? "(none)"}`,
  ].join(" ");
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

interface LibrarySpec {
  readonly name: string;
  readonly caption: string;
  readonly visible: string;
  readonly claims: ReadonlyArray<{ label: string; holds: (facts: LibraryFacts) => boolean }>;
}

const SPECS: readonly LibrarySpec[] = [
  {
    name: "01-empty",
    caption:
      "The Library on a Bot that has written nothing: /workspace is pinned at the top of the list and the list is otherwise empty.",
    claims: [
      { label: "the Library tab is open", holds: (f) => f.tab === "library" },
      { label: "the state is empty", holds: (f) => f.state === "empty" },
      { label: "the pinned row is /workspace", holds: (f) => f.pinnedLabel === "/workspace" },
      {
        label: "no group is drawn and no entry is listed",
        holds: (f) => f.groups.length === 0 && f.entries.length === 0,
      },
      { label: "nothing has been opened", holds: (f) => f.openPath === null && f.refused === null },
    ],
    visible: "#library-pinned",
  },
  {
    name: "02-populated",
    caption:
      "After a real run wrote a file through /workspace: the list shows it under Today, with its size, from the Bot's own directory on this computer.",
    claims: [
      { label: "the Library tab is open", holds: (f) => f.tab === "library" },
      { label: "the state is loaded", holds: (f) => f.state === "loaded" },
      {
        label: "the file the run wrote is listed with a size",
        holds: (f) =>
          f.entries.some(
            (entry) => entry.name === "note.txt" && entry.kind === "file" && entry.size > 0,
          ),
      },
      { label: "it is grouped under Today", holds: (f) => f.groups.includes("Today") },
      { label: "nothing has been refused", holds: (f) => f.refused === null },
    ],
    visible: "#library-list",
  },
  {
    name: "03-file-open",
    caption:
      "The file open: the view shows the path and the bytes the container wrote, which carry the nonce this run minted.",
    claims: [
      { label: "the file view shows the file's path", holds: (f) => f.openPath === "note.txt" },
      {
        label: "the view holds the bytes that came back",
        holds: (f) => f.openText?.includes(LINE) === true,
      },
      { label: "nothing has been refused", holds: (f) => f.refused === null },
    ],
    visible: "#library-view-text",
  },
  {
    name: "04-refused",
    caption:
      "A path that resolves outside the workspace, opened from the list: the read is refused by name and no bytes are shown.",
    claims: [
      { label: "the refusal is the named one", holds: (f) => f.refused === "symlink_escape" },
      { label: "no bytes were rendered", holds: (f) => f.openText === null },
      { label: "the list still shows the workspace", holds: (f) => f.state === "loaded" },
    ],
    visible: "#library-view-refused",
  },
];

function specFor(name: string): LibrarySpec {
  const spec = SPECS.find((entry) => entry.name === name);
  if (spec === undefined) throw new Error(`no frame spec named ${name}`);
  return spec;
}

let artifactsDir = "";

async function capture(cdp: Cdp, sessionId: string, name: string, log: Log): Promise<LibraryFacts> {
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

/** `bun run up --no-open`, as a person runs it, with the bots root this driver made. */
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

// ---------------------------------------------------------------------------
// Docker and ports, read-only, label-scoped to this repo's own containers
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

const added = (before: readonly string[], after: readonly string[]): string[] =>
  after.filter((name) => !before.includes(name));

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
  await waitTrue(cdp, sessionId, "the library hook", `typeof window.__libraryFacts === 'function'`);
  return sessionId;
}

function clickSelector(cdp: Cdp, sessionId: string, selector: string): Promise<void> {
  return evalJson(cdp, sessionId, `document.querySelector(${JSON.stringify(selector)}).click()`);
}

function clickExpression(cdp: Cdp, sessionId: string, expression: string): Promise<void> {
  return evalJson(cdp, sessionId, `${expression}.click()`);
}

const SETTLED = `window.__threadFacts().done === true || document.querySelector('#thread .run-failed') !== null`;
const WAITING = `[...document.querySelectorAll('#thread .approval-card')].filter((card) => (card.dataset.decision ?? null) === null)`;

/** Answer every card the run parks on, one at a time, until it settles. */
async function answerUntilSettled(
  cdp: Cdp,
  log: Log,
  page: string,
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
  await waitTrue(cdp, page, "the answered run to settle", SETTLED);
  return sent;
}

// ---------------------------------------------------------------------------
// The request and the bytes, over the route surface itself
// ---------------------------------------------------------------------------

interface Wire {
  readonly request: string;
  readonly status: number;
  readonly body: string;
}

/**
 * One call to the oRPC route surface with the page's own token. The request line is recorded so the
 * artifact carries the request that listed the file, not just its result.
 */
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
  artifactsDir = join(root, "packages", "verify", "artifacts", "files-surface", sha);
  rmSync(artifactsDir, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });

  // The bots root is this driver's own, and the Bot's workspace under it starts empty, so the empty
  // state is empty and nothing here touches a Bot a person has run. It is a real host directory: the
  // container mounts it.
  const botsRoot = realpathSync(mkdtempSync(join(tmpdir(), "freebot-files-bots-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "freebot-files-out-")));
  made.push(botsRoot, outside);
  const secret = join(outside, "secret.txt");
  writeFileSync(secret, "outside the workspace\n");

  headerLines = [
    "feature: files-surface",
    "command: bun packages/verify/scripts/files-surface.ts",
    `timestamp: ${new Date().toISOString()}`,
    `git sha: ${full}`,
    `git sha short: ${sha}`,
    `branch: ${branch}`,
    `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
    `the line the model was asked to write: ${LINE}`,
    `the bots root this driver made: ${botsRoot}`,
    `the file outside it the refused read points at: ${secret}`,
    "",
  ];
  log.note("# files-surface live-ui frames");
  log.note(
    "DRIVER DISCLOSURE: the launcher is spawned as `bun run up --no-open` with FREEBOT_WORKSPACE pointing at a fresh directory, so the server starts with no Bots, the page creates its own, and no Bot a person has run is touched. The provider mode is `auto`, so the model is whatever the vault selects; the prompt is typed into the page's own box and the approval card is answered on the page. The file the Library reads is the one the model wrote through /workspace inside the container. The symlink the refused state opens is made by this driver with `ln -s`, because asking a live model to plant one is not this driver's to ask; the passwd-shaped target is a file this driver wrote outside the workspace.",
  );

  const baseline = runContainers();
  log.note(
    `containers before the run (label ${UNIT_LABEL}): ${baseline.length}${baseline.length === 0 ? "" : ` (${baseline.join(", ")})`}`,
  );

  log.section("the launcher, and the bots root it holds");
  const first = await launch(botsRoot);
  log.note(`the printed URL, redacted: ${redacted(first.url)}`);
  const botsLine = await waitForMatch(
    () => first.stderr(),
    /^(freebot up: bots under .*)$/m,
    30_000,
  );
  log.note(`the launcher's line: ${botsLine}`);
  log.check(
    "the launcher holds the bots root this driver made, with one workspace per Bot",
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
    "the launcher selected the keyed path from the vault, so the file is a real model's",
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
  const vaultLine = await waitForMatch(() => first.stderr(), /^(freebot up: vault .*)$/m, 30_000);
  log.note(`the launcher's line: ${vaultLine}`);
  log.check("the vault it read is present", vaultLine.includes("present"), true);

  userDataDir = join(tmpdir(), `freebot-files-${Date.now()}`);
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
  log.note(`cdp: ${cdp.version}, headless, DevToolsActivePort file (dynamic)`);

  const captured: LibraryFacts[] = [];

  log.section("the Library on an empty workspace");
  const page = await openPage(cdp, first.url);
  await waitTrue(
    cdp,
    page,
    "the page to connect",
    `document.querySelector('#conn').textContent === 'connected'`,
  );
  // The Bot the page made on its first load. Every workspace read names it, because a workspace
  // belongs to a Bot and the server refuses a read that names none.
  const bots = await post(first, "list_bots", {});
  log.note(`the request: ${bots.request}`);
  log.note(`the answer: ${bots.status} ${bots.body}`);
  const botId =
    (JSON.parse(bots.body) as { json: { bots: Array<{ botId: string; name: string }> } }).json
      .bots[0]?.botId ?? "";
  const botName =
    (JSON.parse(bots.body) as { json: { bots: Array<{ botId: string; name: string }> } }).json
      .bots[0]?.name ?? "";
  log.check(
    "the page created one Bot on a server that held none, through the same arm a person's click uses",
    [bots.status, botId, botName],
    [200, "bot-local", "Local Bot"],
  );
  const botWorkspace = botWorkspacePath(botsRoot, botId);
  const escapePath = join(botWorkspace, "escape.txt");
  const escapeCommand = `ln -s ${secret} ${escapePath}`;
  log.check(
    "the page is the URL the launcher printed, token in the fragment and never sent to a server",
    await evalJson(
      cdp,
      page,
      `({ fragmentKey: location.hash.slice(0, 7), search: location.search })`,
    ),
    { fragmentKey: "#token=", search: "" },
  );
  await waitTrue(cdp, page, "the Library tab", `document.querySelector('#tab-library') !== null`);
  log.check(
    "the Library starts hidden behind its tab, and the conversation is what is on screen",
    await evalJson(
      cdp,
      page,
      `({ tab: ${FACTS}.tab, hidden: document.querySelector('#library').hidden })`,
    ),
    { tab: "conversation", hidden: true },
  );
  await clickSelector(cdp, page, "#tab-library");
  await waitTrue(cdp, page, "the empty Library", `${FACTS}.state === 'empty'`);
  captured.push(await capture(cdp, page, "01-empty", log));

  log.section("a prompt typed into the page, answered once, for a file written through /workspace");
  await clickSelector(cdp, page, "#tab-conversation");
  const prompt = `Use the bash tool to write exactly this, and nothing else, into the file /workspace/note.txt: '${LINE}' followed by a newline. Create no other file and read nothing. Then reply with one short sentence.`;
  await evalJson(
    cdp,
    page,
    `(() => {
      const input = document.querySelector('#prompt');
      input.value = ${JSON.stringify(prompt)};
      document.querySelector('#start').click();
    })()`,
  );
  await waitTrue(cdp, page, "the parked approval", `${WAITING}.length >= 1`);
  const parked = await evalJson<{ command: string; buttons: string[] }>(
    cdp,
    page,
    `(() => {
      const card = ${WAITING}[0];
      const callId = card.dataset.approval.replace(/^.*:/, '');
      const tool = document.querySelector('#thread .tool-card[data-tool-call="' + callId + '"]');
      return {
        command: tool.querySelector('.cmd').textContent,
        buttons: [...card.querySelectorAll('button')].map((button) => button.textContent),
      };
    })()`,
  );
  log.note(`the parked call, read off the page: ${parked.command}`);
  log.check(
    "the page's prompt reached the run's own box",
    await evalJson(cdp, page, "document.querySelector('#prompt').value"),
    prompt,
  );
  log.check("the buttons are the two real answers", parked.buttons, ["Allow once", "Deny"]);
  log.check("the parked call is a bash call", parked.command.startsWith("bash "), true);
  const parkedSet = runContainers();
  const parkedLive = added(baseline, parkedSet);
  log.check(
    "the parked run holds one live container, this launch's own",
    [parkedLive.length, parkedSet.length],
    [1, baseline.length + 1],
  );
  log.note(`containers while the run is parked: ${parkedSet.length} (${parkedLive.join(", ")})`);
  await answerUntilSettled(cdp, log, page, "allow");
  const settled = await evalJson<{ text: string; failed: string | null; error: string | null }>(
    cdp,
    page,
    `(() => ({
      text: [...document.querySelectorAll('#thread .delta')].map((node) => node.textContent).join(""),
      failed: document.querySelector('#thread .run-failed')?.textContent ?? null,
      error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
    }))()`,
  );
  log.check("the allowed run failed nowhere", [settled.failed, settled.error], [null, null]);
  log.note(`the model's closing text: ${JSON.stringify(settled.text)}`);

  log.section("the run ended, its container is gone, and the file is on this computer");
  const removed = [...first.stderr().matchAll(/removed sandbox container (\S+)/g)].flatMap(
    (match) => (match[1] === undefined ? [] : [match[1]]),
  );
  log.note(`containers the launch removed: ${removed.join(", ") || "(none)"}`);
  log.check(
    "every container the launch says it removed is gone from Docker",
    removed.flatMap((name) => containersNamed(name)),
    [],
  );
  log.check(
    "the container the parked run held is gone, so the Library reads a computer nothing is running",
    await settles(() => JSON.stringify(runContainers()) === JSON.stringify(baseline)),
    true,
  );
  const onDisk = await Bun.file(join(botWorkspace, "note.txt"))
    .text()
    .catch(() => null);
  log.note(`the workspace file, read by the driver from the host: ${JSON.stringify(onDisk)}`);
  log.check(
    "the file the container wrote is in this Bot's workspace directory on the host, and carries the nonce",
    onDisk?.includes(LINE) === true,
    true,
  );

  log.section("the request that listed it, and the bytes that came back");
  const listing = await post(first, "list_files", { botId, path: "." });
  log.note(`the request: ${listing.request}`);
  log.note(`the answer: ${listing.status} ${listing.body}`);
  log.check("the listing answered 200", listing.status, 200);
  log.check(
    "the listing it returned carries the file the run wrote",
    (
      JSON.parse(listing.body) as { json: { entries: Array<{ name: string; size: number }> } }
    ).json.entries.some((entry) => entry.name === "note.txt" && entry.size > 0),
    true,
  );
  const read = await post(first, "read_file", { botId, path: "note.txt" });
  log.note(`the request: ${read.request}`);
  log.note(`the answer: ${read.status} ${JSON.stringify(read.body)}`);
  const readText = (JSON.parse(read.body) as { json: { text: string; size: number } }).json;
  log.note(`the bytes that came back: ${JSON.stringify(readText.text)} (${readText.size} bytes)`);
  log.check(
    "the bytes the surface returned carry the nonce the run was asked to write",
    readText.text.includes(LINE),
    true,
  );

  log.section("the Library after the run");
  await clickSelector(cdp, page, "#tab-library");
  await waitTrue(cdp, page, "the populated Library", `${FACTS}.state === 'loaded'`);
  captured.push(await capture(cdp, page, "02-populated", log));
  await clickSelector(cdp, page, '.library-entry[data-path="note.txt"]');
  await waitTrue(cdp, page, "the file view", `${FACTS}.openPath === 'note.txt'`);
  captured.push(await capture(cdp, page, "03-file-open", log));
  log.check(
    "the page shows the same bytes the route surface returned",
    (await factsOf(cdp, page)).openText,
    readText.text,
  );

  log.section("a path that resolves outside the workspace");
  log.note(`the Bot's workspace directory: ${botWorkspace}`);
  log.note(`the driver's own command: ${escapeCommand}`);
  symlinkSync(secret, escapePath);
  await clickSelector(cdp, page, "#tab-conversation");
  await clickSelector(cdp, page, "#tab-library");
  await waitTrue(cdp, page, "the re-read Library", `${FACTS}.state === 'loaded'`);
  log.check(
    "the symlink is listed, so opening it is what refuses",
    (await factsOf(cdp, page)).entries.some((entry) => entry.path === "escape.txt"),
    true,
  );
  const refused = await post(first, "read_file", { botId, path: "escape.txt" });
  log.note(`the request: ${refused.request}`);
  log.note(`the answer: ${refused.status} ${refused.body}`);
  log.check(
    "the route surface refused the escape with its own code and status",
    [refused.status, (JSON.parse(refused.body) as { json: { code: string } }).json.code],
    [403, "symlink_escape"],
  );
  const absolute = await post(first, "read_file", { botId, path: "/etc/passwd" });
  log.check(
    "an absolute path is refused at the contract boundary",
    [absolute.status, (JSON.parse(absolute.body) as { json: { code: string } }).json.code],
    [400, "BAD_REQUEST"],
  );
  const traversal = await post(first, "read_file", { botId, path: "../secret.txt" });
  log.check(
    "a .. traversal is refused at the contract boundary",
    [traversal.status, (JSON.parse(traversal.body) as { json: { code: string } }).json.code],
    [400, "BAD_REQUEST"],
  );
  await clickSelector(cdp, page, '.library-entry[data-path="escape.txt"]');
  await waitTrue(cdp, page, "the refusal on the page", `${FACTS}.refused !== null`);
  captured.push(await capture(cdp, page, "04-refused", log));

  log.section("shutdown, and the containers this driver created");
  first.interrupt();
  const code = await first.exited();
  log.check("the launch exits zero on SIGINT", code, 0);
  log.check(
    "the label's container set is back where it started",
    await settles(() => JSON.stringify(runContainers()) === JSON.stringify(baseline)),
    true,
  );
  log.check("nothing listens on the launch's page port", listeners(first.apiPort), []);

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
  log.note("name -> asserted DOM facts -> caption");
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
    `chrome ${CHROME.split("/").at(-1)} over CDP; really launched \`bun run up --no-open\`; the model is the vault's keyed provider; the container is from the pinned image and is gone before the Library reads the file`,
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
