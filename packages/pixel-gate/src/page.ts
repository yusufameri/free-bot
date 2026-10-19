/**
 * The two pages, the probes that read them, and the third page that diffs them.
 *
 * Everything a run needs from a browser lives here: the app launcher, the export server, the probe
 * expressions, the capture-time freeze, and the in-page diff page. The run orchestration is in
 * `gate.ts`; this module is the browser-facing half of it.
 *
 * The freeze is the one thing worth calling out. Before any capture, both pages get a stylesheet
 * that removes animations and transitions. The export animates at rest: its seeded Bot Atlas is in
 * the `working` state, so `renderSidebar` paints a `.pulse` span whose rule is
 * `animation: pulse 1.5s ease-in-out infinite` (`freebot-prototype.html:110`), and a page that
 * animates cannot be compared to anything twice. Removing the animation leaves the element at its
 * own base style, which is one deterministic frame. The same stylesheet goes on the app, so the two
 * sides are captured under identical rules rather than one frozen and one live.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Cdp,
  evaluate,
  launchChrome,
  screenshot,
  settle,
  setViewport,
  sleep,
  waitFor,
} from "@freebot/verify/cdp";
import { type Comparison, type DiffPage, IN_PAGE_RUNTIME, type Rect } from "./diff.ts";
import type { Box, BoxMap, Viewport } from "./regions.ts";

/**
 * The determinism flags. `--hide-scrollbars` is the shared client's; the other three are here.
 *
 * A screenshot comparison wants the same pixels twice, and Chrome's defaults are tuned for a screen
 * rather than for a camera. Grayscale antialiasing (`--disable-lcd-text`) removes the subpixel order
 * of the monitor, no hinting removes the rasterizer's stem-snapping, and the sRGB profile removes
 * the display's colour transform. All three are set on the single browser instance, so both pages
 * are rendered under them and neither side is favoured.
 */
export const DETERMINISM_FLAGS: readonly string[] = [
  "--disable-lcd-text",
  "--font-render-hinting=none",
  "--force-color-profile=srgb",
];

/**
 * The flags a Linux CI runner needs and a desktop does not. The runner's Chrome runs as a build user
 * with a small `/dev/shm`, so the sandbox and the shared-memory path are the two things that stop it
 * writing `DevToolsActivePort`; `--disable-gpu` keeps a headless VM from trying to open one. None of
 * them affect the rasterized pixels the determinism flags pin.
 */
export const LINUX_FLAGS: readonly string[] = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

/** Every flag this platform's run passes, in the order the report prints them. */
export function launchFlags(platform = process.platform): string[] {
  return [...DETERMINISM_FLAGS, ...(platform === "linux" ? LINUX_FLAGS : [])];
}

/** The stylesheet that stops both pages moving, injected before any capture. */
export const FREEZE_CSS = `*, *::before, *::after {
  animation: none !important;
  transition: none !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}`;

/**
 * The font the export assumes and this repo vendors: one Geist variable face, committed with its
 * OFL licence at `apps/web/host/fonts/`. The app's own page declares the same `@font-face`; this
 * injected copy is what makes the committed export use the same bytes, because the frozen export is
 * never edited and its stylesheet only names the family. Both routes answer the same file, so the
 * two pages resolve one face rather than two fallbacks that happen to measure alike.
 */
export const FONT_FILE = "apps/web/host/fonts/geist-var.woff2";
export const FONT_ROUTE = "/fonts/geist-var.woff2";
export const FONT_CSS = `@font-face {
  font-family: 'Geist';
  src: url('${FONT_ROUTE}') format('woff2');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}`;

export interface AppUnderTest {
  readonly url: string;
  readonly home: string;
  readonly botId: string;
  readonly threadId: string;
  readonly providerMode: string;
  readonly vault: string;
  stderr(): string;
  stop(): Promise<void>;
}

export interface ExportUnderTest {
  readonly url: string;
  readonly file: string;
  readonly replacements: number;
  stop(): void;
}

