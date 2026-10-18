#!/usr/bin/env bun
/**
 * The U4.3 evidence driver: UX.md page 1, connect a provider, over a real server and a real model.
 *
 * The peer is the real launcher, spawned the way a person runs it, with two directories of this
 * driver's own: FREEBOT_HOME holds the vault the page writes, and FREEBOT_WORKSPACE holds the Bots.
 * The machine's real vault is opened read-only to borrow its connection for the capable case, and
 * the key value never leaves this process except into the page's own key field.
 *
 * The page is opened in headless Chrome over CDP and driven the way a person drives it: type a base
 * URL, a model and a key, press `Save and test`, watch the request run, read the answer, continue to
 * the conversation, ask for a file to be written, and answer the approval card. The limited case
 * points the same page at a local stub provider this driver starts, and the refused case points it
 * at the real endpoint with a deliberately wrong key so the provider refuses the credential itself.
 *
 * Run from the repo root: bun packages/verify/scripts/provider-setup.ts
 */

import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeVault, readVault } from "../../../apps/server/src/vault.ts";
import { botWorkspacePath } from "../../../apps/server/src/workspace-files.ts";
import type { ShellFacts } from "../../../packages/ui/src/bots.ts";
import type { FrameFacts } from "../../../packages/ui/src/frames.ts";
import type { ProviderFacts } from "../../../packages/ui/src/provider.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const root = fileURLToPath(new URL("../../..", import.meta.url));

/** The label every container this repo's runs carry, which scopes the container census (order 22). */
const UNIT_LABEL = "freebot.unit=u1.7";

const LINE = `freebot-u4.3 ${randomBytes(6).toString("hex")}`;

/** The key the refused case presents. A literal, not a credential: the provider is meant to reject it. */
const WRONG_KEY = "freebot-u4.3-not-a-real-key";

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
// The facts, one snapshot per asserted state
// ---------------------------------------------------------------------------

const PROVIDER = "window.__providerFacts()";
const SHELL = "window.__shellFacts()";
const THREAD = "window.__threadFacts()";

interface PageFacts {
  readonly provider: ProviderFacts;
  readonly shell: ShellFacts;
  readonly thread: FrameFacts;
  /** The headline the page is showing, read from the DOM rather than from the model. */
  readonly headline: string;
  readonly saveLabel: string;
  readonly saveDisabled: boolean;
  readonly replayLabel: string;
  /** The promise the page makes about the key, as printed. */
  readonly keyKept: string;
  /** The sidebar footer's provider row. */
  readonly footerRow: string;
  readonly sidebarHidden: boolean;
  readonly bodyPage: string | null;
  readonly error: string | null;
}

const FACTS_EXPRESSION = `({
  provider: ${PROVIDER},
  shell: ${SHELL},
  thread: ${THREAD},
  headline: document.querySelector('#provider-headline').textContent,
  saveLabel: document.querySelector('#provider-save').textContent,
  saveDisabled: document.querySelector('#provider-save').disabled,
  replayLabel: document.querySelector('#provider-replay').textContent,
  keyKept: document.querySelector('#provider-key-kept').textContent,
  footerRow: document.querySelector('#provider-open').textContent,
  sidebarHidden: document.querySelector('#sidebar').hidden,
  bodyPage: document.body.dataset.page ?? null,
  error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
})`;

function factsOf(cdp: Cdp, sessionId: string): Promise<PageFacts> {
  return evalJson<PageFacts>(cdp, sessionId, FACTS_EXPRESSION);
}

/** The facts a caption's claims are evaluated against, as one comparable string. */
function factsKey(facts: PageFacts): string {
  return JSON.stringify(facts);
}

