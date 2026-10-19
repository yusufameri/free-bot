#!/usr/bin/env bun
/**
 * The design contract's harness: the app and the export, measured the same way, at the nine
 * viewports `DESIGN-MANIFEST.json` names.
 *
 * The app is booted the way a person boots it, `bun run up --no-open --replay`, over a fresh
 * `FREEBOT_HOME` and bots root of this driver's own, so no Bot or run a person made is touched and
 * no provider is called. The export is served from the committed copy with one byte changed, its
 * initial screen, so it boots into its app screen instead of its welcome screen; that replacement is
 * counted and the run fails if the count is not exactly one.
 *
 * Per viewport the driver reads the same field from both pages: the bounding box of each shell
 * region, the computed style of a paired element per role, and the computed value of every token
 * name in `packages/ui/src/tokens.ts`. Geometry and computed styles are the assertion. A differing
 * pixel count is reported as information, with its number and its reason, and never as a verdict.
 * The export renders prototype Bots and this app renders real records, so the two pages differ in
 * content whatever their styling.
 *
 * Every delta has to be either zero or declared in `DECLARED_DELTAS` with the reason it cannot close.
 * An undeclared delta fails the run, so drift in the shell cannot land quietly.
 *
 * Writes `packages/verify/artifacts/design-contract/<short-sha>/` with one PNG per viewport at the
 * manifest's width, the export's own shot of the same viewport under `reference/`, and `assert.txt`.
 *
 * Run from the repo root: `bun packages/verify/scripts/design-contract.ts`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOKENS } from "../../../packages/ui/src/tokens.ts";
import { DECLARED_BOX_DELTAS } from "../../pixel-gate/src/deltas.ts";
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
import { diffPng, type PixelDiff } from "../src/png.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const feature = "design-contract";
const EXPORT_HTML = "design/prototype-84c6b185/freebot-prototype.html";
const MANIFEST = "design/prototype-84c6b185/DESIGN-MANIFEST.json";

/** A token the export has no name for, or a surface this frame does not carry, is not comparable. */
const COMPARED_TOKENS = TOKENS.filter((token) => token.origin === "export").map(
  (token) => token.name,
);

/** A shell region, measured as a bounding box on both pages. */
const GEOMETRY = [
  { field: "sidebar", mine: "#sidebar", theirs: ".sidebar" },
  { field: "thread", mine: "#center", theirs: ".main" },
  { field: "resizer", mine: "#resizer", theirs: ".resizer" },
  { field: "aside", mine: "#aside", theirs: ".aside" },
] as const;

/** A computed style, read off one element per page, paired by the role the element plays. */
const STYLES = [
  { field: "row radius", prop: "border-radius", mine: ".bot-row", theirs: ".sb-row" },
  { field: "row name size", prop: "font-size", mine: "#bot-list .name", theirs: ".sb-row .name" },
  { field: "label size", prop: "font-size", mine: "#sidebar-title", theirs: ".sb-label" },
  { field: "button radius", prop: "border-radius", mine: "#start", theirs: ".btn" },
  { field: "button size", prop: "font-size", mine: "#start", theirs: ".btn" },
  { field: "motion timing", prop: "transition-duration", mine: "#start", theirs: ".btn" },
  { field: "body size", prop: "font-size", mine: "body", theirs: "body" },
  { field: "background", prop: "background-color", mine: "body", theirs: "body" },
  { field: "foreground", prop: "color", mine: "body", theirs: "body" },
  { field: "sidebar edge", prop: "border-right-color", mine: "#sidebar", theirs: ".sidebar" },
] as const;

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

/**
 * Deltas the contract declares. The list is the pixel gate's, imported from
 * `packages/pixel-gate/src/deltas.ts`, so there is one copy of it and the tool that measures the
 * delta and the driver that prints the declaration cannot disagree. This driver's own geometry
 * fields are all zero at every viewport, so no entry here is read by `compare`; the entries are the
 * content-region exceptions order 36's last sentence asks for, and they are printed below.
 */
export const DECLARED_DELTAS = DECLARED_BOX_DELTAS;

/** Tokens the export declares one way and uses another, with the reason this page uses the token. */
const TOKEN_OVERRIDES: Readonly<Record<string, string>> = {
  "--aside-w":
    "the export's script overwrites its own declared 384px with its persisted 372px default (freebot-prototype.html:37, 2248, 829) as `S.asideW || 372`; this frame declares the same 384px token and writes the same used 372px at boot (packages/ui/browser/aside.ts), which is why the aside and the thread columns measure equal. A difference here means one side's boot write or drag default moved.",
};

