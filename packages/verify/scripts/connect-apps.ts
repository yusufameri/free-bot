#!/usr/bin/env bun
/**
 * The U8.4 evidence driver: the Connect apps screen, driven through the page a person uses.
 *
 * One real launch, one real fixture server, and one page in headless Chrome. What makes this
 * evidence rather than a screenshot of a mock:
 *
 * - the launcher is spawned the way a person spawns it (`bun run up --no-open --replay`) over a
 *   FreeBot home this driver made, so `~/.freebot` is never read or written;
 * - the person's own service is `packages/connectors`' MCP server built over the `emulate` GitHub
 *   fixture, with an exact-match bearer gate, so a credential the screen saves is the credential the
 *   service receives;
 * - Add, Test, Retry, Authorize, Reconnect and Remove are clicked on the page's own controls, and
 *   every state is asserted from the DOM and again from the route the screen read;
 * - a record with no credential is put in the record file by hand, because no route creates one, and
 *   the screen must show `untested` rather than call the service broken;
 * - the credential is asserted in the vault (positive control) and in no record file, no response
 *   body, no DOM text, no source file and no artifact line;
 * - each shot reads the page's facts before and after the capture and fails when they moved.
 *
 * Run from the repo root: bun packages/verify/scripts/connect-apps.ts
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectorPaths } from "../../../apps/server/src/connectors.ts";
import type { ConnectAppsFacts } from "../../../packages/ui/src/connections.ts";
import {
  type Cdp,
  evaluate,
  launchChrome,
  openPage,
  screenshot,
  setViewport,
  sleep,
  waitFor,
} from "../src/cdp.ts";
import { artifactRefusal, captureRefusals, type Secret } from "../src/connect-apps.ts";
import { type GithubFixture, startGithubFixture } from "../src/emulator.ts";
import { createGithubConnector, type GithubConnector } from "../src/github-mcp.ts";
import { artifactDir } from "../src/index.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const feature = "connect-apps";
const SECRETS: Secret[] = [];

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

  fail(line: string): void {
    this.#failed += 1;
    this.lines.push(`FAIL - ${line}`);
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
const bodies: string[] = [];
const closers: Array<() => Promise<void>> = [];
let fixture: GithubFixture | null = null;
let service: GithubConnector | null = null;
let launch: Bun.Subprocess | null = null;
let chrome: Awaited<ReturnType<typeof launchChrome>> | null = null;
const factsLines: string[] = [];
const captureLines: string[] = [];

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function git(args: readonly string[]): string {
  const proc = Bun.spawnSync(["git", ...args]);
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

/** Every file under `dir` carrying `secret`, as paths. The scan connector-credentials uses. */
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
    await sleepMs(200);
  }
  return predicate();
}

function listeners(port: number): string {
  const proc = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  const raw = proc.stdout.toString().trim();
  return raw === "" ? "" : raw.split("\n").slice(1).join("; ");
}

function writeArtifact(): string | null {
  const text = [...headerLines, ...log.lines, ""].join("\n");
  const refusal = artifactRefusal(text, SECRETS, operatorToken);
  if (refusal !== null) {
    console.error(`refusing to write an artifact: ${refusal}`);
    return null;
  }
  const path = join(artifactsDir, "assert.txt");
  writeFileSync(path, text);
  return path;
}

// ---------------------------------------------------------------------------
// The launch, and the page
// ---------------------------------------------------------------------------

let operatorToken = "";

