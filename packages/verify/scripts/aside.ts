#!/usr/bin/env bun
/**
 * U6.3's driver: the details pane, the notices and the banner, as a person meets them.
 *
 * Two real launches, both spawned the way a person starts the app (`bun run up --no-open`), over
 * `FREEBOT_HOME` and bots roots of this driver's own, so no Bot, run, key or container a person or
 * another driver made is touched.
 *
 * - The first launch pins the committed replay (`--replay`), so its run is deterministic and bills
 *   nothing. Its vault holds this driver's own three-line placeholder, which is why the page shows a
 *   provider record at all: the record's outcome is `untested`, and that is the notice's real signal
 *   in this app. Its page is opened through this driver's own TCP relay, which is what the banner
 *   test severs for real: `relay.sever()` destroys every relayed connection and refuses new ones
 *   until `restore()`, so the page's own socket to `/events` really closes.
 * - The second launch runs the *keyed* path from the same placeholder vault, pointing at
 *   `http://127.0.0.1:9/...`, a port nothing listens on. Nothing is billed and no network leaves the
 *   machine; a run there fails the way a mistyped endpoint fails, which is the second notice's real
 *   signal. That page also carries the no-signal check: its vault and record are removed mid-run and
 *   its failed thread is left behind, so a page with no signal at all must render no stack.
 *
 * The driver reads every judgement from an independent source: the records over `/rpc` (the same
 * routes the page uses), the server's own log over a second `/events` socket of the driver's own
 * (the witness), and the file bytes the workspace really holds. Where it asserts the pane, it asserts
 * the numbers it measured itself, never a class it set.
 *
 * Writes `packages/verify/artifacts/aside/<short-sha>/` with one PNG per state and `assert.txt`.
 *
 * Run from the repo root: `bun packages/verify/scripts/aside.ts`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const feature = "aside";
const MANIFEST = "design/prototype-84c6b185/DESIGN-MANIFEST.json";

/**
 * The pane's tabs. `UX.md:33` names five (`Computer`, `Details`, `Tasks`, `Library`, `Media`); the
 * four here are the ones this app holds a real source for, and `Media`'s delta is recorded in
 * `docs/DESIGN-CONTRACT.md` and in this artifact. The export's `ASIDE_TABS` carries two more,
 * `Memory` and `Routines`, whose subject matter is Phase 3.
 */
const TABS = [
  { id: "computer", label: "Computer" },
  { id: "details", label: "Details" },
  { id: "tasks", label: "Tasks" },
  { id: "library", label: "Library" },
] as const;

/**
 * The export's data strings this app must not carry, from the export's own placeholder bots.
 * `Teach a task` is not here: U6.8 ships it as the Skills page's own action copy, and the workspace
 * driver asserts that page. This list is data, not chrome.
 */
const PLACEHOLDERS = ["pre-run-4f3a", "waiting on approval"];

/**
 * The message types the thread renderer gives a row of their own. Decisions, results, resolved
 * approvals and status frames update the card or the counters they belong to, so the rendered row
 * set is this set and not the wire's full sequence.
 */
const ROW_TYPES = new Set([
  "run.started",
  "turn.started",
  "message.text.delta",
  "tool_call.requested",
  "approval.requested",
  "run.finished",
  "run.failed",
]);

/** The export's own copy and labels, asserted as literals. */
const COLLAPSE_LABEL = "Collapse the pane";
const REOPEN_LABEL = "Show details pane";
const TOGGLE_TEXT = "Details";
const DISMISS_ALL = "Dismiss all";
const DISMISS_LABEL = "Dismiss";
const OPEN_LABEL = "Open";
const UNTESTED_HEADLINE = "The connection did not pass its test";
const BANNER_TEXT =
  "Reconnecting — the stream dropped. The transcript refills from the last event it held.";

/** The pane's own clamps and defaults, from the export's pointer handler. */
const MIN_W = 280;
const MAX_W = 560;
const DEFAULT_W = 372;

/** The export's two thresholds: it drops the aside below 1120px and the sidebar below 860px. */
const ASIDE_THRESHOLD = 1120;
const SIDEBAR_THRESHOLD = 860;

/** Regions whose own content extent is checked against their own box, per viewport. */
const REGIONS = [
  "#center",
  "#sidebar",
  "#aside",
  "#resizer",
  "#thread",
  "#library",
  "#tabs",
  "#operator",
  "header",
  ".meta",
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

// ---------------------------------------------------------------------------
// Logs, sockets and the page's own facts
// ---------------------------------------------------------------------------

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

/** One frame of the thread's log, as the witness socket saw it. */
interface Frame {
  readonly seq: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/**
 * The server's own log, read over a second `/events` socket the driver opens itself.
 *
 * The page cannot be the source of what the log holds: the whole point of the banner test is that the
 * page stops seeing the log for a while. This socket goes straight to the origin, not through the
 * relay, so it keeps reading while the page's own socket is severed.
 */
class Witness {
  readonly frames: Frame[] = [];

  private constructor(private readonly socket: WebSocket) {}

  static async open(url: string): Promise<Witness> {
    const socket = new WebSocket(url);
    const witness = new Witness(socket);
    socket.onmessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as {
        seq?: number;
        type?: string;
        payload?: Record<string, unknown>;
      };
      if (typeof message.seq !== "number" || typeof message.type !== "string") return;
      witness.frames.push({ seq: message.seq, type: message.type, payload: message.payload ?? {} });
    };
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () =>
        reject(new Error(`the witness socket was refused: ${url}`)),
      );
      setTimeout(() => reject(new Error("the witness socket never opened")), 10_000);
    });
    return witness;
  }

  get lastSeq(): number {
    return this.frames.reduce((max, frame) => Math.max(max, frame.seq), 0);
  }

  count(): number {
    return this.frames.length;
  }

  seqs(): number[] {
    return this.frames.map((frame) => frame.seq);
  }

  /** The seqs the page renders as a row, which is this driver's own contract with the renderer. */
  rowSeqs(): number[] {
    return this.frames.flatMap((frame) => (ROW_TYPES.has(frame.type) ? [frame.seq] : []));
  }

  /** The first frame of one kind after `seq`, or null. */
  after(seq: number, type: string): Frame | null {
    return this.frames.find((frame) => frame.seq > seq && frame.type === type) ?? null;
  }

  last(type: string): Frame | null {
    return [...this.frames].reverse().find((frame) => frame.type === type) ?? null;
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket.close();
  }
}

/** The page's facts, every one of them read out of the rendered DOM. */
interface Facts {
  readonly asideRole: string | null;
  readonly tabRoles: string[];
  readonly closeLabel: string | null;
  readonly closeIcon: string | null;
  readonly toggle: { text: string; label: string | null; pressed: string | null };
  readonly aside: {
    tab: string;
    tabs: Array<{ id: string; label: string; selected: boolean; ariaSelected: string }>;
    collapsed: boolean;
    width: number;
    storedWidth: number;
    storedTab: string;
    bodyText: string;
    caps: string[];
    rows: Array<{ label: string; value: string }>;
    commands: string[];
    files: Array<{ name: string; path: string; kind: string }>;
    notes: string[];
  };
  readonly notices: {
    connection: string;
    banner: { shown: boolean; text: string };
    notices: Array<{ id: string; text: string; actions: string[] }>;
    dismissed: string[];
  };
  readonly thread: {
    lastSeq: number;
    done: boolean;
    frameCount: number;
    resume: number | null;
    streamEnd: string | null;
  };
  readonly shell: {
    bots: Array<{ botId: string; name: string; threadCount: number; selected: boolean }>;
    selectedBotId: string | null;
    threads: Array<{ threadId: string; title: string; runs: number; selected: boolean }>;
    selectedThreadId: string | null;
    title: string;
  };
  readonly connection: string;
  readonly collapsed: boolean;
  readonly asideBox: { width: number; height: number; x: number } | null;
  readonly resizerBox: { width: number; height: number; x: number } | null;
  readonly asideDisplay: string;
  readonly gridColumns: string;
  readonly usedWidth: string;
  readonly declaredWidth: string;
  readonly seqs: number[];
  readonly bodyText: string;
  readonly noticeRows: number;
  readonly noticeIds: string[];
  readonly noticesHidden: boolean;
  readonly bannerHidden: boolean;
  readonly approvalCards: Array<{ approvalId: string; decision: string | null }>;
  readonly tabBodyText: string;
}