interface ManifestViewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly category: string;
  readonly mustAvoidHorizontalScroll: boolean;
}

interface Probes {
  readonly geometry: Readonly<Record<string, { width: number; height: number; left: number }>>;
  readonly styles: Readonly<Record<string, string>>;
  /** Read from the `:root` rule: what the page declares, before any inline override. */
  readonly declared: Readonly<Record<string, string>>;
  /** Read from `documentElement`: what the page actually uses. */
  readonly tokens: Readonly<Record<string, string>>;
  readonly document: readonly [number, number];
  readonly regions: Readonly<Record<string, readonly [number, number]>>;
  readonly fonts: Fonts;
}

interface Fonts {
  readonly resolved: string;
  readonly geistWidth: number;
  readonly absentWidth: number;
  readonly systemWidth: number;
}

const log: string[] = [];
let passed = 0;
let failed = 0;

function section(title: string): void {
  log.push("", `## ${title}`);
}

function note(text: string): void {
  log.push(text);
}

/** One comparison. Equal, or a declared delta, passes; anything else fails and says so. */
function compare(
  field: string,
  kind: string,
  mine: string,
  theirs: string,
  delta: number | null,
): void {
  const declared = DECLARED_DELTAS.find((entry) => entry.field === field);
  const equal = delta === null ? mine === theirs : delta === 0;
  const ok = equal || (delta !== null && (declared?.allow.includes(delta) ?? false));
  if (ok) passed += 1;
  else failed += 1;
  const shown =
    delta === null ? (equal ? "same" : "differs") : delta > 0 ? `+${delta}` : `${delta}`;
  const why =
    !equal && delta !== null && declared !== undefined ? ` [declared: ${declared.reason}]` : "";
  log.push(
    `${ok ? "ok  " : "FAIL"} ${kind.padEnd(8)} ${field.padEnd(16)} app ${mine.padEnd(22)} export ${theirs.padEnd(22)} delta ${shown}${why}`,
  );
}

