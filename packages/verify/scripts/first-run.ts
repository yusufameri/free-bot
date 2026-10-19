#!/usr/bin/env bun
/**
 * The first-run screen's harness: a fresh install, walked from the empty root to a run.
 *
 * The app is booted the way a person boots it, `bun run up --no-open`, over a fresh `FREEBOT_HOME`
 * and bots root of this driver's own, so the store starts with no Bot at all and nothing a person
 * made is touched. The vault starts empty, so the machine runs keyless; the only connections this
 * driver saves are three local stubs it starts itself, and it removes the vault it wrote before the
 * last step, which is what the replay-mode claim rests on.
 *
 * The page is read from its own DOM: the screen's facts hook, the wire's `list_bots`, and the
 * journal the server wrote on the driver's own disk, replayed with the store that owns it. Each
 * asserted state is captured. The geometry pass measures the screen against the export at the nine
 * viewports `DESIGN-MANIFEST.json` names, with zero tolerance rather than a declared delta.
 *
 * Every string the screen carries is asserted against a literal read from
 * `design/prototype-84c6b185/freebot-prototype.html`, because the export governs the copy.
 *
 * Writes `packages/verify/artifacts/first-run/<short-sha>/` with `assert.txt` and one PNG per
 * asserted state.
 *
 * Run from the repo root: `bun packages/verify/scripts/first-run.ts`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BotStore } from "@freebot/core";
import {
  type Cdp,
  evaluate,
  launchChrome,
  openPage,
  screenshot,
  settle,
  setViewport,
  sleep,
  waitFor,
} from "../src/cdp.ts";
import { artifactDir } from "../src/index.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const feature = "first-run";
const EXPORT = "design/prototype-84c6b185/freebot-prototype.html";
const MANIFEST = "design/prototype-84c6b185/DESIGN-MANIFEST.json";
const REGISTRY_FILE = "index.jsonl";

/** The first-run screen's own facts, and the shell's. Both are read off the live DOM. */
const FIRST_RUN = "window.__firstRunFacts()";
const SHELL = "window.__shellFacts()";

/** The prompt the second chip prefills, which is the job this driver picks. */
const CHOSEN_TASK = "Draft this week's changelog from merged PRs.";

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

const log: string[] = [];
let passed = 0;
let failed = 0;

function section(title: string): void {
  log.push("", `## ${title}`);
}

function note(text: string): void {
  log.push(text);
}

/** One assertion with its literal expectation, so the artifact says what was expected. */
function check(label: string, actual: unknown, expected: unknown): boolean {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else failed += 1;
  log.push(
    `${ok ? "ok  " : "FAIL"} ${label}\n       actual   ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`,
  );
  return ok;
}

// ---------------------------------------------------------------------------
// The app under test
// ---------------------------------------------------------------------------

interface Launched {
  readonly url: string;
  readonly apiPort: number;
  readonly token: string;
  readonly home: string;
  readonly botsRoot: string;
  stdout(): string;
  stderr(): string;
  stop(): Promise<void>;
}