/** A short description of a captured state, for the artifact's frame index. */
function describeFacts(facts: PageFacts): string {
  return [
    `state=${facts.provider.state}`,
    `shown=${facts.provider.shown}`,
    `status=${facts.provider.connection?.status ?? "(none)"}`,
    `toolCalling=${facts.provider.capabilities[0] ?? "(none)"}`,
    `answer=${JSON.stringify((facts.provider.answer ?? "").slice(0, 40))}`,
    `refusal=${JSON.stringify(facts.provider.refusal)}`,
    `footerRow=${JSON.stringify(facts.footerRow)}`,
    `bots=${facts.shell.bots.length}`,
    `frames=${facts.thread.frameCount}`,
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
    name: "01-no-provider",
    caption:
      "The first page on a machine whose vault holds nothing: the three fields, `Save and test`, and the quiet `Run in replay mode`, with no Bot list and no conversation behind them.",
    claims: [
      { label: "page 1 owns the center column", holds: (f) => f.provider.shown === true },
      { label: "the state is empty", holds: (f) => f.provider.state === "empty" },
      {
        label: "the headline welcomes the person",
        holds: (f) => f.headline === "Connect a provider",
      },
      { label: "the vault file is absent", holds: (f) => f.provider.vault.present === false },
      {
        label: "the fields are empty and the key is empty",
        holds: (f) =>
          f.provider.fields.baseUrl === "" &&
          f.provider.fields.model === "" &&
          f.provider.fields.keyEmpty === true,
      },
      { label: "the save reads `Save and test`", holds: (f) => f.saveLabel === "Save and test" },
      {
        label: "the quiet path reads `Run in replay mode`",
        holds: (f) => f.replayLabel === "Run in replay mode",
      },
      {
        label: "the request line is empty, because nothing is running",
        holds: (f) => f.provider.endpoint === "",
      },
      {
        label: "nothing is named as replaced, because the vault held nothing",
        holds: (f) => f.provider.replaced === null,
      },
      { label: "no Bot list is on screen", holds: (f) => f.sidebarHidden === true },
      {
        label: "the conversation and its tabs are out of the way",
        holds: (f) => f.bodyPage === "connect",
      },
      { label: "nothing is refused", holds: (f) => f.error === null },
    ],
    visible: "#provider-form",
  },
  {
    name: "02-testing",
    caption:
      "`Save and test` with the request in flight: the page shows the endpoint and the model it is posting to, and the save control is disabled until the reply arrives.",
    claims: [
      { label: "the state is testing", holds: (f) => f.provider.state === "testing" },
      {
        label: "the save control is disabled while it runs",
        holds: (f) => f.saveDisabled === true,
      },
      {
        label: "the request line names the endpoint and the model",
        holds: (f) =>
          f.provider.endpoint.startsWith("POST http") && f.provider.endpoint.includes("model "),
      },
      {
        label: "the status line says what it is waiting on",
        holds: (f) => f.provider.message.startsWith("Waiting for the reply. POST"),
      },
      { label: "the answer is not on screen yet", holds: (f) => f.provider.answer === null },
      {
        label: "the fields still hold what was typed",
        holds: (f) => f.provider.fields.keyEmpty === false,
      },
    ],
    visible: "#provider-request",
  },
  {
    name: "03-capable-saved",
    caption:
      "The same save once the reply landed: a tool call in the test turn, the flags it produced, and the model's own answer, with the connection saved at mode 600 and `Continue to your Bots` offered.",
    claims: [
      { label: "the state is capable", holds: (f) => f.provider.state === "capable" },
      { label: "the headline says so", holds: (f) => f.headline === "This connection is capable" },
      {
        label: "the connection is the one that was typed",
        holds: (f) => f.provider.connection?.status === "capable",
      },
      {
        label: "tool calling was observed, not assumed",
        holds: (f) => f.provider.capabilities[0] === "tool calling: strong",
      },
      {
        label: "the model's own answer is on the page",
        holds: (f) => (f.provider.answer ?? "").length > 0,
      },
      { label: "the key field is empty again", holds: (f) => f.provider.fields.keyEmpty === true },
      {
        label: "the vault is written",
        holds: (f) => f.provider.vault.present === true && f.provider.vault.mode === "600",
      },
      { label: "the page says where the key went", holds: (f) => f.keyKept.includes("mode 600") },
      {
        label: "the save says what a further save would replace",
        holds: (f) =>
          f.provider.replaced?.includes(f.provider.connection?.model ?? "\u0000") === true,
      },
      {
        label: "the footer row names the model and its capability",
        holds: (f) => f.footerRow.includes(" · capable"),
      },
      { label: "nothing is refused", holds: (f) => f.error === null },
    ],
    visible: "#provider-capabilities",
  },
  {
    name: "04-limited-saved",
    caption:
      "A provider that answers with no tool call: the page stores the weaker capability, says the structured output fallback will carry runs, and shows the flags it actually observed.",
    claims: [
      { label: "the state is limited", holds: (f) => f.provider.state === "limited" },
      {
        label: "the headline says so",
        holds: (f) => f.headline === "This connection answers, without a tool call",
      },
      {
        label: "no native call was observed",
        holds: (f) => f.provider.capabilities[0] === "tool calling: weak",
      },
      {
        label: "the structured fallback was exercised",
        holds: (f) => f.provider.capabilities[2] === "structured output: true",
      },
      { label: "the save says what it replaced", holds: (f) => f.provider.replaced !== null },
      {
        label: "the footer row follows the connection",
        holds: (f) => f.footerRow.includes(" · limited"),
      },
    ],
    visible: "#provider-capabilities",
  },
  {
    name: "05-refused-saved",
    caption:
      "A key the provider rejects: the page shows the provider's own status code and message, and the connection is saved marked untested so the next run fails loudly instead of replaying.",
    claims: [
      { label: "the state is untested", holds: (f) => f.provider.state === "untested" },
      {
        label: "the headline says the test did not pass",
        holds: (f) => f.headline === "The connection did not pass its test",
      },
      {
        label: "the provider answered with a status of its own",
        holds: (f) => f.provider.refusal?.status !== null,
      },
      { label: "and with a message", holds: (f) => (f.provider.refusal?.message ?? "").length > 0 },
      { label: "no flags were recorded", holds: (f) => f.provider.capabilities.length === 0 },
      {
        label: "the connection was saved anyway",
        holds: (f) =>
          f.provider.connection?.status === "untested" && f.provider.vault.present === true,
      },
      { label: "the save says what it replaces", holds: (f) => f.provider.replaced !== null },
      { label: "the key field is empty again", holds: (f) => f.provider.fields.keyEmpty === true },
    ],
    visible: "#provider-refusal",
  },
  {
    name: "06-run-on-saved-connection",
    caption:
      "A run after the capable save: the model wrote the file through the sandbox and closed the turn, all of it through the connection the page saved rather than through a recording.",
    claims: [
      {
        label: "the conversation is on screen",
        holds: (f) => f.bodyPage === "app" && f.sidebarHidden === false,
      },
      { label: "the run reached its end", holds: (f) => f.thread.done === true },
      {
        label: "the governed call ran",
        holds: (f) =>
          f.thread.cards.length > 0 && f.thread.cards.every(([, status]) => status === "done"),
      },
      { label: "the approval was answered", holds: (f) => f.thread.approvals.includes("allow") },
      { label: "the model's own text is on the page", holds: (f) => f.thread.deltas.length > 0 },
      {
        label: "the footer row still names the capable connection",
        holds: (f) => f.footerRow.includes(" · capable"),
      },
      { label: "nothing is refused", holds: (f) => f.error === null },
    ],
    visible: "#thread .tool-card",
  },
];