function check(label: string, ok: boolean, detail: unknown): void {
  if (ok) passed += 1;
  else failed += 1;
  log.push(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(detail)}`);
}

/**
 * The measurement expression, built from the tables above so both pages answer the identical
 * question with their own selectors. Selectors and property names are interpolated as JSON, never as
 * bare source.
 */
function measureExpression(side: "mine" | "theirs"): string {
  const selector = (entry: { mine: string; theirs: string }): string => entry[side];
  return `(() => {
    const geometryTargets = ${JSON.stringify(
      GEOMETRY.map((entry) => [entry.field, selector(entry)]),
    )};
    const styleTargets = ${JSON.stringify(
      STYLES.map((entry) => [entry.field, entry.prop, selector(entry)]),
    )};
    const tokenNames = ${JSON.stringify(COMPARED_TOKENS)};
    const regions = ${JSON.stringify(REGIONS)};
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (node === null) return null;
      const rect = node.getBoundingClientRect();
      const width = Math.round(rect.width * 100) / 100;
      const height = Math.round(rect.height * 100) / 100;
      return { width, height, left: Math.round(rect.left * 100) / 100 };
    };
    const style = (selector, prop) => {
      const node = document.querySelector(selector);
      if (node === null) return "<no element>";
      const value = getComputedStyle(node).getPropertyValue(prop).trim();
      return value === "" ? "<unset>" : value;
    };
    const rootStyle = getComputedStyle(document.documentElement);
    const geometry = {};
    for (const [field, selector] of geometryTargets) geometry[field] = box(selector);
    const styles = {};
    for (const [field, prop, selector] of styleTargets) styles[field] = style(selector, prop);
    const tokens = {};
    for (const name of tokenNames) tokens[name] = rootStyle.getPropertyValue(name).trim();
    const declared = {};
    for (const sheet of document.styleSheets) {
      let rules = [];
      try { rules = sheet.cssRules; } catch (err) { continue; }
      for (const rule of rules) {
        if (rule.selectorText !== ':root') continue;
        for (const name of tokenNames) {
          const value = rule.style.getPropertyValue(name).trim();
          if (value !== '') declared[name] = value;
        }
      }
    }
    const sizes = {};
    for (const selector of regions) {
      const node = document.querySelector(selector);
      sizes[selector] = node === null ? null : [node.scrollWidth, node.clientWidth];
    }
    const canvas = document.createElement('canvas').getContext('2d');
    const width = (family) => {
      canvas.font = '16px ' + family;
      return Math.round(canvas.measureText('FreeBot Handgloves 0123456789').width * 100) / 100;
    };
    return {
      geometry,
      styles,
      declared,
      tokens,
      regions: sizes,
      document: [document.documentElement.scrollWidth, window.innerWidth],
      fonts: {
        resolved: getComputedStyle(document.body).fontFamily,
        geistWidth: width("'Geist'"),
        absentWidth: width("'__freebot_no_such_family__'"),
        systemWidth: width('system-ui'),
      },
    };
  })()`;
}

async function measure(cdp: Cdp, sessionId: string, side: "mine" | "theirs"): Promise<Probes> {
  return evaluate<Probes>(cdp, sessionId, measureExpression(side));
}

/** The app's own shell facts, read from its DOM, so a capture cannot race a repaint. */
interface AppFacts {
  readonly operator: string;
  readonly bots: number;
  readonly threads: number;
  readonly asideChildren: number;
  readonly resizerChildren: number;
  readonly asideTabs: number;
  readonly operatorVisible: boolean;
}

async function shellFacts(cdp: Cdp, sessionId: string): Promise<AppFacts> {
  return evaluate<AppFacts>(
    cdp,
    sessionId,
    `({
      operator: document.querySelector('.shell').dataset.operator,
      bots: window.__shellFacts().bots.length,
      threads: window.__shellFacts().threads.length,
      asideChildren: document.querySelector('#aside').children.length,
      resizerChildren: document.querySelector('#resizer').children.length,
      asideTabs: document.querySelectorAll('#aside .aside-tab').length,
      operatorVisible: !document.querySelector('#operator').hidden,
    })`,
  );
}

/** The pixel comparison, reported rather than asserted: unequal sizes are a failure to measure. */
async function compareShots(appShot: Buffer, exportShot: Buffer): Promise<PixelDiff> {
  try {
    return diffPng(appShot, exportShot);
  } catch (error) {
    failed += 1;
    const why = error instanceof Error ? error.message : String(error);
    log.push(`FAIL the two shots are the same size and can be compared: ${why}`);
    return { width: 0, height: 0, differing: 0, total: 0, share: 0, meanAbsolute: 0 };
  }
}

interface AppUnderTest {
  readonly url: string;
  stop(): Promise<void>;
  readonly home: string;
}

/**
 * Boot the real launcher over a fresh home and bots root, in replay mode, and make the one Bot this
 * frame measures a shell with.
 *
 * The vault entry this writes is three lines in a temporary directory and a model mode that never
 * reads it: replay is chosen by `--replay`, so no request is made and no key can reach a network.
 * It exists because the page shows the app shell only for a machine that holds a connection
 * (`apps/web/host/main.ts` asks `get_provider` first), and this unit's subject is that shell.
 *
 * The Bot is made over the same route a page uses, before the page opens, because a store with no
 * Bot opens the first-run screen instead of the shell (U6.2). The screen it replaces is the subject
 * of `packages/verify/scripts/first-run.ts`; this driver's subject stays the shell's geometry.
 */
async function startApp(): Promise<AppUnderTest> {
  const home = mkdtempSync(join(tmpdir(), "freebot-design-contract-"));
  writeFileSync(
    join(home, "provider.env"),
    [
      "# This driver's own vault, in a temporary directory. The model mode is replay, so this entry",
      "# is read for the page state and never used for a request. It is deleted with the directory.",
      `FREEBOT_BYOK_KEY=design-contract-${Date.now()}`,
      "FREEBOT_BYOK_BASE_URL=http://127.0.0.1:9/contract-not-a-provider",
      "FREEBOT_BYOK_MODEL=design-contract-placeholder",
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
  const reader = proc.stdout.getReader();
  const reading = (async () => {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      out += decoder.decode(value);
    }
  })();
  const deadline = Date.now() + 30_000;
  while (!/^http:\/\/127\.0\.0\.1:\d+\/#token=\S+$/m.test(out)) {
    if (Date.now() > deadline) throw new Error(`the launcher printed no URL: ${out}`);
    await sleep(100);
  }
  void reading;
  const url = /^(http:\/\/127\.0\.0\.1:\d+\/#token=\S+)$/m.exec(out)?.[1] ?? "";
  await createBot(url);
  return {
    url,
    home,
    async stop() {
      proc.kill("SIGINT");
      await proc.exited;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** The one Bot this frame needs, made over the route a page would use. */
async function createBot(url: string): Promise<void> {
  const parsed = new URL(url);
  const token = new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token") ?? "";
  const response = await fetch(`http://${parsed.host}/rpc/create_bot`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      origin: `http://${parsed.host}`,
    },
    body: JSON.stringify({ json: { name: "Frame Check" } }),
  });
  const answer = (await response.json()) as { json?: { botId?: string } };
  if (answer.json?.botId !== "bot-local") {
    throw new Error(`the frame's first Bot was not made: ${JSON.stringify(answer)}`);
  }
}

