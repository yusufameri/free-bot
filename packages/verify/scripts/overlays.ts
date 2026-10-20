#!/usr/bin/env bun
/**
 * U6.4's driver: the command palette, the Bot picker and the modal, as a person meets them.
 *
 * One real launch, spawned the way a person starts the app (`bun run up --no-open --replay`) over a
 * `FREEBOT_HOME` and bots root of this driver's own, so no Bot, run, key or container a person or
 * another driver made is touched. The replay provider means no packet leaves the loopback interface
 * and nothing is billed.
 *
 * The page is opened through a TCP relay this driver owns. The relay holds back exactly one request,
 * `POST /rpc/create_bot`, for 900 ms: the picker's `Creating…` state is a row waiting on a slow
 * server, and this is a really slow server rather than a timer the page fakes.
 *
 * Everything the page decides is read out of the rendered DOM: the panels' own text, the rows'
 * `aria-selected`, the `mark`s, and `document.activeElement` for every focus claim. The records the
 * overlays list come from the same routes the page reads (`/rpc/list_bots`, `/rpc/list_threads`,
 * `/rpc/read_file`), and the palette's action proof compares the state a chosen row lands in with
 * the state the matching button lands in.
 *
 * Writes `packages/verify/artifacts/overlays/<short-sha>/` with one PNG per state and `assert.txt`.
 *
 * Run from the repo root: `bun packages/verify/scripts/overlays.ts`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { openRelay } from "./tcp-relay.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const feature = "overlays";
const MANIFEST = "design/prototype-84c6b185/DESIGN-MANIFEST.json";

/** The copy the app owns, asserted as literals so a wording change is a failing run. */
const PALETTE_PLACEHOLDER = "Bots, threads and actions";
const PICKER_PLACEHOLDER = "Find a Bot, or name a new one";
const NO_RESULTS = "Nothing matched. Message search is not in this build.";
const CREATE_LABEL = "Create new Bot";
const CREATING_LABEL = "Creating…";
const HINT_TWO = "Type 2 more characters to search Bots.";
const HINT_ONE = "Type 1 more character to search Bots.";
const PAGES = ["Conversation", "Library", "Connect a provider"];
const ACTIONS = ["New Bot", "New thread"];

/** The export's own sidebar head: the two controls every one of its three overlays hangs off. */
const SEARCH_LABEL = "Search";
const SEARCH_HINT = "⌘K";
const NEW_CHAT_LABEL = "New chat";

/** The fixture this driver writes, so the assertions have literals to read. */
const NOTES = "Overlay notes\n";
const LONG_LINE = "the modal scrolls when the file is longer than the modal\n";
const LONG_LINES = 400;
const ESCAPE_NAME = "escape.txt";

/**
 * The export's chrome and its prototype data, which must not ship. The first four are the export's
 * own instructions to an implementer and its two input placeholders; the rest is the data its
 * prototype printed and this app has no record for. Two strings that used to sit in the data list
 * are gone on purpose: `Teach a task` and `Connect apps` are the export's own Workspace copy, which
 * U6.8 ships and `workspace-pages.ts` asserts.
 */
const EXPORT_CHROME = [
  "data-od-id",
  'class="lbl"',
  'className = "lbl"',
  'Bots, settings, actions, routines — or "a quoted phrase" for messages',
  "Search Bots, or type a name to create one",
] as const;

const EXPORT_DATA = [
  "pre-run-4f3a",
  // `Launch room` is the export's sample room name, which the group form no longer prefills and the
  // app must not ship, so it stays asserted here.
  "Launch room",
  "waiting on approval",
  '"secrets audit"',
  '"changelog"',
  "Export the transcript",
  "Simulate a dropped stream",
  "Reconnect the stream",
  "Add a secret",
  "infra/secrets.old.yml",
  "apps/web/.env.local is tracked and should not be",
] as const;

/** Regions whose own content extent is checked against their own box, per viewport. */
const REGIONS = [
  "#center",
  "#sidebar",
  "#aside",
  "#thread",
  "#library",
  "#tabs",
  "header",
] as const;

const log: string[] = [];
let passed = 0;
let failed = 0;

function section(title: string): void {
  log.push("", `## ${title}`);
}

function note(text: string): void {
  log.push(text);
}

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else failed += 1;
  log.push(
    `${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` != ${JSON.stringify(expected)}`}`,
  );
}

interface Viewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly category: string;
  readonly mustAvoidHorizontalScroll: boolean;
}

function readViewports(): Viewport[] {
  const parsed = JSON.parse(readFileSync(join(root, MANIFEST), "utf8")) as {
    responsiveViewports?: Viewport[];
  };
  const viewports = parsed.responsiveViewports ?? [];
  if (viewports.length !== 9) {
    throw new Error(`${MANIFEST}: expected nine responsiveViewports, found ${viewports.length}`);
  }
  return viewports;
}

function shortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

function redacted(url: string): string {
  return url.replace(/#token=.*$/, "#token=<redacted>");
}

// ---------------------------------------------------------------------------
// The launcher and the relay
// ---------------------------------------------------------------------------

interface App {
  readonly label: string;
  readonly url: string;
  readonly apiPort: number;
  readonly token: string;
  readonly home: string;
  readonly botsRoot: string;
  readonly workspace: string;
  readonly bots: readonly { botId: string; name: string }[];
  stderr(): string;
  stop(): Promise<void>;
}

/** What a route call needs: the port and the token, which exist before the Bots do. */
interface Endpoint {
  readonly apiPort: number;
  readonly token: string;
}

/** One launcher, over a home and a bots root of this driver's own, with its own placeholder vault. */
async function startApp(): Promise<App> {
  const label = "overlays";
  const home = mkdtempSync(join(tmpdir(), `freebot-${label}-`));
  const botsRoot = join(home, "bots");
  writeFileSync(
    join(home, "provider.env"),
    [
      `# This driver's own placeholder vault, in a temporary directory: ${home}`,
      "# Nothing here is a real credential, and no request to it leaves the loopback interface.",
      `FREEBOT_BYOK_KEY=overlays-${Date.now()}`,
      "FREEBOT_BYOK_BASE_URL=http://127.0.0.1:9/overlays-not-a-provider",
      "FREEBOT_BYOK_MODEL=overlays-placeholder",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
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
  const deadline = Date.now() + 30_000;
  while (!/^http:\/\/127\.0\.0\.1:\d+\/#token=\S+$/m.test(out)) {
    if (Date.now() > deadline) throw new Error(`the launcher printed no URL: ${out}`);
    await sleep(100);
  }
  const url = /^(http:\/\/127\.0\.0\.1:\d+\/#token=\S+)$/m.exec(out)?.[1] ?? "";
  const parsed = new URL(url);
  const token = new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token") ?? "";
  const app = {
    label,
    url,
    apiPort: Number(parsed.port),
    token,
    home,
    botsRoot,
    workspace: "",
    stderr: () => err,
    async stop() {
      proc.kill("SIGINT");
      await proc.exited;
      rmSync(home, { recursive: true, force: true });
    },
  };
  const bots: { botId: string; name: string }[] = [];
  for (const [name, threads] of [
    ["Overlay One", ["First conversation"]],
    ["Overlay Two", ["Second conversation", "Third conversation"]],
  ] as const) {
    const bot = (await rpc(app, "create_bot", { name })) as { botId: string };
    if (bot.botId === "") throw new Error(`the launcher made no Bot for ${name}`);
    for (const title of threads) await rpc(app, "create_thread", { botId: bot.botId, title });
    bots.push({ botId: bot.botId, name });
  }
  const first = bots[0];
  if (first === undefined) throw new Error("the launcher made no Bots");
  const outside = join(home, "outside-secret.txt");
  writeFileSync(outside, "not this Bot's file\n");
  for (const bot of bots) {
    const workspace = join(botsRoot, bot.botId, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "notes.md"), NOTES);
    writeFileSync(join(workspace, "long.txt"), LONG_LINE.repeat(LONG_LINES));
    // A path that resolves outside the workspace, which the read refuses by name.
    symlinkSync(outside, join(workspace, ESCAPE_NAME));
  }
  return { ...app, workspace: join(botsRoot, first.botId, "workspace"), bots };
}

async function rpc(
  app: Endpoint,
  procedure: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${app.apiPort}/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${app.token}`,
      origin: `http://127.0.0.1:${app.apiPort}`,
    },
    body: JSON.stringify({ json: input }),
  });
  const answer = (await response.json()) as { json?: unknown; error?: unknown };
  if (answer.error !== undefined)
    throw new Error(`${procedure} refused: ${JSON.stringify(answer.error)}`);
  return answer.json;
}