async function launchUp(home: string, botsRoot: string): Promise<{ url: string; port: number }> {
  const proc = Bun.spawn(["bun", "run", "up", "--no-open", "--replay"], {
    cwd: root,
    env: {
      ...process.env,
      FREEBOT_HOME: home,
      FREEBOT_WORKSPACE: botsRoot,
      FREEBOT_PROVIDER: "replay",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  launch = proc;
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
  const deadline = Date.now() + 30_000;
  let url: string | null = null;
  while (Date.now() < deadline && url === null) {
    url = /^(http:\/\/127\.0\.0\.1:\d+\/#token=\S+)$/m.exec(out)?.[1] ?? null;
    if (url === null) await sleepMs(25);
  }
  if (url === null) {
    throw new Error(`the launcher printed no URL within 30s; saw:\n${err.slice(-1500)}`);
  }
  const parsed = new URL(url);
  operatorToken = new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token") ?? "";
  return { url, port: Number(parsed.port) };
}

interface Wire {
  readonly request: string;
  readonly status: number;
  readonly body: string;
}

async function post(
  port: number,
  procedure: string,
  input: Record<string, unknown>,
): Promise<Wire> {
  const url = `http://127.0.0.1:${port}/rpc/${procedure}`;
  const body = JSON.stringify({ json: input });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${operatorToken}`,
      origin: `http://127.0.0.1:${port}`,
    },
    body,
  });
  const answer = await response.text();
  bodies.push(answer);
  return {
    request: `POST /rpc/${procedure} with the launch's own operator token`,
    status: response.status,
    body: answer,
  };
}

function jsonOf(answer: Wire): Record<string, unknown> {
  return (JSON.parse(answer.body) as { json: Record<string, unknown> }).json;
}

const FACTS = "window.__connectAppsFacts ? window.__connectAppsFacts() : null";

async function readFacts(cdp: Cdp, page: string): Promise<ConnectAppsFacts> {
  return await evaluate<ConnectAppsFacts>(cdp, page, FACTS);
}

/** Set one input the way a person's keystroke would, so the page's own listener sees it. */
async function fill(cdp: Cdp, page: string, id: string, value: string): Promise<void> {
  try {
    await evaluate(
      cdp,
      page,
      `(() => {
        const node = document.querySelector(${JSON.stringify(`#${id}`)});
        if (!node) throw new Error("missing");
        node.value = ${JSON.stringify(value)};
        node.dispatchEvent(new Event("input", { bubbles: true }));
        return node.value.length;
      })()`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not fill #${id}: ${message.split(value).join("<redacted>")}`);
  }
}