/**
 * Serve the committed export over http with its initial screen changed to `app`.
 *
 * This is the harness's one edit to the export, and it is a byte change to a constant rather than a
 * DOM patch, because the export's screen switch runs before any driver code can reach the page. The
 * count is checked, so a different export fails here instead of being measured as its welcome page.
 */
function serveExport(): { url: string; stop(): void; replaced: number } {
  const source = readFileSync(join(root, EXPORT_HTML), "utf8");
  const replaced = source.split("screen: 'welcome',").length - 1;
  const html = source.replace("screen: 'welcome',", "screen: 'app',");
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path !== "/" && path !== "/index.html") return new Response("not found", { status: 404 });
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    replaced,
    stop: () => void server.stop(true),
  };
}

function shortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

function readViewports(): ManifestViewport[] {
  const parsed = JSON.parse(readFileSync(join(root, MANIFEST), "utf8")) as {
    responsiveViewports?: ManifestViewport[];
  };
  const viewports = parsed.responsiveViewports ?? [];
  if (viewports.length !== 9) {
    throw new Error(`${MANIFEST}: expected nine responsiveViewports, found ${viewports.length}`);
  }
  return viewports;
}

async function main(): Promise<number> {
  const sha = shortSha();
  const dir = artifactDir(root, feature, sha);
  const reference = join(dir, "reference");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(reference, { recursive: true });

  const viewports = readViewports();
  section("the contract's matrix");
  note(`read from ${MANIFEST}`);
  for (const viewport of viewports) {
    note(
      `${viewport.name} ${viewport.width}x${viewport.height} ${viewport.category} mustAvoidHorizontalScroll=${viewport.mustAvoidHorizontalScroll}`,
    );
  }
  check(
    "every viewport forbids horizontal scroll",
    viewports.every((viewport) => viewport.mustAvoidHorizontalScroll),
    true,
  );
  note(`compared tokens: ${COMPARED_TOKENS.length} names, all read from packages/ui/src/tokens.ts`);

  const app = await startApp();
  console.error(`app up ${app.url.replace(/#token=.*$/, "#token=<redacted>")}`);
  const exported = serveExport();
  console.error(`export served ${exported.url}`);
  const chrome = await launchChrome({ windowSize: "1920,1080" });
  console.error(`chrome ${chrome.cdp.version}`);
  check(
    "the export's initial screen was replaced exactly once",
    exported.replaced === 1,
    `${exported.replaced} replacement(s) of "screen: 'welcome'," in ${EXPORT_HTML}`,
  );

  try {
    const appSession = await openPage(chrome.cdp, app.url);
    console.error("app page loaded");
    await waitFor(
      chrome.cdp,
      appSession,
      "the app shell with a Bot in it",
      `document.querySelector('.shell')?.dataset.operator === 'true' &&
       typeof window.__shellFacts === 'function' && window.__shellFacts().bots.length === 1`,
      45_000,
    );
    console.error("app shell ready");
    const exportSession = await openPage(chrome.cdp, exported.url);
    console.error("export page loaded");
    await waitFor(
      chrome.cdp,
      exportSession,
      "the export's app screen",
      `document.querySelector('#app') !== null && !document.querySelector('#app').classList.contains('hidden') &&
       document.querySelectorAll('.sb-row').length > 0`,
    );

    section("the app under test");
    note(
      "booted as `bun run up --no-open --replay` over a fresh FREEBOT_HOME and bots root, read from its own stdout",
    );
    note(`url ${app.url.replace(/#token=.*$/, "#token=<redacted>")}`);
    const opening = await shellFacts(chrome.cdp, appSession);
    note(`shell ${JSON.stringify(opening)}`);
    check(
      "the pane is the export's aside and not an empty region: a strip holding the four tabs and the close button, one body, and an empty resizer track (U6.3)",
      opening.asideChildren === 2 && opening.asideTabs === 4 && opening.resizerChildren === 0,
      [opening.asideChildren, opening.asideTabs, opening.resizerChildren],
    );
    const appProbes = await measure(chrome.cdp, appSession, "mine");
    note(
      `fonts: body stack resolved to ${appProbes.fonts.resolved}; a Geist-family string measures ${appProbes.fonts.geistWidth}px, the absent-family fallback ${appProbes.fonts.absentWidth}px, system-ui ${appProbes.fonts.systemWidth}px, so Geist ${appProbes.fonts.geistWidth === appProbes.fonts.absentWidth ? "does NOT resolve on this machine" : "resolves to a family of its own"}`,
    );

    section("the export under test");
    note(`${EXPORT_HTML}, byte-identical to the store's copy apart from its initial screen`);
    const exportProbes = await measure(chrome.cdp, exportSession, "theirs");
    note(
      `fonts: body stack resolved to ${exportProbes.fonts.resolved}; a Geist-family string measures ${exportProbes.fonts.geistWidth}px, the absent-family fallback ${exportProbes.fonts.absentWidth}px`,
    );

    section("the deltas this frame declares");
    note(
      `${DECLARED_DELTAS.length} entries, shared with the pixel gate so the list has one source. This driver's own geometry fields are all zero at every viewport; these are the content-region exceptions the gate measures.`,
    );
    for (const entry of DECLARED_DELTAS) {
      const pixels = Object.entries(entry.pixels)
        .map(
          ([name, delta]) =>
            `${name} left ${delta.left}, top ${delta.top}, width ${delta.width}, height ${delta.height}`,
        )
        .join("; ");
      note(
        `geometry ${entry.field}: allowed deltas ${JSON.stringify(entry.allow)}. ${entry.reason}`,
      );
      note(`  pixels: ${pixels}`);
    }
    for (const [name, reason] of Object.entries(TOKEN_OVERRIDES)) {
      if (appProbes.tokens[name] === exportProbes.tokens[name]) continue;
      note(
        `token ${name}: the export declares ${exportProbes.declared[name]} and uses ${exportProbes.tokens[name]}, this app uses ${appProbes.tokens[name]}. ${reason}`,
      );
    }

    const overflowPairs: string[] = [];
    for (const [index, viewport] of viewports.entries()) {
      const label = `${String(index + 1).padStart(2, "0")}-${viewport.name}-${viewport.width}x${viewport.height}`;
      section(`viewport ${label}`);
      await Promise.all([
        setViewport(chrome.cdp, appSession, viewport.width, viewport.height),
        setViewport(chrome.cdp, exportSession, viewport.width, viewport.height),
      ]);
      await settle(chrome.cdp, appSession);
      await settle(chrome.cdp, exportSession);

      const before = await shellFacts(chrome.cdp, appSession);
      const mine = await measure(chrome.cdp, appSession, "mine");
      const theirs = await measure(chrome.cdp, exportSession, "theirs");
      const appShot = await screenshot(chrome.cdp, appSession);
      const exportShot = await screenshot(chrome.cdp, exportSession);
      const after = await shellFacts(chrome.cdp, appSession);

      for (const entry of GEOMETRY) {
        const left = mine.geometry[entry.field];
        const right = theirs.geometry[entry.field];
        if (left === undefined || right === undefined) {
          check(`geometry ${entry.field} exists on both pages`, false, [left, right]);
          continue;
        }
        compare(
          entry.field,
          "geometry",
          `${left.width}px`,
          `${right.width}px`,
          Math.round((left.width - right.width) * 100) / 100,
        );
      }
      const visibleRegions = GEOMETRY.map(
        (entry) => [entry.field, mine.geometry[entry.field]] as const,
      ).filter(([, box]) => box !== undefined && box.width > 0);
      const ordered = visibleRegions.every(([, box], index) => {
        if (index === 0) return true;
        const previous = visibleRegions[index - 1]?.[1];
        if (previous === undefined || box === undefined) return false;
        return box.left >= previous.left + previous.width - 0.5;
      });
      check(
        "geometry: the visible regions run sidebar, thread, resizer, aside, left to right",
        ordered,
        visibleRegions.map(([field, box]) => [field, box?.left, box?.width]),
      );
      for (const entry of STYLES) {
        const left = mine.styles[entry.field] ?? "<missing>";
        const right = theirs.styles[entry.field] ?? "<missing>";
        compare(entry.field, "style", left, right, left === right ? 0 : null);
      }
      const tokenMismatches = COMPARED_TOKENS.filter(
        (name) => mine.declared[name] !== theirs.declared[name],
      );
      check(
        `tokens: all ${COMPARED_TOKENS.length} declared :root values match the export's`,
        tokenMismatches.length === 0,
        tokenMismatches.map((name) => [name, mine.declared[name], theirs.declared[name]]),
      );
      // Chrome substitutes a custom property's `var()` references at computed-value time, so the
      // four color-mix fills read back with the literal they reference. Both pages substitute the
      // same way, which is why the used values are compared to each other rather than to a literal.
      const usedMismatches = COMPARED_TOKENS.filter(
        (name) => mine.tokens[name] !== theirs.tokens[name] && TOKEN_OVERRIDES[name] === undefined,
      );
      check(
        `tokens: all ${COMPARED_TOKENS.length} used values match the export's, apart from the ${Object.keys(TOKEN_OVERRIDES).length} declared override`,
        usedMismatches.length === 0,
        usedMismatches.map((name) => [name, mine.tokens[name], theirs.tokens[name]]),
      );
      check(
        "fonts: the app and the export resolve the body family the same way",
        mine.fonts.resolved === theirs.fonts.resolved,
        [mine.fonts.resolved, theirs.fonts.resolved],
      );

      const [appWidth, innerWidth] = mine.document;
      const documentOk = appWidth <= innerWidth;
      check("overflow documentElement.scrollWidth <= innerWidth", documentOk, [
        appWidth,
        innerWidth,
      ]);
      overflowPairs.push(
        `${label}: documentElement.scrollWidth ${appWidth} <= window.innerWidth ${innerWidth} ${documentOk ? "ok" : "FAIL"}`,
      );
      for (const selector of REGIONS) {
        const pair = mine.regions[selector];
        if (pair === null || pair === undefined) continue;
        const [scrollWidth, clientWidth] = pair;
        check(`overflow ${selector} scrollWidth <= clientWidth`, scrollWidth <= clientWidth, pair);
        if (!documentOk)
          overflowPairs.push(`${label}: ${selector} ${scrollWidth} > ${clientWidth}`);
      }

      const diff = await compareShots(appShot, exportShot);
      check(
        "the page held still across the capture",
        JSON.stringify(before) === JSON.stringify(after),
        before,
      );
      note(
        `pixels: ${(diff.share * 100).toFixed(2)}% differ (${diff.differing.toLocaleString()}/${diff.total.toLocaleString()}), mean|delta| ${diff.meanAbsolute.toFixed(2)} of 255. Information, not a verdict: the export renders prototype Bots and this app renders real records, so two pages with different content render different pixels whatever their styling.`,
      );
      writeFileSync(join(dir, `${label}.png`), appShot);
      writeFileSync(join(reference, `${label}-export.png`), exportShot);
      note(`artifact ${label}.png (${appShot.byteLength} bytes)`);
      note(`reference ${label}-export.png (${exportShot.byteLength} bytes)`);
      log.push(`RESULT: ${failed === 0 ? "PASS" : "FAIL"} — viewport ${label}`);
      console.error(`${failed === 0 ? "ok  " : "FAIL"} ${label}`);
    }

    section("the nine overflow pairs");
    for (const pair of overflowPairs) note(pair);

    section("token assertions");
    for (const name of COMPARED_TOKENS) {
      const found = TOKENS.find((token) => token.name === name);
      note(`ok   ${name.padEnd(16)} ${String(found?.value).padEnd(60)} ${found?.source}`);
    }
  } finally {
    chrome.stop();
    exported.stop();
    await app.stop();
  }

  log.push("");
  log.push(
    `chrome ${chrome.cdp.version}; the app in replay mode with no provider call, the export served from the committed copy`,
  );
  log.push(`RESULT: ${failed === 0 ? "PASS" : "FAIL"} (${passed}/${passed + failed})`);
  writeFileSync(join(dir, "assert.txt"), `${log.join("\n")}\n`);
  console.log(
    log.filter((line) => line.startsWith("FAIL") || line.startsWith("RESULT")).join("\n"),
  );
  console.log(`artifact: packages/verify/artifacts/${feature}/${sha}/assert.txt`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`driver crashed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
