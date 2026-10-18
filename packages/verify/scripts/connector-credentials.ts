#!/usr/bin/env bun
/**
 * The U8.2 evidence driver: a connector's credential is the person's own, in their own vault.
 *
 * One launch, the four connector routes, and a service this process runs. What makes this evidence
 * rather than a fixture with a mock behind it:
 *
 * - the launcher is spawned the way a person spawns it (`bun run up --no-open --replay`) over a
 *   freebot home this driver made, so the two files it reads are this run's own and the machine's
 *   `~/.freebot` is never opened;
 * - the person's own service is a real MCP server this process serves, whose one tool acts on the
 *   `emulate` GitHub fixture bound on `0.0.0.0` and seeded per run, so its answers and its own state
 *   are reads of the services rather than of this driver's intent;
 * - every route call goes over the app's own HTTP surface (`POST /rpc/<procedure>`) with the launch's
 *   operator token, and every assertion is a read of a response body, of one of the two files, or of
 *   what the services were given;
 * - the three probes the provider key already has — not returnable over the wire, not in the record
 *   file, not in any artifact — are run here against a connector credential, each with its literal
 *   search;
 * - the rotation is asserted on what the service received before and after, on the same connector
 *   object and inside one launch's lifetime, which is the property the seam's `headers()` exists for;
 * - the removal is asserted as a `404 connector_not_found` and as an empty vault, which is the
 *   fail-closed shape rather than a fallback to a stale secret.
 *
 * What this driver does not do: it starts no run, so no container is created and no Docker resource
 * is touched. The run path's use of a connector is the subject of the mounted
 * `packages/verify/scripts/connectors.ts`, which this driver runs beside as a regression pass.
 *
 * Run from the repo root: bun packages/verify/scripts/connector-credentials.ts
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpServer } from "@freebot/connectors";
import {
  ConnectorRegistry,
  connectorPaths,
  pathsBeside,
  readConnectorCredentials,
  readConnectorRecords,
} from "../../../apps/server/src/connectors.ts";
import { type GithubFixture, type IssueRow, startGithubFixture } from "../src/emulator.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));

/** The connector this driver signs in, which is also the id its tools are namespaced by. */
const CONNECTOR_ID = "emulate-github";
/** The label a person would type for it. */
const CONNECTOR_LABEL = "Emulated GitHub";

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
/** Every secret this run minted or read, so the artifact writer can refuse one that carries any. */
const secrets: string[] = [];
/** Everything this driver started that has to be stopped, whatever path the run takes. */
const closers: Array<() => Promise<void>> = [];
/** The credentials this driver minted, each under the label the artifact names it by. */
const known: Array<[string, string]> = [];
/** Every response body this driver read, so probe 1 can search all of them at once. */
const bodies: string[] = [];
let fixture: GithubFixture | null = null;
let launch: Launched | null = null;

// ---------------------------------------------------------------------------
// Small facts about this machine
// ---------------------------------------------------------------------------

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

async function settles(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(200);
  }
  return predicate();
}