// ---------------------------------------------------------------------------
// The page's own facts
// ---------------------------------------------------------------------------

interface OverlayFacts {
  readonly stack: string[];
  readonly scrims: number;
  readonly hiddenClass: number;
  readonly focus: { readonly tag: string; readonly id: string; readonly inside: string | null };
  readonly palette: {
    readonly open: boolean;
    readonly mode: string;
    readonly query: string;
    readonly placeholder: string;
    readonly groups: string[];
    readonly rows: string[];
    readonly subs: string[];
    readonly marks: string[];
    readonly active: number;
    readonly activeLabel: string | null;
    readonly ariaSelected: string[];
    readonly note: string | null;
  };
  readonly picker: {
    readonly open: boolean;
    readonly query: string;
    readonly placeholder: string;
    readonly rows: string[];
    readonly disabled: boolean[];
    readonly hint: string | null;
  };
  readonly modal: {
    readonly open: boolean;
    readonly role: string | null;
    readonly ariaModal: string | null;
    readonly wide: boolean;
    readonly title: string;
    readonly path: string;
    readonly size: string;
    readonly text: string | null;
    readonly refusal: string | null;
    readonly scrolls: boolean;
    readonly closeLabel: string | null;
    readonly closeIcon: string | null;
  };
}

/** What the driver reads after each step: the overlays' facts, the records behind them, the page. */
interface Facts {
  readonly overlays: OverlayFacts;
  readonly activeElement: {
    readonly id: string;
    readonly className: string;
    readonly path: string | null;
    readonly tag: string;
    readonly text: string;
  };
  readonly shell: {
    readonly operator: boolean;
    readonly bots: Array<{ botId: string; name: string; threadCount: number; selected: boolean }>;
    readonly selectedBotId: string | null;
    readonly threads: Array<{ threadId: string; title: string; runs: number; selected: boolean }>;
    readonly selectedThreadId: string | null;
    readonly title: string;
  };
  readonly aside: {
    readonly tab: string;
    readonly rows: Array<{ label: string; value: string }>;
    readonly files: Array<{ name: string; path: string; kind: string }>;
  };
  readonly library: {
    readonly state: string;
    readonly tab: string;
    readonly openPath: string | null;
  };
  readonly listTab: string;
  readonly connection: string;
  readonly activeRowBackground: string | null;
  readonly otherRowBackground: string | null;
  readonly panelText: string;
  readonly asideTogglePressed: string | null;
  readonly prompt: string;
}

async function facts(cdp: Cdp, session: string): Promise<Facts> {
  return evaluate<Facts>(
    cdp,
    session,
    `(() => {
      // This page is a background target, so its animation clock does not advance on its own. The
      // driver lands every running transition before it reads a colour, which is how the state it
      // measures is the settled one rather than wherever the clock stopped.
      for (const anim of document.getAnimations()) {
        try { anim.finish(); } catch (error) { /* a transition that cannot land keeps its value */ }
      }
      const node = document.activeElement;
      const panel = document.querySelector('#palette, #picker, #modal');
      const list = document.querySelector('#palette-list, #picker-list');
      const rows = list === null ? [] : [...list.querySelectorAll('.pop-item')];
      const active = rows.find((row) => row.dataset.active === 'true') ?? null;
      const other = rows.find((row) => row.dataset.active !== 'true') ?? null;
      const style = (el) => el === null ? null : getComputedStyle(el).backgroundColor;
      return {
        overlays: window.__overlayFacts(),
        activeElement: {
          id: node?.id ?? '',
          className: typeof node?.className === 'string' ? node.className : '',
          path: node?.getAttribute ? node.getAttribute('data-path') : null,
          tag: node?.tagName?.toLowerCase() ?? '',
          text: (node?.textContent ?? '').slice(0, 40),
        },
        shell: window.__shellFacts(),
        aside: {
          tab: window.__asideFacts().tab,
          rows: window.__asideFacts().rows,
          files: window.__asideFacts().files,
        },
        library: (() => {
          const l = window.__libraryFacts();
          return { state: l.state, tab: l.tab, openPath: l.openPath };
        })(),
        listTab: document.body.dataset.tab ?? '',
        connection: document.querySelector('#conn')?.dataset.connection ?? '',
        activeRowBackground: style(active),
        otherRowBackground: style(other),
        panelText: panel === null ? '' : panel.innerText ?? panel.textContent ?? '',
        asideTogglePressed: document.querySelector('#aside-toggle')?.getAttribute('aria-pressed') ?? null,
        prompt: document.querySelector('#prompt')?.value ?? '',
      };
    })()`,
  );
}

/** The page's own state when a boot wait times out, so a failure names its cause. */
async function explain(cdp: Cdp, session: string): Promise<string> {
  return await evaluate<string>(
    cdp,
    session,
    `(() => {
      const has = (name) => typeof window[name] === 'function';
      return JSON.stringify({
        hooks: ['__overlayFacts', '__shellFacts', '__asideFacts', '__libraryFacts']
          .map((name) => name + '=' + (has(name) ? 'fn' : 'ABSENT')).join(' '),
        operator: document.querySelector('.shell')?.dataset.operator ?? null,
        page: document.body.dataset.page ?? null,
        bots: has('__shellFacts') ? window.__shellFacts().bots.length : 'ABSENT',
        selectedThread: has('__shellFacts') ? window.__shellFacts().selectedThreadId : 'ABSENT',
        withSidebarSearch: document.querySelector('#sidebar-search') !== null,
        conn: document.querySelector('#conn')?.dataset.connection ?? null,
        error: document.querySelector('#error')?.textContent ?? null,
        href: location.href.replace(/#token=.*/, '#token=<redacted>'),
        title: document.title,
        ready: document.readyState,
        htmlBytes: document.documentElement.outerHTML.length,
        scripts: [...document.scripts].map((node) => node.src),
        resources: [...performance.getEntriesByType('resource')].map((entry) => [
          entry.name.replace(/#token=.*/, ''),
          Math.round(entry.duration),
          entry.transferSize ?? -1,
        ]),
      });
    })()`,
  );
}

/** The page's overflow, its overlay's own box, and its regions at the current viewport. */
interface OverflowProbe {
  readonly document: readonly [number, number];
  readonly regions: Record<string, readonly [number, number] | null>;
  readonly panel: { readonly left: number; readonly right: number; readonly width: number } | null;
  readonly panelScroll: readonly [number, number] | null;
  readonly innerWidth: number;
  readonly innerHeight: number;
}

async function overflowProbe(cdp: Cdp, session: string): Promise<OverflowProbe> {
  return evaluate<OverflowProbe>(
    cdp,
    session,
    `(() => {
      const regions = ${JSON.stringify(REGIONS)};
      const out = {};
      for (const selector of regions) {
        const node = document.querySelector(selector);
        out[selector] = node === null ? null : [node.scrollWidth, node.clientWidth];
      }
      const panel = document.querySelector('#palette, #picker, #modal');
      const list = document.querySelector('#palette-list, #picker-list');
      const rect = panel === null ? null : panel.getBoundingClientRect();
      return {
        document: [document.documentElement.scrollWidth, window.innerWidth],
        regions: out,
        panel: rect === null ? null : {
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        },
        panelScroll: panel === null ? null : [panel.scrollWidth, panel.clientWidth],
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      };
    })()`,
  );
}

// ---------------------------------------------------------------------------
// The page's own input: real keys, real pointer moves
// ---------------------------------------------------------------------------

interface Point {
  readonly x: number;
  readonly y: number;
}

