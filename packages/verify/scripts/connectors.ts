#!/usr/bin/env bun
/**
 * The U8.1 evidence driver: the connector seam, end to end, over an emulated service.
 *
 * One interface, one emulated service, one real run path. The launcher is spawned the way a person
 * spawns it (`bun run up --no-open`), over a bots root and a freebot home this driver made, with a
 * transcript that asks for a connector tool and a `connectors.json` that holds the connector's
 * credential with mode 600. The model is the replay provider: keyless, and pinned to this driver's
 * own recorded turn, so the run bills nobody and varies from nothing (order 9).
 *
 * What makes this evidence rather than a fixture with a mock behind it:
 *
 * - the service is a real HTTP service this process serves (`emulate`, GitHub), bound on 0.0.0.0,
 *   seeded with a repository and a token this run minted, and every assertion about its state is a
 *   read of the service itself;
 * - the connector reaches it through a real MCP server (`packages/connectors`' own transport), whose
 *   bearer gate refuses a call with no credential;
 * - the run reaches the connector through the landed pipeline: the launcher, the gate, the log, the
 *   approval, the seam, and the service;
 * - the reset is the service's own `reset()`, followed by a second run that has to work again from
 *   empty;
 * - the sandbox is a real container from the pinned image, and it is asked, in its own words,
 *   whether it can act on the service and whether it holds either credential.
 *
 * Run from the repo root: bun packages/verify/scripts/connectors.ts
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ConnectorRegistry } from "../../../apps/server/src/connectors.ts";
import { botWorkspacePath } from "../../../apps/server/src/workspace-files.ts";
import { type GithubFixture, type IssueRow, startGithubFixture } from "../src/emulator.ts";
import { createGithubConnector, type GithubConnector } from "../src/github-mcp.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));

/** The label every run container carries, which is what scopes the census and the cleanup. */
const RUN_LABEL = "freebot.unit=u1.7";
/** This driver's own label, for the one container it runs by hand. */
const PROBE_LABEL = "freebot.unit=u8.1-connector-probe";
/** The pinned image, as `docs/sandbox-image.md` records it. */
const SANDBOX_IMAGE = "freebot-sandbox:u0.6";
/** The connector's id, which namespaces its tool names. */
const CONNECTOR_ID = "emulate-github";
/** The landed transcript, replayed by the third run to prove the sandbox arm still works. */
const LANDED_TRANSCRIPT = join(root, "packages/pi-bridge/fixtures/rpc-handshake.jsonl");
/** The committed template this driver renders its two connector turns from. */
const CONNECTOR_TEMPLATE = join(root, "packages/verify/fixtures/connector-turn.jsonl");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The log, and the artifact it becomes
// ---------------------------------------------------------------------------

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

const log = new Log();
let headerLines: string[] = [];
let artifactsDir = "";
const made: string[] = [];
/** Every secret this run minted, so the artifact writer can refuse one that carries any. */
const secrets: string[] = [];
let fixture: GithubFixture | null = null;
let connector: GithubConnector | null = null;

// ---------------------------------------------------------------------------
// Small facts about this machine
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

/** The addresses `port` is listening on, as `command address`; a 0.0.0.0 bind shows as `*:port`. */
function listeners(port: number): string[] {
  const proc = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  const raw = proc.stdout.toString().trim();
  return raw === ""
    ? []
    : raw
        .split("\n")
        .slice(1)
        .map((line) => {
          const columns = line.split(/\s+/);
          return `${columns[0] ?? ""} ${columns[8] ?? ""}`;
        });
}

function git(args: readonly string[]): string {
  const proc = Bun.spawnSync(["git", ...args]);
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

/** Every file under `dir` carrying `secret`, as paths, for the credential scans. */
function filesCarrying(dir: string, secret: string): string[] {
  const proc = Bun.spawnSync([
    "rg",
    "-l",
    "-F",
    "--hidden",
    "-g",
    "!.git",
    "-g",
    "!node_modules",
    "--",
    secret,
    dir,
  ]);
  const raw = proc.stdout.toString().trim();
  return raw === "" ? [] : raw.split("\n").sort();
}

/** Every file under `dir`, and nothing about their contents. */
function filesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) found.push(child);
    }
  };
  try {
    walk(dir);
  } catch {
    // A directory that is not there holds no file that carries a credential.
  }
  return found;
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