function specFor(name: string): FrameSpec {
  const spec = SPECS.find((entry) => entry.name === name);
  if (spec === undefined) throw new Error(`no frame spec named ${name}`);
  return spec;
}

let artifactsDir = "";
/** The literal the artifact must never contain: the key this driver borrowed. */
let secret = "";
/** Every frame this run committed, keyed by its name, so the index and the distinctness check agree. */
const captured = new Map<string, PageFacts>();

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
  captured.set(name, after);
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

/** `bun run up --no-open`, as a person runs it, over a vault and a bots root this driver made. */
async function launch(home: string, botsRoot: string): Promise<Launched> {
  const proc = Bun.spawn(["bun", "run", "up", "--no-open"], {
    cwd: root,
    env: { ...process.env, FREEBOT_HOME: home, FREEBOT_WORKSPACE: botsRoot },
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

function redacted(text: string): string {
  return text
    .replace(/#token=\S+/g, "#token=<redacted>")
    .replace(/Bearer \S+/g, "Bearer <redacted>")
    .split(secret)
    .join("<redacted-key>");
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
    await waitTrue(
      cdp,
      sessionId,
      "the page 1 hook",
      `typeof window.__providerFacts === 'function'`,
      30_000,
    );
  } catch (error) {
    console.error(`the page never exposed its provider hook; console: ${cdp.console.join(" | ")}`);
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

function fill(cdp: Cdp, sessionId: string, selector: string, value: string): Promise<void> {
  return evalJson(
    cdp,
    sessionId,
    `(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  );
}

/**
 * Type a value into a field the way a keyboard would. The key uses this rather than an expression,
 * because an expression carrying it could reach this driver's console, its error text, or its
 * artifact, and the key belongs in exactly one place: the field.
 */
async function typeText(
  cdp: Cdp,
  sessionId: string,
  selector: string,
  text: string,
): Promise<void> {
  const focused = await evalJson<boolean>(
    cdp,
    sessionId,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); return document.activeElement === el; })()`,
  );
  if (!focused) throw new Error(`could not focus ${selector}`);
  await cdp.send("Input.insertText", { text }, sessionId);
}

const ENDS = `#thread .run-finished, #thread .run-failed`;

function endedAfter(baseline: number): string {
  return `document.querySelectorAll(${JSON.stringify(ENDS)}).length > ${baseline}`;
}

const WAITING = `[...document.querySelectorAll('#thread .approval-card')].filter((card) => (card.dataset.decision ?? null) === null)`;

/** Answer every card the run parks on, one at a time, until it settles. */
async function answerUntilSettled(
  cdp: Cdp,
  log: Log,
  page: string,
  decision: "allow" | "deny",
  baseline: number,
  timeoutMs = 240_000,
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

/** Type a prompt into the page's own box and drive the run to its end. */
async function runPrompt(
  cdp: Cdp,
  log: Log,
  page: string,
  prompt: string,
  launch_: Launched,
): Promise<void> {
  const baseline = await evalJson<number>(
    cdp,
    page,
    `document.querySelectorAll(${JSON.stringify(ENDS)}).length`,
  );
  await evalJson(
    cdp,
    page,
    `(() => {
      const input = document.querySelector('#prompt');
      input.value = ${JSON.stringify(prompt)};
      document.querySelector('#start').click();
    })()`,
  );
  try {
    await waitTrue(
      cdp,
      page,
      "the parked approval",
      `${WAITING}.length >= 1 || ${endedAfter(baseline)}`,
      240_000,
    );
  } catch (error) {
    log.note(`the run never parked; the page said: ${JSON.stringify(await factsOf(cdp, page))}`);
    log.note(`launcher stderr tail: ${redacted(launch_.stderr().slice(-1200))}`);
    throw error;
  }
  if (await evalJson<boolean>(cdp, page, endedAfter(baseline))) {
    throw new Error("the run reached its end without parking at the gate");
  }
  await answerUntilSettled(cdp, log, page, "allow", baseline);
}

// ---------------------------------------------------------------------------
// The route surface, with the page's own token
// ---------------------------------------------------------------------------

interface Wire {
  readonly request: string;
  readonly status: number;
  readonly body: string;
}

async function post(
  launched: Launched,
  procedure: string,
  input: Record<string, unknown>,
): Promise<Wire> {
  const url = `http://127.0.0.1:${launched.apiPort}/rpc/${procedure}`;
  const body = JSON.stringify({ json: input });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${launched.token}`,
      origin: `http://127.0.0.1:${launched.apiPort}`,
    },
    body,
  });
  return {
    request: `POST /rpc/${procedure} content-type: application/json authorization: Bearer <redacted> origin: http://127.0.0.1:${launched.apiPort} body=${body}`,
    status: response.status,
    body: await response.text(),
  };
}

// ---------------------------------------------------------------------------
// The local stub provider, for the reply that carries no tool call
// ---------------------------------------------------------------------------

interface Stub {
  readonly baseUrl: string;
  /** Every body the stub was asked, in order. */
  readonly asked: Array<Record<string, unknown>>;
  stop(): void;
}

/**
 * A provider that answers whole replies and never calls a tool natively. The second request the page
 * makes asks for a JSON object, and this answers one carrying a tool, which is exactly the weaker
 * connection the fallback exists for. Its path carries a per-run token, so nothing else on the
 * machine can be mistaken for it and it can be read back for the artifact.
 */
function startStub(): Stub {
  const asked: Array<Record<string, unknown>> = [];
  const token = randomBytes(6).toString("hex");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      asked.push(body);
      const structured = body.response_format !== undefined;
      const content = structured
        ? JSON.stringify({ tool: "freebot_smoke_echo", arguments: { text: "save-time-smoke" } })
        : "I answer questions, but I cannot call tools.";
      return Response.json({
        id: "chatcmpl-stub",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1-${token}`,
    asked,
    stop: () => server.stop(true),
  };
}

// ---------------------------------------------------------------------------
// The key scan
// ---------------------------------------------------------------------------

/**
 * Every `.ts`/`.tsx`/`.md`/`.html`/`.json`/`.txt` file under the tree, minus the three directories
 * that hold other people's bytes. The scan is the last check the unit makes: a key this driver never
 * printed cannot be in the tree, and the check is what proves it rather than the intention.
 */
function trackedFiles(): string[] {
  const found: string[] = [];
  const skip = new Set([".git", "node_modules", "artifacts"]);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(ts|tsx|md|html|json|txt|sh|lock|jsonl)$/.test(entry.name)) found.push(abs);
    }
  };
  walk(root);
  return found.sort();
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const log = new Log();
let headerLines: string[] = [];
let chromeProc: Bun.Subprocess | null = null;
let userDataDir: string | null = null;
const made: string[] = [];

/** Write the artifact, refusing one that carries the key, the operator token, or a key-shaped literal. */
function writeArtifact(): string | null {
  const text = [...headerLines, ...log.lines, ""].join("\n");
  for (const launched of live) {
    if (launched.token !== "" && text.includes(launched.token)) {
      console.error("refusing to write an artifact that contains the operator token");
      return null;
    }
  }
  if (secret !== "" && text.includes(secret)) {
    console.error("refusing to write an artifact that contains the borrowed key");
    return null;
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

async function main(): Promise<void> {
  const sha = shortSha();
  const full = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
  const branch = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    .stdout.toString()
    .trim();
  artifactsDir = join(root, "packages", "verify", "artifacts", "provider-setup", sha);
  rmSync(artifactsDir, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });

  // The machine's own vault, read in-process and never written. This driver's server gets a vault of
  // its own, so nothing here can replace the connection a person is using.
  const realVault = readVault();
  if (realVault === null) {
    throw new Error(
      "this driver needs a connection in the machine's vault: the capable case is a real model",
    );
  }
  const realDescription = describeVault();
  secret = realVault.key;

  const home = realpathSync(mkdtempSync(join(tmpdir(), "freebot-provider-home-")));
  const botsRoot = realpathSync(mkdtempSync(join(tmpdir(), "freebot-provider-bots-")));
  made.push(home, botsRoot);

  headerLines = [
    "feature: provider-setup",
    "command: bun packages/verify/scripts/provider-setup.ts",
    `timestamp: ${new Date().toISOString()}`,
    `git sha: ${full}`,
    `git sha short: ${sha}`,
    `branch: ${branch}`,
    `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
    `the line the model was asked to write: ${LINE}`,
    `the vault this driver launched with: ${join(home, "provider.env")} (fresh, empty)`,
    `the bots root this driver made: ${botsRoot}`,
    `the machine's own vault, read-only: ${realDescription.path} (present, mode ${realDescription.mode ?? "unknown"})`,
    `the connection borrowed for the capable case: ${realVault.model} at ${new URL(realVault.baseUrl).host}`,
    "",
  ];
  log.note("# provider-setup live-ui frames");
  log.note(
    [
      "DRIVER DISCLOSURE: the launcher is spawned as `bun run up --no-open` with FREEBOT_HOME and",
      "FREEBOT_WORKSPACE pointing at fresh directories this driver made, so the vault the page writes",
      "and the Bots it runs are this driver's own and the machine's real vault is never written.",
      "The key the capable case types into the page is that vault's own key, read in-process; it is",
      "never printed, echoed in a command line, or committed, and the artifact writer on this driver",
      "refuses to write a file containing it. The limited case points the same page at a local stub",
      "provider this driver starts, and the refused case points it at the real endpoint with a",
      "deliberately wrong key so the provider answers with its own status code.",
    ].join(" "),
  );

  const baseline = runContainers();
  log.note(
    `containers before the run (label ${UNIT_LABEL}): ${baseline.length}${baseline.length === 0 ? "" : ` (${baseline.join(", ")})`}`,
  );

  log.section("the launch, over a home and a bots root this driver made");
  const first = await launch(home, botsRoot);
  log.note(`the printed URL, redacted: ${redacted(first.url)}`);
  const modeLine = await waitForMatch(
    () => first.stderr(),
    /^(freebot up: model mode .*)$/m,
    30_000,
  );
  log.note(`the launcher's line: ${modeLine}`);
  log.check(
    "the launcher's boot line says keyless, because the vault it was given is empty",
    [modeLine.startsWith("freebot up: model mode auto"), modeLine.includes("keyless, replaying")],
    [true, true],
  );
  const vaultLine = await waitForMatch(() => first.stderr(), /^(freebot up: vault .*)$/m, 30_000);
  log.note(`the launcher's line: ${vaultLine}`);
  log.check(
    "and names the empty vault this driver made",
    vaultLine,
    `freebot up: vault ${join(home, "provider.env")} absent`,
  );

  userDataDir = join(tmpdir(), `freebot-provider-${Date.now()}`);
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

  const capturedNames: string[] = [];

  log.section("page 1 on a machine whose vault holds nothing");
  // A Bot first, over the route a page uses: a store with no Bot opens the first-run screen now, and
  // this driver's subject is page 1, which is what a keyless machine with a Bot boots into.
  const madeFirst = await makeFirstBot(first, "Page One Check");
  log.note(`the Bot this driver made before page 1 opened: ${JSON.stringify(madeFirst)}`);
  const page = await openPage(cdp, first.url);
  const empty = await capture(cdp, page, "01-no-provider", log);
  capturedNames.push("01-no-provider");
  log.check(
    "the page opened on page 1 rather than on a conversation, because no provider is saved",
    [empty.provider.shown, empty.sidebarHidden, empty.bodyPage],
    [true, true, "connect"],
  );
  log.check(
    "the vault the page names is the one the launcher was given, and nothing was written to it",
    [empty.provider.vault.path, empty.provider.vault.present],
    [join(home, "provider.env"), false],
  );

  log.section("`Save and test` against the real endpoint, watching the request run");
  await fill(cdp, page, "#provider-base-url", realVault.baseUrl);
  await fill(cdp, page, "#provider-model", realVault.model);
  await typeText(cdp, page, "#provider-key", realVault.key);
  const typed = await factsOf(cdp, page);
  log.check(
    "the three fields hold what was typed, and the key field is not empty",
    [typed.provider.fields.baseUrl, typed.provider.fields.model, typed.provider.fields.keyEmpty],
    [realVault.baseUrl, realVault.model, false],
  );
  log.check(
    "the request line shows the endpoint and the model before the button is pressed",
    [typed.provider.endpoint, typed.provider.replaced],
    [`POST ${realVault.baseUrl}/chat/completions  model ${realVault.model}`, null],
  );
  await clickSelector(cdp, page, "#provider-save");
  await waitTrue(cdp, page, "the testing state", `${PROVIDER}.state === 'testing'`, 60_000);
  try {
    await capture(cdp, page, "02-testing", log);
    capturedNames.push("02-testing");
  } catch (error) {
    log.fail("frame 02-testing", error);
    throw error;
  }
  await waitTrue(
    cdp,
    page,
    "the connection to be tested",
    `${PROVIDER}.state === 'capable' || ${PROVIDER}.state === 'limited' || ${PROVIDER}.state === 'untested'`,
    240_000,
  );
  const tested = await factsOf(cdp, page);
  log.note(`the answer the page shows: ${JSON.stringify(tested.provider.answer)}`);
  log.note(`the refusal the page shows: ${JSON.stringify(tested.provider.refusal)}`);
  log.check(
    "the real model called the tool, so the connection is capable",
    [tested.provider.state, tested.provider.capabilities],
    [
      "capable",
      [
        "tool calling: strong",
        "streaming: true",
        "structured output: unknown",
        "context window: unknown",
      ],
    ],
  );
  capturedNames.push("03-capable-saved");
  await capture(cdp, page, "03-capable-saved", log);

  log.section("the key went to the vault and nowhere else");
  const vaultStat = statSync(join(home, "provider.env"));
  log.check(
    "the vault file the page wrote is mode 600",
    (vaultStat.mode & 0o777).toString(8),
    "600",
  );
  const written = readVault(join(home, "provider.env"));
  log.check(
    "and it holds the endpoint and the model that were typed",
    written === null ? null : { baseUrl: written.baseUrl, model: written.model },
    { baseUrl: realVault.baseUrl, model: realVault.model },
  );
  log.check(
    "and the key line is the only place the key value is written",
    written !== null && written.key === realVault.key,
    true,
  );
  const recordPath = join(home, "provider.json");
  const recordText = readFileSync(recordPath, "utf8");
  log.check("the record file is mode 600", (statSync(recordPath).mode & 0o777).toString(8), "600");
  log.check(
    "and carries the capability, and the key value is not in it",
    [JSON.parse(recordText).status, recordText.includes(realVault.key)],
    ["capable", false],
  );
  const providerRead = await post(first, "get_provider", {});
  log.note(`the request: ${providerRead.request}`);
  log.note(`the answer: ${providerRead.status} ${redacted(providerRead.body)}`);
  const readBack = JSON.parse(providerRead.body) as {
    json: { vault: { mode: string | null }; connection: Record<string, unknown> };
  };
  log.check(
    "`get_provider` answers with the vault's mode and the connection, and no key reaches the client",
    [
      readBack.json.vault.mode,
      Object.keys(readBack.json.connection).sort(),
      providerRead.body.includes(realVault.key),
    ],
    ["600", ["answer", "baseUrl", "flags", "model", "refusal", "status", "testedAt"], false],
  );

  log.section("the run path: the saved connection is what a run uses");
  await clickSelector(cdp, page, "#provider-continue");
  await waitTrue(cdp, page, "the Bot list", `${SHELL}.bots.length >= 1`, 60_000);
  await waitTrue(
    cdp,
    page,
    "the first Bot and its thread",
    `${SHELL}.threads.length >= 1 && document.querySelector('#conn').textContent === 'connected'`,
    60_000,
  );
  const inApp = await factsOf(cdp, page);
  log.check(
    "continuing lands on the conversation, with the footer row naming the capable connection",
    [inApp.bodyPage, inApp.sidebarHidden, inApp.footerRow.includes(" · capable")],
    ["app", false, true],
  );
  const writePrompt = `Use the bash tool to write exactly this, and nothing else, into the file /workspace/note.txt: '${LINE}' followed by a newline. Create no other file and read nothing. Then reply with one short sentence.`;
  await runPrompt(cdp, log, page, writePrompt, first);
  await waitTrue(cdp, page, "the thread's own count", `${SHELL}.threads[0].runs === 1`, 60_000);
  capturedNames.push("06-run-on-saved-connection");
  await capture(cdp, page, "06-run-on-saved-connection", log);

  const turnLines = [...first.stderr().matchAll(/^(freebot provider: .*)$/gm)].map(
    (m) => m[1] ?? "",
  );
  log.note("the server's own per-turn lines, as they arrived:");
  for (const line of turnLines) log.note(`  ${redacted(line)}`);
  log.check(
    "the run's own turn lines name the endpoint and the model the page saved",
    turnLines.some(
      (line) =>
        line.includes(`POST ${realVault.baseUrl}/chat/completions`) &&
        line.includes(`model=${realVault.model}`),
    ),
    true,
  );
  log.check(
    "and every one of them carries a redacted Authorization rather than a key",
    [
      turnLines.length > 0,
      turnLines.every((line) => !line.includes(realVault.key)),
      turnLines.some((line) => line.includes('authorization="Bearer <redacted>"')),
    ],
    [true, true, true],
  );

  const botId = (await factsOf(cdp, page)).shell.bots[0]?.botId ?? "";
  const onDisk = await Bun.file(join(botWorkspacePath(botsRoot, botId), "note.txt"))
    .text()
    .catch(() => null);
  log.note(`the Bot's workspace, read by the driver from the host: ${JSON.stringify(onDisk)}`);
  log.check(
    "the file the model wrote through the sandbox carries the nonce this driver minted",
    onDisk?.includes(LINE) === true,
    true,
  );
  log.check(
    "the launcher's boot line said keyless and the run went keyed, because the vault the page wrote is what the run path reads",
    [modeLine.includes("keyless, replaying"), turnLines.some((line) => line.includes("POST http"))],
    [true, true],
  );
  log.check(
    "the transcript's governed call is the container's, not a recording's",
    onDisk?.trim() === LINE && (await factsOf(cdp, page)).thread.cards.length > 0,
    true,
  );

  log.section("a provider that answers with no tool call");
  const stub = startStub();
  log.note(`the stub provider this driver started: ${stub.baseUrl}`);
  await clickSelector(cdp, page, "#provider-open");
  await waitTrue(cdp, page, "page 1 from the sidebar footer", `${PROVIDER}.shown === true`, 30_000);
  const backOnPageOne = await factsOf(cdp, page);
  log.check(
    "the footer row brings page 1 back, and it says what a save will replace",
    [backOnPageOne.provider.shown, backOnPageOne.provider.replaced !== null],
    [true, true],
  );
  log.note(`the disclosure before the save: ${JSON.stringify(backOnPageOne.provider.replaced)}`);
  await fill(cdp, page, "#provider-base-url", stub.baseUrl);
  await fill(cdp, page, "#provider-model", "stub-model");
  await typeText(cdp, page, "#provider-key", "stub-key-not-a-credential");
  await clickSelector(cdp, page, "#provider-save");
  await waitTrue(cdp, page, "the stub's answer", `${PROVIDER}.state === 'limited'`, 120_000);
  capturedNames.push("04-limited-saved");
  await capture(cdp, page, "04-limited-saved", log);
  log.note(
    `what the stub was asked, in order: ${JSON.stringify(
      stub.asked.map((body) => ({
        tools: (body.tools as Array<{ function: { name: string } }> | undefined)?.map(
          (tool) => tool.function.name,
        ),
        tool_choice: body.tool_choice,
        stream: body.stream,
        response_format: body.response_format,
      })),
    )}`,
  );
  log.check(
    "the requests carried a tool definition, then asked for the structured output fallback",
    [
      (stub.asked[0]?.tools as Array<{ function: { name: string } }> | undefined)?.map(
        (tool) => tool.function.name,
      ),
      stub.asked[0]?.tool_choice,
      stub.asked[0]?.stream,
      stub.asked.at(-1)?.response_format,
      stub.asked.length,
    ],
    [["freebot_smoke_echo"], "auto", true, { type: "json_object" }, 3],
  );
  stub.stop();

  log.section("a key the provider itself rejects");
  const beforeRefusal = await factsOf(cdp, page);
  log.note(
    `the disclosure before the refused save: ${JSON.stringify(beforeRefusal.provider.replaced)}`,
  );
  log.check(
    "the page said what the refused save would replace before it was pressed",
    beforeRefusal.provider.replaced?.includes("stub-model") === true,
    true,
  );
  await fill(cdp, page, "#provider-base-url", realVault.baseUrl);
  await fill(cdp, page, "#provider-model", realVault.model);
  await typeText(cdp, page, "#provider-key", WRONG_KEY);
  await clickSelector(cdp, page, "#provider-save");
  await waitTrue(cdp, page, "the provider's refusal", `${PROVIDER}.state === 'untested'`, 120_000);
  capturedNames.push("05-refused-saved");
  const refused = await capture(cdp, page, "05-refused-saved", log);
  log.note(
    `the provider's own refusal, as the page shows it: ${JSON.stringify(refused.provider.refusal)}`,
  );
  log.check(
    "the provider answered with a refusal status of its own, and it is a credential refusal",
    [
      refused.provider.refusal?.status ?? 0,
      [401, 403, 429].includes(refused.provider.refusal?.status ?? 0),
    ],
    [refused.provider.refusal?.status ?? 0, true],
  );
  log.check(
    "the page says the test did not pass and renders the provider's message",
    [
      refused.headline,
      refused.provider.message,
      refused.provider.refusal?.message.includes(String(refused.provider.refusal?.status)) === true,
    ],
    ["The connection did not pass its test", "Saved, untested.", true],
  );
  log.check(
    "the refused connection is saved anyway, marked untested",
    [
      JSON.parse(readFileSync(recordPath, "utf8")).status,
      (statSync(join(home, "provider.env")).mode & 0o777).toString(8),
    ],
    ["untested", "600"],
  );
  log.check(
    "and the wrong key is what the vault now holds, so the next run fails at the provider",
    readVault(join(home, "provider.env"))?.key === WRONG_KEY,
    true,
  );

  log.section("shutdown, and the containers this driver created");
  first.interrupt();
  const code = await first.exited();
  log.check("the launch exits zero on SIGINT", code, 0);
  log.check("nothing listens on the launch's page port", listeners(first.apiPort), []);
  log.check(
    "the label's container set is back where it started",
    await settles(() => JSON.stringify(runContainers()) === JSON.stringify(baseline)),
    true,
  );

  cdp.close();
  chromeProc.kill();

  log.section("pairwise distinctness of the committed frames");
  const keys = capturedNames.map((name) => factsKey(captured.get(name) as PageFacts));
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
  log.check(
    "frames: every named frame was committed",
    SPECS.map((spec) => captured.has(spec.name)),
    SPECS.map(() => true),
  );

  log.section("frame index");
  log.note("name -> asserted facts -> caption");
  for (const spec of SPECS) {
    const found = captured.get(spec.name);
    if (found === undefined) {
      log.fail(`frame index ${spec.name}`, "no capture was taken");
      continue;
    }
    log.note(`${spec.name} -> ${describeFacts(found)} -> ${spec.caption}`);
  }

  log.section("the key, in the tree");
  const hits = trackedFiles().filter((path) => {
    try {
      return readFileSync(path, "utf8").includes(secret);
    } catch {
      return false;
    }
  });
  log.check(
    `no file under apps, packages, docs or spikes carries the borrowed key (${hits.length} scanned hits)`,
    hits,
    [],
  );
  log.check(
    "and the artifact this driver is about to write does not either",
    [...headerLines, ...log.lines].join("\n").includes(secret),
    false,
  );
}

let exitCode = 1;
try {
  await main();
  exitCode = log.failed === 0 ? 0 : 1;
} catch (error) {
  log.fail("the driver stopped early", error);
  exitCode = 1;
} finally {
  const path = writeArtifact();
  if (path !== null) {
    console.log(log.result());
    console.log(`artifact: ${path.replace(`${root}/`, "")}`);
  }
  await cleanup();
  process.exitCode = exitCode;
}