/** One real press and release at the element's own box center. */
async function clickAt(cdp: Cdp, session: string, selector: string): Promise<Point> {
  const point = await evaluate<Point | null>(
    cdp,
    session,
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (node === null) return null;
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`,
  );
  if (point === null) throw new Error(`no box to click for ${selector}`);
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: point.x, y: point.y },
    session,
  );
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 },
    session,
  );
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 },
    session,
  );
  await settle(cdp, session);
  return point;
}

/** One real press and release at a page coordinate: the scrim's own center is the panel. */
async function clickPoint(cdp: Cdp, session: string, x: number, y: number): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, session);
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 },
    session,
  );
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 },
    session,
  );
  await settle(cdp, session);
}

/** Put the pointer over an element without pressing, which is the hover state. */
async function hover(cdp: Cdp, session: string, selector: string): Promise<Point> {
  const point = await evaluate<Point | null>(
    cdp,
    session,
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (node === null) return null;
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`,
  );
  if (point === null) throw new Error(`no box to hover for ${selector}`);
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: point.x, y: point.y },
    session,
  );
  await settle(cdp, session, 60);
  return point;
}

const VIRTUAL_KEYS: Record<string, { code: string; keyCode: number }> = {
  Escape: { code: "Escape", keyCode: 27 },
  Enter: { code: "Enter", keyCode: 13 },
  Tab: { code: "Tab", keyCode: 9 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  k: { code: "KeyK", keyCode: 75 },
  f: { code: "KeyF", keyCode: 70 },
  n: { code: "KeyN", keyCode: 78 },
};

/** One real keystroke: the key the page's own handler reads, with the modifiers it reads too. */
async function press(cdp: Cdp, session: string, key: string, modifiers = 0): Promise<void> {
  const spec = VIRTUAL_KEYS[key];
  if (spec === undefined) throw new Error(`no virtual key for ${key}`);
  const letter = /^[a-z]$/.test(key);
  const shifted = letter && modifiers & 8 ? key.toUpperCase() : key;
  // `keyDown`, not `rawKeyDown`: the browser's own default for Tab (move the focus) and for Enter
  // (press the focused control) is what the trap and the keyboard path are made of.
  const text = key === "Enter" ? "\r" : letter && !(modifiers & 4) ? key : undefined;
  await cdp.send(
    "Input.dispatchKeyEvent",
    {
      type: "keyDown",
      key: shifted,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
      modifiers,
      ...(text === undefined ? {} : { text }),
    },
    session,
  );
  await cdp.send(
    "Input.dispatchKeyEvent",
    {
      type: "keyUp",
      key: shifted,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
      modifiers,
    },
    session,
  );
  await settle(cdp, session, 200);
}

/** Type text the way a person does: one real key event per character, so the page's own input fires. */
async function type(cdp: Cdp, session: string, text: string): Promise<void> {
  for (const character of text) {
    const upper = character.toUpperCase();
    const shifted = character !== upper || /[^a-z0-9]/.test(character);
    await cdp.send(
      "Input.dispatchKeyEvent",
      {
        type: "keyDown",
        text: character,
        key: character,
        code: /^[a-zA-Z]$/.test(character) ? `Key${upper}` : "",
        windowsVirtualKeyCode: upper.charCodeAt(0),
        modifiers: shifted && /[A-Z]/.test(character) ? 8 : 0,
      },
      session,
    );
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: character }, session);
  }
  await settle(cdp, session, 80);
}

/**
 * Show the pane's Library tab and let its read land before a walk starts.
 *
 * The pane repaints when its records move, and a repaint replaces the nodes, so a walk that starts
 * while the read is still landing loses the focus it had just gained. Anchoring first is what makes
 * the walk below land in a handful of presses instead of racing a render.
 */
async function anchorPane(cdp: Cdp, session: string): Promise<void> {
  await clickAt(cdp, session, "#aside .aside-tab[data-tab='library']");
  await waitFor(
    cdp,
    session,
    "the pane's Library listing before a walk",
    `document.querySelectorAll('#aside .aside-file').length >= 3`,
    20_000,
  );
  await sleep(500);
}

/** Where the focus is, as one phrase, so a walk that misses says where it ended up. */
async function focusPhrase(cdp: Cdp, session: string): Promise<string> {
  return await evaluate<string>(
    cdp,
    session,
    `(() => {
       const node = document.activeElement;
       if (node === null) return 'nothing';
       return [node.tagName.toLowerCase(), node.id, typeof node.className === 'string' ? node.className : '', node.getAttribute('data-path') ?? '']
         .filter((part) => part !== '').join('.');
     })()`,
  );
}

/** Walk the focus forward with real Tab presses until it lands on the element asked for. */
async function tabTo(cdp: Cdp, session: string, selector: string, max = 24): Promise<string> {
  for (let step = 0; step <= max; step++) {
    const landed = await evaluate<boolean>(
      cdp,
      session,
      `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(selector)})`,
    );
    if (landed) return `after ${step} Tab press(es)`;
    await press(cdp, session, "Tab");
  }
  return `never reached ${selector}: the focus ended on ${await focusPhrase(cdp, session)}`;
}

/** Take the page's own screenshot and keep it. */
const artifacts: string[] = [];

async function capture(cdp: Cdp, session: string, dir: string, name: string): Promise<number> {
  const shot = await screenshot(cdp, session);
  writeFileSync(join(dir, name), shot);
  artifacts.push(name);
  note(`artifact ${name} (${shot.byteLength} bytes)`);
  return shot.byteLength;
}