/** `bun run up`, as a person runs it, over the home and bots root this driver made. */
async function launch(input: {
  readonly home: string;
  readonly botsRoot: string;
  readonly transcript: string;
  readonly connectorsFile: string;
}): Promise<Launched> {
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "up",
      "--no-open",
      "--replay",
      "--transcript",
      input.transcript,
      "--connectors",
      input.connectorsFile,
    ],
    {
      cwd: root,
      env: { ...process.env, FREEBOT_HOME: input.home, FREEBOT_WORKSPACE: input.botsRoot },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
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
// The records, over the route surface itself
// ---------------------------------------------------------------------------

interface Wire {
  readonly request: string;
  readonly status: number;
  readonly body: string;
}

/** One call to the oRPC route surface with the launch's own token, with the request line recorded. */
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

/** A Bot and a thread of this driver's own, made the way a page makes them. */
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

// ---------------------------------------------------------------------------
// The thread's stream, watched the way the page watches it
// ---------------------------------------------------------------------------

interface Frame {
  readonly v: number;
  readonly seq: number;
  readonly ts: number;
  readonly runId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/** One socket on one thread's log, with the two control messages the page sends. */
class Stream {
  readonly #ws: WebSocket;
  readonly frames: Frame[] = [];
  #waiters: Array<{ predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  readonly hello: Record<string, unknown> = {};

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        v?: number;
        seq?: number;
        ts?: number;
        runId?: string;
        type?: string;
        payload?: Record<string, unknown>;
      };
      if (message.type === "stream.hello" || message.type === "stream.resumed") {
        Object.assign(this.hello, { [message.type]: message.payload ?? {} });
        return;
      }
      const frame: Frame = {
        v: message.v ?? 0,
        seq: message.seq ?? 0,
        ts: message.ts ?? 0,
        runId: message.runId ?? "",
        type: message.type ?? "",
        payload: message.payload ?? {},
      };
      this.frames.push(frame);
      this.#waiters = this.#waiters.filter((waiter) => {
        if (!waiter.predicate(frame)) return true;
        waiter.resolve(frame);
        return false;
      });
    };
  }

  static async open(url: string): Promise<Stream> {
    const ws = new WebSocket(url);
    const stream = new Stream(ws);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () =>
        reject(
          new Error(`stream connect failed: ${url.replace(/token=[^&]*/, "token=<redacted>")}`),
        );
    });
    return stream;
  }

  next(predicate: (frame: Frame) => boolean, desc: string, timeoutMs = 180_000): Promise<Frame> {
    const found = this.frames.find(predicate);
    if (found !== undefined) return Promise.resolve(found);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`stream timeout: ${desc}`)), timeoutMs);
      this.#waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  send(message: unknown): void {
    this.#ws.send(JSON.stringify(message));
  }

  close(): void {
    this.#ws.close();
  }
}

function framesOfType(frames: readonly Frame[], type: string): Frame[] {
  return frames.filter((frame) => frame.type === type);
}

/**
 * One run, driven the way the page drives it: a start control message, the approval card answered
 * with `allow`, then the run's end. The frames this run wrote are returned in order.
 *
 * A run that does not reach its end says what it did instead: the frames it wrote and the tail of
 * the launcher's own stderr go into the artifact before the failure, because a driver that hangs
 * with no record of the run is a driver nobody can debug.
 */
async function runThrough(
  log: Log,
  input: {
    readonly launch: Launched;
    readonly botId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly toolName: string;
  },
): Promise<Frame[]> {
  const stream = await Stream.open(
    `ws://127.0.0.1:${input.launch.apiPort}/events?token=${input.launch.token}&thread_id=${input.threadId}&last_seen_seq=0`,
  );
  try {
    const before = stream.frames.length;
    stream.send({
      type: "start",
      prompt: input.prompt,
      botId: input.botId,
      threadId: input.threadId,
    });
    const requested = await stream.next(
      (frame) => frame.type === "tool_call.requested" && frame.payload.toolName === input.toolName,
      `the model to ask for ${input.toolName}`,
    );
    log.note(`the model's call: ${JSON.stringify(requested.payload)}`);
    const parked = await stream.next((frame) => frame.type === "approval.requested", "the park");
    log.note(`the parked approval: ${JSON.stringify(parked.payload)}`);
    stream.send({ type: "answer", decision: "allow", approvalId: parked.payload.approvalId });
    log.note(`answered with allow`);
    const failed = stream.next((frame) => frame.type === "run.failed", "the run to fail");
    // The race below drops the loser: a rejection nobody kept must not surface as an unhandled one.
    void failed.catch(() => {});
    const finished = await Promise.race([
      stream.next((frame) => frame.type === "run.finished", "the run's end"),
      failed.then((frame) => {
        throw new Error(`the run failed: ${JSON.stringify(frame.payload)}`);
      }),
    ]);
    log.note(`the run ended at seq ${finished.seq}`);
    return stream.frames.slice(before);
  } catch (error) {
    log.note(`the run did not finish: ${error instanceof Error ? error.message : String(error)}`);
    log.note(
      `the frames it wrote: ${JSON.stringify(
        stream.frames.map(
          (frame) => `${frame.seq} ${frame.type} ${JSON.stringify(frame.payload).slice(0, 160)}`,
        ),
        null,
        1,
      )}`,
    );
    log.note(`the launcher's stderr tail: ${input.launch.stderr().slice(-1200)}`);
    throw error;
  } finally {
    stream.close();
  }
}

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