async function click(cdp: Cdp, page: string, selector: string): Promise<void> {
  await evaluate(
    cdp,
    page,
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error("missing ${selector}");
      node.click();
      return true;
    })()`,
  );
}

async function overflow(cdp: Cdp, page: string): Promise<boolean> {
  return await evaluate<boolean>(
    cdp,
    page,
    "document.documentElement.scrollWidth > window.innerWidth",
  );
}

/**
 * One shot, with the page's facts read before and after it. A capture whose state moved, or whose
 * facts carry a credential, is a failure rather than a picture.
 */
async function capture(
  cdp: Cdp,
  page: string,
  name: string,
  caption: string,
): Promise<ConnectAppsFacts> {
  const before = await readFacts(cdp, page);
  const shot = await screenshot(cdp, page);
  const after = await readFacts(cdp, page);
  for (const refusal of captureRefusals(before, after, caption, SECRETS)) log.fail(refusal);
  writeFileSync(join(artifactsDir, name), shot);
  factsLines.push(name);
  captureLines.push(JSON.stringify({ shot: name, caption, facts: before }));
  log.note(`shot: ${name} (${caption})`);
  return before;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const sha = git(["rev-parse", "--short", "HEAD"]);
  artifactsDir = artifactDir(root, feature, sha);
  mkdirSync(artifactsDir, { recursive: true });

  const home = mkdtempSync(join(tmpdir(), "freebot-connect-apps-home-"));
  const botsRoot = join(home, "bots");
  made.push(home);
  const paths = connectorPaths({ FREEBOT_HOME: home });
  const placeholderKey = `connect-apps-placeholder-${crypto.randomUUID()}`;
  SECRETS.push(["the placeholder provider key", placeholderKey]);

  headerLines = [
    "feature: connect apps",
    "command: bun packages/verify/scripts/connect-apps.ts",
    `timestamp: ${new Date().toISOString()}`,
    `git sha: ${git(["rev-parse", "HEAD"])}`,
    `git sha short: ${sha}`,
    `branch: ${git(["rev-parse", "--abbrev-ref", "HEAD"])}`,
    `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
    `the freebot home this driver made: ${home}`,
    `the record file the screen reads: ${paths.record}`,
    `the vault file the credential lives in: ${paths.vault}`,
    "",
  ];
  log.note("# connect apps evidence: one launch, one page, every state the record can say");
  log.note(
    "DRIVER DISCLOSURE: the launcher is spawned as `bun run up --no-open --replay` with FREEBOT_HOME and FREEBOT_WORKSPACE pointing at directories this driver made. The provider is the replay provider, so no model is called and no key is spent. The connector's service is an MCP server this process serves over the `emulate` GitHub fixture bound on 0.0.0.0 and seeded per run, with an exact bearer gate. No real third-party account, service or key is involved anywhere.",
  );
  log.note(
    "the credentials this run minted are named by label everywhere below, never by value; the artifact writer refuses a line carrying one.",
  );

  // -------------------------------------------------------------------------
  // The fixture service
  // -------------------------------------------------------------------------
  log.section("the person's own service, over an emulated GitHub on every interface");
  fixture = await startGithubFixture({
    login: "freebot-fixture",
    owner: "freebot-fixture",
    repo: "connect-apps",
  });
  SECRETS.push(["the emulated service's token", fixture.token]);
  service = createGithubConnector({ fixture, name: "freebot-connect-apps", version: "1.0.0" });
  closers.push(() => service?.close() ?? Promise.resolve());
  log.note(`the emulated service is at ${fixture.url} (port ${fixture.port})`);
  log.note(`the connector's MCP service is at ${service.url}`);
  log.check(
    "the connector's service refuses a handshake with no credential",
    await (async () => {
      const answer = await fetch(service?.url ?? "", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      return [answer.status, (await answer.text()).trim()];
    })(),
    [401, "no credential"],
  );

  // -------------------------------------------------------------------------
  // The launch, a Bot, and the page
  // -------------------------------------------------------------------------
  log.section("the launch, and the screen's empty state");
  writeFileSync(
    join(home, "provider.env"),
    [
      "# connect-apps.ts placeholder vault; --replay means no request reads it",
      `FREEBOT_BYOK_KEY=${placeholderKey}`,
      "FREEBOT_BYOK_BASE_URL=http://127.0.0.1:9/not-a-provider",
      "FREEBOT_BYOK_MODEL=connect-apps-placeholder",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const up = await launchUp(home, botsRoot);
  log.note(`the printed URL, redacted: ${up.url.replace(/#token=.*$/, "#token=<redacted>")}`);
  const bot = await post(up.port, "create_bot", { name: "Atlas" });
  const botId = (jsonOf(bot) as { botId: string }).botId;
  await post(up.port, "create_thread", { botId });

  chrome = await launchChrome();
  const cdp = chrome.cdp;
  const page = await openPage(cdp, up.url);
  await setViewport(cdp, page, 1440, 900);
  await waitFor(cdp, page, "the app shell", "document.querySelector('#sidebar')?.hidden === false");
  await waitFor(
    cdp,
    page,
    "the Bot list",
    "document.querySelectorAll('#bot-list .sb-row').length >= 1",
  );

  await click(cdp, page, "#connect-apps");
  await waitFor(
    cdp,
    page,
    "the Connect apps gallery",
    "document.querySelector('#page .page-title h1')?.textContent === 'Apps and connectors' && (document.querySelector('#page .empty-state') !== null || document.querySelector('#connections-list') !== null)",
  );
  const empty = await capture(cdp, page, "01-empty.png", "the gallery before any connector exists");
  log.check(
    "the footer's Connect apps lands on the export's gallery, over an install holding none",
    [empty.view, empty.title, empty.rows, empty.empty],
    ["gallery", "Apps and connectors", [], true],
  );
  log.check(
    "the screen names the deltas it cannot close, Composio's adapter kind first",
    empty.deltas.includes("Composio adapter") && empty.deltas.length >= 5,
    true,
  );
  log.check("the gallery has no horizontal overflow at 1440x900", await overflow(cdp, page), false);

  // -------------------------------------------------------------------------
  // Add, through the form and the real route
  // -------------------------------------------------------------------------
  log.section("Add: the person's name, endpoint and credential, through connect_connector");
  const credentialA = service.token;
  SECRETS.push(["a", credentialA]);
  await click(cdp, page, "#connections-add");
  await waitFor(cdp, page, "the add form", "document.querySelector('#connector-form') !== null");
  await fill(cdp, page, "connector-label", "Emulated GitHub");
  await fill(cdp, page, "connector-url", service.url);
  await fill(cdp, page, "connector-header-name", "authorization");
  await fill(cdp, page, "connector-header-value", `Bearer ${credentialA}`);
  const addForm = await capture(
    cdp,
    page,
    "02-add-form.png",
    "the add form with a credential typed",
  );
  log.check(
    "the add form holds the credential only until it is submitted",
    [addForm.view, addForm.add?.open, addForm.add?.credentialEmpty],
    ["add", true, false],
  );
  await evaluate(cdp, page, "document.querySelector('#connector-form').requestSubmit()");
  await waitFor(
    cdp,
    page,
    "the new connector's detail",
    "document.querySelector('#connector-detail')?.dataset.state === 'connected'",
  );
  const connected = await capture(
    cdp,
    page,
    "03-connected.png",
    "the connector added and probed, with the tools its service offered",
  );
  log.check(
    "Add saved the record, probed the person's own service, and opened its detail",
    [
      connected.view,
      connected.detail?.label,
      connected.detail?.state,
      connected.detail?.line.includes("reached your own service"),
      connected.detail?.ref,
      connected.detail?.tools,
      connected.detail?.tested.startsWith("Tested "),
      connected.detail?.actions,
    ],
    [
      "detail",
      "Emulated GitHub",
      "connected",
      true,
      "connector:emulated-github",
      ["create_issue", "list_issues"],
      true,
      ["Test"],
    ],
  );
  log.check(
    "the credential field is gone with the form, and the page's text carries no value",
    [
      connected.add,
      await evaluate<boolean>(
        cdp,
        page,
        `!document.documentElement.outerHTML.includes(${JSON.stringify(credentialA)})`,
      ),
    ],
    [null, true],
  );
  const listedAfterAdd = await post(up.port, "list_connectors", {});
  log.check(
    "the list re-read the record the save wrote: one row, the same state the screen shows",
    (jsonOf(listedAfterAdd).connectors as Array<{ id: string; state: string }>).map((row) => [
      row.id,
      row.state,
    ]),
    [["emulated-github", "connected"]],
  );
  log.check(
    "the record file carries the id, the endpoint and the credential's reference, and no header",
    [
      JSON.parse(readFileSync(paths.record, "utf8")).connectors.map(
        (record: Record<string, unknown>) => [record.id, record.state, record.ref],
      ),
      readFileSync(paths.record, "utf8").includes(credentialA),
      readFileSync(paths.record, "utf8").includes("authorization"),
    ],
    [[["emulated-github", "connected", "connector:emulated-github"]], false, false],
  );
  log.check(
    "the vault holds the credential at mode 600, which is the positive control for the scans",
    [
      (statSync(paths.vault).mode & 0o777).toString(8),
      readFileSync(paths.vault, "utf8").includes(credentialA),
    ],
    ["600", true],
  );

  // -------------------------------------------------------------------------
  // Test, and the route's own answer
  // -------------------------------------------------------------------------
  log.section("Test: the route probes again, and the screen shows its answer");
  const beforeTest = await post(up.port, "list_connectors", {});
  const testedAtBefore = (
    jsonOf(beforeTest).connectors as Array<{ id: string; testedAt: number }>
  ).find((row) => row.id === "emulated-github")?.testedAt;
  await sleep(5);
  await click(cdp, page, "#connector-action-test");
  await waitFor(
    cdp,
    page,
    "the test's own notice",
    "document.querySelector('#connections-notice')?.textContent?.includes('Tested Emulated GitHub.') === true",
  );
  const tested = await readFacts(cdp, page);
  const afterTest = await post(up.port, "list_connectors", {});
  const testedAtAfter = (
    jsonOf(afterTest).connectors as Array<{ id: string; testedAt: number }>
  ).find((row) => row.id === "emulated-github")?.testedAt;
  log.check(
    "Test kept the connector connected, reported the probe's state, and the route's own clock moved",
    [
      tested.detail?.state,
      tested.notice,
      typeof testedAtAfter === "number" && typeof testedAtBefore === "number",
      (testedAtAfter ?? 0) > (testedAtBefore ?? 0),
    ],
    ["connected", "Tested Emulated GitHub. The probe answered Connected.", true, true],
  );

  // -------------------------------------------------------------------------
  // Unreachable, through the same form
  // -------------------------------------------------------------------------
  log.section("Unreachable: a service that does not answer, and the failure control it offers");
  const credentialB = `freebot-connector-b-${crypto.randomUUID()}`;
  SECRETS.push(["b", credentialB]);
  await click(cdp, page, "#connections-back");
  await waitFor(
    cdp,
    page,
    "the gallery again",
    "document.querySelector('#connections-list') !== null",
  );
  await click(cdp, page, "#connections-add");
  await waitFor(cdp, page, "the add form", "document.querySelector('#connector-form') !== null");
  await fill(cdp, page, "connector-label", "Notes service");
  await fill(cdp, page, "connector-url", "http://127.0.0.1:9/mcp");
  await fill(cdp, page, "connector-header-value", `Bearer ${credentialB}`);
  await evaluate(cdp, page, "document.querySelector('#connector-form').requestSubmit()");
  await waitFor(
    cdp,
    page,
    "the unreachable detail",
    "document.querySelector('#connector-detail')?.dataset.state === 'unreachable'",
  );
  const unreachable = await capture(
    cdp,
    page,
    "04-unreachable.png",
    "a connector whose service did not answer, with Retry as its failure control",
  );
  const listedUnreachable = await post(up.port, "list_connectors", {});
  const unreachableRow = (
    jsonOf(listedUnreachable).connectors as Array<{ id: string; state: string; detail: string }>
  ).find((row) => row.id === "notes-service");
  log.check(
    "the screen shows the route's own answer, not a fixture string",
    [unreachable.detail?.state, unreachable.detail?.refused, unreachableRow?.detail],
    ["unreachable", unreachableRow?.detail ?? "", unreachableRow?.detail ?? ""],
  );
  log.check(
    "the unreachable state offers Retry and Reconnect, and never the credential",
    [
      unreachable.detail?.actions,
      unreachable.detail?.refused.includes(credentialB),
      unreachable.detail?.tools,
    ],
    [["Retry", "Reconnect"], false, []],
  );
  await click(cdp, page, "#connector-action-retry");
  await waitFor(
    cdp,
    page,
    "the retry's own notice",
    "document.querySelector('#connections-notice')?.textContent?.includes('Tested Notes service.') === true",
  );
  const retried = await readFacts(cdp, page);
  log.check(
    "Retry ran the route's real probe again and the state is still unreachable",
    [retried.detail?.state, retried.notice],
    ["unreachable", "Tested Notes service. The probe answered Unreachable."],
  );

  // -------------------------------------------------------------------------
  // Untested: a record with no credential, and Authorize
  // -------------------------------------------------------------------------
  log.section("Untested: a record the vault holds no credential for, and Authorize");
  const recordFile = JSON.parse(readFileSync(paths.record, "utf8")) as {
    connectors: Array<Record<string, unknown>>;
  };
  recordFile.connectors.push({
    id: "fixture-notes",
    label: "Fixture notes",
    url: service.url,
  });
  writeFileSync(paths.record, `${JSON.stringify(recordFile, null, 2)}\n`, { mode: 0o600 });
  await click(cdp, page, "#nav-list [data-view='apps']");
  await waitFor(
    cdp,
    page,
    "the hand-written record in the gallery",
    "document.querySelector('#connections-list [data-connector=\"fixture-notes\"]') !== null",
  );
  await click(cdp, page, "#connections-list [data-connector='fixture-notes']");
  await waitFor(
    cdp,
    page,
    "the untested detail",
    "document.querySelector('#connector-detail')?.dataset.state === 'untested'",
  );
  const untested = await capture(
    cdp,
    page,
    "05-untested.png",
    "a record with no credential, which reads untested rather than broken",
  );
  log.check(
    "an untested record says the vault holds no credential, offers Authorize, and lists no tools",
    [
      untested.detail?.state,
      untested.detail?.line.includes("holds no credential"),
      untested.detail?.refused.includes("no credential in"),
      untested.detail?.actions,
      untested.detail?.tools,
      untested.detail?.tested,
    ],
    ["untested", true, true, ["Authorize", "Test"], [], "Never tested"],
  );
  await click(cdp, page, "#connector-action-authorize");
  await waitFor(
    cdp,
    page,
    "the credential form",
    "document.querySelector('#connector-credential-form') !== null",
  );
  await fill(cdp, page, "connector-credential-header-value", `Bearer ${service.token}`);
  await evaluate(cdp, page, "document.querySelector('#connector-credential-form').requestSubmit()");
  await waitFor(
    cdp,
    page,
    "the authorized detail",
    "document.querySelector('#connector-detail')?.dataset.state === 'connected'",
  );
  const authorized = await capture(
    cdp,
    page,
    "06-authorized.png",
    "the same record after Authorize saved a credential and probed",
  );
  log.check(
    "Authorize saved a credential through the real route and the record became connected",
    [
      authorized.detail?.state,
      authorized.detail?.tools,
      authorized.notice,
      authorized.credentialEmpty,
      await evaluate<boolean>(
        cdp,
        page,
        `!document.documentElement.outerHTML.includes(${JSON.stringify(service.token)})`,
      ),
    ],
    [
      "connected",
      ["create_issue", "list_issues"],
      "Saved a credential for Fixture notes. The probe answered Connected.",
      null,
      true,
    ],
  );

  // -------------------------------------------------------------------------
  // Remove, with its confirmation
  // -------------------------------------------------------------------------
  log.section("Remove: the confirmation, the record and the credential");
  await click(cdp, page, "#connections-back");
  await waitFor(cdp, page, "the gallery", "document.querySelector('#connections-list') !== null");
  await click(cdp, page, "#connections-list [data-connector='notes-service']");
  await waitFor(
    cdp,
    page,
    "the unreachable detail",
    "document.querySelector('#connector-detail')?.dataset.state === 'unreachable'",
  );
  await click(cdp, page, "#connector-remove");
  await waitFor(
    cdp,
    page,
    "the removal confirmation",
    "document.querySelector('#connector-remove-confirm') !== null",
  );
  await capture(cdp, page, "07-remove-confirm.png", "the removal confirmation before it is sent");
  await click(cdp, page, "#connector-remove-yes");
  await waitFor(
    cdp,
    page,
    "the gallery without the removed connector",
    "document.querySelector('#connections-list') !== null && document.querySelector('#connections-list [data-connector=\"notes-service\"]') === null",
  );
  const removed = await capture(
    cdp,
    page,
    "08-removed.png",
    "the gallery after Remove, with the removed connector gone",
  );
  const listedAfterRemove = await post(up.port, "list_connectors", {});
  log.check(
    "Remove took the record and the vault line, and the gallery re-read the store",
    [
      removed.notice,
      (jsonOf(listedAfterRemove).connectors as Array<{ id: string }>).map((row) => row.id).sort(),
      readFileSync(paths.vault, "utf8").includes("FREEBOT_CONNECTOR_notes-service="),
    ],
    [
      "Removed Notes service. Its record and its credential are gone.",
      ["emulated-github", "fixture-notes"],
      false,
    ],
  );
  log.check(
    "the footer's count follows the rows the screen holds",
    await evaluate<string>(
      cdp,
      page,
      "document.querySelector('#connect-apps-count')?.textContent ?? ''",
    ),
    "2 on",
  );

  // -------------------------------------------------------------------------
  // 390, and the credential census
  // -------------------------------------------------------------------------
  log.section("the same gallery at 390x844, and the credential census");
  await setViewport(cdp, page, 390, 844);
  await sleep(250);
  const narrow = await capture(cdp, page, "09-gallery-390.png", "the gallery at 390x844");
  log.check("the gallery has no horizontal overflow at 390x844", await overflow(cdp, page), false);
  log.check(
    "the narrow gallery still holds both connectors and their states",
    narrow.rows.map((row) => [row.id, row.tag]),
    [
      ["emulated-github", "Connected"],
      ["fixture-notes", "Connected"],
    ],
  );

  log.note("");
  log.note("the census, each with its literal search:");
  log.check(
    "no response body this driver read carries a credential",
    [
      bodies.length,
      bodies.filter((body) => SECRETS.some(([, value]) => body.includes(value))).length,
    ],
    [bodies.length, 0],
  );
  log.check(
    "the record file carries no header value and no header name",
    [
      readFileSync(paths.record, "utf8").includes(credentialA),
      readFileSync(paths.record, "utf8").includes(credentialB),
      readFileSync(paths.record, "utf8").includes("authorization"),
    ],
    [false, false, false],
  );
  log.check(
    "the vault holds a line for each connector that has a credential, sorted by id",
    [
      readFileSync(paths.vault, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("FREEBOT_CONNECTOR_"))
        .map((line) => line.slice("FREEBOT_CONNECTOR_".length).split("=")[0]),
    ],
    [["emulated-github", "fixture-notes"]],
  );
  log.check(
    "no file of the worktree carries any credential this run minted",
    SECRETS.flatMap(([label, value]) =>
      filesCarrying(root, value).map((path) => `${label}: ${path}`),
    ),
    [],
  );
  log.check(
    "and the driver's own table names them, never their values",
    SECRETS.map(([label]) => label),
    ["the placeholder provider key", "the emulated service's token", "a", "b"],
  );

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------
  log.section("shutdown");
  const apiPort = up.port;
  launch?.kill("SIGINT");
  log.check("the launch exits zero on SIGINT", await (launch?.exited ?? Promise.resolve(0)), 0);
  log.check(
    "nothing listens on the launch's port once it has stopped",
    await settles(() => listeners(apiPort) === ""),
    true,
  );

  log.lines.push("");
  log.lines.push(
    "one really launched `bun run up --no-open --replay` process over a home this driver made; the screen is the page's own sidebar entry and the Workspace Apps page; every state is reached through the page's controls except the untested record, which is hand-written because no route creates a credential-less record; the connector's service and the service its tools act on are fixtures this run serves; no run was started, so no container was created and no Docker resource was touched.",
  );
  log.lines.push(log.result());

  const written = writeArtifact();
  const factsBody = [
    `feature: ${feature}`,
    `git short sha: ${sha}`,
    `timestamp: ${new Date().toISOString()}`,
    `screenshots: ${factsLines.join(", ")}`,
    "",
    ...captureLines,
    "",
  ].join("\n");
  const refusal = artifactRefusal(factsBody, SECRETS, operatorToken);
  if (refusal === null) writeFileSync(join(artifactsDir, "facts.jsonl"), factsBody);
  else console.error(`refusing to write facts.jsonl: ${refusal}`);

  console.log(
    log.lines.filter((line) => line.includes("RESULT") || line.startsWith("FAIL")).join("\n"),
  );
  console.log(`assert.txt: ${written ?? "(refused)"}`);
  return log.failed === 0 && written !== null ? 0 : 1;
}

async function cleanup(): Promise<void> {
  for (const close of closers.splice(0)) await close().catch(() => {});
  launch?.kill("SIGINT");
  await Promise.race([launch?.exited ?? Promise.resolve(0), sleepMs(20_000)]);
  chrome?.stop();
  if (fixture !== null) await fixture.close().catch(() => {});
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
}

if (import.meta.main) {
  try {
    const code = await main();
    await cleanup();
    process.exit(code);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const redacted = SECRETS.reduce(
      (text, [, value]) => text.split(value).join("<redacted>"),
      message,
    );
    console.error(`driver crashed: ${redacted}`);
    if (artifactsDir !== "") {
      const written = writeArtifact();
      if (written !== null) console.error(`assert.txt (partial, crashed): ${written}`);
    }
    await cleanup();
    process.exit(1);
  }
}