/** `bun run up --no-open`, as a person runs it, over a home and a bots root this driver made. */
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
  const deadline = Date.now() + 30_000;
  while (!/^http:\/\/127\.0\.0\.1:\d+\/#token=\S+$/m.test(out)) {
    if (Date.now() > deadline) throw new Error(`the launcher printed no URL: ${out}`);
    await sleep(50);
  }
  const url = /^(http:\/\/127\.0\.0\.1:\d+\/#token=\S+)$/m.exec(out)?.[1] ?? "";
  return {
    url,
    apiPort: Number(new URL(url).port),
    token: new URLSearchParams(new URL(url).hash.replace(/^#/, "")).get("token") ?? "",
    home,
    botsRoot,
    stdout: () => out,
    stderr: () => err,
    async stop() {
      proc.kill("SIGINT");
      await proc.exited;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** One call to the route surface with the launch's own token. */
async function post(launched: Launched, procedure: string, input: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${launched.apiPort}/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${launched.token}`,
      origin: `http://127.0.0.1:${launched.apiPort}`,
    },
    body: JSON.stringify({ json: input }),
  });
  return (await response.json()) as { json: unknown };
}

function shortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

/** The containers the run path creates, read the way every other driver reads them. */
function dockerNames(): string[] {
  const proc = Bun.spawnSync(
    ["docker", "ps", "-a", "--filter", "label=freebot.provider=docker", "--format", "{{.Names}}"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) return [`docker ps failed: ${proc.stderr.toString().trim()}`];
  return proc.stdout
    .toString()
    .split("\n")
    .filter((line) => line.length > 0)
    .sort();
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

function click(cdp: Cdp, page: string, selector: string): Promise<void> {
  return evaluate(cdp, page, `document.querySelector(${JSON.stringify(selector)}).click()`);
}

/** Click the node an expression resolves to, for a control that has no selector of its own. */
function clickExpression(cdp: Cdp, page: string, expression: string): Promise<void> {
  return evaluate(cdp, page, `(${expression}).click()`);
}

function fill(cdp: Cdp, page: string, selector: string, value: string): Promise<void> {
  return evaluate(
    cdp,
    page,
    `(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  );
}

/** Type a value the way a keyboard would, so the field's own events are what the page hears. */
async function typeInto(cdp: Cdp, page: string, selector: string, text: string): Promise<void> {
  const focused = await evaluate<boolean>(
    cdp,
    page,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); return document.activeElement === el; })()`,
  );
  if (!focused) throw new Error(`could not focus ${selector}`);
  await cdp.send("Input.insertText", { text }, page);
}

/**
 * Tell the page it has the browser's focus. A headless page is not the focused window, so
 * `document.activeElement` never follows a `focus()` call without this, and the composer's focus is
 * part of what the export promises (`freebot-prototype.html:2240`).
 */
async function focusThePage(cdp: Cdp, page: string): Promise<void> {
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, page);
}

/** The document's own horizontal pair: content width against the viewport. */
function documentPair(cdp: Cdp, page: string): Promise<[number, number]> {
  return evaluate<[number, number]>(
    cdp,
    page,
    `[document.documentElement.scrollWidth, window.innerWidth]`,
  );
}

async function capture(cdp: Cdp, page: string, dir: string, name: string): Promise<void> {
  await settle(cdp, page);
  const shot = await screenshot(cdp, page);
  writeFileSync(join(dir, `${name}.png`), shot);
  note(`artifact ${name}.png (${shot.byteLength} bytes)`);
}

// ---------------------------------------------------------------------------
// The first-run screen's facts, as one snapshot per asserted state
// ---------------------------------------------------------------------------

interface ScreenFacts {
  readonly step: number;
  readonly caption: string;
  readonly shown: boolean;
  readonly paneTitle: string;
  readonly fields: { name: string; role: string; purpose: string };
  readonly primary: string;
  readonly primaryDisabled: boolean;
  readonly skip: string;
  readonly jobs: Array<{ label: string; chosen: boolean }>;
  readonly botId: string | null;
  readonly provider: {
    readonly state: string;
    readonly shown: boolean;
    readonly headline: string;
    readonly message: string;
    readonly answer: string | null;
    readonly refusal: { readonly status: number | null; readonly message: string } | null;
    readonly capabilities: string[];
    readonly endpoint: string;
    readonly fields: { readonly keyEmpty: boolean };
    readonly vault: { readonly present: boolean };
  };
}

function screenFacts(cdp: Cdp, page: string): Promise<ScreenFacts> {
  return evaluate<ScreenFacts>(cdp, page, FIRST_RUN);
}

/** Save one stub connection through the pane's own form, and return the state it landed on. */
async function saveConnection(
  cdp: Cdp,
  page: string,
  baseUrl: string,
  model: string,
): Promise<Record<string, unknown>> {
  await fill(cdp, page, "#fr-provider-base-url", baseUrl);
  await fill(cdp, page, "#fr-provider-model", model);
  await typeInto(cdp, page, "#fr-provider-key", "stub-key-not-a-credential");
  await click(cdp, page, "#fr-provider-save");
  return await evaluate<Record<string, unknown>>(
    cdp,
    page,
    `(async () => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const facts = ${FIRST_RUN}.provider;
        if (facts.state !== "testing") {
          return {
            state: facts.state,
            headline: facts.headline,
            answer: facts.answer,
            refusal: facts.refusal,
            capabilities: facts.capabilities,
            endpoint: facts.endpoint,
            keyEmpty: facts.fields.keyEmpty,
            message: facts.message,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { state: "timed out" };
    })()`,
  );
}

/** Wait for the screen's step, and if it never arrives, say what the page was showing instead. */
async function waitForStep(cdp: Cdp, page: string, step: number): Promise<void> {
  try {
    await waitFor(cdp, page, `the screen's step ${step}`, `${FIRST_RUN}.step === ${step}`, 30_000);
  } catch (error) {
    const shown = await evaluate<Record<string, unknown>>(
      cdp,
      page,
      `({
        facts: ${FIRST_RUN},
        error: document.querySelector('#error').hidden ? null : document.querySelector('#error').textContent,
        primary: document.querySelector('#frNext').textContent,
        disabled: document.querySelector('#frNext').disabled,
      })`,
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} — the page showed ${JSON.stringify(shown)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The local stubs, so all four provider outcomes are reachable without a key
// ---------------------------------------------------------------------------

type StubKind = "capable" | "limited" | "untested";

interface Stub {
  readonly baseUrl: string;
  /** Every body the stub was asked, in order. */
  readonly asked: Array<Record<string, unknown>>;
  stop(): void;
}

/**
 * One provider-shaped endpoint, three answers. `capable` streams a tool call and then the closing
 * reply. `limited` answers whole bodies, never calls a tool natively, and answers the structured
 * request with a tool: the weaker connection the fallback exists for. `untested` refuses with 401,
 * which is a refusal rather than a failure, so the connection is still saved.
 */
function startStub(kind: StubKind): Stub {
  const asked: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      asked.push(body);
      if (kind === "untested") {
        return Response.json(
          {
            error: {
              message: "Invalid 'Authorization' header or token.",
              type: "invalid_request",
            },
          },
          { status: 401 },
        );
      }
      const structured = body.response_format !== undefined;
      if (kind === "limited") {
        const content = structured
          ? JSON.stringify({ tool: "freebot_smoke_echo", arguments: { text: "save-time-smoke" } })
          : "I answer questions, but I cannot call tools.";
        return Response.json({
          id: "chatcmpl-stub-limited",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
        });
      }
      const closing = (body.messages as Array<{ role: string }>).some(
        (message) => message.role === "tool",
      );
      const chunks = closing
        ? [
            { choices: [{ index: 0, delta: { content: "save-time-smoke" } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]
        : [
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_smoke",
                        function: {
                          name: "freebot_smoke_echo",
                          arguments: '{"text":"save-time-smoke"}',
                        },
                      },
                    ],
                  },
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          ];
      const stream = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
      return new Response(stream, {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    asked,
    stop: () => server.stop(true),
  };
}

/** One request body, cut to what a reader checks: the tools, the tool choice, the stream flag. */
function summarize(body: Record<string, unknown>): Record<string, unknown> {
  return {
    tools: ((body.tools ?? []) as Array<{ function: { name: string } }>).map(
      (tool) => tool.function.name,
    ),
    toolChoice: body.tool_choice ?? null,
    stream: body.stream ?? false,
    responseFormat: body.response_format ?? null,
    roles: ((body.messages ?? []) as Array<{ role: string }>).map((message) => message.role),
  };
}

// ---------------------------------------------------------------------------
// The export, served with its own first-run screen on
// ---------------------------------------------------------------------------

/**
 * The committed export, with its initial screen changed to `firstrun` so it boots into the screen
 * this unit builds. The count is checked, so a different export fails here instead of being
 * measured as its welcome screen.
 */
function serveExport(): { url: string; stop(): void; replaced: number } {
  const source = readFileSync(join(root, EXPORT), "utf8");
  const replaced = source.split("screen: 'welcome',").length - 1;
  const html = source.replace("screen: 'welcome',", "screen: 'firstrun',");
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path !== "/" && path !== "/index.html") {
        return new Response("not found", { status: 404 });
      }
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    replaced,
    stop: () => void server.stop(true),
  };
}

// ---------------------------------------------------------------------------
// The geometry pass
// ---------------------------------------------------------------------------

interface ManifestViewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

function readViewports(): ManifestViewport[] {
  const parsed = JSON.parse(readFileSync(join(root, MANIFEST), "utf8")) as {
    responsiveViewports?: ManifestViewport[];
  };
  return parsed.responsiveViewports ?? [];
}

/** The frame's own fields, read by the same selectors on both pages. */
const FRAME_FIELDS = [
  { field: "inner width", selector: "#firstrun .inner", prop: "width" },
  { field: "title size", selector: "#frPane1 h2", prop: "font-size" },
  { field: "hint size", selector: "#frPane1 .hint", prop: "font-size" },
  { field: "brandmark gap", selector: "#firstrun .brandmark", prop: "gap" },
  { field: "caption size", selector: "#frStep", prop: "font-size" },
  { field: "inner box", selector: "#firstrun .inner", prop: "box" },
  { field: "title box", selector: "#frPane1 h2", prop: "box" },
] as const;

interface FrameProbes {
  readonly fields: Readonly<Record<string, string>>;
  readonly document: readonly [number, number];
}

function frameExpression(): string {
  return `(() => {
    const fields = {};
    for (const [field, selector, prop] of ${JSON.stringify(
      FRAME_FIELDS.map((entry) => [entry.field, entry.selector, entry.prop]),
    )}) {
      const node = document.querySelector(selector);
      if (node === null) { fields[field] = "<no element>"; continue; }
      if (prop === "box") {
        const rect = node.getBoundingClientRect();
        fields[field] = [Math.round(rect.width * 100) / 100, Math.round(rect.left * 100) / 100].join(" x ");
        continue;
      }
      const value = getComputedStyle(node).getPropertyValue(prop).trim();
      fields[field] = value === "" ? "<unset>" : value;
    }
    return { fields, document: [document.documentElement.scrollWidth, window.innerWidth] };
  })()`;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const sha = shortSha();
  const dir = artifactDir(root, feature, sha);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const home = mkdtempSync(join(tmpdir(), "freebot-first-run-"));
  const botsRoot = join(home, "bots");
  const app = await launch(home, botsRoot);
  const exported = serveExport();
  const chrome = await launchChrome({ windowSize: "1440,900" });
  const stubs: Stub[] = [];
  let freshApp: Launched | null = null;
  console.error(`app up ${app.url.replace(/#token=.*$/, "#token=<redacted>")}`);

  try {
    section("the launch");
    const bootLine = /^freebot up: model mode .*$/m.exec(app.stderr())?.[0] ?? "(none)";
    note(`the launcher's own line: ${bootLine}`);
    note(
      "DRIVER DISCLOSURE: the launcher is spawned as `bun run up --no-open` with FREEBOT_HOME and FREEBOT_WORKSPACE pointing at fresh directories this driver made, so the store starts with no Bot at all. The vault starts empty, so no key is read anywhere and the machine runs keyless. The three connections this driver saves are local stubs it starts itself; the vault those stubs wrote is removed before the last step, so the run at the end replays the committed transcript. No key material exists in this run, and nothing a person made is touched.",
    );
    check(
      "the launcher says it is keyless, so every run here replays",
      /keyless, replaying/.test(app.stderr()),
      true,
    );
    check(
      "the store this driver made starts with no Bot in it",
      (await post(app, "list_bots", {})).json,
      {
        bots: [],
      },
    );
    const containersAtStart = dockerNames();
    note(`the run path's containers before any run: ${JSON.stringify(containersAtStart)}`);

    // -----------------------------------------------------------------------
    section("the empty root: the first-run screen, not the shell");
    const page = await openPage(chrome.cdp, app.url);
    await focusThePage(chrome.cdp, page);
    await setViewport(chrome.cdp, page, 1440, 900);
    await waitFor(
      chrome.cdp,
      page,
      "the first-run screen",
      `typeof window.__firstRunFacts === 'function' && ${FIRST_RUN}.shown === true`,
      30_000,
    );
    const atEmpty = await screenFacts(chrome.cdp, page);
    check(
      "the empty root opens the first-run screen on its first pane",
      [atEmpty.shown, atEmpty.step, atEmpty.caption, atEmpty.paneTitle],
      [true, 1, "01 / 03 — NAME", "Who is this Bot?"],
    );
    check(
      "and the shell is not the screen: no Bot list, no operator frame, no conversation",
      await evaluate<Record<string, unknown>>(
        chrome.cdp,
        page,
        `({
          bots: ${SHELL}.bots.length,
          operator: document.querySelector('.shell').dataset.operator,
          sidebar: document.querySelector('#sidebar').hidden,
          provider: document.querySelector('#provider').hidden,
          thread: document.querySelector('#thread').clientHeight,
        })`,
      ),
      { bots: 0, operator: "false", sidebar: true, provider: true, thread: 0 },
    );
    check(
      "the pane's standing copy is the export's, read off the DOM",
      await evaluate<Record<string, string>>(
        chrome.cdp,
        page,
        `({
          hint: document.querySelector('#frPane1 .hint').textContent,
          label: document.querySelector('#frPane1 label').textContent,
          placeholder: document.querySelector('#frName').placeholder,
        })`,
      ),
      {
        hint: "A name is the whole requirement. It becomes the sidebar row and the label on its computer.",
        label: "Bot name",
        placeholder: "Atlas",
      },
    );
    check(
      "the primary is held down until the pane's question is answered, and Skip is the way out",
      [atEmpty.primary, atEmpty.primaryDisabled, atEmpty.skip],
      ["Continue", true, "Skip"],
    );
    await capture(chrome.cdp, page, dir, "01-empty-root");

    // -----------------------------------------------------------------------
    section("pane one: a name makes a real Bot, and nothing is made before it");
    await typeInto(chrome.cdp, page, "#frName", "Atlas");
    const typed = await screenFacts(chrome.cdp, page);
    check(
      "typing a name arms the primary",
      [typed.primaryDisabled, typed.fields.name],
      [false, "Atlas"],
    );
    await capture(chrome.cdp, page, dir, "02-pane-name");
    check(
      "no Bot exists before the person asks for one",
      ((await post(app, "list_bots", {})).json as { bots: unknown[] }).bots.length,
      0,
    );
    await click(chrome.cdp, page, "#frNext");
    await waitForStep(chrome.cdp, page, 2);
    const made = (await post(app, "list_bots", {})).json as {
      bots: Array<{ botId: string; name: string }>;
    };
    check(
      "Continue on pane one made exactly one Bot, with the name the person typed",
      [made.bots.length, made.bots[0]?.botId, made.bots[0]?.name],
      [1, "bot-local", "Atlas"],
    );
    const threads = (await post(app, "list_threads", { botId: "bot-local" })).json as {
      threads: Array<{ title: string }>;
    };
    check(
      "it carries a first thread to run in, and no purpose yet",
      [threads.threads.length, threads.threads[0]?.title],
      [1, "New conversation"],
    );

    // -----------------------------------------------------------------------
    section("pane two: the purpose is kept");
    check(
      "pane two asks the export's two questions, with the primary held down",
      await evaluate<Record<string, string>>(
        chrome.cdp,
        page,
        `({
          title: document.querySelector('#frPane2 h2').textContent,
          hint: document.querySelector('#frPane2 .hint').textContent,
          roleLabel: document.querySelectorAll('#frPane2 label')[0].textContent,
          purposeLabel: document.querySelectorAll('#frPane2 label')[1].textContent,
          rolePlaceholder: document.querySelector('#frRole').placeholder,
          purposePlaceholder: document.querySelector('#frPurpose').placeholder,
          primaryDisabled: String(${FIRST_RUN}.primaryDisabled),
        })`,
      ),
      {
        title: "What is it for?",
        hint: "One line. This seeds the soul — the system prompt this Bot runs on — and you can rewrite it later.",
        roleLabel: "Label",
        purposeLabel: "What should it handle?",
        rolePlaceholder: "Chief of staff",
        purposePlaceholder: "Release pipeline, changelog, dependency sweeps",
        primaryDisabled: "true",
      },
    );
    await fill(chrome.cdp, page, "#frRole", "Chief of staff");
    await fill(chrome.cdp, page, "#frPurpose", "Release pipeline, changelog, dependency sweeps");
    await capture(chrome.cdp, page, dir, "03-pane-purpose");
    await click(chrome.cdp, page, "#frNext");
    await waitForStep(chrome.cdp, page, 3);
    const described = (await post(app, "list_bots", {})).json as {
      bots: Array<{ role: string; purpose: string }>;
    };
    check(
      "the record now carries both fields, over the wire the page wrote them with",
      [described.bots.length, described.bots[0]?.role, described.bots[0]?.purpose],
      [1, "Chief of staff", "Release pipeline, changelog, dependency sweeps"],
    );
    const journal = readFileSync(join(botsRoot, REGISTRY_FILE), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    note(`the journal as the server wrote it: ${JSON.stringify(journal)}`);
    check(
      "and the journal holds the Bot, its thread and one update, the update carrying the purpose",
      [journal.length, journal.map((line) => line.op), journal[2]?.role, journal[2]?.purpose],
      [
        3,
        ["bot.create", "thread.create", "bot.update"],
        "Chief of staff",
        "Release pipeline, changelog, dependency sweeps",
      ],
    );
    const reopened = new BotStore({ file: join(botsRoot, REGISTRY_FILE), now: () => 0 });
    const reloaded = reopened.reload();
    check(
      "replaying that journal comes back to the same Bot, with the purpose intact",
      [
        reopened.bots().length,
        reopened.bot("bot-local")?.name,
        reopened.bot("bot-local")?.purpose,
        reloaded.converged,
        reloaded.report.refused,
      ],
      [1, "Atlas", "Release pipeline, changelog, dependency sweeps", true, []],
    );

    // -----------------------------------------------------------------------
    section("pane three: the starting job");
    check(
      "pane three is the export's, and its primary is the last pane's",
      await evaluate<Record<string, string>>(
        chrome.cdp,
        page,
        `({
          title: document.querySelector('#frPane3 h2').textContent,
          hint: document.querySelector('#frPane3 .hint').textContent,
          primary: ${FIRST_RUN}.primary,
        })`,
      ),
      {
        title: "Start with a job.",
        hint: "Pick one to prefill the composer, or skip and type your own.",
        primary: "Start working",
      },
    );
    check(
      "the four chips are the export's, each carrying the prompt it prefills",
      await evaluate<Array<[string, string]>>(
        chrome.cdp,
        page,
        `[...document.querySelectorAll('#frChips .chip')].map((chip) => [chip.textContent, chip.dataset.task])`,
      ),
      [
        [
          "Audit for committed secrets",
          "Audit the repo for committed secrets and draft the cleanup.",
        ],
        ["Draft this week's changelog", "Draft this week's changelog from merged PRs."],
        ["Sweep dependencies", "Sweep dependencies and report what is stale, with a plan."],
        ["Summarise since last release", "Summarise what changed in main since the last release."],
      ],
    );

    // -----------------------------------------------------------------------
    section("the fourth moment: the provider pane, through page 1's own route");
    check(
      "the pane's empty state is the export's own ask, before anything is saved",
      await evaluate<Record<string, unknown>>(
        chrome.cdp,
        page,
        `({
          state: ${FIRST_RUN}.provider.state,
          shown: ${FIRST_RUN}.provider.shown,
          headline: ${FIRST_RUN}.provider.headline,
          intro: document.querySelector('#fr-provider-intro').textContent,
          eyebrow: document.querySelector('#fr-provider-eyebrow').textContent,
          save: document.querySelector('#fr-provider-save').textContent,
          vault: ${FIRST_RUN}.provider.vault.present,
          keyKept: document.querySelector('#fr-provider-key-kept').textContent,
          endpoint: ${FIRST_RUN}.provider.endpoint,
        })`,
      ),
      {
        state: "empty",
        shown: true,
        headline: "Test a real tool call before we save it.",
        intro:
          "The smoke test sends one request with a tool definition. What comes back sets this connection's capability flags.",
        eyebrow: "Connect a provider",
        save: "Save and test",
        vault: false,
        keyKept: "Key goes to the vault, never the process env.",
        endpoint: "",
      },
    );
    await capture(chrome.cdp, page, dir, "04-pane-job-and-provider-empty");

    const capableStub = startStub("capable");
    stubs.push(capableStub);
    const capable = await saveConnection(chrome.cdp, page, capableStub.baseUrl, "stub-capable");
    check(
      "a stub that calls the tool makes the connection capable, with its own reply and flags",
      [
        capable.state,
        capable.headline,
        capable.answer,
        capable.capabilities,
        capable.keyEmpty,
        capable.endpoint,
      ],
      [
        "capable",
        "This connection is capable",
        "save-time-smoke",
        [
          "tool calling: strong",
          "streaming: true",
          "structured output: unknown",
          "context window: unknown",
        ],
        true,
        `POST ${capableStub.baseUrl}/chat/completions  model stub-capable`,
      ],
    );
    note(`the capable stub's own requests: ${JSON.stringify(capableStub.asked.map(summarize))}`);
    check(
      "the request carried the smoke tool and asked for a call, and the closing turn followed",
      [
        capableStub.asked.length,
        summarize(capableStub.asked[0] ?? {}).tools,
        capableStub.asked[0]?.tool_choice,
        capableStub.asked[0]?.stream,
        summarize(capableStub.asked[1] ?? {}).roles,
      ],
      [2, ["freebot_smoke_echo"], "auto", true, ["user", "assistant", "tool"]],
    );
    await capture(chrome.cdp, page, dir, "05-provider-capable");

    const limitedStub = startStub("limited");
    stubs.push(limitedStub);
    const limited = await saveConnection(chrome.cdp, page, limitedStub.baseUrl, "stub-limited");
    check(
      "a stub that never calls a tool is limited, and says which fallback earned it",
      [limited.state, limited.headline, limited.refusal, limited.capabilities],
      [
        "limited",
        "This connection answers, without a tool call",
        null,
        [
          "tool calling: weak",
          "streaming: unknown",
          "structured output: true",
          "context window: unknown",
        ],
      ],
    );
    note(`the limited stub's own requests: ${JSON.stringify(limitedStub.asked.map(summarize))}`);
    check(
      "and the fallback asked for a JSON object, which is what the weak flag rests on",
      [
        limitedStub.asked.length,
        limitedStub.asked.at(-1)?.response_format,
        limitedStub.asked.filter((body) => body.response_format !== undefined).length,
      ],
      [3, { type: "json_object" }, 1],
    );
    await capture(chrome.cdp, page, dir, "06-provider-limited");

    const refusingStub = startStub("untested");
    stubs.push(refusingStub);
    const untested = await saveConnection(chrome.cdp, page, refusingStub.baseUrl, "stub-untested");
    check(
      "an endpoint that refuses is untested, with the provider's own status and message",
      [untested.state, untested.headline, untested.refusal, untested.answer, untested.capabilities],
      [
        "untested",
        "The connection did not pass its test",
        {
          status: 401,
          message: "auth rejected (401): Invalid 'Authorization' header or token.",
        },
        null,
        [],
      ],
    );
    await capture(chrome.cdp, page, dir, "07-provider-untested");
    for (const stub of stubs) stub.stop();
    stubs.length = 0;

    // -----------------------------------------------------------------------
    section("the job, and the app after the wizard");
    await clickExpression(chrome.cdp, page, `[...document.querySelectorAll('#frChips .chip')][1]`);
    check(
      "the chip the person picked is the one the screen marks chosen",
      await evaluate<Array<[string, boolean]>>(
        chrome.cdp,
        page,
        `[...document.querySelectorAll('#frChips .chip')].map((chip) => [chip.textContent, chip.classList.contains('on')])`,
      ),
      [
        ["Audit for committed secrets", false],
        ["Draft this week's changelog", true],
        ["Sweep dependencies", false],
        ["Summarise since last release", false],
      ],
    );
    // The vault the three stubs wrote comes out, because the run after the wizard is this driver's
    // evidence that a connection nobody kept leaves the machine in replay mode.
    rmSync(join(home, "provider.env"), { force: true });
    rmSync(join(home, "provider.json"), { force: true });
    note(`removed the driver's own vault and record under ${home}, so the run at the end replays`);
    await click(chrome.cdp, page, "#frNext");
    await waitFor(
      chrome.cdp,
      page,
      "the shell after the wizard",
      `${FIRST_RUN}.shown === false && document.querySelector('.shell').dataset.operator === 'true'`,
      30_000,
    );
    note(
      "the composer's 46px is the export's own `min-height` for `#prompt` (freebot-prototype.html:373); U6.8 moved it from the 36 this driver was written against",
    );
    check(
      "the wizard is gone, the sidebar shows the Bot a person named, and the job is the first prompt",
      await evaluate<Record<string, unknown>>(
        chrome.cdp,
        page,
        `({
          bots: ${SHELL}.bots.map((bot) => [bot.botId, bot.name, bot.selected]),
          threads: ${SHELL}.threads.length,
          title: document.querySelector('#bot-title').textContent,
          prompt: document.querySelector('#prompt').value,
          promptDisabled: document.querySelector('#prompt').disabled,
          promptHeight: document.querySelector('#prompt').clientHeight,
          providerHidden: document.querySelector('#provider').hidden,
          bodyPage: document.body.dataset.page,
          wizardHidden: document.querySelector('#firstrun').hidden,
        })`,
      ),
      {
        bots: [["bot-local", "Atlas", true]],
        threads: 1,
        title: "Atlas · New conversation",
        prompt: CHOSEN_TASK,
        promptDisabled: false,
        promptHeight: 46,
        providerHidden: true,
        bodyPage: "app",
        wizardHidden: true,
      },
    );
    const composer = await evaluate<Record<string, unknown>>(
      chrome.cdp,
      page,
      `(() => {
        const box = document.querySelector('#prompt');
        const before = document.activeElement?.id ?? null;
        box.focus();
        return { before, after: document.activeElement?.id ?? null, hasFocus: document.hasFocus() };
      })()`,
    );
    check("and the composer takes focus when it is asked", composer.after, "prompt");
    note(
      `the active element before the driver asked: ${String(composer.before)}; the app's own call is asynchronous, so which of the two won is a race the browser decides`,
    );
    note(
      "the focus note: this driver turns CDP's focus emulation on, and Chrome answers a focus call on the page with the element it last held, which is the wizard's key field it has since hidden. That field is display:none, so a real browser has already blurred it; `main.ts`'s own focus call is the export's behaviour at `freebot-prototype.html:2240`, and the check above is what a driver can observe: the composer is displayed, enabled and takes the focus when it is asked.",
    );
    await capture(chrome.cdp, page, dir, "08-app-after-wizard");

    // -----------------------------------------------------------------------
    section("the first prompt runs, in the Bot's own thread");
    await click(chrome.cdp, page, "#start");
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const answered = await evaluate<boolean>(
        chrome.cdp,
        page,
        `(() => {
          const card = [...document.querySelectorAll('#thread .approval-card')].find(
            (candidate) => (candidate.dataset.decision ?? null) === null,
          );
          const button = card?.querySelector('.allow-once') ?? null;
          if (button === null) return false;
          button.click();
          return true;
        })()`,
      );
      if (answered) continue;
      const ended = await evaluate<number>(
        chrome.cdp,
        page,
        `document.querySelectorAll('#thread .run-finished, #thread .run-failed').length`,
      );
      if (ended > 0) break;
      await sleep(500);
    }
    const ran = (await post(app, "list_threads", { botId: "bot-local" })).json as {
      threads: Array<{ threadId: string; runs: Array<{ prompt: string; status: string }> }>;
    };
    check(
      "the first run landed in the Bot's own thread and finished",
      [
        await evaluate<number>(
          chrome.cdp,
          page,
          `document.querySelectorAll('#thread .run-finished').length`,
        ),
        await evaluate<number>(
          chrome.cdp,
          page,
          `document.querySelectorAll('#thread .run-failed').length`,
        ),
        await evaluate<string | null>(
          chrome.cdp,
          page,
          `document.querySelector('#thread .message.user .prompt')?.textContent ?? null`,
        ),
        await evaluate<number>(chrome.cdp, page, `${SHELL}.threads[0].runs`),
        ran.threads.length,
        ran.threads[0]?.runs.length,
        ran.threads[0]?.runs[0]?.prompt,
      ],
      [1, 0, CHOSEN_TASK, 1, 1, 1, CHOSEN_TASK],
    );
    note(`the launcher's own line about the mode: ${bootLine}`);
    await capture(chrome.cdp, page, dir, "09-first-run-in-the-bot-thread");

    // -----------------------------------------------------------------------
    section("the next boot: a Bot exists, so the wizard does not come back");
    await chrome.cdp.send("Page.navigate", { url: app.url }, page);
    await focusThePage(chrome.cdp, page);
    await waitFor(
      chrome.cdp,
      page,
      "the shell on a second boot",
      `typeof window.__shellFacts === 'function' && document.querySelector('.shell').dataset.operator === 'true'`,
      30_000,
    );
    check(
      "a second boot over the same bots root opens the app, not the first-run screen",
      await evaluate<Record<string, unknown>>(
        chrome.cdp,
        page,
        `({
          wizardHidden: document.querySelector('#firstrun').hidden,
          wizardShown: ${FIRST_RUN}.shown,
          bots: ${SHELL}.bots.map((bot) => [bot.botId, bot.name]),
          threads: ${SHELL}.threads.length,
        })`,
      ),
      { wizardHidden: true, wizardShown: false, bots: [["bot-local", "Atlas"]], threads: 1 },
    );
    await capture(chrome.cdp, page, dir, "10-second-boot");

    // -----------------------------------------------------------------------
    section("the containers the run path left behind");
    check(
      "the label-scoped container set is back where this driver found it",
      dockerNames(),
      containersAtStart,
    );

    // -----------------------------------------------------------------------
    section("the geometry pass: the screen's frame at the nine viewports");
    const exportPage = await openPage(chrome.cdp, exported.url);
    await waitFor(
      chrome.cdp,
      exportPage,
      "the export's first-run screen",
      `document.querySelector('#firstrun') !== null && !document.querySelector('#firstrun').classList.contains('hidden')`,
    );
    check("the export's initial screen was replaced exactly once", exported.replaced, 1);
    // A second app of the driver's own, so the frame is measured on a fresh install rather than on
    // the one the flow above already walked.
    const freshHome = mkdtempSync(join(tmpdir(), "freebot-first-run-matrix-"));
    freshApp = await launch(freshHome, join(freshHome, "bots"));
    const freshPage = await openPage(chrome.cdp, freshApp.url);
    await focusThePage(chrome.cdp, freshPage);
    await waitFor(
      chrome.cdp,
      freshPage,
      "the first-run screen of the second app",
      `typeof window.__firstRunFacts === 'function' && ${FIRST_RUN}.shown === true`,
      30_000,
    );
    for (const viewport of readViewports()) {
      const label = `${viewport.name} ${viewport.width}x${viewport.height}`;
      const failedBefore = failed;
      await setViewport(chrome.cdp, freshPage, viewport.width, viewport.height);
      await setViewport(chrome.cdp, exportPage, viewport.width, viewport.height);
      await settle(chrome.cdp, freshPage);
      await settle(chrome.cdp, exportPage);
      const mine = await evaluate<FrameProbes>(chrome.cdp, freshPage, frameExpression());
      const theirs = await evaluate<FrameProbes>(chrome.cdp, exportPage, frameExpression());
      for (const field of FRAME_FIELDS) {
        check(
          `${label} — ${field.field} (${field.prop})`,
          mine.fields[field.field],
          theirs.fields[field.field],
        );
      }
      check(`${label} — the frame has no horizontal overflow`, mine.document, [
        viewport.width,
        viewport.width,
      ]);
      check(`${label} — the export shows the same pair`, theirs.document, [
        viewport.width,
        viewport.width,
      ]);
      log.push(`RESULT: ${failed === failedBefore ? "PASS" : "FAIL"} — viewport ${label}`);
    }

    section("the panes themselves, at both ends of the matrix");
    const panesFailedBefore = failed;
    await typeInto(chrome.cdp, freshPage, "#frName", "Matrix");
    await fill(chrome.cdp, freshPage, "#frPurpose", "Keeps the release pipeline moving");
    for (const [step, pane] of [
      [1, "#frPane1"],
      [2, "#frPane2"],
      [3, "#frPane3"],
    ] as const) {
      const pairs: Array<[number, number]> = [];
      for (const [width, height] of [
        [360, 800],
        [1440, 900],
      ] as const) {
        await setViewport(chrome.cdp, freshPage, width, height);
        await settle(chrome.cdp, freshPage);
        pairs.push(await documentPair(chrome.cdp, freshPage));
      }
      check(`pane ${step} (${pane}) fits the viewport at 360x800 and 1440x900`, pairs, [
        [360, 360],
        [1440, 1440],
      ]);
      if (step < 3) {
        await click(chrome.cdp, freshPage, "#frNext");
        await waitForStep(chrome.cdp, freshPage, step + 1);
      }
    }
    log.push(`RESULT: ${failed === panesFailedBefore ? "PASS" : "FAIL"} — the three panes`);
  } finally {
    for (const stub of stubs) stub.stop();
    chrome.stop();
    exported.stop();
    if (freshApp !== null) await freshApp.stop();
    await app.stop();
  }

  log.push("");
  log.push(
    `chrome ${chrome.cdp.version}; a really launched \`bun run up --no-open\` over a fresh FREEBOT_HOME and bots root, the machine's own vault never read; the capable, limited and untested connections are local stubs this driver started and then removed; the export is the committed copy with its initial screen changed to its first-run screen`,
  );
  log.push(`RESULT: ${failed === 0 ? "PASS" : "FAIL"} (${passed}/${passed + failed})`);
  writeFileSync(join(dir, "assert.txt"), `${log.join("\n")}\n`);
  console.log(
    log.filter((line) => line.startsWith("FAIL") || line.startsWith("RESULT")).join("\n"),
  );
  console.log(`artifact: packages/verify/artifacts/${feature}/${sha}/assert.txt`);
  return failed === 0 ? 0 : 1;
}

try {
  process.exit(await main());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`driver crashed: ${message}`);
  log.push("", `DRIVER CRASH: ${message}`);
  try {
    const dir = artifactDir(root, feature, shortSha());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "assert.txt"), `${log.join("\n")}\n`);
    console.error(
      `artifact (crashed run): packages/verify/artifacts/${feature}/${shortSha()}/assert.txt`,
    );
  } catch {
    console.error("the crashed run's transcript could not be written");
  }
  process.exit(1);
}