/** Write the artifact, refusing one that carries any credential or a key-shaped literal. */
function writeArtifact(): string | null {
  const text = [...headerLines, ...log.lines, ""].join("\n");
  for (const launched of live) {
    if (launched.token !== "" && text.includes(launched.token)) {
      console.error("refusing to write an artifact that contains the operator token");
      return null;
    }
  }
  for (const secret of secrets) {
    if (secret !== "" && text.includes(secret)) {
      console.error("refusing to write an artifact that contains a credential");
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
  for (const name of dockerNames([`label=${PROBE_LABEL}`])) {
    Bun.spawnSync(["docker", "rm", "-f", name]);
  }
  if (connector !== null) await connector.close().catch(() => {});
  if (fixture !== null) await fixture.close().catch(() => {});
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const sha = git(["rev-parse", "--short", "HEAD"]);
  artifactsDir = join(root, "packages", "verify", "artifacts", "connectors", sha);
  rmSync(artifactsDir, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });

  const home = mkdtempSync(join(tmpdir(), "freebot-connectors-home-"));
  const botsRoot = mkdtempSync(join(tmpdir(), "freebot-connectors-bots-"));
  made.push(home, botsRoot);
  const nonce = `u8.1-${Math.random().toString(36).slice(2, 10)}`;

  headerLines = [
    "feature: connectors",
    "command: bun packages/verify/scripts/connectors.ts",
    `timestamp: ${new Date().toISOString()}`,
    `git sha: ${git(["rev-parse", "HEAD"])}`,
    `git sha short: ${sha}`,
    `branch: ${git(["rev-parse", "--abbrev-ref", "HEAD"])}`,
    `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
    `the run's nonce: ${nonce}`,
    `the freebot home this driver made: ${home}`,
    `the bots root this driver made: ${botsRoot}`,
    `the connector turn template: ${relative(root, CONNECTOR_TEMPLATE)}`,
    "",
  ];
  log.note("# connectors evidence: one seam, one emulated service, one container");
  log.note(
    "DRIVER DISCLOSURE: the launcher is spawned as `bun run up --no-open --replay --transcript <this run's turn> --connectors <this run's file>` with FREEBOT_HOME and FREEBOT_WORKSPACE pointing at fresh directories. No account, no provider key and no third-party credential is involved: the service is a GitHub emulator this process serves, seeded with a token this run minted, and the model is the recorded turn this driver rendered. The credential the connector uses lives in a mode-600 file under the driver's own home and reaches one request header.",
  );

  // -------------------------------------------------------------------------
  // The emulated service
  // -------------------------------------------------------------------------
  log.section("the emulated service, on every interface, seeded with a repository and a token");
  const service = await startGithubFixture({
    login: "freebot-fixture",
    owner: "freebot-fixture",
    repo: "connector-fixture",
  });
  fixture = service;
  secrets.push(service.token);
  log.note(`the service is at ${service.url} (port ${service.port})`);
  const serviceListeners = listeners(service.port);
  log.note(
    `the listening socket: ${JSON.stringify(serviceListeners)} (a 0.0.0.0 bind shows as a *: port, which is what lets a container reach it and be refused)`,
  );
  log.check(
    "the service listens on every interface, so reachability cannot be confused with authorization",
    serviceListeners.some((line) => line.includes("*:")),
    true,
  );
  const refused = await service.probeWithoutCredential();
  log.note(`a write with no credential: ${refused.status} ${refused.body}`);
  log.check(
    "the service refuses a write that carries no credential",
    [refused.status, refused.body.includes("Requires authentication")],
    [401, true],
  );
  log.check("and its state is still empty, read from the service", await service.issues(), []);

  // -------------------------------------------------------------------------
  // The connector's far side: a real MCP server over the service
  // -------------------------------------------------------------------------
  log.section("the connector's far side: a real MCP server whose two tools act on the service");
  const side = createGithubConnector({
    fixture: service,
    name: "freebot-fixture-connector",
    version: "1.0.0",
  });
  connector = side;
  secrets.push(side.token);
  const mcpUrl = `${side.url}/mcp`;
  log.note(`the MCP server is at ${mcpUrl}`);
  log.note(`the listening socket: ${JSON.stringify(listeners(side.port))}`);
  const unauthMcp = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  log.check(
    "the MCP server refuses a handshake with no credential",
    [unauthMcp.status, (await unauthMcp.text()).trim()],
    [401, "no credential"],
  );

  // -------------------------------------------------------------------------
  // The seam, in this process, against that server
  // -------------------------------------------------------------------------
  log.section("the seam itself, over the wire, in this process");
  const seam = ConnectorRegistry.fromEntries([
    { id: CONNECTOR_ID, url: mcpUrl, headers: { authorization: `Bearer ${side.token}` } },
  ]).connectors()[0];
  if (seam === undefined) throw new Error("the registry built no connector");
  const seamTools = await seam.describe();
  log.check(
    "the tools the seam sees are the server's own list, under the connector's own names",
    seamTools.map((tool) => tool.name),
    ["create_issue", "list_issues"],
  );
  log.check(
    "the credential is a reference and the health row carries no value",
    [
      await seam.authenticate(),
      JSON.stringify(await seam.health()).includes(side.token),
      (await seam.health()).ok,
    ],
    [`connector:${CONNECTOR_ID}`, false, true],
  );
  log.note(`the health row: ${JSON.stringify(await seam.health())}`);
  const wrongCredential = ConnectorRegistry.fromEntries([
    { id: CONNECTOR_ID, url: mcpUrl, headers: { authorization: "Bearer not-the-credential" } },
  ]).connectors()[0];
  const wrongCall =
    wrongCredential === undefined
      ? "no connector"
      : await wrongCredential
          .call("create_issue", { title: "refused" })
          .then(() => "ran")
          .catch((error: Error) =>
            error.message.includes("401") && !error.message.includes("not-the-credential")
              ? "refused, and the message names no value"
              : `unexpected: ${error.message}`,
          );
  log.check(
    "a call the server refuses fails, and the failure carries no credential",
    wrongCall,
    "refused, and the message names no value",
  );
  log.check(
    "the service still holds no issue, so the refused call created nothing",
    await service.issues(),
    [],
  );

  // -------------------------------------------------------------------------
  // The home the launcher reads, and the two transcripts it replays
  // -------------------------------------------------------------------------
  log.section("the credential's one home, and the turns the launcher replays");
  const template = readFileSync(CONNECTOR_TEMPLATE, "utf8");
  const turns = ["1", "2"].map((run) => {
    const path = join(home, `connector-turn-${run}.jsonl`);
    writeFileSync(path, template.replaceAll("{{NONCE}}", nonce).replaceAll("{{RUN}}", run));
    return path;
  });
  const titles = [1, 2].map((run) => `connector-seam ${nonce} run ${run}`);
  const connectorsFile = join(home, "connectors.json");
  writeFileSync(
    connectorsFile,
    `${JSON.stringify(
      {
        connectors: [
          { id: CONNECTOR_ID, url: mcpUrl, headers: { authorization: `Bearer ${side.token}` } },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  log.note(`the connector's home: ${connectorsFile}`);
  log.check(
    "the file holding the connector's credential is readable by its owner alone",
    statSync(connectorsFile).mode & 0o777,
    0o600,
  );
  log.check(
    "it is under the driver's own home, not in the repository",
    [connectorsFile.startsWith(home), relative(root, connectorsFile).startsWith("..")],
    [true, true],
  );
  log.check(
    "the rendered turn names one tool: the model-facing name the connector's id makes",
    turns.map(
      (path) =>
        /"type":"tool_execution_start"[^\n]*"toolName":"([^"]+)"/.exec(
          readFileSync(path, "utf8"),
        )?.[1] ?? null,
    ),
    [`${CONNECTOR_ID}__create_issue`, `${CONNECTOR_ID}__create_issue`],
  );

  // -------------------------------------------------------------------------
  // The first launch, and the first run
  // -------------------------------------------------------------------------
  log.section("the first launch, and a run that asks the connector for one issue");
  const baseline = dockerNames([`label=${RUN_LABEL}`]);
  log.note(
    `run containers before this driver: ${baseline.length}${baseline.length === 0 ? "" : ` (${baseline.join(", ")})`}`,
  );
  const first = await launch({ home, botsRoot, transcript: turns[0] ?? "", connectorsFile });
  log.note(`the printed URL, redacted: ${redacted(first.url)}`);
  const modeLine = await waitForMatch(
    () => first.stderr(),
    /^(freebot up: model mode .*)$/m,
    30_000,
  );
  log.note(`the launcher's line: ${modeLine}`);
  log.check(
    "the launcher replayed this driver's turn rather than calling a model",
    [
      modeLine.includes("model mode replay"),
      modeLine.includes("keyless, replaying"),
      modeLine.includes(turns[0] ?? ""),
    ],
    [true, true, true],
  );
  const connectorsLine = await waitForMatch(
    () => first.stderr(),
    /^(freebot up: connectors .*)$/m,
    30_000,
  );
  log.note(`the launcher's line: ${connectorsLine}`);
  log.check(
    "the launcher named the file it read and the connector in it, by id and address, and no header",
    [
      connectorsLine.includes(connectorsFile),
      connectorsLine.includes(CONNECTOR_ID),
      connectorsLine.includes(mcpUrl),
      connectorsLine.includes("Bearer"),
    ],
    [true, true, true, false],
  );
  const botsLine = await waitForMatch(
    () => first.stderr(),
    /^(freebot up: bots under .*)$/m,
    30_000,
  );
  log.check(
    "the launcher is holding the bots root this driver made",
    botsLine,
    `freebot up: bots under ${botsRoot}; each Bot's workspace is mounted at /workspace and kept across runs`,
  );

  const { botId, threadId } = await makeFirstBot(first, "Connector Bot");
  log.note(`the Bot and thread this driver made over the route a page uses: ${botId}, ${threadId}`);
  const firstRun = await runThrough(log, {
    launch: first,
    botId,
    threadId,
    prompt: `Open an issue on the fixture repository titled ${titles[0] ?? ""}.`,
    toolName: `${CONNECTOR_ID}__create_issue`,
  });

  log.section("what the run's own log says about the call");
  const requested = framesOfType(firstRun, "tool_call.requested")[0];
  log.check(
    "the model asked for the connector's tool under the name the connector's id namespaces, and the gate governs it",
    [requested?.payload.toolName, requested?.payload.destructive, requested?.payload.command],
    [
      `${CONNECTOR_ID}__create_issue`,
      true,
      `${CONNECTOR_ID}__create_issue {"title":"${titles[0] ?? ""}"}`,
    ],
  );
  const parked = framesOfType(firstRun, "approval.requested")[0];
  log.check(
    "the first ask was parked, not decided: the loop writes no decision frame for a parkable verdict, and the ledger this fresh launch started with holds no grant",
    [
      firstRun
        .filter(
          (frame) => frame.type.startsWith("tool_call.") || frame.type.startsWith("approval."),
        )
        .map((frame) => frame.type),
      String(parked?.payload.approvalId),
    ],
    [
      [
        "tool_call.requested",
        "approval.requested",
        "approval.resolved",
        "tool_call.decision",
        "tool_call.result",
      ],
      `run-1:call_connector_1`,
    ],
  );
  log.check(
    "the log's one recorded verdict is the allow after the answer, and nothing was denied",
    [
      framesOfType(firstRun, "tool_call.decision").map((frame) => [
        frame.payload.allow,
        frame.payload.code,
      ]),
      firstRun.some((frame) => frame.type === "tool_call.result" && frame.payload.denied === true),
    ],
    [[[true, undefined]], false],
  );
  log.check(
    "the park named the action's hash and the command, so the card is about this call and no other",
    [
      String(parked?.payload.approvalId),
      String(parked?.payload.actionHash).startsWith("v1:sha256:"),
      parked?.payload.command,
    ],
    [
      `run-1:call_connector_1`,
      true,
      `${CONNECTOR_ID}__create_issue {"title":"${titles[0] ?? ""}"}`,
    ],
  );
  const resolved = framesOfType(firstRun, "approval.resolved")[0];
  log.check(
    "the answer minted a grant whose action hash is the parked one",
    [
      resolved?.payload.decision,
      (resolved?.payload.grant as { actionHash?: string } | undefined)?.actionHash ===
        parked?.payload.actionHash,
      (resolved?.payload.grant as { state?: string } | undefined)?.state,
    ],
    ["allow", true, "issued"],
  );
  const result = framesOfType(firstRun, "tool_call.result")[0];
  log.note(`the call's result: ${JSON.stringify(result?.payload)}`);
  log.check(
    "the call ran, was not denied, and answered with the service's own report of the issue it created",
    [
      result?.payload.ok,
      result?.payload.denied,
      /\{"number":\d+,"title":"connector-seam [^"]+","state":"open","url":"[^"]+"\}/.test(
        String(result?.payload.output ?? ""),
      ),
    ],
    [true, false, true],
  );
  log.check(
    "the model read the result and closed the run with the recorded narration",
    [
      framesOfType(firstRun, "message.text.delta")
        .map((frame) => frame.payload.text)
        .join(""),
      framesOfType(firstRun, "run.finished").length,
      framesOfType(firstRun, "run.failed").length,
    ],
    ["Opened the issue through the connector seam.", 1, 0],
  );
  log.check(
    "the connector's own server saw exactly the one call the model asked for, and it carried no credential",
    side.calls,
    [`create_issue {"title":"${titles[0] ?? ""}"}`],
  );

  log.section("the service's own state, after the run");
  const afterFirst: IssueRow[] = await service.issues();
  log.note(`the issues the service holds: ${JSON.stringify(afterFirst)}`);
  log.check(
    "the service holds one issue: this run's, with the title the turn asked for and the seeded account as its author",
    afterFirst.map((issue) => [issue.number, issue.title, issue.state, issue.author]),
    [[1, titles[0] ?? "", "open", "freebot-fixture"]],
  );
  const listed = await post(first, "list_connectors", {});
  log.note(`the request: ${listed.request}`);
  log.note(`the answer: ${listed.status} ${listed.body}`);
  log.check(
    "a route lists the connector as a row with a credential reference, its tools and a health probe, and no credential",
    (() => {
      const rows = (
        JSON.parse(listed.body) as {
          json: {
            connectors: Array<{
              id: string;
              url: string;
              ref: string;
              tools: Array<{ name: string }>;
              health: { ok: boolean };
            }>;
          };
        }
      ).json.connectors;
      return [
        listed.status,
        rows.map((row) => [
          row.id,
          row.url,
          row.ref,
          row.tools.map((tool) => tool.name),
          row.health.ok,
        ]),
        listed.body.includes(side.token),
        listed.body.includes("Bearer"),
      ];
    })(),
    [
      200,
      [[CONNECTOR_ID, mcpUrl, `connector:${CONNECTOR_ID}`, ["create_issue", "list_issues"], true]],
      false,
      false,
    ],
  );
  const tested = await post(first, "test_connector", { id: CONNECTOR_ID });
  log.note(`the request: ${tested.request}`);
  log.note(`the answer: ${tested.status} ${tested.body}`);
  log.check(
    "the test arm probes with the person's credential and reports the tools",
    [
      tested.status,
      (JSON.parse(tested.body) as { json: { ok: boolean } }).json.ok,
      (JSON.parse(tested.body) as { json: { tools: unknown[] } }).json.tools.length,
      tested.body.includes(side.token),
    ],
    [200, true, 2, false],
  );
  const unknown = await post(first, "test_connector", { id: "not-a-connector" });
  log.note(`the request: ${unknown.request}`);
  log.note(`the answer: ${unknown.status} ${unknown.body}`);
  log.check(
    "a connector the install does not hold is refused by name",
    [unknown.status, (JSON.parse(unknown.body) as { json: { code: string } }).json.code],
    [404, "connector_not_found"],
  );

  // -------------------------------------------------------------------------
  // The reset, and the second run
  // -------------------------------------------------------------------------
  log.section("the reset, and the second run from empty");
  log.note(
    `run containers while the first launch is up: ${JSON.stringify(dockerNames([`label=${RUN_LABEL}`]))}`,
  );
  log.check(
    "the run's container is gone, by name, once the run ended",
    await settles(
      () => JSON.stringify(dockerNames([`label=${RUN_LABEL}`])) === JSON.stringify(baseline),
    ),
    true,
  );
  log.check(
    "the connector's credential is in no file of the Bot's workspace or of the run's journal on the host",
    [
      filesUnder(botsRoot).filter((path) => readFileSync(path, "utf8").includes(side.token)).length,
      filesUnder(botsRoot).filter((path) => readFileSync(path, "utf8").includes(service.token))
        .length,
      filesUnder(botsRoot).length > 0,
    ],
    [0, 0, true],
  );
  service.reset();
  log.check("the service's own reset leaves it holding no issue", await service.issues(), []);
  first.interrupt();
  log.check("the first launch exits zero on SIGINT", await first.exited(), 0);
  log.check("nothing listens on the first launch's page port", listeners(first.apiPort), []);

  const second = await launch({ home, botsRoot, transcript: turns[1] ?? "", connectorsFile });
  log.note(`the second printed URL, redacted: ${redacted(second.url)}`);
  const threadsBefore = await post(second, "list_threads", { botId });
  log.note(`the request: ${threadsBefore.request}`);
  log.note(`the answer: ${threadsBefore.status} ${threadsBefore.body}`);
  log.check(
    "the second launch came back over the same bots root, with the thread and its one run",
    (
      JSON.parse(threadsBefore.body) as {
        json: { threads: Array<{ runs: Array<{ status: string }> }> };
      }
    ).json.threads.map((row) => row.runs.map((run) => run.status)),
    [["done"]],
  );
  const secondRun = await runThrough(log, {
    launch: second,
    botId,
    threadId,
    prompt: `Open an issue on the fixture repository titled ${titles[1] ?? ""}.`,
    toolName: `${CONNECTOR_ID}__create_issue`,
  });
  const secondResult = framesOfType(secondRun, "tool_call.result")[0];
  log.note(`the second run's result: ${JSON.stringify(secondResult?.payload)}`);
  const secondPark = framesOfType(secondRun, "approval.requested")[0];
  log.check(
    "the second launch's call was parked the same way, on a ledger of its own: this process is new, so its only parkable verdict is no_grant",
    [
      secondRun
        .filter(
          (frame) => frame.type.startsWith("tool_call.") || frame.type.startsWith("approval."),
        )
        .map((frame) => frame.type),
      String(secondPark?.payload.approvalId),
      framesOfType(secondRun, "tool_call.decision").map((frame) => [
        frame.payload.allow,
        frame.payload.code,
      ]),
      secondRun.some((frame) => frame.type === "tool_call.result" && frame.payload.denied === true),
    ],
    [
      [
        "tool_call.requested",
        "approval.requested",
        "approval.resolved",
        "tool_call.decision",
        "tool_call.result",
      ],
      `run-2:call_connector_1`,
      [[true, undefined]],
      false,
    ],
  );
  log.check(
    "the second run's frames name the second launch's own run id",
    [...new Set(secondRun.map((frame) => frame.runId))],
    ["run-2"],
  );
  const afterSecond = await service.issues();
  log.note(`the issues the service holds after the second run: ${JSON.stringify(afterSecond)}`);
  log.check(
    "the service holds exactly the second run's issue: one, numbered from the reset, titled by the second turn",
    afterSecond.map((issue) => [issue.number, issue.title, issue.author]),
    [[1, titles[1] ?? "", "freebot-fixture"]],
  );
  log.check(
    "and the connector's own server saw the second run's call, with the second turn's title",
    side.calls.slice(-1),
    [`create_issue {"title":"${titles[1] ?? ""}"}`],
  );
  const runs = await post(second, "list_threads", { botId });
  log.note(`the request: ${runs.request}`);
  log.note(`the answer: ${runs.status} ${runs.body}`);
  log.check(
    "the thread's record holds both runs, both done: a connector call is a run like any other",
    (
      JSON.parse(runs.body) as { json: { threads: Array<{ runs: Array<{ status: string }> }> } }
    ).json.threads.map((row) => row.runs.map((run) => run.status)),
    [["done", "done"]],
  );

  // -------------------------------------------------------------------------
  // The container: what it can reach, and what it holds
  // -------------------------------------------------------------------------
  log.section("the sandbox, in its own words");
  const workspace = botWorkspacePath(botsRoot, botId);
  const probeName = `freebot-u8.1-probe-${nonce}`;
  const probeScript = `(async () => {
  const target = "http://host.docker.internal:${service.port}/repos/${service.owner}/${service.repo}/issues";
  const report = {};
  const answer = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "from the sandbox" }),
  });
  report.probe = [answer.status, (await answer.text()).trim()];
  const fs = require("node:fs");
  const haystacks = {
    env: Object.entries(process.env).map(([name, value]) => name + "=" + String(value)).join("\\n"),
    init: (() => { try { return fs.readFileSync("/proc/1/environ", "utf8"); } catch (error) { return "unreadable: " + error.message; } })(),
    workspace: (() => {
      try {
        return fs.readdirSync("/workspace").map((name) => fs.readFileSync("/workspace/" + name, "utf8")).join("\\n");
      } catch (error) { return "unreadable: " + error.message; }
    })(),
  };
  const secrets = ${JSON.stringify([service.token, side.token])};
  report.carries = Object.entries(haystacks).filter(([, text]) => secrets.some((secret) => text.includes(secret))).map(([where]) => where);
  report.checked = Object.keys(haystacks);
  report.workspaceListing = (() => { try { return fs.readdirSync("/workspace").sort(); } catch (error) { return ["unreadable: " + error.message]; } })();
  console.log(JSON.stringify(report));
})().catch((error) => { console.log(JSON.stringify({ error: String(error) })); process.exit(1); });`;
  const probe = Bun.spawnSync([
    "docker",
    "run",
    "--rm",
    "--name",
    probeName,
    "--label",
    PROBE_LABEL,
    "--add-host=host.docker.internal:host-gateway",
    "--mount",
    `type=bind,source=${workspace},target=/workspace`,
    "--entrypoint",
    "node",
    SANDBOX_IMAGE,
    "-e",
    probeScript,
  ]);
  const probeOut = probe.stdout.toString().trim();
  const probeErr = probe.stderr.toString().trim();
  log.note(`the probe container's output: ${probeOut}`);
  if (probeErr !== "") log.note(`the probe container's stderr: ${probeErr}`);
  const report = JSON.parse(probeOut) as {
    probe: [number, string];
    carries: string[];
    checked: string[];
    workspaceListing: string[];
  };
  log.check(
    "a container of the pinned image can reach the service and is refused a write, holding no credential of the service's",
    [report.probe?.[0], report.probe?.[1]?.includes("Requires authentication")],
    [401, true],
  );
  log.check(
    "neither credential is in the container's environment, its init's environment, or the Bot's workspace",
    report.carries,
    [],
  );
  log.check(
    "the probe read all three places, so an empty answer is a fact about each",
    report.checked,
    ["env", "init", "workspace"],
  );
  log.note(
    `the probe container's view of the Bot's workspace: ${JSON.stringify(report.workspaceListing)}`,
  );
  log.check(
    "the service still holds only the second run's issue: the container created nothing",
    (await service.issues()).map((issue) => issue.title),
    [titles[1] ?? ""],
  );
  log.check(
    "the probe container is gone by name, and this driver's own label holds nothing",
    [dockerNames([`name=^${probeName}$`]), dockerNames([`label=${PROBE_LABEL}`])],
    [[], []],
  );

  // -------------------------------------------------------------------------
  // Additive: the sandbox arm still runs in a launch that holds connectors
  // -------------------------------------------------------------------------
  log.section("the sandbox arm, in the same home, with the same connectors file");
  const third = await launch({
    home,
    botsRoot,
    transcript: LANDED_TRANSCRIPT,
    connectorsFile,
  });
  log.note(`the third printed URL, redacted: ${redacted(third.url)}`);
  const thirdLine = await waitForMatch(
    () => third.stderr(),
    /^(freebot up: connectors .*)$/m,
    30_000,
  );
  log.check(
    "the third launch read the same connectors file, so the connector arm is offered beside the landed sandbox arm",
    thirdLine.includes(CONNECTOR_ID),
    true,
  );
  const bashRun = await runThrough(log, {
    launch: third,
    botId,
    threadId,
    prompt: "spike: use native bash",
    toolName: "bash",
  });
  const bashResult = framesOfType(bashRun, "tool_call.result")[0];
  log.note(`the bash call's result: ${JSON.stringify(bashResult?.payload)}`);
  log.check(
    "the landed transcript's bash call ran in a container of the pinned image and reached the sandbox",
    [
      bashResult?.payload.ok,
      String(bashResult?.payload.output ?? "").includes("native-should-not-run"),
    ],
    [true, true],
  );
  log.check(
    "and the service's state is untouched by it: the two arms coexist, and only the connector touches the service",
    (await service.issues()).map((issue) => issue.title),
    [titles[1] ?? ""],
  );

  // -------------------------------------------------------------------------
  // Shutdown, and the credential's absence from everything committed
  // -------------------------------------------------------------------------
  log.section("shutdown");
  third.interrupt();
  log.check("the third launch exits zero on SIGINT", await third.exited(), 0);
  second.interrupt();
  log.check("the second launch exits zero on SIGINT", await second.exited(), 0);
  log.check("nothing listens on the third launch's page port", listeners(third.apiPort), []);
  log.check(
    "no run container survives any of the three launches",
    await settles(
      () => JSON.stringify(dockerNames([`label=${RUN_LABEL}`])) === JSON.stringify(baseline),
    ),
    true,
  );

  log.section("the credential is in no file of this repository");
  log.check(
    "no file of the worktree carries the operator token",
    filesCarrying(root, first.token),
    [],
  );
  log.check(
    "no file of the worktree carries the service's token",
    filesCarrying(root, service.token),
    [],
  );
  log.check(
    "no file of the worktree carries the connector's credential",
    filesCarrying(root, side.token),
    [],
  );
  const report1 = log.lines.join("\n");
  log.check(
    "no line of this artifact carries the operator token",
    report1.includes(first.token),
    false,
  );
  log.check(
    "no line of this artifact carries the service's token",
    report1.includes(service.token),
    false,
  );
  log.check(
    "no line of this artifact carries the connector's credential",
    report1.includes(side.token),
    false,
  );
  log.check(
    "no line of this artifact carries a key-shaped literal",
    /FREEBOT_BYOK_KEY=\S{8,}/.test(report1),
    false,
  );

  log.lines.push("");
  log.lines.push(
    `three really launched \`bun run up\` processes over one home and one bots root; the service is the emulate GitHub fixture on 0.0.0.0, its state read over its own REST surface; the connector is packages/connectors' MCP client against its own MCP server; the sandbox is a container of ${SANDBOX_IMAGE}, driven by hand for the reachability probe and by the run path for the landed bash turn`,
  );
  log.lines.push(log.result());

  const written = writeArtifact();
  console.log(
    log.lines.filter((line) => line.includes("RESULT") || line.startsWith("FAIL")).join("\n"),
  );
  console.log(`assert.txt: ${written ?? "(refused)"}`);
  return log.failed === 0 && written !== null ? 0 : 1;
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