/** One read of the page: the modules' own facts plus the measurements the driver does itself. */
async function facts(cdp: Cdp, session: string): Promise<Facts> {
  return evaluate<Facts>(
    cdp,
    session,
    `(() => {
      const box = (selector) => {
        const node = document.querySelector(selector);
        if (node === null) return null;
        const rect = node.getBoundingClientRect();
        return {
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
          x: Math.round(rect.left * 100) / 100,
        };
      };
      let declaredWidth = "<none>";
      for (const sheet of document.styleSheets) {
        let rules = [];
        try { rules = sheet.cssRules; } catch (err) { continue; }
        for (const rule of rules) {
          if (rule.selectorText !== ':root') continue;
          const value = rule.style.getPropertyValue('--aside-w').trim();
          if (value !== '') declaredWidth = value;
        }
      }
      const aside = document.querySelector('#aside');
      return {
        asideRole: aside?.querySelector('.aside-tabs')?.getAttribute('role') ?? null,
        tabRoles: [...aside.querySelectorAll('.aside-tab')].map((n) => n.getAttribute('role') ?? ''),
        closeLabel: aside.querySelector('.aside-close')?.getAttribute('aria-label') ?? null,
        closeIcon: aside.querySelector('.aside-close use')?.getAttribute('href') ?? null,
        toggle: (() => {
          const node = document.querySelector('#aside-toggle');
          return node === null ? { text: '', label: null, pressed: null } : {
            text: node.textContent ?? '',
            label: node.getAttribute('aria-label'),
            pressed: node.getAttribute('aria-pressed'),
          };
        })(),
        aside: window.__asideFacts(),
        notices: window.__noticeFacts(),
        thread: (() => {
          const thread = window.__threadFacts();
          return {
            lastSeq: thread.lastSeq,
            done: thread.done,
            frameCount: thread.frameCount,
            resume: thread.resume,
            streamEnd: thread.streamEnd,
          };
        })(),
        shell: window.__shellFacts(),
        connection: document.querySelector('#conn')?.dataset.connection ?? '',
        collapsed: document.body.classList.contains('collapsed'),
        asideBox: box('#aside'),
        resizerBox: box('#resizer'),
        asideDisplay: aside === null ? '<none>' : getComputedStyle(aside).display,
        gridColumns: getComputedStyle(document.querySelector('.shell')).gridTemplateColumns,
        usedWidth: getComputedStyle(document.documentElement).getPropertyValue('--aside-w').trim(),
        declaredWidth,
        seqs: [...document.querySelectorAll('#thread .frame[data-seq]')]
          .map((node) => Number(node.dataset.seq)).sort((a, b) => a - b),
        bodyText: document.body.innerText,
        noticeRows: document.querySelectorAll('#notices .notice[data-notice]').length,
        noticeIds: [...document.querySelectorAll('#notices .notice[data-notice]')].map((n) => n.dataset.notice ?? ''),
        noticesHidden: document.querySelector('#notices').hidden,
        bannerHidden: document.querySelector('#banner').hidden,
        approvalCards: [...document.querySelectorAll('.approval-card[data-approval]')].map((node) => ({
          approvalId: node.dataset.approval ?? '',
          decision: node.dataset.decision ?? null,
        })),
        tabBodyText: document.querySelector('#asideBody')?.textContent ?? '',
      };
    })()`,
  );
}

/** The terms of a boot wait, one by one, so a timeout names its own cause instead of just timing out. */
async function explain(cdp: Cdp, session: string): Promise<string> {
  return await evaluate<string>(
    cdp,
    session,
    `(() => {
      const shell = document.querySelector('.shell');
      const has = (name) => typeof window[name] === 'function';
      const call = (name, fn) => has(name) ? fn() : 'ABSENT';
      return JSON.stringify({
        hooks: ['__asideFacts', '__noticeFacts', '__providerFacts', '__threadFacts', '__shellFacts']
          .map((name) => name + '=' + (has(name) ? 'fn' : 'ABSENT')).join(' '),
        operator: shell?.dataset.operator ?? null,
        page: document.body.dataset.page ?? null,
        bots: call('__shellFacts', () => window.__shellFacts().bots.length),
        selectedThread: call('__shellFacts', () => window.__shellFacts().selectedThreadId),
        conn: document.querySelector('#conn')?.dataset.connection ?? null,
        provider: call('__providerFacts', () => window.__providerFacts().connection),
        errorText: document.querySelector('#error')?.textContent ?? null,
        tabs: document.querySelectorAll('.aside-tab').length,
        href: location.href.replace(/#token=.*/, '#token=<redacted>'),
        title: document.title,
        ready: document.readyState,
        htmlBytes: document.documentElement.outerHTML.length,
        shellPresent: document.querySelector('.shell') !== null,
        errorPresent: document.querySelector('#error') !== null,
      });
    })()`,
  );
}