/** The addresses a port is listening on, as `lsof` prints them; empty when nothing is. */
function listeners(port: number): string {
  const proc = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  const raw = proc.stdout.toString().trim();
  return raw === "" ? "" : raw.split("\n").slice(1).join("; ");
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

/** `bun run up` as a person runs it, over the home this driver made and no other. */
async function launchUp(home: string, botsRoot: string): Promise<Launched> {
  const proc = Bun.spawn(["bun", "run", "up", "--no-open", "--replay"], {
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
  const started: Launched = {
    url: "",
    apiPort: 0,
    token: "",
    stdout: () => out,
    stderr: () => err,
    interrupt: () => proc.kill("SIGINT"),
    exited: () => proc.exited,
  };
  const deadline = Date.now() + 30_000;
  let url: string | null = null;
  while (Date.now() < deadline && url === null) {
    url = /^(http:\/\/127\.0\.0\.1:\d+\/#token=\S+)$/m.exec(out)?.[1] ?? null;
    if (url === null) await sleep(25);
  }
  if (url === null) {
    throw new Error(`the launcher printed no URL within 30s; saw:\n${err.slice(-1500)}`);
  }
  const parsed = new URL(url);
  return {
    ...started,
    url,
    apiPort: Number(parsed.port),
    token: new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token") ?? "",
  };
}

/** One `bun run up` boot line, read off the launcher's own stderr. */
async function bootLine(read: () => string, prefix: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  const pattern = new RegExp(`^(${prefix}.*)$`, "m");
  while (Date.now() < deadline) {
    const found = pattern.exec(read());
    if (found?.[1] !== undefined) return found[1];
    await sleep(25);
  }
  throw new Error(`no line starting with ${prefix} within 30s; saw:\n${read().slice(-1500)}`);
}

// ---------------------------------------------------------------------------
// The routes, over the app's own HTTP surface
// ---------------------------------------------------------------------------

interface Wire {
  readonly request: string;
  readonly status: number;
  readonly body: string;
}

/**
 * One call to the oRPC route surface with the launch's own token. `redact` is for the one call whose
 * input IS the credential: the request line is recorded without its body rather than with a body the
 * artifact writer would refuse to write.
 */
async function post(
  launch: Launched,
  procedure: string,
  input: Record<string, unknown>,
  options: { readonly redact?: boolean } = {},
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
  const answer = await response.text();
  bodies.push(answer);
  return {
    request: `POST /rpc/${procedure} content-type: application/json authorization: Bearer <redacted> origin: http://127.0.0.1:${launch.apiPort} body=${
      options.redact === true
        ? "<redacted: this input carries the credential, which is the one place in the contract one appears>"
        : body
    }`,
    status: response.status,
    body: answer,
  };
}

function jsonOf(answer: Wire): Record<string, unknown> {
  return (JSON.parse(answer.body) as { json: Record<string, unknown> }).json;
}

// ---------------------------------------------------------------------------
// The person's own service: a real MCP server over the emulated service
// ---------------------------------------------------------------------------

interface RecordingService {
  readonly url: string;
  /** Every authorization value the gate was given, in order. The only place a value is observed. */
  readonly requests: string[];
  /** Every tool call this server served, as its own name and the arguments it was given. */
  readonly calls: readonly string[];
  /** The credential this service accepts from now on: what a person changing it in their account does. */
  setCredential(value: string): void;
  close(): Promise<void>;
}

function startRecordingService(fixtureService: GithubFixture, first: string): RecordingService {
  let accepted = first;
  const requests: string[] = [];
  const issuesPath = `/repos/${fixtureService.owner}/${fixtureService.repo}/issues`;

  /** The emulated service's REST surface, called with the service's own credential. */
  const call = async (
    path: string,
    init: { readonly method?: "POST"; readonly body?: string } = {},
  ): Promise<{ status: number; body: string }> => {
    const response = await fetch(`${fixtureService.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${fixtureService.token}`,
        accept: "application/vnd.github+json",
        ...(init.method === undefined ? {} : { "content-type": "application/json" }),
      },
    });
    return { status: response.status, body: await response.text() };
  };

  const server = createMcpServer({
    name: "freebot-connector-fixture",
    version: "1.0.0",
    tools: [
      {
        name: "create_issue",
        description: `Open an issue on ${fixtureService.owner}/${fixtureService.repo}.`,
        parameters: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
        run: async (args) => {
          const title =
            typeof args === "object" && args !== null ? (args as { title?: unknown }).title : null;
          if (typeof title !== "string" || title.length === 0) {
            return { text: "create_issue needs a title", isError: true };
          }
          const answer = await call(issuesPath, {
            method: "POST",
            body: JSON.stringify({ title }),
          });
          if (answer.status !== 201) {
            return { text: `the service refused: ${answer.status} ${answer.body}`, isError: true };
          }
          const parsed = JSON.parse(answer.body) as { number?: number; title?: string };
          return { text: JSON.stringify({ number: parsed.number, title: parsed.title }) };
        },
      },
      {
        name: "list_issues",
        description: `List the issues on ${fixtureService.owner}/${fixtureService.repo}.`,
        parameters: { type: "object", properties: {} },
        run: async () => {
          const answer = await call(`${issuesPath}?state=all`);
          const parsed: unknown = JSON.parse(answer.body);
          const rows = Array.isArray(parsed) ? parsed : [];
          return {
            text: JSON.stringify(
              rows.map((row) => (typeof row === "object" && row !== null ? row : null)),
            ),
          };
        },
      },
    ],
    // The gate this connector authenticates against, and the one place a credential's value is
    // observed. It records what arrived before it judges it, which is what the rotation proof reads.
    authorize: (request) => {
      const header = request.headers.get("authorization") ?? "(none)";
      requests.push(header);
      return header === `Bearer ${accepted}` ? null : "no credential";
    },
  });

  return {
    url: `${server.url}/mcp`,
    requests,
    calls: server.calls,
    setCredential: (value) => {
      accepted = value;
    },
    close: () => server.close(),
  };
}

/** The label the artifact names the credential a service report equals, or null for an unknown one. */
function labelOf(received: string): string | null {
  for (const [label, value] of known) {
    if (received === `Bearer ${value}`) return label;
  }
  return null;
}

/** The labels of the credentials the service received while `body` ran, in order of first appearance. */
async function headersDuring(
  service: RecordingService,
  body: () => Promise<void>,
): Promise<Array<string | null>> {
  const from = service.requests.length;
  await body();
  return [...new Set(service.requests.slice(from).map(labelOf))];
}

/** The credential labels and nothing else: the keys of the driver's own table, sorted. */
function labels(): string[] {
  return known.map(([label]) => label).sort();
}

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

/** Write the artifact, refusing one that carries any credential or a key-shaped literal. */
function writeArtifact(): string | null {
  const text = [...headerLines, ...log.lines, ""].join("\n");
  if (launch !== null && launch.token !== "" && text.includes(launch.token)) {
    console.error("refusing to write an artifact that contains the operator token");
    return null;
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
  for (const close of closers.splice(0)) await close().catch(() => {});
  if (launch !== null) {
    launch.interrupt();
    await Promise.race([launch.exited(), sleep(20_000)]);
  }
  if (fixture !== null) await fixture.close().catch(() => {});
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const sha = git(["rev-parse", "--short", "HEAD"]);
  artifactsDir = join(root, "packages", "verify", "artifacts", "connector-credentials", sha);
  rmSync(artifactsDir, { recursive: true, force: true });
  mkdirSync(artifactsDir, { recursive: true });

  const home = mkdtempSync(join(tmpdir(), "freebot-connector-credentials-home-"));
  const botsRoot = mkdtempSync(join(tmpdir(), "freebot-connector-credentials-bots-"));
  made.push(home, botsRoot);
  const nonce = `u8.2-${Math.random().toString(36).slice(2, 10)}`;
  const paths = pathsBeside(join(home, "connectors.json"));

  headerLines = [
    "feature: connector credentials",
    "command: bun packages/verify/scripts/connector-credentials.ts",
    `timestamp: ${new Date().toISOString()}`,
    `git sha: ${git(["rev-parse", "HEAD"])}`,
    `git sha short: ${sha}`,
    `branch: ${git(["rev-parse", "--abbrev-ref", "HEAD"])}`,
    `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
    `the run's nonce: ${nonce}`,
    `the freebot home this driver made: ${home}`,
    `the bots root this driver made: ${botsRoot}`,
    `the record file the launcher reads: ${paths.record}`,
    `the vault file the credential lives in: ${paths.vault}`,
    "",
  ];
  log.note("# connector credentials evidence: one launch, four routes, two files");
  log.note(
    "DRIVER DISCLOSURE: the launcher is spawned as `bun run up --no-open --replay` with FREEBOT_HOME and FREEBOT_WORKSPACE pointing at fresh directories and no --connectors flag, so the launcher derives both connector files from that home. No account, no provider key and no third-party credential is involved anywhere in this run: the connector's service is an MCP server this process serves, the service its tools act on is the `emulate` GitHub fixture on 0.0.0.0 seeded with a token this run minted, and the model is never called because no run is started.",
  );
  log.note(
    "the credentials this run minted are named by label everywhere below, never by value; the artifact writer refuses to write a line carrying one.",
  );

  // -------------------------------------------------------------------------
  // The person's own service, and the service it acts on
  // -------------------------------------------------------------------------
  log.section("the person's own service, over an emulated GitHub on every interface");
  const service = await startGithubFixture({
    login: "freebot-fixture",
    owner: "freebot-fixture",
    repo: "connector-credentials",
  });
  fixture = service;
  secrets.push(service.token);
  const credentialA = `freebot-connector-a-${crypto.randomUUID()}`;
  known.push(["a", credentialA]);
  secrets.push(credentialA);
  const recording = startRecordingService(service, credentialA);
  closers.push(() => recording.close());
  log.note(`the emulated service is at ${service.url} (port ${service.port})`);
  log.note(`the connector's service is at ${recording.url}`);
  log.check(
    "the emulated service starts holding nothing, read from the service",
    await service.issues(),
    [],
  );
  const noCredential = await fetch(recording.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  log.check(
    "the connector's service refuses a handshake that carries no credential",
    [noCredential.status, (await noCredential.text()).trim()],
    [401, "no credential"],
  );
  // That probe was made to prove the gate refuses; the credential path starts from here, so the
  // service's record of what it was given starts from here too.
  recording.requests.length = 0;

  // -------------------------------------------------------------------------
  // The launch, and the machine it left alone
  // -------------------------------------------------------------------------
  log.section("the launch, over this driver's own home");
  launch = await launchUp(home, botsRoot);
  const up = launch;
  log.note(`the printed URL, redacted: ${up.url.replace(/#token=.*$/, "#token=<redacted>")}`);
  const launcherHome = await bootLine(() => up.stderr() ?? "", "freebot up: vault ");
  log.note(`the launcher's line: ${launcherHome}`);
  log.check(
    "the launch reads the vault of the home this driver made, and not the machine's",
    [launcherHome.includes(home), launcherHome.includes(join(home, "provider.env"))],
    [true, true],
  );
  const connectorLine = await bootLine(() => up.stderr() ?? "", "freebot up: connectors ");
  log.note(`the launcher's line: ${connectorLine}`);
  log.check(
    "the launcher names both files it will read: the record and the credential vault at mode 600",
    [
      connectorLine.includes(paths.record),
      connectorLine.includes(paths.vault),
      connectorLine.includes("mode 600"),
      connectorLine.includes("Bearer"),
    ],
    [true, true, true, false],
  );
  log.check(
    "the machine's own home is elsewhere: the two files this run read and wrote are under the home this driver made",
    [
      paths.record.startsWith(home),
      paths.vault.startsWith(home),
      connectorPaths().record === paths.record,
    ],
    [true, true, false],
  );

  const empty = await post(up, "list_connectors", {});
  log.note(`the request: ${empty.request}`);
  log.note(`the answer: ${empty.status} ${empty.body}`);
  log.check(
    "a machine nobody has connected anything on answers with no connectors and no credential file to read",
    [
      empty.status,
      jsonOf(empty).connectors,
      readConnectorRecords(paths),
      existsSync(paths.record),
      existsSync(paths.vault),
    ],
    [200, [], [], false, false],
  );

  // -------------------------------------------------------------------------
  // The sign-in: connect, which is the person's own credential and a real call
  // -------------------------------------------------------------------------
  log.section("the sign-in: the person's own credential reaches their own service");
  const connected = await post(
    up,
    "connect_connector",
    {
      id: CONNECTOR_ID,
      label: CONNECTOR_LABEL,
      url: recording.url,
      headers: { authorization: `Bearer ${credentialA}` },
    },
    { redact: true },
  );
  log.note(`the request: ${connected.request}`);
  log.note(`the answer: ${connected.status} ${connected.body}`);
  const connectedRow = jsonOf(connected);
  log.check(
    "connect saves the credential, probes the person's own service through the seam, and answers with the row",
    [
      connected.status,
      Object.keys(connectedRow).sort(),
      [connectedRow.id, connectedRow.label, connectedRow.url, connectedRow.ref, connectedRow.state],
      connectedRow.detail,
      typeof connectedRow.testedAt,
      [...readConnectorCredentials(paths).keys()],
    ],
    [
      200,
      ["detail", "id", "label", "ref", "state", "testedAt", "tools", "url"],
      [CONNECTOR_ID, CONNECTOR_LABEL, recording.url, `connector:${CONNECTOR_ID}`, "connected"],
      `connector:${CONNECTOR_ID} accepted, 2 tools`,
      "number",
      [CONNECTOR_ID],
    ],
  );
  log.check(
    "the row's tools are the service's own list, in its own names",
    (jsonOf(connected).tools as Array<{ name: string }>).map((tool) => tool.name),
    ["create_issue", "list_issues"],
  );
  log.check(
    "the credential is where this feature says it is: the vault, mode 600, one line per connector",
    [
      (statSync(paths.vault).mode & 0o777).toString(8),
      basename(paths.vault),
      readFileSync(paths.vault, "utf8").includes(`FREEBOT_CONNECTOR_${CONNECTOR_ID}=`),
    ],
    ["600", "connectors.env", true],
  );
  log.check(
    "the record file is mode 600 too, and carries the id, the label, the endpoint and the state",
    [
      (statSync(paths.record).mode & 0o777).toString(8),
      readConnectorRecords(paths).map((record) => [
        record.id,
        record.label,
        record.url,
        record.ref,
        record.state,
      ]),
    ],
    [
      "600",
      [[CONNECTOR_ID, CONNECTOR_LABEL, recording.url, `connector:${CONNECTOR_ID}`, "connected"]],
    ],
  );

  // -------------------------------------------------------------------------
  // The three probes
  // -------------------------------------------------------------------------
  log.section("the three probes, each with its literal search");
  log.note(
    `the credential this run signed in with is ${credentialA.length} characters; it is named below by its label, never by its value.`,
  );
  const tested = await post(up, "test_connector", { id: CONNECTOR_ID });
  const listed = await post(up, "list_connectors", {});
  log.note(`the test request: ${tested.request}`);
  log.note(`the test answer: ${tested.status} ${tested.body}`);
  log.note(`the list answer: ${listed.status} ${listed.body}`);
  log.check(
    "probe 1, over the wire: every response body read so far, searched literally for the credential",
    [bodies.length, bodies.filter((body) => body.includes(credentialA)).length],
    [bodies.length, 0],
  );
  log.check(
    "and for the word the header is carried under, which no row has a field for",
    bodies.filter((body) => body.includes("authorization") || body.includes("headers")).length,
    0,
  );
  log.check(
    "probe 2, in the record file: the whole file, searched literally for the credential and for the header name",
    [
      readFileSync(paths.record, "utf8").includes(credentialA),
      readFileSync(paths.record, "utf8").includes("authorization"),
    ],
    [false, false],
  );
  const artifactSoFar = [...headerLines, ...log.lines].join("\n");
  log.check(
    "probe 3, anywhere: rg -l -F <the credential> over the worktree, and over this artifact's own lines",
    [
      filesCarrying(root, credentialA),
      artifactSoFar.includes(credentialA),
      artifactSoFar.includes(up.token),
    ],
    [[], false, false],
  );

  // -------------------------------------------------------------------------
  // The service's own state, and a call through the app's own registry
  // -------------------------------------------------------------------------
  log.section("the service's own state, and one call through the app's own registry");
  const held = ConnectorRegistry.open(paths).connectors()[0];
  log.check(
    "the app's registry, over the two files the launch is holding, builds one connector with the reference and no value",
    held?.id,
    CONNECTOR_ID,
  );
  const callThroughTheSeam = await held?.call("create_issue", {
    title: `credential path ${nonce}`,
  });
  const afterCreate: IssueRow[] = await service.issues();
  log.note(`the call's own answer: ${JSON.stringify(callThroughTheSeam)}`);
  log.note(`the emulated service's own state: ${JSON.stringify(afterCreate)}`);
  log.check(
    "the service acted on the person's credential and the emulated service now holds the issue it created",
    [
      callThroughTheSeam?.ok,
      afterCreate.map((issue) => [issue.number, issue.title, issue.state]),
      recording.calls,
    ],
    [
      true,
      [[1, `credential path ${nonce}`, "open"]],
      [`create_issue {"title":"credential path ${nonce}"}`],
    ],
  );
  log.note(
    "the call above is made by the app's own registry in this process, over the two files the launch is holding; the launch is what put the credential in the vault, and this is the app's own code reading it.",
  );

  // -------------------------------------------------------------------------
  // Rotation: one launch, one connector object, two credentials
  // -------------------------------------------------------------------------
  log.section("rotation: the header the service received, before and after");
  log.note(
    `the service received, in order of first appearance, while the credential named "a" was in the vault: ${JSON.stringify([...new Set(recording.requests.map(labelOf))])}`,
  );
  log.check(
    "every request the service has been given so far carried the credential the vault held",
    [...new Set(recording.requests.map(labelOf))],
    ["a"],
  );
  log.check(
    "and it was given more than one, so the handshake and the tool listing both went through the seam",
    recording.requests.length > 1,
    true,
  );

  const credentialB = `freebot-connector-b-${crypto.randomUUID()}`;
  known.push(["b", credentialB]);
  secrets.push(credentialB);
  // What a person does in their own account: the service starts accepting the new credential.
  recording.setCredential(credentialB);

  const rotated = await post(
    up,
    "connect_connector",
    {
      id: CONNECTOR_ID,
      url: recording.url,
      headers: { authorization: `Bearer ${credentialB}` },
    },
    { redact: true },
  );
  log.note(`the rotation request: ${rotated.request}`);
  log.note(`the rotation answer: ${rotated.status} ${rotated.body}`);
  log.check(
    "the rotated answer is the same connector, in the same row shape, with the label it already had",
    [
      rotated.status,
      jsonOf(rotated).id,
      jsonOf(rotated).label,
      jsonOf(rotated).ref,
      jsonOf(rotated).state,
      readConnectorRecords(paths).length,
    ],
    [200, CONNECTOR_ID, CONNECTOR_LABEL, `connector:${CONNECTOR_ID}`, "connected", 1],
  );

  log.check(
    "the route's own probe, on the launch that served the sign-in, sent the new credential",
    await headersDuring(recording, async () => {
      await post(up, "test_connector", { id: CONNECTOR_ID });
    }),
    ["b"],
  );
  log.check(
    "the connector object the run path built before the rotation now sends the new credential, unbuilt and unrestarted",
    await headersDuring(recording, async () => {
      await held?.call("list_issues", {});
    }),
    ["b"],
  );
  const bootLines = (up.stderr().match(/freebot up: page and run on/g) ?? []).length;
  log.check(
    "the rotation happened inside one launch's lifetime: one boot line, and no stop line yet",
    [bootLines, up.stderr().includes("freebot up: stopped")],
    [1, false],
  );
  log.check(
    "the vault holds the new credential and only it, and the record is still one connector",
    [
      readConnectorCredentials(paths).get(CONNECTOR_ID)?.authorization === `Bearer ${credentialB}`,
      readConnectorCredentials(paths).size,
      readConnectorRecords(paths).length,
    ],
    [true, 1, 1],
  );

  // -------------------------------------------------------------------------
  // Removal: fail closed rather than a stale secret
  // -------------------------------------------------------------------------
  log.section("removal: the credential out of the vault, the record out of the store");
  const removed = await post(up, "remove_connector", { id: CONNECTOR_ID });
  log.note(`the removal request: ${removed.request}`);
  log.note(`the removal answer: ${removed.status} ${removed.body}`);
  log.check(
    "the removal answers that the connector was there and is now gone",
    [removed.status, jsonOf(removed)],
    [200, { id: CONNECTOR_ID, removed: true }],
  );
  log.check(
    "the vault holds no line for it and the record holds no entry for it",
    [
      readConnectorCredentials(paths).has(CONNECTOR_ID),
      readConnectorRecords(paths).filter((record) => record.id === CONNECTOR_ID),
      readFileSync(paths.vault, "utf8").includes(CONNECTOR_ID),
    ],
    [false, [], false],
  );
  const afterRemoval = await post(up, "list_connectors", {});
  log.note(`the list answer: ${afterRemoval.status} ${afterRemoval.body}`);
  log.check(
    "the surface lists nothing, on a launch that was listing this connector a moment ago",
    jsonOf(afterRemoval).connectors,
    [],
  );
  const refused = await post(up, "test_connector", { id: CONNECTOR_ID });
  log.note(`the refusal request: ${refused.request}`);
  log.note(`the refusal answer: ${refused.status} ${refused.body}`);
  log.check(
    "a call for the removed connector fails closed, by name, rather than finding a stale secret",
    [refused.status, jsonOf(refused).code, jsonOf(refused).message],
    [404, "connector_not_found", `no such connector: ${CONNECTOR_ID}`],
  );
  log.check(
    "and the app's registry, over the same two files, holds no connector for it either",
    ConnectorRegistry.open(paths).connectors(),
    [],
  );
  const again = await post(up, "remove_connector", { id: CONNECTOR_ID });
  log.note(`the second removal answer: ${again.status} ${again.body}`);
  log.check(
    "a second removal is not an error and changes nothing",
    [again.status, jsonOf(again)],
    [200, { id: CONNECTOR_ID, removed: false }],
  );

  log.section("a record with no credential is untested, not unreachable");
  writeFileSync(
    paths.record,
    `${JSON.stringify({
      connectors: [{ id: CONNECTOR_ID, label: CONNECTOR_LABEL, url: recording.url }],
    })}\n`,
    { mode: 0o600 },
  );
  const beforeUntested = recording.requests.length;
  const untested = await post(up, "list_connectors", {});
  log.note(`the list answer: ${untested.status} ${untested.body}`);
  log.check(
    "the row says the vault holds no credential for it, rather than calling the service broken",
    [
      (jsonOf(untested).connectors as Array<{ state: string; detail: string }>).map(
        (row) => row.state,
      ),
      (jsonOf(untested).connectors as Array<{ detail: string }>)[0]?.detail.includes(paths.vault),
      recording.requests.length - beforeUntested,
    ],
    [["untested"], true, 0],
  );

  // -------------------------------------------------------------------------
  // Shutdown, and the credential's absence from everything committed
  // -------------------------------------------------------------------------
  log.section("shutdown");
  up.interrupt();
  log.check("the launch exits zero on SIGINT", await up.exited(), 0);
  log.check(
    "nothing listens on the launch's page port once it has stopped",
    await settles(() => listeners(up.apiPort) === ""),
    true,
  );

  log.section("the credential is in no file of this repository");
  log.check(
    "no file of the worktree carries the connector's credential",
    filesCarrying(root, credentialA),
    [],
  );
  log.check(
    "no file of the worktree carries the rotated credential",
    filesCarrying(root, credentialB),
    [],
  );
  log.check(
    "no file of the worktree carries the emulated service's token",
    filesCarrying(root, service.token),
    [],
  );
  log.check(
    "no file of the worktree carries the operator token",
    filesCarrying(root, up.token),
    [],
  );
  log.check(
    "and the driver's own table names the two credentials by label, never by value",
    labels(),
    ["a", "b"],
  );

  log.lines.push("");
  log.lines.push(
    `one really launched \`bun run up\` process over a home this driver made; the credential path is the app's own routes (list, connect, test, remove) and the two files they read and write; the person's own service is packages/connectors' MCP server, whose tools act on the emulate GitHub fixture bound on 0.0.0.0 and seeded per run; no run was started, so no container was created and no Docker resource was touched.`,
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
  if (artifactsDir !== "") {
    const written = writeArtifact();
    if (written !== null) console.error(`assert.txt (partial, crashed): ${written}`);
  }
  await cleanup();
  process.exit(1);
}