/** The one URL the launcher prints, as `packages/verify/scripts/design-contract.ts` reads it. */
const URL_LINE = /^(http:\/\/127\.0\.0\.1:\d+\/#token=\S+)$/m;

export function redact(url: string): string {
  return url.replace(/#token=.*$/, "#token=<redacted>");
}

/**
 * Boot the real app the way a person boots it, over a home and a bots root of this run's own.
 *
 * `--replay` pins the committed transcript so nothing is billed and no request leaves the machine,
 * and the vault this writes is three lines of the run's own placeholder at mode 600 in a temporary
 * directory that is deleted on the way out. The real vault at `~/.freebot/provider.env` is never
 * read, printed or copied.
 *
 * The Bot is made over the same route a page uses, before the page opens, because a store with no
 * Bot opens the first-run screen instead of the shell, and this run's subject is the shell. That is
 * the pattern `packages/verify/scripts/design-contract.ts` established.
 */
export async function startApp(root: string, label: string): Promise<AppUnderTest> {
  const home = mkdtempSync(join(tmpdir(), `freebot-pixel-gate-${label}-`));
  const vaultPath = join(home, "provider.env");
  writeFileSync(
    vaultPath,
    [
      `# This run's own placeholder vault, in a temporary directory: ${home}`,
      "# The model mode is replay, so this entry is read for the page state and never used for a",
      "# request. Nothing here is a real credential and the directory is deleted with the run.",
      `FREEBOT_BYOK_KEY=pixel-gate-${label}-${Date.now()}`,
      "FREEBOT_BYOK_BASE_URL=http://127.0.0.1:9/pixel-gate-not-a-provider",
      `FREEBOT_BYOK_MODEL=pixel-gate-${label}-placeholder`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const proc = Bun.spawn(["bun", "run", "up", "--no-open", "--replay"], {
    cwd: root,
    env: {
      ...process.env,
      FREEBOT_HOME: home,
      FREEBOT_WORKSPACE: join(home, "bots"),
      FREEBOT_PROVIDER: "replay",
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
  let url = "";
  let botId = "";
  let threadId = "";
  try {
    const deadline = Date.now() + 30_000;
    while (!URL_LINE.test(out)) {
      if (Date.now() > deadline) throw new Error(`the launcher printed no URL: ${out}\n${err}`);
      await sleep(100);
    }
    url = URL_LINE.exec(out)?.[1] ?? "";
    const parsed = new URL(url);
    const token = new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token") ?? "";
    botId = await rpc(
      `http://${parsed.host}`,
      token,
      "create_bot",
      { name: "Pixel Gate" },
      "botId",
    );
    // A thread as well as a Bot, because the page opens its stream only for a selected thread
    // (`apps/web/host/main.ts:294`: a token with no thread returns before the socket is made) and this
    // run's subject is the armed operator shell rather than a half-connected one.
    threadId = await rpc(`http://${parsed.host}`, token, "create_thread", { botId }, "threadId");
  } catch (error) {
    // A launcher that started but never answered is still this run's process, so it dies with the
    // home it was given rather than outliving the run that spawned it.
    proc.kill("SIGINT");
    await proc.exited;
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  return {
    url,
    home,
    botId,
    threadId,
    providerMode: "replay",
    vault: `${vaultPath} (this run's own placeholder, mode 600, removed with ${home})`,
    stderr: () => err,
    async stop() {
      proc.kill("SIGINT");
      await proc.exited;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** One route the page itself uses, so this run's setup is the page's setup. */
async function rpc(
  origin: string,
  token: string,
  procedure: string,
  input: Record<string, unknown>,
  field: string,
): Promise<string> {
  const response = await fetch(`${origin}/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      origin,
    },
    body: JSON.stringify({ json: input }),
  });
  const answer = (await response.json()) as { json?: Record<string, unknown>; error?: unknown };
  if (answer.error !== undefined) {
    throw new Error(`${procedure} refused: ${JSON.stringify(answer.error)}`);
  }
  const value = answer.json?.[field];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${procedure} returned no ${field}: ${JSON.stringify(answer)}`);
  }
  return value;
}

/**
 * Serve the committed export over http with its initial screen changed to `app`.
 *
 * This is the run's one edit to the export and it is a byte change to a constant rather than a DOM
 * patch, because the export's screen switch runs before any driver code can reach the page. The
 * count is checked, so a different export fails here instead of being measured as its welcome page.
 * Same mechanism as `packages/verify/scripts/design-contract.ts`, on purpose.
 */
export function serveExport(root: string, file: string): ExportUnderTest {
  const source = readFileSync(join(root, file), "utf8");
  const font = readFileSync(join(root, FONT_FILE));
  const licence = readFileSync(join(root, "apps/web/host/fonts/OFL.txt"), "utf8");
  const replacements = source.split("screen: 'welcome',").length - 1;
  const html = source.replace("screen: 'welcome',", "screen: 'app',");
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === FONT_ROUTE) {
        return new Response(font, {
          headers: {
            "content-type": "font/woff2",
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      }
      if (path === "/fonts/OFL.txt") {
        return new Response(licence, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (path !== "/" && path !== "/index.html") {
        return new Response("not found", { status: 404 });
      }
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    file,
    replacements,
    stop: () => void server.stop(true),
  };
}

/** The one Chrome instance this run owns. */
export interface Browser {
  readonly cdp: Cdp;
  readonly version: string;
  readonly flags: readonly string[];
  stop(): void;
}

export async function startBrowser(): Promise<Browser> {
  const flags = launchFlags();
  const chrome = await launchChrome({
    windowSize: "1920,1080",
    extraArgs: flags,
  });
  return {
    cdp: chrome.cdp,
    version: chrome.cdp.version,
    flags,
    stop: () => chrome.stop(),
  };
}

/**
 * The target list of the one browser, as a literal same-instance proof.
 *
 * Every page this run uses has to appear in this one list. The app's URL carries a token, the
 * export's carries an ephemeral port, and the diff page carries a fragment nothing else uses, so the
 * match is exact rather than approximate.
 */
export interface TargetFact {
  readonly url: string;
  readonly targetId: string;
  readonly type: string;
}

export async function targets(cdp: Cdp): Promise<TargetFact[]> {
  const answer = await cdp.send<{ targetInfos?: TargetFact[] }>("Target.getTargets");
  return answer.targetInfos ?? [];
}

/** Stop every page moving, on both sides, before anything is captured. */
export async function freeze(cdp: Cdp, sessionId: string): Promise<number> {
  return evaluate<number>(
    cdp,
    sessionId,
    `(() => {
      const style = document.createElement('style');
      style.id = 'freebot-pixel-gate-freeze';
      style.textContent = ${JSON.stringify(`${FONT_CSS}\n${FREEZE_CSS}`)};
      document.head.appendChild(style);
      let stopped = 0;
      for (const animation of document.getAnimations()) {
        animation.cancel();
        stopped += 1;
      }
      return stopped;
    })()`,
  );
}

/** One page's measurements at whatever viewport it currently has. */
export interface Probe {
  readonly boxes: BoxMap;
  readonly document: readonly [number, number];
  readonly regions: Readonly<Record<string, readonly [number, number] | null>>;
  readonly fonts: {
    readonly stack: string;
    readonly geistWidth: number;
    readonly absentWidth: number;
    readonly systemWidth: number;
  };
  readonly frozen: boolean;
  readonly mediaQueries: { readonly narrow1120: boolean; readonly narrow860: boolean };
}

/**
 * Read one page: the bounding box of every selector, the document's own scroll pair, one overflow
 * pair per region, and the font facts.
 *
 * The selectors are interpolated as JSON, never as bare source. A selector missing from the page
 * answers `null` rather than throwing, because a region the breakpoints stand down is a fact about
 * the viewport and not an error.
 */
export async function probe(
  cdp: Cdp,
  sessionId: string,
  selectors: readonly string[],
  overflowSelectors: readonly string[],
): Promise<Probe> {
  return evaluate<Probe>(
    cdp,
    sessionId,
    `(() => {
      const selectors = ${JSON.stringify(selectors)};
      const overflowSelectors = ${JSON.stringify(overflowSelectors)};
      const box = (selector) => {
        const node = document.querySelector(selector);
        if (node === null) return null;
        const rect = node.getBoundingClientRect();
        return {
          left: Math.round(rect.left * 100) / 100,
          top: Math.round(rect.top * 100) / 100,
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
        };
      };
      const boxes = {};
      for (const selector of selectors) boxes[selector] = box(selector);
      const regions = {};
      for (const selector of overflowSelectors) {
        const node = document.querySelector(selector);
        regions[selector] = node === null ? null : [node.scrollWidth, node.clientWidth];
      }
      const canvas = document.createElement('canvas').getContext('2d');
      const width = (family) => {
        canvas.font = '16px ' + family;
        return Math.round(canvas.measureText('FreeBot Handgloves 0123456789').width * 100) / 100;
      };
      return {
        boxes,
        document: [document.documentElement.scrollWidth, window.innerWidth],
        regions,
        fonts: {
          stack: getComputedStyle(document.body).fontFamily,
          geistWidth: width("'Geist'"),
          absentWidth: width("'__freebot_no_such_family__'"),
          systemWidth: width('system-ui'),
        },
        frozen: document.getElementById('freebot-pixel-gate-freeze') !== null,
        mediaQueries: {
          narrow1120: window.matchMedia('(max-width: 1120px)').matches,
          narrow860: window.matchMedia('(max-width: 860px)').matches,
        },
      };
    })()`,
  );
}

/** The selectors whose own content extent is checked against their own box, per page. */
export const OVERFLOW_SELECTORS: readonly string[] = [
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
];

/** The elements the app's own driver waits on before it calls the shell ready. */
export const APP_READY = `document.querySelector('.shell')?.dataset.operator === 'true' &&
  typeof window.__shellFacts === 'function' &&
  window.__shellFacts().bots.length === 1 &&
  document.querySelector('#conn')?.dataset.connection === 'connected'`;

/** The export's own app screen, rendered and painted. */
export const EXPORT_READY = `document.querySelector('#app') !== null &&
  !document.querySelector('#app').classList.contains('hidden') &&
  document.querySelectorAll('.sb-row').length > 0 &&
  document.querySelector('#transcript') !== null`;

/**
 * The third page: a blank target in the same browser that decodes both shots and diffs them.
 *
 * `about:blank#<fragment>` rather than a navigation to a URL, because a same-document navigation
 * fires no load event and this page has nothing to load. The fragment is what makes the target
 * identifiable in `Target.getTargets`, which is how the same-instance check finds it.
 */
export const DIFF_TARGET_FRAGMENT = "freebot-pixel-gate-diff";

export async function openDiffPage(cdp: Cdp): Promise<string> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
    url: `about:blank#${DIFF_TARGET_FRAGMENT}`,
  });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await cdp.send("Runtime.enable", {}, sessionId);
  await evaluate<boolean>(cdp, sessionId, IN_PAGE_RUNTIME);
  return sessionId;
}

/** How much base64 travels in one `Runtime.evaluate`. Keeps each CDP frame modest. */
const CHUNK = 192 * 1024;

/**
 * Start a viewport's shots on the diff page, discarding the previous viewport's.
 *
 * `put` appends, so a second viewport's bytes concatenated onto a first would be a corrupt PNG
 * rather than a comparison.
 */
export async function beginShots(cdp: Cdp, diffSession: string): Promise<void> {
  await evaluate<boolean>(cdp, diffSession, "window.__pg.begin()");
}

/**
 * Hand one shot to the diff page, in base64 chunks.
 *
 * The image travels in chunks rather than by any file, so nothing on disk is ever the source of a
 * comparison. That is order 36c: no golden images, the comparison is live.
 */
export async function putShot(
  cdp: Cdp,
  diffSession: string,
  name: string,
  buffer: Buffer,
): Promise<void> {
  const base64 = buffer.toString("base64");
  for (let at = 0; at < base64.length; at += CHUNK) {
    await evaluate<number>(
      cdp,
      diffSession,
      `window.__pg.put(${JSON.stringify(name)}, ${JSON.stringify(base64.slice(at, at + CHUNK))})`,
    );
  }
}

/** Compare two named shots inside the named rectangles, and read the statistics back. */
export async function compareShots(
  cdp: Cdp,
  diffSession: string,
  left: string,
  right: string,
  regions: readonly {
    readonly id: string;
    readonly kind: "chrome" | "content";
    readonly rect: Rect;
  }[],
): Promise<Comparison> {
  const answer = await evaluate<Comparison>(
    cdp,
    diffSession,
    `window.__pg.compare(${JSON.stringify(left)}, ${JSON.stringify(right)}, ${JSON.stringify(regions)})`,
  );
  // The page answers with its own reason rather than rejecting: a CDP exception's own text is empty
  // for a rejected promise, which turns a real cause into "Uncaught (in promise)".
  if (answer.error !== null)
    throw new Error(`the diff page refused the comparison: ${answer.error}`);
  return answer;
}

/** One rectangle as a highlighted PNG, decoded outside the page and written by the caller. */
export async function crop(
  cdp: Cdp,
  diffSession: string,
  left: string,
  right: string,
  rect: Rect,
  scale: number,
): Promise<Buffer> {
  const dataUrl = await evaluate<string>(
    cdp,
    diffSession,
    `window.__pg.crop(${JSON.stringify(left)}, ${JSON.stringify(right)}, ${JSON.stringify(rect)}, ${scale})`,
  );
  return Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
}

/** Everything one page needs before it is captured. */
export async function prepare(
  cdp: Cdp,
  sessionId: string,
  viewport: Viewport,
  ready: string,
  describe: string,
): Promise<number> {
  await waitFor(cdp, sessionId, describe, ready, 60_000);
  const stopped = await freeze(cdp, sessionId);
  // The face arrives over the page's own route; wait for it before the first probe, so a capture
  // can never hold the fallback while the real font is still in flight. The wait is bounded: a
  // stalled font request is a page-state finding, not a reason for the gate to hang forever.
  await Promise.race([
    evaluate<boolean>(
      cdp,
      sessionId,
      `(async () => { await document.fonts.ready; return document.fonts.check('16px Geist'); })()`,
    ),
    sleep(5_000),
  ]);
  await setViewport(cdp, sessionId, viewport.width, viewport.height);
  await settle(cdp, sessionId, 250);
  return stopped;
}

/**
 * Dismiss both pages' notice stacks.
 *
 * The app raises its notices from the provider record and the export seeds two; their heights
 * differ for a reason that is not the shell's. The gate measures the shell, so both stacks are
 * cleared before the probe, the same way on both sides. The aside driver is where the notice
 * surface itself is measured.
 */
export async function dismissNotices(cdp: Cdp, sessionId: string): Promise<number> {
  return evaluate<number>(
    cdp,
    sessionId,
    `(() => {
      const all = [...document.querySelectorAll('button')].find(
        (node) => (node.textContent ?? '').trim() === 'Dismiss all',
      );
      if (all === undefined) return 0;
      all.click();
      // The export answers a dismissal with a 2.6s toast. It is transient UI, not the shell, and a
      // capture that catches it is not comparable to one that does not; remove it before the probe.
      for (const node of document.querySelectorAll('.toast')) node.remove();
      return 1;
    })()`,
  );
}

export interface Capture {
  readonly shot: Buffer;
  readonly boxCount: number;
}

/** One page's screenshot, taken after the page is confirmed frozen and settled. */
export async function capture(cdp: Cdp, sessionId: string, viewport: Viewport): Promise<Capture> {
  await setViewport(cdp, sessionId, viewport.width, viewport.height);
  await settle(cdp, sessionId, 250);
  const shot = await screenshot(cdp, sessionId);
  return { shot, boxCount: shot.byteLength };
}

/** A fresh directory for one run's shots, under the artifact directory the caller owns. */
export function shotsDir(dir: string, name: string): string {
  const path = join(dir, "shots", name);
  mkdirSync(path, { recursive: true });
  return path;
}

export type { Box, DiffPage, Viewport };