/** Every container the run path can make: this repo's unit label, on the docker provider. */
function runContainers(): string[] {
  const proc = Bun.spawnSync([
    "docker",
    "ps",
    "-a",
    "--filter",
    "label=freebot.unit=u1.7",
    "--filter",
    "label=freebot.provider=docker",
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

/** Every literal handed in that a text carries, in the order given. */
function present(text: string, literals: readonly string[]): string[] {
  return literals.filter((literal) => text.includes(literal));
}

// ---------------------------------------------------------------------------
// The run of the driver
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const sha = shortSha();
  const dir = artifactDir(root, feature, sha);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const viewports = readViewports();

  section("what this driver runs");
  note(`artifact directory: packages/verify/artifacts/${feature}/${sha}/`);
  note(
    "launch: `bun run up --no-open --replay` over a fresh FREEBOT_HOME and bots root, its own placeholder vault at mode 600, two Bots the driver makes over /rpc, and a workspace holding a note, a 400-line file and a symlink out of the tree",
  );
  note(
    "the page is opened through this driver's own TCP relay. The relay is armed once to hold a single `POST /rpc/create_bot` back for 900 ms: the picker's `Creating…` state is a row waiting on a slow server",
  );
  note(
    "the real vault at ~/.freebot/provider.env is never read, printed or copied by this driver; the only vault file it opens is its own, under the temporary directory named below",
  );
  for (const viewport of viewports) {
    note(
      `${viewport.name} ${viewport.width}x${viewport.height} ${viewport.category} mustAvoidHorizontalScroll=${viewport.mustAvoidHorizontalScroll}`,
    );
  }

  const baseline = runContainers();
  note(
    `containers before this driver runs anything (label freebot.unit=u1.7): ${baseline.length}${baseline.length === 0 ? "" : ` (${baseline.join(", ")})`}`,
  );

  const app = await startApp();
  note(`home: ${app.home}`);
  note(`workspace: ${app.workspace}`);
  note(`url, redacted: ${redacted(app.url)}`);
  note(`Bots the driver made: ${app.bots.map((bot) => `${bot.name} (${bot.botId})`).join(", ")}`);
  const relay = openRelay(app.apiPort);
  const pageUrl = `${relay.url}/#token=${app.token}`;
  note(
    `relay: 127.0.0.1:${relay.port} -> 127.0.0.1:${app.apiPort}; the page is opened at the relay, so its own origin is the relay`,
  );

  const chrome = await launchChrome({ windowSize: "1600,1000" });
  note(`chrome ${chrome.cdp.version} over CDP`);

  let session = "";
  const overlayText: string[] = [];
  try {
    session = await openPage(chrome.cdp, pageUrl);
    try {
      await waitFor(
        chrome.cdp,
        session,
        "the shell with both Bots in it, the overlays mounted and the stream open",
        `typeof window.__overlayFacts === 'function' && typeof window.__asideFacts === 'function' &&
         document.querySelector('.shell')?.dataset.operator === 'true' &&
         window.__shellFacts().bots.length === 2 && window.__shellFacts().selectedThreadId !== null &&
         document.querySelector('#sidebar-search') !== null &&
         document.querySelector('#conn').dataset.connection === 'connected'`,
        45_000,
      );
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${why}; the page's own state: ${await explain(chrome.cdp, session)}; console: ${chrome.cdp.console.slice(-12).join(" | ")}`,
      );
    }
    await settle(chrome.cdp, session);
    await setViewport(chrome.cdp, session, 1440, 900);
    await settle(chrome.cdp, session);

    // ── the entry points ────────────────────────────────────────────────────
    section("the three primitives, and the entry point the export opens each from");
    const boot = await facts(chrome.cdp, session);
    note(`the shell's own title line: ${JSON.stringify(boot.shell.title)}`);
    check(
      "the sidebar's head is the export's search control and `New chat` control, with the group-chat control the sidebar gained beside them",
      [
        ...(await evaluate<unknown[]>(
          chrome.cdp,
          session,
          `[...document.querySelectorAll('.sb-head > *')].map((node) => [
             node.tagName.toLowerCase(),
             node.id,
             node.getAttribute('aria-label'),
             node.querySelector('.sb-search-label')?.textContent ?? null,
             node.querySelector('.kbd')?.textContent ?? null,
             node.querySelector('use')?.getAttribute('href') ?? null,
           ])`,
        )),
      ],
      [
        ["button", "sidebar-search", null, SEARCH_LABEL, SEARCH_HINT, "#i-search"],
        ["button", "sidebar-new-group", "New group chat", null, null, "#i-people"],
        ["button", "sidebar-new-chat", NEW_CHAT_LABEL, null, null, "#i-plus"],
      ],
    );
    check(
      "the palette is reached from three doors (Cmd+K, Cmd+Shift+F, the search button), the picker from two (Cmd+N, `New chat`), and the modal from the pane's Library row",
      await evaluate<unknown>(
        chrome.cdp,
        session,
        `(() => {
           const search = document.querySelector('#sidebar-search');
           const chat = document.querySelector('#sidebar-new-chat');
           const file = document.querySelectorAll('#aside .aside-file').length;
           return { search: search !== null, chat: chat !== null, paneFiles: file };
         })()`,
      ),
      { search: true, chat: true, paneFiles: 0 },
    );
    note(
      "the pane's Library rows are built when that tab is shown, so the modal's own door is asserted where it really is: a `.aside-file` row, which is the export's `data-act=file:open` (`freebot-prototype.html:1364`)",
    );

    // ── the palette ─────────────────────────────────────────────────────────
    section("the palette, from Cmd/Ctrl+K");
    await press(chrome.cdp, session, "k", 4);
    let state = await facts(chrome.cdp, session);
    check("Cmd/Ctrl+K opens the palette and nothing else", state.overlays.stack, ["palette"]);
    check(
      "the input is the element that holds the focus, read from document.activeElement",
      state.activeElement.id,
      "palette-input",
    );
    check(
      "the field says what this app's palette holds, and the export's own placeholder is not it",
      state.overlays.palette.placeholder,
      PALETTE_PLACEHOLDER,
    );
    check(
      "the mode Cmd/Ctrl+K asks for is the export's own `all`",
      state.overlays.palette.mode,
      "all",
    );
    check("the query starts empty", state.overlays.palette.query, "");
    check(
      "the groups are Bots, Threads, Pages and Actions, in that order, each header drawn once",
      state.overlays.palette.groups,
      ["Bots", "Threads", "Pages", "Actions"],
    );
    check(
      "the rows are the two Bots the app holds, the selected Bot's own thread, the pages it has, and the actions it offers",
      state.overlays.palette.rows,
      ["Overlay One", "Overlay Two", "First conversation", ...PAGES, ...ACTIONS],
    );
    check(
      "every row names what it is, in the export's own lowercase vocabulary",
      state.overlays.palette.subs,
      ["bot", "bot", "thread", "page", "page", "page", "action", "action"],
    );
    check("an empty query marks nothing", state.overlays.palette.marks, []);
    check(
      "the first row is the active one before an arrow moves it",
      [state.overlays.palette.active, state.overlays.palette.ariaSelected],
      [0, ["true", "false", "false", "false", "false", "false", "false", "false"]],
    );
    check(
      "the dialog role and the scrim are the modal's own furniture, and the palette carries one scrim",
      [state.overlays.scrims, state.overlays.hiddenClass],
      [1, 0],
    );
    overlayText.push(state.panelText);
    await capture(chrome.cdp, session, dir, "01-palette-empty.png");

    await type(chrome.cdp, session, "overlay two");
    state = await facts(chrome.cdp, session);
    check(
      "a query leaves the rows that carry it, and the matched term is split out of the label",
      [state.overlays.palette.rows, state.overlays.palette.marks],
      [["Overlay Two"], ["Overlay Two"]],
    );
    note(
      `the marked element's own text is the label's own casing: a query of "overlay two" marks ${JSON.stringify(state.overlays.palette.marks[0])}, which is what the export's ` +
        "`new RegExp('(' + lq + ')', 'ig')` marks too (`freebot-prototype.html:2134`)",
    );
    await capture(chrome.cdp, session, dir, "02-palette-marked.png");

    await type(chrome.cdp, session, "zzz");
    state = await facts(chrome.cdp, session);
    check(
      "a query nothing matches is the no-results state, and it says what a quoted term would need",
      [state.overlays.palette.rows, state.overlays.palette.note],
      [[], NO_RESULTS],
    );
    await capture(chrome.cdp, session, dir, "03-palette-none.png");

    await press(chrome.cdp, session, "k", 4);
    await type(chrome.cdp, session, '"secrets audit"');
    state = await facts(chrome.cdp, session);
    check(
      "a quoted term answers nothing, because this app has no message search to route it to",
      [state.overlays.palette.rows, state.overlays.palette.note],
      [[], NO_RESULTS],
    );

    await press(chrome.cdp, session, "Escape");
    await press(chrome.cdp, session, "f", 12);
    state = await facts(chrome.cdp, session);
    check(
      "Cmd/Ctrl+Shift+F opens the palette in the export's own `bots` mode",
      [state.overlays.stack, state.overlays.palette.mode],
      [["palette"], "bots"],
    );
    check(
      "the Bots mode is the Bots group alone, which is what the export's own mode filters to",
      [state.overlays.palette.groups, state.overlays.palette.rows],
      [["Bots"], ["Overlay One", "Overlay Two"]],
    );
    overlayText.push(state.panelText);
    await capture(chrome.cdp, session, dir, "04-palette-bots-mode.png");

    await press(chrome.cdp, session, "ArrowDown");
    state = await facts(chrome.cdp, session);
    check(
      "one ArrowDown moves the selection to the second row, and the state is on the row and on the input",
      [
        state.overlays.palette.active,
        state.overlays.palette.activeLabel,
        state.overlays.palette.ariaSelected,
      ],
      [1, "Overlay Two", ["false", "true"]],
    );
    check(
      "the active row wears a wash the idle row does not",
      [
        state.activeRowBackground !== state.otherRowBackground,
        state.activeRowBackground !== "rgba(0, 0, 0, 0)",
      ],
      [true, true],
    );
    const activeBackground = state.activeRowBackground;
    note(
      `the active wash: ${JSON.stringify(activeBackground)}; the idle row: ${JSON.stringify(state.otherRowBackground)}`,
    );
    await press(chrome.cdp, session, "ArrowUp");
    await press(chrome.cdp, session, "ArrowUp");
    state = await facts(chrome.cdp, session);
    check(
      "ArrowUp walks back and wraps past the first row to the last",
      [state.overlays.palette.active, state.overlays.palette.activeLabel],
      [1, "Overlay Two"],
    );
    await press(chrome.cdp, session, "ArrowDown");
    state = await facts(chrome.cdp, session);
    check(
      "the active row is the state the arrows move, and it is the row Enter would choose",
      [
        state.overlays.palette.active,
        state.overlays.palette.activeLabel,
        state.overlays.palette.ariaSelected,
      ],
      [0, "Overlay One", ["true", "false"]],
    );
    await capture(chrome.cdp, session, dir, "05-palette-active.png");

    await hover(chrome.cdp, session, "#palette-list .pop-item:nth-of-type(2)");
    state = await facts(chrome.cdp, session);
    note(
      `the same row under the pointer: active ${state.overlays.palette.active}, wash ${JSON.stringify(state.activeRowBackground)}`,
    );
    check(
      "a pointer over a row moves the same selection, and the wash it wears is the active row's own",
      [
        state.overlays.palette.active,
        state.activeRowBackground === activeBackground,
        state.otherRowBackground !== activeBackground,
      ],
      [1, true, true],
    );
    await capture(chrome.cdp, session, dir, "06-palette-hover.png");

    check(
      "focus starts inside the palette",
      await evaluate<string[]>(
        chrome.cdp,
        session,
        `(() => [document.activeElement === null ? 'none' : (document.activeElement.closest('#palette') === null ? 'outside' : document.activeElement.id)])()`,
      ),
      ["palette-input"],
    );
    await press(chrome.cdp, session, "Tab");
    check(
      "Tab from the field lands on the first row, and it is still inside the palette",
      await evaluate<unknown>(
        chrome.cdp,
        session,
        `(() => {
           const node = document.activeElement;
           return { inside: node?.closest('#palette') !== null, row: node?.dataset?.row ?? null };
         })()`,
      ),
      { inside: true, row: "0" },
    );
    await press(chrome.cdp, session, "Tab");
    check(
      "the next Tab walks to the second row, which is where the focus order really goes",
      await evaluate<unknown>(
        chrome.cdp,
        session,
        `(() => {
           const node = document.activeElement;
           return { inside: node?.closest('#palette') !== null, row: node?.dataset?.row ?? null };
         })()`,
      ),
      { inside: true, row: "1" },
    );
    await press(chrome.cdp, session, "Tab");
    check(
      "Tab off the last row wraps to the field, so focus never leaves an open overlay",
      await evaluate<unknown>(
        chrome.cdp,
        session,
        `(() => {
           const node = document.activeElement;
           return { inside: node?.closest('#palette') !== null, id: node?.id ?? '' };
         })()`,
      ),
      { inside: true, id: "palette-input" },
    );
    await press(chrome.cdp, session, "Tab", 8);
    check(
      "Shift+Tab off the field wraps back to the last row",
      await evaluate<unknown>(
        chrome.cdp,
        session,
        `(() => {
           const node = document.activeElement;
           return { inside: node?.closest('#palette') !== null, row: node?.dataset?.row ?? null };
         })()`,
      ),
      { inside: true, row: "1" },
    );

    // Keyboard-only end to end: type, walk to the row, press Enter on it.
    await press(chrome.cdp, session, "Tab");
    await type(chrome.cdp, session, "two");
    state = await facts(chrome.cdp, session);
    check("typing in the field leaves the one Bot the query names", state.overlays.palette.rows, [
      "Overlay Two",
    ]);
    await press(chrome.cdp, session, "Tab");
    await press(chrome.cdp, session, "Enter");
    state = await facts(chrome.cdp, session);
    check(
      "Enter on the focused row chooses the same command the active row would: the second Bot is selected, which the sidebar's own row does too",
      [state.overlays.stack, state.shell.selectedBotId, state.shell.bots[1]?.botId],
      [[], state.shell.bots[1]?.botId ?? "", state.shell.bots[1]?.botId ?? ""],
    );

    const beforeClose = state;
    await press(chrome.cdp, session, "Escape");
    await press(chrome.cdp, session, "f", 12);
    await press(chrome.cdp, session, "Escape");
    state = await facts(chrome.cdp, session);
    check(
      "Escape closes an overlay, takes its scrim with it, and changes nothing else on the page",
      [
        state.overlays.stack,
        state.overlays.scrims,
        state.shell.selectedBotId,
        state.shell.selectedThreadId,
        state.listTab,
        state.asideTogglePressed,
      ],
      [
        [],
        0,
        beforeClose.shell.selectedBotId,
        beforeClose.shell.selectedThreadId,
        beforeClose.listTab,
        beforeClose.asideTogglePressed,
      ],
    );
    await clickAt(chrome.cdp, session, "#prompt");
    await press(chrome.cdp, session, "k", 4);
    await press(chrome.cdp, session, "Escape");
    state = await facts(chrome.cdp, session);
    check(
      "opened by key over the composer, Escape hands focus back to the composer's own box",
      state.activeElement.id,
      "prompt",
    );
    await clickAt(chrome.cdp, session, "#sidebar-search");
    state = await facts(chrome.cdp, session);
    check(
      "the sidebar's own search button opens the same palette, in `all` mode",
      [state.overlays.stack, state.overlays.palette.mode],
      [["palette"], "all"],
    );
    await press(chrome.cdp, session, "Escape");
    state = await facts(chrome.cdp, session);
    check(
      "and Escape from that door hands focus back to the button that opened it",
      [state.overlays.stack, state.activeElement.id],
      [[], "sidebar-search"],
    );
    const beforeNoop = state.shell.selectedBotId;
    await press(chrome.cdp, session, "Escape");
    state = await facts(chrome.cdp, session);
    check(
      "Escape with nothing open is a keypress nothing answers: no overlay, no scrim, and the page untouched",
      [
        state.overlays.stack,
        state.overlays.scrims,
        state.shell.selectedBotId,
        state.activeElement.id,
      ],
      [[], 0, beforeNoop, "sidebar-search"],
    );

    // ── the picker ──────────────────────────────────────────────────────────
    section("the picker, from the sidebar's own `New chat` control");
    await clickAt(chrome.cdp, session, "#sidebar-new-chat");
    state = await facts(chrome.cdp, session);
    check("the sidebar's `New chat` control opens the picker", state.overlays.stack, ["picker"]);
    check(
      "the search field holds the focus, read from document.activeElement",
      state.activeElement.id,
      "picker-input",
    );
    check(
      "the field says what this app's picker does",
      state.overlays.picker.placeholder,
      PICKER_PLACEHOLDER,
    );
    check(
      "an empty field offers the create row first and then every Bot, and no hint",
      [state.overlays.picker.rows, state.overlays.picker.disabled, state.overlays.picker.hint],
      [[CREATE_LABEL, "Overlay One", "Overlay Two"], [false, false, false], null],
    );
    overlayText.push(state.panelText);
    await capture(chrome.cdp, session, dir, "07-picker-default.png");

    await type(chrome.cdp, session, "O");
    state = await facts(chrome.cdp, session);
    check(
      "one character needs two more, and the field still filters nothing",
      [
        state.overlays.picker.rows.length,
        state.overlays.picker.rows[0] === "Create “O” Bot",
        state.overlays.picker.hint,
      ],
      [3, true, HINT_TWO],
    );
    await type(chrome.cdp, session, "v");
    state = await facts(chrome.cdp, session);
    check(
      "below three characters the field filters nothing and says how many more it needs",
      [state.overlays.picker.rows, state.overlays.picker.hint],
      [["Create “Ov” Bot", "Overlay One", "Overlay Two"], HINT_ONE],
    );
    await capture(chrome.cdp, session, dir, "08-picker-hint.png");

    await type(chrome.cdp, session, "e");
    state = await facts(chrome.cdp, session);
    check(
      "one more character is the threshold, and the hint goes",
      [state.overlays.picker.rows, state.overlays.picker.hint],
      [["Create “Ove” Bot", "Overlay One", "Overlay Two"], null],
    );
    await type(chrome.cdp, session, "rlay two");
    state = await facts(chrome.cdp, session);
    check(
      "three characters or more filter the Bot rows by name, and the create row carries what was typed",
      [state.overlays.picker.rows, state.overlays.picker.hint],
      [["Create “Overlay two” Bot", "Overlay Two"], null],
    );
    await capture(chrome.cdp, session, dir, "09-picker-filtered.png");

    await press(chrome.cdp, session, "Tab");
    check(
      "Tab from the picker's field lands on the first row, inside the panel",
      await evaluate<unknown>(
        chrome.cdp,
        session,
        `(() => {
           const node = document.activeElement;
           return { inside: node?.closest('#picker') !== null, row: node?.dataset?.row ?? null };
         })()`,
      ),
      { inside: true, row: "0" },
    );
    await press(chrome.cdp, session, "Tab");
    check(
      "and the next Tab walks to the last row of the panel",
      await evaluate<unknown>(
        chrome.cdp,
        session,
        `(() => {
           const node = document.activeElement;
           return { inside: node?.closest('#picker') !== null, row: node?.dataset?.row ?? null };
         })()`,
      ),
      { inside: true, row: "1" },
    );
    await press(chrome.cdp, session, "Tab");
    check(
      "Tab off the last row wraps to the field, so focus never leaves the picker",
      await evaluate<unknown>(
        chrome.cdp,
        session,
        `(() => {
           const node = document.activeElement;
           return { inside: node?.closest('#picker') !== null, id: node?.id ?? '', row: node?.dataset?.row ?? null };
         })()`,
      ),
      { inside: true, id: "picker-input", row: null },
    );

    // The creating state: the relay holds this one request back, so the row really waits.
    await press(chrome.cdp, session, "k", 4);
    await press(chrome.cdp, session, "Escape");
    await clickAt(chrome.cdp, session, "#sidebar-new-chat");
    relay.hold("POST /rpc/create_bot", 900);
    await type(chrome.cdp, session, "Overlay Three");
    await press(chrome.cdp, session, "Enter");
    await sleep(250);
    state = await facts(chrome.cdp, session);
    check(
      "with the create in flight the row is disabled and says so, which is a loading state of the row rather than of the page",
      [state.overlays.picker.rows[0], state.overlays.picker.disabled[0], state.overlays.stack],
      [CREATING_LABEL, true, ["picker"]],
    );
    await capture(chrome.cdp, session, dir, "10-picker-creating.png");
    await waitFor(
      chrome.cdp,
      session,
      "the created Bot in the app's own list",
      `window.__shellFacts().bots.length === 3 && window.__overlayFacts().stack.length === 0`,
      20_000,
    );
    state = await facts(chrome.cdp, session);
    check(
      "the create goes through the same arm the sidebar's own control uses: the Bot exists, it is selected, and it holds the one thread every new Bot starts with",
      [
        state.shell.bots.map((bot) => bot.name),
        state.shell.bots[2]?.threadCount,
        state.shell.bots[2]?.selected,
        state.shell.selectedBotId,
        state.shell.bots[2]?.botId,
      ],
      [
        ["Overlay One", "Overlay Two", "Overlay Three"],
        1,
        true,
        state.shell.bots[2]?.botId ?? "",
        state.shell.bots[2]?.botId ?? "",
      ],
    );
    check(
      "the picker closed itself when the create landed, so a person lands in the new Bot's conversation",
      [state.overlays.stack, state.overlays.scrims],
      [[], 0],
    );
    check(
      "and focus went back to the control that opened it",
      state.activeElement.id,
      "sidebar-new-chat",
    );
    await clickAt(chrome.cdp, session, "#sidebar-new-chat");
    await press(chrome.cdp, session, "Escape");
    state = await facts(chrome.cdp, session);
    check(
      "Escape closes the picker and hands focus to `New chat`",
      [state.overlays.stack, state.activeElement.id],
      [[], "sidebar-new-chat"],
    );

    // ── the modal ───────────────────────────────────────────────────────────
    section("the modal, from the pane's own Library row");
    // The picker section left the Bot it made selected, and that Bot has no files yet: the modal's
    // door needs a Bot whose workspace holds something, so the driver selects one that does.
    await clickAt(chrome.cdp, session, `.bot-row[data-bot='${app.bots[0]?.botId}']`);
    await anchorPane(chrome.cdp, session);
    await waitFor(
      chrome.cdp,
      session,
      "the pane's Library tab with this Bot's files",
      `document.querySelectorAll('#aside .aside-file[data-path="notes.md"]').length === 1`,
      20_000,
    );
    state = await facts(chrome.cdp, session);
    check(
      "the pane's Library tab lists the workspace the Library surface reads, which is the modal's source",
      state.aside.files.map((file) => file.name).sort(),
      ["escape.txt", "long.txt", "notes.md"],
    );
    const walked = await tabTo(chrome.cdp, session, "#aside .aside-file[data-path='notes.md']", 60);
    note(`the keyboard walk into the pane: ${walked}`);
    state = await facts(chrome.cdp, session);
    check(
      "the row the modal opens from is focusable and reached by Tab from the pane's own strip",
      [state.activeElement.path, state.activeElement.tag],
      ["notes.md", "button"],
    );
    await press(chrome.cdp, session, "Enter");
    await waitFor(
      chrome.cdp,
      session,
      "the modal with the file in it",
      `window.__overlayFacts().modal.open === true && window.__overlayFacts().modal.text !== null`,
      20_000,
    );
    state = await facts(chrome.cdp, session);
    check(
      "Enter on the row opens the export's wide modal, with the dialog role and one scrim",
      [
        state.overlays.stack,
        state.overlays.modal.role,
        state.overlays.modal.ariaModal,
        state.overlays.modal.wide,
        state.overlays.scrims,
      ],
      [["modal"], "dialog", "true", true, 1],
    );
    check(
      "the title is the file's own name and the line under it carries the path the read answered",
      [state.overlays.modal.title, state.overlays.modal.path],
      ["notes.md", "notes.md"],
    );
    check(
      "the size tag is the byte count the read answered, and the body is the file's own bytes",
      [state.overlays.modal.size, state.overlays.modal.text],
      [`${NOTES.length} B`, NOTES],
    );
    check(
      "a file that reads is not a refusal",
      [state.overlays.modal.refusal, state.overlays.modal.scrolls],
      [null, false],
    );
    check(
      "the close control is the export's own: a labelled icon button drawing the sprite's x, and it holds the focus",
      [state.overlays.modal.closeLabel, state.overlays.modal.closeIcon, state.activeElement.tag],
      ["Close", "#i-x", "button"],
    );
    overlayText.push(state.panelText);
    await capture(chrome.cdp, session, dir, "11-modal-file.png");

    await hover(chrome.cdp, session, "#modal .modal-head .iconbtn");
    const hovered = await evaluate<unknown>(
      chrome.cdp,
      session,
      `(() => {
         const node = document.querySelector('#modal .modal-head .iconbtn');
         return getComputedStyle(node).backgroundColor;
       })()`,
    );
    check(
      "the close control's hover state is the export's own wash, which is a state the pointer reaches",
      hovered !== "rgba(0, 0, 0, 0)",
      true,
    );
    await press(chrome.cdp, session, "Tab");
    state = await facts(chrome.cdp, session);
    check(
      "Tab inside the modal cycles its own focusables, so focus cannot leave it",
      [
        state.activeElement.tag,
        await evaluate<boolean>(
          chrome.cdp,
          session,
          `document.activeElement?.closest('#modal') !== null`,
        ),
      ],
      ["button", true],
    );
    await press(chrome.cdp, session, "Escape");
    state = await facts(chrome.cdp, session);
    check(
      "Escape closes the modal, takes the scrim, and hands focus back to the row that opened it",
      [state.overlays.stack, state.overlays.scrims, state.activeElement.path],
      [[], 0, "notes.md"],
    );

    await press(chrome.cdp, session, "Enter");
    await waitFor(
      chrome.cdp,
      session,
      "the modal again, from the row that still holds the focus",
      `window.__overlayFacts().modal.open === true`,
      20_000,
    );
    const corner = await evaluate<{ x: number; y: number }>(
      chrome.cdp,
      session,
      `({ x: 8, y: Math.round(window.innerHeight - 8) })`,
    );
    await clickPoint(chrome.cdp, session, corner.x, corner.y);
    state = await facts(chrome.cdp, session);
    check(
      "the scrim itself closes the overlay, which is the export's own `ui:close` on it",
      [state.overlays.stack, state.overlays.scrims],
      [[], 0],
    );

    const refusedWalk = await tabTo(
      chrome.cdp,
      session,
      `#aside .aside-file[data-path='${ESCAPE_NAME}']`,
      60,
    );
    note(`the walk to the refused file: ${refusedWalk}`);
    await press(chrome.cdp, session, "Enter");
    await waitFor(
      chrome.cdp,
      session,
      "the modal with the refused read in it",
      `window.__overlayFacts().modal.refusal !== null`,
      20_000,
    );
    state = await facts(chrome.cdp, session);
    check(
      "a path that resolves outside the workspace reads as the named refusal the server put on the wire, and no bytes",
      [state.overlays.modal.refusal, state.overlays.modal.text],
      [`Could not open ${ESCAPE_NAME}: symlink_escape`, null],
    );
    overlayText.push(state.panelText);
    await capture(chrome.cdp, session, dir, "12-modal-refused.png");
    await press(chrome.cdp, session, "Escape");

    await anchorPane(chrome.cdp, session);
    const longWalk = await tabTo(
      chrome.cdp,
      session,
      "#aside .aside-file[data-path='long.txt']",
      60,
    );
    note(`the walk to the long file: ${longWalk}`);
    await press(chrome.cdp, session, "Enter");
    await waitFor(
      chrome.cdp,
      session,
      "the modal with the long file in it",
      `window.__overlayFacts().modal.open === true && window.__overlayFacts().modal.text !== null`,
      20_000,
    );
    state = await facts(chrome.cdp, session);
    check(
      "a file longer than the modal scrolls inside it rather than pushing the page",
      [state.overlays.modal.scrolls, state.overlays.modal.text?.length],
      [true, LONG_LINE.length * LONG_LINES],
    );
    await capture(chrome.cdp, session, dir, "13-modal-scroll.png");
    await press(chrome.cdp, session, "Escape");

    // ── the palette's action is another door to the same room ───────────────
    section("the palette's action is the same door as the button it names");
    const first = boot.shell.bots[0];
    const second = boot.shell.bots[1];
    if (first === undefined || second === undefined) throw new Error("the driver needs both Bots");
    // The button's own door.
    await clickAt(chrome.cdp, session, `.bot-row[data-bot='${first.botId}']`);
    await clickAt(chrome.cdp, session, `.bot-row[data-bot='${second.botId}']`);
    await waitFor(
      chrome.cdp,
      session,
      "the stream following the Bot the row click selected",
      `document.querySelector('#conn').dataset.connection === 'connected'`,
      20_000,
    );
    const viaPointer = await facts(chrome.cdp, session);
    note(
      `the sidebar row for ${second.name}: selectedBotId ${viaPointer.shell.selectedBotId}, threads ${JSON.stringify(viaPointer.shell.threads.map((thread) => thread.title))}, title ${JSON.stringify(viaPointer.shell.title)}`,
    );
    // The palette's own door, from the same starting point.
    await clickAt(chrome.cdp, session, `.bot-row[data-bot='${first.botId}']`);
    await press(chrome.cdp, session, "k", 4);
    await type(chrome.cdp, session, "Overlay Two");
    state = await facts(chrome.cdp, session);
    check("the palette leaves the Bot the query names", state.overlays.palette.rows, [
      "Overlay Two",
    ]);
    await press(chrome.cdp, session, "Enter");
    await waitFor(
      chrome.cdp,
      session,
      "the stream following the Bot the palette selected",
      `document.querySelector('#conn').dataset.connection === 'connected'`,
      20_000,
    );
    state = await facts(chrome.cdp, session);
    check(
      "choosing that row lands the page exactly where its sidebar row lands it",
      [
        state.shell.selectedBotId,
        state.shell.threads.map((thread) => thread.title),
        state.shell.title,
        state.overlays.stack,
      ],
      [
        viaPointer.shell.selectedBotId,
        viaPointer.shell.threads.map((thread) => thread.title),
        viaPointer.shell.title,
        [],
      ],
    );
    check(
      "which is a state the record agrees with: one selected row, and the title carries the Bot and its first thread",
      [
        state.shell.bots.filter((bot) => bot.selected).map((bot) => bot.name),
        state.shell.title.includes(second.name),
        state.shell.title.includes("Second conversation"),
      ],
      [[second.name], true, true],
    );

    await press(chrome.cdp, session, "k", 4);
    await type(chrome.cdp, session, "Third");
    state = await facts(chrome.cdp, session);
    check(
      "a thread row comes from the selected Bot's own thread record",
      state.overlays.palette.rows,
      ["Third conversation"],
    );
    await press(chrome.cdp, session, "Enter");
    state = await facts(chrome.cdp, session);
    check(
      "choosing a thread row moves the selection to that thread, which is the thread list's own door",
      [
        state.shell.threads.find((thread) => thread.selected)?.title,
        state.shell.selectedThreadId,
        state.shell.title.includes("Third conversation"),
      ],
      [
        "Third conversation",
        state.shell.threads.find((thread) => thread.selected)?.threadId ?? "",
        true,
      ],
    );

    await press(chrome.cdp, session, "k", 4);
    await type(chrome.cdp, session, "library");
    await press(chrome.cdp, session, "Enter");
    state = await facts(chrome.cdp, session);
    check(
      "the Library page row lands on the Library tab and loads its listing, which is what that tab does",
      [state.library.tab, state.listTab, state.library.state],
      ["library", "library", "loaded"],
    );
    await press(chrome.cdp, session, "k", 4);
    await type(chrome.cdp, session, "new thread");
    await press(chrome.cdp, session, "Enter");
    await waitFor(
      chrome.cdp,
      session,
      "the new thread in the selected Bot's list",
      `window.__shellFacts().threads.length === 3`,
      20_000,
    );
    state = await facts(chrome.cdp, session);
    check(
      "the `New thread` action makes one, exactly as the sidebar's own button does",
      [state.shell.threads.length, state.shell.threads[2]?.title, state.overlays.stack],
      [3, "New conversation", []],
    );
    await press(chrome.cdp, session, "k", 4);
    await type(chrome.cdp, session, "new bot");
    await press(chrome.cdp, session, "Enter");
    state = await facts(chrome.cdp, session);
    check(
      "the `New Bot` action opens the picker, which is the control the export's sidebar `+` is",
      [state.overlays.stack, state.activeElement.id],
      [["picker"], "picker-input"],
    );
    await press(chrome.cdp, session, "Escape");
    state = await facts(chrome.cdp, session);
    check(
      "and that picker's Escape leaves the pane's own rows on the record they follow",
      [state.aside.tab, state.aside.files.length > 0, state.overlays.stack],
      ["library", true, []],
    );

    // ── the group form opens empty ───────────────────────────────────────────
    section("the group form, from the sidebar's own `New group chat` control");
    await clickAt(chrome.cdp, session, "#sidebar-new-group");
    const groupForm = await evaluate<{
      label: string | null;
      value: string | null;
      placeholder: string | null;
    }>(
      chrome.cdp,
      session,
      `(() => {
         const input = document.querySelector('.modal .input');
         return {
           label: document.querySelector('.modal .field label')?.textContent ?? null,
           value: input === null ? null : input.value,
           placeholder: input === null ? null : input.placeholder,
         };
       })()`,
    );
    note(
      `the group form's field: label ${JSON.stringify(groupForm.label)}, value ${JSON.stringify(groupForm.value)}, placeholder ${JSON.stringify(groupForm.placeholder)}`,
    );
    await capture(chrome.cdp, session, dir, "14-group-empty.png");
    const botsBeforeCreate = await evaluate<number>(
      chrome.cdp,
      session,
      `window.__shellFacts().bots.length`,
    );
    await clickAt(chrome.cdp, session, ".modal input[type=checkbox]");
    await clickAt(chrome.cdp, session, ".modal .btn-primary");
    const groupRefused = await evaluate<{
      value: string | null;
      toast: string | null;
      botCount: number;
    }>(
      chrome.cdp,
      session,
      `(() => ({
         value: document.querySelector('.modal .input')?.value ?? null,
         toast: document.querySelector('.toast')?.textContent ?? null,
         botCount: window.__shellFacts().bots.length,
       }))()`,
    );
    note(
      `Create with a member checked and the field empty: toast ${JSON.stringify(groupRefused.toast)}, field ${JSON.stringify(groupRefused.value)}, Bots ${botsBeforeCreate} -> ${groupRefused.botCount}`,
    );
    await capture(chrome.cdp, session, dir, "15-group-refused.png");
    overlayText.push(
      await evaluate<string>(
        chrome.cdp,
        session,
        `document.querySelector('.modal')?.innerText ?? ''`,
      ),
    );
    await clickAt(chrome.cdp, session, ".modal .btn-ghost");

    // ── the export's chrome, over the document and the bundle ───────────────
    section("where the export's chrome was looked for");
    const documentScan = await evaluate<{ html: string; text: string; hidden: number; od: number }>(
      chrome.cdp,
      session,
      `(() => ({
         html: document.documentElement.outerHTML,
         text: document.body.innerText,
         hidden: document.querySelectorAll('.hidden').length,
         od: document.querySelectorAll('[data-od-id]').length,
       }))()`,
    );
    const bundleResponse = await fetch(`http://127.0.0.1:${app.apiPort}/main.js`);
    const bundle = await bundleResponse.text();
    note(
      `scanned: the whole rendered document (${documentScan.html.length} bytes of outerHTML, ${documentScan.text.length} bytes of innerText), the text collected from the overlays as they were open (${overlayText.join(" ").length} bytes), and the served bundle GET /main.js (${bundle.length} bytes, ${bundleResponse.status})`,
    );
    check(
      "the export's own implementer chrome is absent from the document and from the bundle",
      present(`${documentScan.html}\n${bundle}`, EXPORT_CHROME),
      [],
    );
    check(
      "the export's prototype data is absent from each overlay's own rendered text, from the document and from the bundle",
      present(
        `${overlayText.join("\n")}\n${documentScan.html}\n${documentScan.text}\n${bundle}`,
        EXPORT_DATA,
      ),
      [],
    );
    check(
      "and no node wears the export's `hidden` class, which is how its own panels come and go",
      [documentScan.hidden, documentScan.od],
      [0, 0],
    );
    for (const literal of [...EXPORT_CHROME, ...EXPORT_DATA]) {
      note(
        `${JSON.stringify(literal)}: ${
          documentScan.html.includes(literal)
            ? "FOUND in the document"
            : documentScan.text.includes(literal)
              ? "FOUND in the text"
              : bundle.includes(literal)
                ? "FOUND in the bundle"
                : "absent from all three"
        }`,
      );
    }

    // ── the nine viewports, with each overlay open ──────────────────────────
    section("the nine viewports, with each overlay open");
    const overflowLines: string[] = [];
    const probeAt = async (viewport: Viewport, overlay: string): Promise<void> => {
      const probe = await overflowProbe(chrome.cdp, session);
      const [documentWidth, innerWidth] = probe.document;
      const documentOk = documentWidth <= innerWidth;
      const overflowing = Object.entries(probe.regions).filter(
        (entry): entry is [string, readonly [number, number]] =>
          entry[1] !== null && entry[1][0] > entry[1][1],
      );
      const panel = probe.panel;
      const panelInside =
        panel !== null &&
        panel.left >= 0 &&
        panel.right <= probe.innerWidth &&
        panel.width <= probe.innerWidth;
      const panelScrolls = probe.panelScroll;
      const panelFits = panelScrolls === null ? true : panelScrolls[0] <= panelScrolls[1];
      check(
        `${viewport.name}: ${overlay} overflows neither the document nor its own box`,
        [documentOk, overflowing.length, panelInside, panelFits],
        [true, 0, true, true],
      );
      overflowLines.push(
        `${viewport.name} ${viewport.width}x${viewport.height} ${overlay}: documentElement ${documentWidth} <= ${innerWidth} ${documentOk ? "ok" : "FAIL"}; regions over: ${overflowing.length}; panel ${panel?.left}..${panel?.right} of ${probe.innerWidth} (${panel?.width}px) ${panelInside ? "inside" : "OUTSIDE"}; panel content ${panelScrolls?.[0]} <= ${panelScrolls?.[1]}`,
      );
      if (viewport.name === "mobile-compact" || viewport.name === "wide") {
        await capture(chrome.cdp, session, dir, `20-viewport-${viewport.name}-${overlay}.png`);
      }
    };

    // The modal's own door is the pane's Library row, and the pane stands down below the export's
    // 1120px threshold (U6.3's declared gap), so it is opened once at 1440 and every viewport is
    // measured with it still open.
    await setViewport(chrome.cdp, session, 1440, 900);
    await settle(chrome.cdp, session);
    await clickAt(chrome.cdp, session, "#aside .aside-tab[data-tab='library']");
    await waitFor(
      chrome.cdp,
      session,
      "the pane's Library row before the viewport sweep",
      `document.querySelectorAll('#aside .aside-file[data-path="notes.md"]').length === 1`,
      20_000,
    );
    await clickAt(chrome.cdp, session, "#aside .aside-file[data-path='notes.md']");
    await waitFor(
      chrome.cdp,
      session,
      "the modal before the viewport sweep",
      `window.__overlayFacts().modal.open === true`,
      20_000,
    );
    for (const viewport of viewports) {
      await setViewport(chrome.cdp, session, viewport.width, viewport.height);
      await settle(chrome.cdp, session);
      await probeAt(viewport, "modal");
    }
    await press(chrome.cdp, session, "Escape");
    for (const viewport of viewports) {
      await setViewport(chrome.cdp, session, viewport.width, viewport.height);
      await settle(chrome.cdp, session);
      await press(chrome.cdp, session, "k", 4);
      await probeAt(viewport, "palette");
      await press(chrome.cdp, session, "Escape");
      await press(chrome.cdp, session, "n", 4);
      await probeAt(viewport, "picker");
      await press(chrome.cdp, session, "Escape");
    }
    section("the nine viewports, one line each");
    for (const line of overflowLines) note(line);
    await setViewport(chrome.cdp, session, 1440, 900);
    await settle(chrome.cdp, session);
    await press(chrome.cdp, session, "Escape");

    // ── containment ─────────────────────────────────────────────────────────
    section("containment: what this driver left behind");
    note(
      "the launch's home is removed with its process. This driver starts no run, so it can make no container; the label's own set is what says so below",
    );
    check("the label's own container set is back where it started", runContainers(), baseline);
    const closed = await facts(chrome.cdp, session);
    check(
      "no overlay and no scrim is left on the page",
      [closed.overlays.stack, closed.overlays.scrims],
      [[], 0],
    );
    await capture(chrome.cdp, session, dir, "30-shell-after.png");
  } catch (error) {
    failed += 1;
    log.push(
      "",
      `FAIL the driver stopped early, so every check after this point is unrun: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  } finally {
    chrome.stop();
    relay.stop();
    await app.stop();
    writeReport(dir, sha, log, passed, failed, artifacts, chrome.cdp.version, app.token);
  }

  return failed === 0 ? 0 : 1;
}

/** The artifact's `assert.txt`: every line this driver logged, the count, and the token check last. */
function writeReport(
  dir: string,
  sha: string,
  lines: string[],
  ok: number,
  bad: number,
  shots: string[],
  chromeVersion: string,
  token: string,
): void {
  lines.push("");
  lines.push(
    `chrome ${chromeVersion}; one real launch (\`bun run up --no-open --replay\`) over a home of this driver's own, one relay that held one create back, one page driven entirely by real key events and real pointer moves`,
  );
  lines.push(`RESULT: ${bad === 0 ? "PASS" : "FAIL"} (${ok}/${ok + bad})`);
  const report = `${lines.join("\n")}\n`;
  writeFileSync(join(dir, "assert.txt"), report);
  check("no committed line carries the launch's operator token", [report.includes(token)], [false]);
  note(`artifacts written: ${shots.length}`);
  console.log(
    lines.filter((line) => line.startsWith("FAIL") || line.startsWith("RESULT")).join("\n"),
  );
  console.log(`artifact: packages/verify/artifacts/${feature}/${sha}/assert.txt`);
}

try {
  process.exit(await main());
} catch (error) {
  console.error(`driver crashed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