/** The page's overflow and region numbers at whatever viewport it currently has. */
interface OverflowProbe {
  readonly document: readonly [number, number];
  readonly regions: Record<string, readonly [number, number] | null>;
  readonly aside: { width: number; display: string } | null;
  readonly sidebar: { display: string; width: number } | null;
  /** The header's control, which is present exactly where the pane is. */
  readonly toggle: string | null;
  readonly columns: string;
  readonly used: string;
  readonly innerWidth: number;
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
      const aside = document.querySelector('#aside');
      const sidebar = document.querySelector('#sidebar');
      const toggle = document.querySelector('#aside-toggle');
      return {
        document: [document.documentElement.scrollWidth, window.innerWidth],
        regions: out,
        aside: aside === null ? null : {
          width: Math.round(aside.getBoundingClientRect().width * 100) / 100,
          display: getComputedStyle(aside).display,
        },
        sidebar: sidebar === null ? null : {
          display: getComputedStyle(sidebar).display,
          width: Math.round(sidebar.getBoundingClientRect().width * 100) / 100,
        },
        toggle: toggle === null ? null : getComputedStyle(toggle).display,
        columns: getComputedStyle(document.querySelector('.shell')).gridTemplateColumns,
        used: getComputedStyle(document.documentElement).getPropertyValue('--aside-w').trim(),
        innerWidth: window.innerWidth,
      };
    })()`,
  );
}

// ---------------------------------------------------------------------------
// The page's own input: real clicks and a real drag, dispatched to the element's box
// ---------------------------------------------------------------------------

interface Point {
  readonly x: number;
  readonly y: number;
}

async function centerOf(cdp: Cdp, session: string, selector: string, nth = 0): Promise<Point> {
  const point = await evaluate<Point | null>(
    cdp,
    session,
    `(() => {
      const nodes = document.querySelectorAll(${JSON.stringify(selector)});
      const node = nodes[${nth}];
      if (node === undefined) return null;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`,
  );
  if (point === null) throw new Error(`no box to click for ${selector}[${nth}]`);
  return point;
}

/** One real press and release at the element's own box center. */
async function clickAt(cdp: Cdp, session: string, selector: string, nth = 0): Promise<Point> {
  const point = await centerOf(cdp, session, selector, nth);
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

/**
 * A real pointer drag on the resizer, from its own box to one page x.
 *
 * A person's drag is a press, moves, and a release; the moves are dispatched twice so a coalesced
 * move cannot be the only one the page sees.
 */
async function dragResizer(cdp: Cdp, session: string, toX: number): Promise<Point> {
  const track = await centerOf(cdp, session, "#resizer");
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: track.x, y: track.y },
    session,
  );
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x: track.x, y: track.y, button: "left", buttons: 1, clickCount: 1 },
    session,
  );
  for (let step = 0; step < 2; step++) {
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: toX, y: track.y, button: "left", buttons: 1 },
      session,
    );
    await sleep(30);
  }
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x: toX, y: track.y, button: "left", buttons: 0, clickCount: 1 },
    session,
  );
  await settle(cdp, session);
  return track;
}

/** Type into the composer's box the way a person does, then press the page's own Start. */
async function startRunFromPage(cdp: Cdp, session: string, prompt: string): Promise<void> {
  await waitFor(
    cdp,
    session,
    "the composer's own Start to be enabled, so the click lands on a live control",
    `document.querySelector('#start')?.disabled === false && document.querySelector('#prompt') !== null`,
    30_000,
  );
  await clickAt(cdp, session, "#prompt");
  // Select all before typing: `Input.insertText` inserts at the caret, so a box holding the last
  // prompt would otherwise send that prompt again with this one appended.
  await cdp.send(
    "Input.dispatchKeyEvent",
    {
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: 4,
      commands: ["selectAll"],
    },
    session,
  );
  await cdp.send(
    "Input.dispatchKeyEvent",
    {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: 4,
    },
    session,
  );
  await cdp.send("Input.insertText", { text: prompt }, session);
  await clickAt(cdp, session, "#start");
}

/**
 * Answer every approval a run asks for, by pressing the page's own Allow once, until the run is done.
 *
 * The replayed fixture's bash call stops the run for approval, and a run may ask more than once, so
 * this returns the count it answered rather than assuming one.
 */
async function answerApprovals(cdp: Cdp, session: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let answered = 0;
  let seen = new Set<string>();
  while (Date.now() < deadline) {
    const state = await evaluate<{ done: boolean; pending: string[] }>(
      cdp,
      session,
      `(() => ({
        done: window.__threadFacts().done === true,
        pending: [...document.querySelectorAll('.approval-card[data-approval]')]
          .filter((card) => card.dataset.decision === undefined && card.querySelector('.allow-once') !== null)
          .map((card) => card.dataset.approval ?? ''),
      }))()`,
    );
    if (state.done) {
      if (answered === 0) throw new Error("the run finished without ever asking for approval");
      return answered;
    }
    const next = state.pending.find((id) => !seen.has(id));
    if (next !== undefined) {
      seen = new Set([...seen, next]);
      await clickAt(cdp, session, ".approval-card[data-approval] .allow-once");
      answered += 1;
      await sleep(400);
      continue;
    }
    await sleep(400);
  }
  throw new Error(`the run never finished after ${answered} approval answer(s)`);
}

/**
 * Load the page again, keeping the fragment, viewport and storage: a person's reload.
 *
 * `Page.reload`, not `Page.navigate`: this page's URL already carries the fragment the token lives
 * in, and navigating to the URL it is already on is a same-document navigation, which fires no
 * `Page.loadEventFired` at all.
 */
async function reload(cdp: Cdp, session: string, url: string): Promise<void> {
  const loaded = cdp.once(
    (message) => message.sessionId === session && message.method === "Page.loadEventFired",
    `reload ${redacted(url)}`,
  );
  await cdp.send("Page.reload", {}, session);
  await loaded;
  try {
    await waitFor(
      cdp,
      session,
      "the page's own hooks after a reload",
      `typeof window.__asideFacts === 'function' && typeof window.__noticeFacts === 'function'`,
      30_000,
    );
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    const state = await evaluate<string>(
      cdp,
      session,
      `JSON.stringify({
         href: location.href.replace(/#token=.*/, '#token=<redacted>'),
         ready: document.readyState,
         htmlBytes: document.documentElement.outerHTML.length,
         scripts: [...document.scripts].map((node) => node.src),
         hooks: ['__asideFacts','__noticeFacts','__providerFacts','__threadFacts','__shellFacts']
           .map((name) => name + '=' + (typeof window[name])),
         resources: [...performance.getEntriesByType('resource')].map((entry) => [
           entry.name.replace(/#token=.*/, ''), Math.round(entry.duration), entry.transferSize ?? -1,
         ]),
       })`,
    );
    throw new Error(
      `${why}; after reload: ${state}; console: ${cdp.console.slice(-12).join(" | ")}`,
    );
  }
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
  readonly botId: string;
  readonly threadId: string;
  stderr(): string;
  stop(): Promise<void>;
}

/**
 * One launcher, over a home and a bots root of this driver's own.
 *
 * `vault` writes this driver's own three-line placeholder at mode 600: a fake key, an endpoint, a
 * model name. Nothing in it is a real credential and the file is deleted with the temp directory.
 * `replay` pins the committed transcript, so a run in that launch never reaches a provider at all.
 */
async function startApp(options: {
  readonly label: string;
  readonly vault: boolean;
  readonly replay: boolean;
  readonly botName: string;
}): Promise<App> {
  const home = mkdtempSync(join(tmpdir(), `freebot-aside-${options.label}-`));
  const botsRoot = join(home, "bots");
  if (options.vault) {
    writeFileSync(
      join(home, "provider.env"),
      [
        `# This driver's own placeholder vault, in a temporary directory: ${home}`,
        "# Nothing here is a real credential, and no request to it leaves the loopback interface.",
        `FREEBOT_BYOK_KEY=aside-${options.label}-${Date.now()}`,
        "FREEBOT_BYOK_BASE_URL=http://127.0.0.1:9/aside-not-a-provider",
        `FREEBOT_BYOK_MODEL=aside-${options.label}-placeholder`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  }
  const args = ["bun", "run", "up", "--no-open", ...(options.replay ? ["--replay"] : [])];
  const proc = Bun.spawn(args, {
    cwd: root,
    env: {
      ...process.env,
      FREEBOT_HOME: home,
      FREEBOT_WORKSPACE: botsRoot,
      ...(options.replay ? { FREEBOT_PROVIDER: "replay" } : {}),
    },
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
    if (Date.now() > deadline)
      throw new Error(`the ${options.label} launcher printed no URL: ${out}`);
    await sleep(100);
  }
  const url = /^(http:\/\/127\.0\.0\.1:\d+\/#token=\S+)$/m.exec(out)?.[1] ?? "";
  const parsed = new URL(url);
  const token = new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token") ?? "";
  const app = {
    label: options.label,
    url,
    apiPort: Number(parsed.port),
    token,
    home,
    botsRoot,
    workspace: "",
    botId: "",
    threadId: "",
    stderr: () => err,
    async stop() {
      proc.kill("SIGINT");
      await proc.exited;
      rmSync(home, { recursive: true, force: true });
    },
  };
  const bot = (await rpc(app, "create_bot", { name: options.botName })) as { botId: string };
  if (bot.botId === "")
    throw new Error(`the ${options.label} launcher made no Bot: ${JSON.stringify(bot)}`);
  const thread = (await rpc(app, "create_thread", { botId: bot.botId })) as { threadId: string };
  const workspace = join(botsRoot, bot.botId, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "notes.md"), "# Notes\n\nThe pane reads this Bot's workspace.\n");
  writeFileSync(join(workspace, "report.txt"), "one line\n");
  writeFileSync(join(workspace, "src", "main.ts"), "export const main = 1;\n");
  return { ...app, workspace, botId: bot.botId, threadId: thread.threadId };
}

async function rpc(app: App, procedure: string, input: Record<string, unknown>): Promise<unknown> {
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
// Docker and the host, read-only, label-scoped to the containers this repo's runs make
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

/** Every container the run path can make: this repo's unit label, on the docker provider. */
function runContainers(): string[] {
  return dockerNames(["label=freebot.unit=u1.7", "label=freebot.provider=docker"]);
}

async function settles(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(200);
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// The run of the driver
// ---------------------------------------------------------------------------

const artifacts: string[] = [];

async function capture(cdp: Cdp, session: string, dir: string, name: string): Promise<number> {
  const shot = await screenshot(cdp, session);
  writeFileSync(join(dir, name), shot);
  artifacts.push(name);
  note(`artifact ${name} (${shot.byteLength} bytes)`);
  return shot.byteLength;
}

/** Every literal of the export's placeholder data, scanned over whatever text is handed in. */
function placeholdersIn(text: string): string[] {
  return PLACEHOLDERS.filter((literal) => text.includes(literal));
}

async function main(): Promise<number> {
  const sha = shortSha();
  const dir = artifactDir(root, feature, sha);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const viewports = readViewports();

  section("what this driver runs");
  note(`artifact directory: packages/verify/artifacts/${feature}/${sha}/`);
  note(
    "launch A: `bun run up --no-open --replay` over a fresh FREEBOT_HOME and bots root, its own placeholder vault at mode 600, its page opened through this driver's own TCP relay",
  );
  note(
    "launch B: `bun run up --no-open` over the same kind of fresh home, so the mode is `auto` and the vault's placeholder endpoint is what a run reaches: http://127.0.0.1:9/…, a port nothing listens on. Nothing is billed and no packet leaves the loopback interface.",
  );
  note(
    "the real vault at ~/.freebot/provider.env is never read, printed or copied by this driver; the only vault files it opens are its own, under the temp directories named below",
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

  const app = await startApp({
    label: "replay",
    vault: true,
    replay: true,
    botName: "Aside Check",
  });
  note(`launch A home: ${app.home}`);
  note(`launch A workspace: ${app.workspace}`);
  note(`launch A url, redacted: ${redacted(app.url)}`);
  const relay = openRelay(app.apiPort);
  const pageUrl = `${relay.url}/#token=${app.token}`;
  note(
    `launch A relay: 127.0.0.1:${relay.port} -> 127.0.0.1:${app.apiPort}; the page is opened at 127.0.0.1:${relay.port}, so its own origin is the relay`,
  );

  const chrome = await launchChrome({ windowSize: "1600,1000" });
  note(`chrome ${chrome.cdp.version} over CDP`);
  const witness = await Witness.open(
    `ws://127.0.0.1:${app.apiPort}/events?thread_id=${app.threadId}&last_seen_seq=0&token=${app.token}`,
  );
  note(
    `the witness socket: a second /events client this driver opened on the origin, following thread ${app.threadId} from seq 0, reading the server's log while the page cannot`,
  );

  let session = "";
  try {
    session = await openPage(chrome.cdp, pageUrl);
    try {
      await waitFor(
        chrome.cdp,
        session,
        "the shell with this Bot in it, the pane mounted, and the stream open",
        `typeof window.__asideFacts === 'function' && typeof window.__noticeFacts === 'function' &&
         document.querySelector('.shell')?.dataset.operator === 'true' &&
         window.__shellFacts().bots.length === 1 && window.__shellFacts().selectedThreadId !== null &&
         document.querySelector('#conn').dataset.connection === 'connected' &&
         window.__providerFacts().connection !== null`,
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

    // ── the frame ───────────────────────────────────────────────────────────
    section("the pane's frame");
    const opened = await facts(chrome.cdp, session);
    note(`the shell's own title line: ${JSON.stringify(opened.shell.title)}`);
    check("the pane's strip carries the export's tablist role", opened.asideRole, "tablist");
    check(
      "the pane's tabs are the four with a real source, in UX.md's order",
      opened.aside.tabs.map((tab) => [tab.id, tab.label]),
      TABS.map((tab) => [tab.id, tab.label]),
    );
    check(
      "every tab carries the export's tab role",
      opened.tabRoles,
      TABS.map(() => "tab"),
    );
    check(
      "exactly the default tab is selected, by class and by aria-selected",
      [
        opened.aside.tabs.filter((tab) => tab.selected).map((tab) => tab.id),
        opened.aside.tabs.filter((tab) => tab.ariaSelected === "true").map((tab) => tab.id),
        opened.aside.tab,
      ],
      [["computer"], ["computer"], "computer"],
    );
    check(
      "the export's two extra tabs and the Media delta are absent",
      opened.aside.tabs.filter((tab) => ["media", "memory", "routines"].includes(tab.id)).length,
      0,
    );
    check(
      "the pane's the strip carries the export's close button, labelled `Collapse the pane`, drawing the sprite's x",
      [opened.closeLabel, opened.closeIcon],
      [COLLAPSE_LABEL, "#i-x"],
    );
    check(
      "the header's own control reads Details, pressed, labelled with what it does",
      [opened.toggle.text, opened.toggle.pressed, opened.toggle.label],
      [TOGGLE_TEXT, "true", COLLAPSE_LABEL],
    );
    check(
      "the frame renders the export's default width, in the grid and in the token",
      [opened.aside.width, Math.round(opened.asideBox?.width ?? -1), opened.usedWidth],
      [DEFAULT_W, DEFAULT_W, `${DEFAULT_W}px`],
    );
    check(
      "and the stylesheet still declares the export's own token, so the settlement is real and not a token edit",
      opened.declaredWidth,
      "384px",
    );
    check("the resizer is the export's 5px track", opened.resizerBox?.width, 5);
    note(
      "the 384/372 settlement: the export declares --aside-w: 384px (freebot-prototype.html:37) and overwrites it at boot with S.asideW || 372 (:2248, seeded 372 at :829), so the export renders 372. This app keeps the declared token and renders the same 372, which closes both the aside and the thread deltas: the export's rendered aside is 372px and so is this app's.",
    );
    await capture(chrome.cdp, session, dir, "01-pane-open.png");

    // ── the notices at boot ─────────────────────────────────────────────────
    section("the notices, from the records they come from");
    const boot = await facts(chrome.cdp, session);
    const providerState = (await rpc(app, "get_provider", {})) as {
      connection: { baseUrl: string; model: string; status: string } | null;
    };
    note(`get_provider over /rpc answers: ${JSON.stringify(providerState.connection)}`);
    check(
      "the provider record this launch holds is `untested`, which is the notice's own signal",
      providerState.connection?.status,
      "untested",
    );
    check(
      "the stack holds exactly the provider notice, its text the provider page's own headline, with its Open action",
      [
        boot.notices.notices.map((notice) => notice.id),
        boot.notices.notices.map((notice) => notice.text),
        boot.notices.notices.flatMap((notice) => notice.actions),
      ],
      [["provider-untested"], [UNTESTED_HEADLINE], ["open-provider"]],
    );
    check(
      "the dismiss controls are the export's: an Open button and a Dismiss control, then Dismiss all",
      [
        await evaluate<unknown[]>(
          chrome.cdp,
          session,
          `[...document.querySelectorAll('#notices button')].map((b) => [b.className, b.getAttribute('aria-label'), b.querySelector('use')?.getAttribute('href') ?? null, b.textContent])`,
        ),
      ],
      [
        [
          ["btn btn-secondary btn-xs", null, null, OPEN_LABEL],
          ["iconbtn", DISMISS_LABEL, "#i-x", ""],
          ["btn btn-ghost btn-xs", null, null, DISMISS_ALL],
        ],
      ],
    );
    check(
      "the stack is on the page, and the banner is not: nothing has dropped yet",
      [
        boot.noticeRows,
        boot.noticesHidden,
        boot.notices.banner.shown,
        boot.bannerHidden,
        boot.notices.banner.text,
      ],
      [1, false, false, true, BANNER_TEXT],
    );
    note(
      "the run notice is absent for a run that has not failed: `noticesFrom` raises one only for a thread whose newest run failed, and this launch has no run yet",
    );
    await clickAt(chrome.cdp, session, "#notices .iconbtn");
    check(
      "Dismiss takes the one notice off the page and remembers it",
      [
        (await facts(chrome.cdp, session)).notices.notices,
        (await facts(chrome.cdp, session)).noticeRows,
        (await facts(chrome.cdp, session)).notices.dismissed,
      ],
      [[], 0, ["provider-untested"]],
    );
    await reload(chrome.cdp, session, pageUrl);
    const afterDismiss = await facts(chrome.cdp, session);
    check(
      "and it is still dismissed after a reload, while the signal it came from is still there",
      [
        afterDismiss.notices.notices,
        afterDismiss.noticeRows,
        afterDismiss.notices.dismissed,
        ((await rpc(app, "get_provider", {})) as { connection: { status: string } }).connection
          .status,
      ],
      [[], 0, ["provider-untested"], "untested"],
    );
    await evaluate(
      chrome.cdp,
      session,
      `localStorage.removeItem('freebot.notices.dismissed'), true`,
    );
    await reload(chrome.cdp, session, pageUrl);
    const restoredNotice = await facts(chrome.cdp, session);
    check(
      "a page with no dismissals shows the notice again, so the stack is the signal's and not a fixture",
      [
        restoredNotice.notices.notices.map((notice) => notice.id),
        restoredNotice.noticeRows,
        restoredNotice.notices.dismissed,
      ],
      [["provider-untested"], 1, []],
    );

    // ── the resizer ─────────────────────────────────────────────────────────
    section("the resizer: a real drag, the export's clamps, and a reload");
    await setViewport(chrome.cdp, session, 1440, 900);
    await settle(chrome.cdp, session);
    const innerWidth =
      (await facts(chrome.cdp, session)).thread.lastSeq >= 0
        ? await evaluate<number>(chrome.cdp, session, `window.innerWidth`)
        : 0;
    note(`the viewport this section drags in: ${innerWidth}x900`);
    const midX = innerWidth - 430;
    await dragResizer(chrome.cdp, session, midX);
    const dragged = await facts(chrome.cdp, session);
    check(
      "a drag to one page x sets the width from the right edge",
      [dragged.aside.width, Math.round(dragged.asideBox?.width ?? -1), dragged.usedWidth],
      [430, 430, "430px"],
    );
    await dragResizer(chrome.cdp, session, 0);
    const wide = await facts(chrome.cdp, session);
    check(
      "a drag past the left edge clamps at the export's 560",
      [wide.aside.width, Math.round(wide.asideBox?.width ?? -1)],
      [MAX_W, MAX_W],
    );
    await capture(chrome.cdp, session, dir, "05-resizer-560.png");
    await dragResizer(chrome.cdp, session, innerWidth);
    const narrow = await facts(chrome.cdp, session);
    check(
      "a drag past the right edge clamps at the export's 280",
      [narrow.aside.width, Math.round(narrow.asideBox?.width ?? -1)],
      [MIN_W, MIN_W],
    );
    await capture(chrome.cdp, session, dir, "06-resizer-280.png");
    await dragResizer(chrome.cdp, session, innerWidth - 430);
    check(
      "a third drag lands where the pointer says, not on a clamp",
      (await facts(chrome.cdp, session)).aside.width,
      430,
    );
    await reload(chrome.cdp, session, pageUrl);
    await waitFor(
      chrome.cdp,
      session,
      "the pane's restored width after a reload",
      `window.__asideFacts().width === 430`,
      20_000,
    );
    const afterReload = await facts(chrome.cdp, session);
    check(
      "the width survives a reload, in the grid and in what the page stored",
      [
        afterReload.aside.width,
        Math.round(afterReload.asideBox?.width ?? -1),
        afterReload.aside.storedWidth,
      ],
      [430, 430, 430],
    );

    section("collapse and expand, from the conversation header's own control");
    await clickAt(chrome.cdp, session, "#aside-toggle");
    const collapsed = await facts(chrome.cdp, session);
    check(
      "the header's control collapses the pane: the column goes to zero, the pane stands down, and the control says so",
      [
        collapsed.collapsed,
        collapsed.asideDisplay,
        Math.round(collapsed.asideBox?.width ?? -1),
        collapsed.gridColumns.endsWith("0px 0px") || collapsed.gridColumns.endsWith("0 0"),
        collapsed.toggle.pressed,
        collapsed.toggle.label,
      ],
      [true, "none", 0, true, "false", REOPEN_LABEL],
    );
    await capture(chrome.cdp, session, dir, "07-collapsed.png");
    await reload(chrome.cdp, session, pageUrl);
    const stillCollapsed = await facts(chrome.cdp, session);
    check(
      "and the collapsed state survives a reload",
      [stillCollapsed.collapsed, stillCollapsed.asideDisplay, stillCollapsed.toggle.pressed],
      [true, "none", "false"],
    );
    await clickAt(chrome.cdp, session, "#aside-toggle");
    const expanded = await facts(chrome.cdp, session);
    check(
      "the same control expands it again, back to the width the drag left",
      [
        expanded.collapsed,
        expanded.asideDisplay,
        expanded.aside.width,
        expanded.toggle.pressed,
        expanded.toggle.label,
      ],
      [false, "flex", 430, "true", COLLAPSE_LABEL],
    );
    await reload(chrome.cdp, session, pageUrl);
    const stillExpanded = await facts(chrome.cdp, session);
    check(
      "and the expanded state survives a reload too",
      [stillExpanded.collapsed, stillExpanded.aside.width],
      [false, 430],
    );

    // ── the run, from the page's own composer ───────────────────────────────
    section("a run the page itself starts, and every tab read back against its own source");
    const containersBeforeRun = runContainers();
    note(
      `containers before the first run: ${containersBeforeRun.length}${containersBeforeRun.length === 0 ? "" : ` (${containersBeforeRun.join(", ")})`}`,
    );
    await startRunFromPage(chrome.cdp, session, "check the workspace and report");
    let answeredApprovals = 0;
    try {
      answeredApprovals = await answerApprovals(chrome.cdp, session, 120_000);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      const record = (await rpc(app, "list_threads", { botId: app.botId })) as {
        threads: Array<{ threadId: string; runs: Array<{ runId: string; status: string }> }>;
      };
      throw new Error(
        `${why}; the shell state: ${await explain(chrome.cdp, session)}; the thread record: ${JSON.stringify(
          record.threads.find((thread) => thread.threadId === app.threadId),
        )}; the server's last words: ${app.stderr().slice(-1_200)}`,
      );
    }
    await settle(chrome.cdp, session, 300);
    const afterApproval = await facts(chrome.cdp, session);
    check(
      "the run's approvals were answered from the page's own cards, one card per approval the store holds",
      [
        answeredApprovals,
        afterApproval.approvalCards.map((card) => [card.approvalId, card.decision]),
        witness.frames.filter((frame) => frame.type === "approval.requested").length,
      ],
      [1, [["run-1:call_stub_11", "allow"]], 1],
    );
    note(`containers while the page's run is on screen: ${JSON.stringify(runContainers())}`);
    const runOne = (await rpc(app, "list_threads", { botId: app.botId })) as {
      threads: Array<{
        threadId: string;
        title: string;
        createdAt: number;
        runs: Array<{ runId: string; prompt: string; status: string; startedAt: number }>;
      }>;
    };
    const threadRecord = runOne.threads.find((thread) => thread.threadId === app.threadId);
    const latest = threadRecord?.runs.at(-1) ?? null;
    note(`the thread record's own run: ${JSON.stringify(latest)}`);
    check(
      "the run the page started is the thread's one real run, and it finished",
      latest?.status,
      "done",
    );
    check(
      "the transcript the page rendered holds one row per row-bearing frame the server's log holds, in order and with no gaps",
      [(await facts(chrome.cdp, session)).seqs, witness.rowSeqs()],
      [witness.rowSeqs(), witness.rowSeqs()],
    );
    const commandFrame =
      witness.frames.find((frame) => frame.type === "tool_call.requested") ?? null;
    const resultFrame = witness.frames.find((frame) => frame.type === "tool_call.result") ?? null;
    note(`the wire's own tool call: ${JSON.stringify(commandFrame?.payload.command ?? null)}`);
    note(
      `the wire's own result: ${JSON.stringify(String(resultFrame?.payload.output ?? "").slice(0, 200))}`,
    );

    for (const tab of TABS) {
      await clickAt(
        chrome.cdp,
        session,
        ".aside-tab",
        TABS.findIndex((entry) => entry.id === tab.id),
      );
      const shown = await facts(chrome.cdp, session);
      check(
        `tab ${tab.id}: clicking its own strip button selects it, alone`,
        [
          shown.aside.tab,
          shown.aside.tabs.filter((entry) => entry.selected).map((entry) => entry.id),
        ],
        [tab.id, [tab.id]],
      );
      note(`tab ${tab.id}: body text ${JSON.stringify(shown.tabBodyText.slice(0, 400))}`);
      if (tab.id === "computer") {
        check(
          "tab computer: the run rows are the thread record's own run",
          [
            shown.aside.rows.find((row) => row.label === "Run")?.value,
            shown.aside.rows.find((row) => row.label === "Status")?.value,
            shown.aside.caps,
          ],
          [latest?.runId, "done", ["This run's computer", "The last command it ran"]],
        );
        check(
          "tab computer: the command card is the wire's own command and output, not a placeholder",
          [
            shown.aside.commands,
            await evaluate<string | null>(
              chrome.cdp,
              session,
              `document.querySelector('#asideBody pre.output')?.textContent ?? null`,
            ),
          ],
          [
            [String(commandFrame?.payload.command ?? "")],
            String(resultFrame?.payload.output ?? ""),
          ],
        );
        check(
          "tab computer: the stream rows are the page's own counters, and its seq is the log's last seq",
          [
            shown.aside.rows.find((row) => row.label === "Frames")?.value,
            shown.aside.rows.find((row) => row.label === "Seq")?.value,
            shown.aside.rows.find((row) => row.label === "Stream")?.value,
          ],
          [String(witness.count()), String(witness.lastSeq), "connected"],
        );
      }
      if (tab.id === "details") {
        const bots = (await rpc(app, "list_bots", {})) as {
          bots: Array<{
            name: string;
            role: string;
            purpose: string;
            threadCount: number;
            createdAt: number;
          }>;
        };
        const bot = bots.bots[0];
        const provider = (await rpc(app, "get_provider", {})) as {
          connection: {
            model: string;
            status: string;
            testedAt: number | null;
            baseUrl: string;
          } | null;
        };
        check(
          "tab details: the Bot rows are the Bot record's own fields",
          [
            shown.aside.rows.find((row) => row.label === "Name")?.value,
            shown.aside.rows.find((row) => row.label === "Label")?.value,
            shown.aside.rows.find((row) => row.label === "Purpose")?.value,
            shown.aside.rows.find((row) => row.label === "Threads")?.value,
          ],
          [bot?.name, "not set", "not set", String(bot?.threadCount)],
        );
        check(
          "tab details: the thread rows are the thread record's own fields",
          [
            shown.aside.rows.find((row) => row.label === "Title")?.value,
            shown.aside.rows.find((row) => row.label === "Runs")?.value,
          ],
          [threadRecord?.title, String(threadRecord?.runs.length)],
        );
        check(
          "tab details: the model rows are the provider record's own fields",
          [
            shown.aside.rows.find((row) => row.label === "Model")?.value,
            shown.aside.rows.find((row) => row.label === "Connection")?.value,
            shown.aside.rows.find((row) => row.label === "Tested")?.value,
            shown.aside.rows.find((row) => row.label === "Endpoint")?.value,
          ],
          [
            provider.connection?.model,
            provider.connection?.status,
            "never",
            new URL(String(provider.connection?.baseUrl)).host,
          ],
        );
        check("tab details: its caps are the pane's own sections", shown.aside.caps, [
          "This Bot",
          "This thread",
          "The model",
        ]);
      }
      if (tab.id === "tasks") {
        check(
          "tab tasks: the latest run card is the thread's newest run, with the wire's status word",
          [
            await evaluate<string | null>(
              chrome.cdp,
              session,
              `document.querySelector('#asideBody .tcard')?.dataset.run ?? null`,
            ),
            await evaluate<string | null>(
              chrome.cdp,
              session,
              `document.querySelector('#asideBody .tcard .tag')?.textContent ?? null`,
            ),
            await evaluate<string | null>(
              chrome.cdp,
              session,
              `document.querySelector('#asideBody .tcard .ttl')?.textContent ?? null`,
            ),
          ],
          [latest?.runId, "done", latest?.prompt],
        );
        check(
          "tab tasks: the recent-runs rows are every run the thread records",
          [
            shown.aside.rows
              .filter((row) => row.label.startsWith("run-"))
              .map((row) => row.label.split(" ")[0]),
            shown.aside.rows.filter((row) => row.label.startsWith("run-")).map((row) => row.value),
          ],
          [threadRecord?.runs.map((run) => run.runId), threadRecord?.runs.map((run) => run.status)],
        );
      }
      if (tab.id === "library") {
        const listing = (await rpc(app, "list_files", { botId: app.botId, path: "." })) as {
          entries: Array<{ name: string; path: string; kind: string; size: number }>;
        };
        note(`the workspace route's own listing: ${JSON.stringify(listing.entries)}`);
        check(
          "tab library: the rows are the workspace route's own entries, name, path and kind",
          shown.aside.files.map((row) => [row.name, row.path, row.kind]),
          listing.entries.map((entry) => [entry.name, entry.path, entry.kind]),
        );
        check(
          "tab library: the pinned path row is the /workspace mount, with its tag",
          [
            await evaluate<string | null>(
              chrome.cdp,
              session,
              `document.querySelector('#asideBody .aside-path .mono')?.textContent ?? null`,
            ),
            await evaluate<string | null>(
              chrome.cdp,
              session,
              `document.querySelector('#asideBody .aside-path .tag')?.textContent ?? null`,
            ),
            shown.aside.caps,
          ],
          ["/workspace", "pinned", ["Today"]],
        );
        const notesBytes = statSync(join(app.workspace, "notes.md")).size;
        check(
          "tab library: a row's size is the byte count the file really has",
          await evaluate<string | null>(
            chrome.cdp,
            session,
            `document.querySelector('#asideBody .aside-file[data-name="notes.md"] .aside-file-size')?.textContent ?? null`,
          ),
          `${notesBytes} B`,
        );
      }
      const scan = await evaluate<{ html: string; text: string }>(
        chrome.cdp,
        session,
        `({ html: document.querySelector('#aside').outerHTML, text: document.body.innerText })`,
      );
      const found = placeholdersIn(`${scan.html}\n${scan.text}`);
      check(`no export placeholder string is on the page with tab ${tab.id} shown`, found, []);
    }

    // ── the placeholder scan, and the served bundle ─────────────────────────
    section("where the placeholder strings were looked for");
    const documentScan = await evaluate<{ html: string; text: string }>(
      chrome.cdp,
      session,
      `({ html: document.documentElement.outerHTML, text: document.body.innerText })`,
    );
    const bundleResponse = await fetch(`http://127.0.0.1:${app.apiPort}/main.js`);
    const bundle = await bundleResponse.text();
    note(
      `scanned: the whole rendered document (${documentScan.html.length} bytes of outerHTML, ${documentScan.text.length} bytes of innerText) with each of the four tabs shown in turn, and the served bundle GET /main.js (${bundle.length} bytes, ${bundleResponse.status})`,
    );
    check(
      "no export placeholder string is in the document or in the bundle the server serves",
      placeholdersIn(`${documentScan.html}\n${documentScan.text}\n${bundle}`),
      [],
    );
    for (const literal of PLACEHOLDERS) {
      note(
        `${literal}: ${documentScan.html.includes(literal) ? "found in the document" : documentScan.text.includes(literal) ? "found in the text" : bundle.includes(literal) ? "found in the bundle" : "absent from both"}`,
      );
    }

    // ── the tabs, one frame each ────────────────────────────────────────────
    for (const tab of TABS) {
      await clickAt(
        chrome.cdp,
        session,
        ".aside-tab",
        TABS.findIndex((entry) => entry.id === tab.id),
      );
      await capture(
        chrome.cdp,
        session,
        dir,
        `${String(2 + TABS.findIndex((entry) => entry.id === tab.id)).padStart(2, "0")}-tab-${tab.id}.png`,
      );
    }
    await clickAt(chrome.cdp, session, ".aside-tab", 0);

    // ── the banner, over a stream this driver really cuts ───────────────────
    section("the banner, over a stream really severed");
    note(
      "the severing is the relay's: every relayed connection is destroyed and every new one is ended on sight, so the page's own socket to /events really closes, with no class toggled by hand.",
    );
    note(
      "the run that fills the log while the page is blind is started over the witness socket, with the same `start` control frame the page's own composer sends. A second run from the page could not park: this launch's first allow consumed the grant for the fixture's one destructive call, and the policy refuses a consumed grant rather than asking again (`packages/review/src/policy.ts:143`, `packages/core/src/run-loop.ts:203`), so a second run would run to the end in under a second and leave nothing in flight to miss.",
    );
    const parked = await facts(chrome.cdp, session);
    const cursorBefore = parked.thread.lastSeq;
    note(
      `the page's own cursor is seq ${cursorBefore} and its connection reads ${parked.connection}`,
    );
    const witnessBefore = witness.lastSeq;
    note(`the witness has read the log to seq ${witnessBefore} by then`);
    note(
      "severing the relay now: every relayed connection is destroyed and new ones are ended on sight. The page's socket to /events is one of them.",
    );
    relay.sever();
    await waitFor(
      chrome.cdp,
      session,
      "the page to report the stream it just lost",
      `document.querySelector('#conn').dataset.connection === 'reconnecting'`,
      20_000,
    );
    await waitFor(
      chrome.cdp,
      session,
      "the banner",
      `window.__noticeFacts().banner.shown === true && document.querySelector('#banner').hidden === false`,
      10_000,
    );
    const severed = await facts(chrome.cdp, session);
    check(
      "the banner appears on a stream that really dropped, with the export's sentence and its pulse",
      [
        severed.notices.banner.shown,
        severed.bannerHidden,
        severed.notices.banner.text,
        severed.connection,
        await evaluate<string | null>(
          chrome.cdp,
          session,
          `document.querySelector('#banner .pulse') === null ? null : 'pulse'`,
        ),
      ],
      [true, false, BANNER_TEXT, "reconnecting", "pulse"],
    );
    check(
      "and the page's transcript stopped moving at the cursor it had",
      severed.thread.lastSeq,
      cursorBefore,
    );
    check(
      "and nothing was missed yet: the page's cursor is still the log's own tail, so the banner reports the socket and not a gap in the log",
      [severed.thread.lastSeq, witness.lastSeq],
      [cursorBefore, cursorBefore],
    );
    await capture(chrome.cdp, session, dir, "08-banner-reconnecting.png");
    note(
      "starting the next run over the witness socket, with the same `start` control frame the page's own composer sends, so the log grows while the page cannot see any of it",
    );
    witness.send({
      type: "start",
      prompt: "the run the stream loses",
      botId: app.botId,
      threadId: app.threadId,
    });
    const grew = await settles(
      () =>
        witness.frames.some((frame) => frame.type === "run.finished" && frame.seq > cursorBefore),
      60_000,
    );
    const settled = await settles(
      () =>
        witness.frames.some(
          (frame) =>
            frame.type === "run.status" &&
            frame.payload.status === "done" &&
            frame.seq > cursorBefore,
        ),
      30_000,
    );
    const tail = witness.lastSeq;
    check(
      "the run the witness started really ran to its end while the page was blind",
      [grew, settled, tail > cursorBefore],
      [true, true, true],
    );
    const witnessDuring = await facts(chrome.cdp, session);
    check(
      "the log really grew while the page was blind, and the page really did not see it",
      [tail > witnessBefore, witnessDuring.thread.lastSeq],
      [true, cursorBefore],
    );
    note(
      `the store went from seq ${witnessBefore} to seq ${tail} while the page's own cursor stayed at ${cursorBefore}`,
    );
    note(`restoring the relay; the page's own retry loop is what reconnects`);
    relay.restore();
    await waitFor(
      chrome.cdp,
      session,
      "the page to reconnect and refill from the store",
      `window.__noticeFacts().banner.shown === false && document.querySelector('#conn').dataset.connection === 'connected' && window.__threadFacts().lastSeq === ${tail}`,
      60_000,
    );
    const resumed = await facts(chrome.cdp, session);
    check(
      "the banner clears when the socket answers again, with no class toggled by hand",
      [resumed.notices.banner.shown, resumed.bannerHidden, resumed.connection],
      [false, true, "connected"],
    );
    check(
      "the transcript refilled from the store with no gap: every row the page missed is rendered in wire order, and nothing else was lost",
      [resumed.seqs, resumed.thread.lastSeq, new Set(resumed.seqs).size],
      [witness.rowSeqs(), tail, witness.rowSeqs().length],
    );
    check(
      "and the page resumed from exactly where its own cursor had stopped",
      [
        resumed.thread.resume,
        await evaluate<number | null>(
          chrome.cdp,
          session,
          `Number(document.querySelector('#resume')?.dataset.resumedFrom ?? NaN) || null`,
        ),
      ],
      [cursorBefore, cursorBefore],
    );
    await capture(chrome.cdp, session, dir, "09-resumed.png");
    const afterRunTwo = (await rpc(app, "list_threads", { botId: app.botId })) as {
      threads: Array<{ threadId: string; runs: Array<{ runId: string; status: string }> }>;
    };
    const threadTwo = afterRunTwo.threads.find((thread) => thread.threadId === app.threadId);
    check(
      "the two runs this launch holds are the thread's own records, the page's run and the witness's, both settled",
      threadTwo?.runs.map((run) => [run.runId, run.status]),
      [
        ["run-1", "done"],
        ["run-2", "done"],
      ],
    );
    check(
      "and a run that finished raises no notice, so the stack still holds only the provider's",
      (await facts(chrome.cdp, session)).notices.notices.map((notice) => notice.id),
      ["provider-untested"],
    );

    // ── nine viewports, and both clamps at the three that carry the pane ─────
    section("the nine viewports, with the pane present, and both clamps");
    const overflowLines: string[] = [];
    for (const [index, viewport] of viewports.entries()) {
      await setViewport(chrome.cdp, session, viewport.width, viewport.height);
      await settle(chrome.cdp, session);
      const probe = await overflowProbe(chrome.cdp, session);
      const [documentWidth, innerWidth] = probe.document;
      const documentOk = documentWidth <= innerWidth;
      check(`${viewport.name}: documentElement.scrollWidth <= window.innerWidth`, documentOk, true);
      const overflowing = Object.entries(probe.regions).filter(
        (entry): entry is [string, readonly [number, number]] =>
          entry[1] !== null && entry[1][0] > entry[1][1],
      );
      check(
        `${viewport.name}: no region overflows its own box`,
        overflowing.map(([selector, pair]) => [selector, pair]),
        [],
      );
      const present = viewport.width > ASIDE_THRESHOLD;
      const sidebarStands = viewport.width > SIDEBAR_THRESHOLD;
      check(
        `${viewport.name}: ${present ? `the pane is laid out at the width the token names (${probe.used})` : `the export's own ${ASIDE_THRESHOLD}px threshold stands the pane down, and its ${SIDEBAR_THRESHOLD}px one decides the sidebar (freebot-prototype.html:540-551)`}`,
        present
          ? [
              probe.aside?.display,
              Math.round(probe.aside?.width ?? -1),
              Number.parseFloat(probe.used),
            ]
          : [
              probe.aside?.display,
              probe.sidebar?.display,
              probe.columns.trim().split(/\s+/).length,
            ],
        present
          ? ["flex", Number.parseFloat(probe.used), Number.parseFloat(probe.used)]
          : ["none", sidebarStands ? "flex" : "none", sidebarStands ? 2 : 1],
      );
      check(
        `${viewport.name}: the header's control is there exactly where the pane is`,
        probe.toggle,
        // `flex`, not `inline-flex`: a button in a flex row blockifies (`.head-row` is the parent).
        present ? "flex" : "none",
      );
      overflowLines.push(
        `${String(index + 1).padStart(2, "0")}-${viewport.name} ${viewport.width}x${viewport.height}: documentElement ${documentWidth} <= ${innerWidth} ${documentOk ? "ok" : "FAIL"}; regions over: ${overflowing.length}; pane ${probe.aside?.display} ${probe.aside?.width}px; token ${probe.used}; control ${probe.toggle}`,
      );
      if (viewport.name === "mobile-compact" || viewport.name === "wide") {
        await capture(chrome.cdp, session, dir, `10-viewport-${viewport.name}.png`);
      }
    }
    section("the nine viewports, one line each");
    for (const line of overflowLines) note(line);

    section("both clamps at every viewport that carries the pane");
    for (const viewport of viewports.filter((entry) => entry.width > ASIDE_THRESHOLD)) {
      await setViewport(chrome.cdp, session, viewport.width, viewport.height);
      await settle(chrome.cdp, session);
      for (const [name, target] of [
        ["560", 0],
        ["280", viewport.width],
      ] as const) {
        await dragResizer(chrome.cdp, session, target);
        const probe = await overflowProbe(chrome.cdp, session);
        const dragged = await facts(chrome.cdp, session);
        check(
          `${viewport.name} at ${name}px: the drag landed and the document does not overflow`,
          [dragged.aside.width, probe.document[0] <= probe.document[1]],
          [Number(name), true],
        );
      }
    }
    await setViewport(chrome.cdp, session, 1440, 900);
    await settle(chrome.cdp, session);
    await dragResizer(chrome.cdp, session, innerWidth - 430);

    // ── the second launch: a run that really fails, and a page with no signal
    section("launch B: a run against the placeholder endpoint, and what a failed run raises");
    const failing = await startApp({
      label: "failing",
      vault: true,
      replay: false,
      botName: "Failing Check",
    });
    note(`launch B home: ${failing.home}`);
    note(`launch B url, redacted: ${redacted(failing.url)}`);
    const choiceLine =
      /^(freebot up: model mode .*)$/m.exec(failing.stderr())?.[1] ?? "(no model mode line yet)";
    note(`launch B's own line about the model: ${choiceLine}`);
    const secondSession = await openPage(chrome.cdp, failing.url);
    try {
      await waitFor(
        chrome.cdp,
        secondSession,
        "launch B's shell",
        `typeof window.__asideFacts === 'function' && document.querySelector('.shell')?.dataset.operator === 'true' &&
         window.__providerFacts().connection !== null && document.querySelector('#conn').dataset.connection === 'connected'`,
        45_000,
      );
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(`${why}; the page's own state: ${await explain(chrome.cdp, secondSession)}`);
    }
    await setViewport(chrome.cdp, secondSession, 1440, 900);
    await settle(chrome.cdp, secondSession);
    await startRunFromPage(chrome.cdp, secondSession, "this one cannot reach its model");
    await waitFor(
      chrome.cdp,
      secondSession,
      "the run to fail and the notice stack to raise it",
      `window.__noticeFacts().notices.some((notice) => notice.id === 'run-failed-run-1')`,
      60_000,
    );
    const failingState = await facts(chrome.cdp, secondSession);
    const failingThreads = (await rpc(failing, "list_threads", { botId: failing.botId })) as {
      threads: Array<{ runs: Array<{ runId: string; status: string }> }>;
    };
    note(`launch B's thread record: ${JSON.stringify(failingThreads.threads.at(0)?.runs ?? [])}`);
    check(
      "the failed run is the thread record's own failed run, and the notice names it",
      [
        failingThreads.threads.at(0)?.runs.map((run) => [run.runId, run.status]),
        failingState.notices.notices.map((notice) => [notice.id, notice.text]),
      ],
      [
        [["run-1", "failed"]],
        [
          ["provider-untested", UNTESTED_HEADLINE],
          ["run-failed-run-1", "Run run-1 failed."],
        ],
      ],
    );
    check(
      "the banner is not on that page either: nothing was severed there",
      [failingState.notices.banner.shown, failingState.connection],
      [false, "connected"],
    );
    await clickAt(chrome.cdp, secondSession, ".aside-tab", 0);
    const failedCard = await facts(chrome.cdp, secondSession);
    check(
      "the pane's computer tab reads the failed run off the same record, with the honest no-command note",
      [
        failedCard.aside.rows.find((row) => row.label === "Run")?.value,
        failedCard.aside.rows.find((row) => row.label === "Status")?.value,
        failedCard.aside.notes.includes("No command yet. A run's tool calls land here."),
      ],
      ["run-1", "failed", true],
    );
    await capture(chrome.cdp, secondSession, dir, "12-failed-run-notice.png");
    await clickAt(chrome.cdp, secondSession, "#notices .btn-ghost");
    const dismissedAll = await facts(chrome.cdp, secondSession);
    check(
      "Dismiss all takes both notices off and remembers both ids",
      [dismissedAll.noticeRows, dismissedAll.notices.dismissed.sort(), dismissedAll.noticesHidden],
      [0, ["provider-untested", "run-failed-run-1"], true],
    );
    await reload(chrome.cdp, secondSession, failing.url);
    await waitFor(
      chrome.cdp,
      secondSession,
      "launch B's shell after a reload",
      `window.__shellFacts().selectedThreadId !== null`,
      30_000,
    );
    const stillDismissed = await facts(chrome.cdp, secondSession);
    check(
      "both stay dismissed across a reload although both signals are still there",
      [
        stillDismissed.noticeRows,
        stillDismissed.notices.dismissed.sort(),
        ((await rpc(failing, "get_provider", {})) as { connection: { status: string } }).connection
          .status,
      ],
      [0, ["provider-untested", "run-failed-run-1"], "untested"],
    );

    section("launch B with its signal taken away: a page that has none renders no stack");
    rmSync(join(failing.home, "provider.env"), { force: true });
    rmSync(join(failing.home, "provider.json"), { force: true });
    const quietBot = (await rpc(failing, "create_bot", { name: "No Signal" })) as { botId: string };
    await rpc(failing, "create_thread", { botId: quietBot.botId });
    note(
      `launch B's vault and provider record removed; a second Bot (${quietBot.botId}) with a thread and no runs made over /rpc`,
    );
    await evaluate(
      chrome.cdp,
      secondSession,
      `localStorage.removeItem('freebot.notices.dismissed'), true`,
    );
    await reload(chrome.cdp, secondSession, failing.url);
    await waitFor(
      chrome.cdp,
      secondSession,
      "launch B's page 1, with no connection at all",
      `window.__providerFacts().shown === true && window.__providerFacts().connection === null`,
      30_000,
    );
    note(
      "the page boots into page 1 because the machine holds no connection; its own replay control is the way on, which is the path a person takes",
    );
    await clickAt(chrome.cdp, secondSession, "#provider-replay");
    await waitFor(
      chrome.cdp,
      secondSession,
      "launch B's shell",
      `document.querySelector('.shell')?.dataset.operator === 'true' && window.__shellFacts().bots.length === 2`,
      30_000,
    );
    const quiet = targetQuiet(chrome.cdp, secondSession);
    await quiet;
    await clickAt(chrome.cdp, secondSession, "#bot-list .bot-row", 1);
    await waitFor(
      chrome.cdp,
      secondSession,
      "the Bot with no signal selected",
      `window.__shellFacts().selectedBotId === ${JSON.stringify(quietBot.botId)}`,
      20_000,
    );
    await settle(chrome.cdp, secondSession, 300);
    const noSignal = await facts(chrome.cdp, secondSession);
    check(
      "the thread on screen has no runs, this machine has no connection, and the stack is not on the page",
      [
        noSignal.shell.threads.map((thread) => thread.runs),
        noSignal.notices.notices,
        noSignal.noticeRows,
        noSignal.noticesHidden,
        noSignal.notices.banner.shown,
      ],
      [[0], [], 0, true, false],
    );
    check(
      "the page's own state: the stream is up, so an absent banner is not an absent connection",
      [noSignal.connection, noSignal.notices.dismissed],
      ["connected", []],
    );
    const detailsFree = await clickAt(chrome.cdp, secondSession, ".aside-tab", 1);
    void detailsFree;
    const blank = await facts(chrome.cdp, secondSession);
    check(
      "and the pane says what it really holds: no connection, no run, no command",
      [
        blank.aside.rows.find((row) => row.label === "Connection")?.value,
        blank.aside.rows.find((row) => row.label === "Model")?.value,
      ],
      ["none", "not set"],
    );
    await capture(chrome.cdp, secondSession, dir, "13-no-signal.png");
    await rpc(failing, "list_files", { botId: failing.botId, path: "." });

    // ── containment ─────────────────────────────────────────────────────────
    section("containment: what this driver left behind");
    note(
      `launch A's home removed with its process; its containers are the runs' own and were removed with them`,
    );
    check(
      "the label's container set is back where it started",
      await settles(() => JSON.stringify(runContainers()) === JSON.stringify(baseline)),
      true,
    );
    await capture(chrome.cdp, session, dir, "14-follow-up.png");
  } catch (error) {
    failed += 1;
    log.push(
      "",
      `FAIL the driver stopped early, so every check after this point is unrun: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  } finally {
    witness.close();
    chrome.stop();
    relay.stop();
    await app.stop();
    // A driver that dies still owes its log: the report is written here, on both paths, so a timeout
    // is readable in the artifact without a rerun.
    writeReport(dir, sha, log, passed, failed, artifacts, chrome.cdp.version, app.token);
  }

  return failed === 0 ? 0 : 1;
}

/** The artifact's `assert.txt`: every line this driver logged, the count, and the token check last. */
function writeReport(
  dir: string,
  sha: string,
  log: string[],
  passed: number,
  failed: number,
  artifacts: string[],
  chromeVersion: string,
  token: string,
): void {
  log.push("");
  log.push(
    `chrome ${chromeVersion}; two real launches (\`bun run up --no-open --replay\` and \`bun run up --no-open\`), one relay the driver severed, one witness socket on the server's own log`,
  );
  log.push(`RESULT: ${failed === 0 ? "PASS" : "FAIL"} (${passed}/${passed + failed})`);
  const report = `${log.join("\n")}\n`;
  writeFileSync(join(dir, "assert.txt"), report);
  check(
    "no committed line carries either launch's operator token",
    [report.includes(token)],
    [false],
  );
  note(`artifacts written: ${artifacts.length}`);
  console.log(
    log.filter((line) => line.startsWith("FAIL") || line.startsWith("RESULT")).join("\n"),
  );
  console.log(`artifact: packages/verify/artifacts/${feature}/${sha}/assert.txt`);
}

/** The quiet Bot's own row, clicked only after the shell has painted both Bots. */
async function targetQuiet(cdp: Cdp, session: string): Promise<void> {
  await waitFor(
    cdp,
    session,
    "both Bot rows in the sidebar",
    `document.querySelectorAll('#bot-list .bot-row').length === 2`,
    20_000,
  );
}

try {
  process.exit(await main());
} catch (error) {
  console.error(`driver crashed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
