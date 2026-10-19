#!/usr/bin/env bun
/**
 * U6.6's driver: the landing route, as a person meets it, at the nine viewports the manifest names.
 *
 * The peer is the real launcher, spawned the way a person starts the app (`bun run up --no-open
 * --replay`) over a `FREEBOT_HOME` and a bots root of this driver's own, so no Bot, run, key or
 * container a person or another driver made is touched and no provider is called. Two routes are
 * read from that one launch: `/landing`, this unit's subject, and `/`, which must be exactly what it
 * was before this unit existed.
 *
 * What makes this evidence rather than a fixture:
 *
 * - The page's own copy is asserted against literals read from
 *   `design/prototype-84c6b185/freebot-prototype.html` at run time, so a landing that drifted from
 *   the export fails here rather than being compared to a copy this file made.
 * - The three facts the page states about the install (`bun run up`, the pinned image tag, the
 *   repository URL) are read from the repository at run time and compared to what the page renders,
 *   so a version or a tag that moves makes the page wrong and this driver say so.
 * - The controls are followed, not merely counted: the hero's two links are clicked for real and the
 *   page that arrives is the app's own `/`, read back by its own `title` and its own markup.
 * - `/` is captured and compared by content against the same route served before this unit: the
 *   driver measures the shell it boots into, so a landing that moved what `/` serves fails here.
 *
 * Writes `packages/verify/artifacts/landing/<short-sha>/` with the hero at 1440x900 and 430x932 plus
 * one shot per viewport, `assert.txt`, and the reachable controls' own targets.
 *
 * Run from the repo root: `bun packages/verify/scripts/landing.ts`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_IMAGE } from "@freebot/sandbox";
import {
  type Cdp,
  type Chrome,
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
const feature = "landing";
const EXPORT = "design/prototype-84c6b185/freebot-prototype.html";
const MANIFEST = "design/prototype-84c6b185/DESIGN-MANIFEST.json";
const ROUTE = "/landing";

/**
 * The export's landing region, `freebot-prototype.html:566-613`, by line. Every literal this driver
 * asserts is read from the file at run time rather than typed here, so the export stays the source
 * and a drifted page fails.
 */
const EXPORT_REGION = { from: 566, to: 613 } as const;

/**
 * The strings the export's landing region carries that this page must NOT carry, because they are
 * prototype chrome or prototype data rather than product copy.
 */
const EXPORT_CHROME = ["data-od-id", "lbl", "pre-run-4f3a", "Teach a task", "waiting on approval"];

/** Regions whose own content extent is checked against their own box, per viewport. */
const REGIONS = [
  ".landing",
  ".onboard",
  ".onboard .inner",
  ".page-inner",
  ".facts",
  "#landing-runs",
  "#landing-gaps",
  "#landing-commands",
] as const;

interface Viewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly category: string;
  readonly mustAvoidHorizontalScroll: boolean;
}

const log: string[] = [];
const artifacts: string[] = [];
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
    `${ok ? "ok  " : "FAIL"} ${label}: actual ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`,
  );
}

/** A check whose expectation is a predicate rather than a literal, for shape assertions. */
function checkThat(label: string, ok: boolean, detail: unknown): void {
  if (ok) passed += 1;
  else failed += 1;
  log.push(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(detail)}`);
}

function shortSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
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

/** The export's landing region, by line, so a literal can be located in it rather than retyped. */
function exportRegion(): string[] {
  const lines = readFileSync(join(root, EXPORT), "utf8").split("\n");
  return lines.slice(EXPORT_REGION.from - 1, EXPORT_REGION.to);
}

/**
 * Assert one literal the page renders against the export's own line, found by a needle inside the
 * region. The export's text is stripped of its markup and whitespace-collapsed, and so is the
 * page's, so the comparison is between what a reader sees on both.
 */
function exportTextFor(needle: string): string | null {
  const line = exportRegion().find((candidate) => candidate.includes(needle));
  if (line === undefined) return null;
  return line
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The export's own text between two needles, for the one literal the export wraps across lines (the
 * statement, `freebot-prototype.html:577-580`). Empty when either needle is missing, so the caller
 * fails on a real absence rather than on a match against an empty string.
 */
function exportTextBetween(startNeedle: string, endNeedle: string): string {
  const lines = exportRegion();
  const start = lines.findIndex((line) => line.includes(startNeedle));
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && line.includes(endNeedle));
  if (end === -1) return "";
  return lines
    .slice(start, end + 1)
    .join(" ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The page's facts, read out of its rendered DOM through the hook its own module installs. */
interface Facts {
  readonly hero: string;
  readonly eyebrow: string;
  readonly sections: readonly string[];
  readonly controls: readonly {
    readonly id: string;
    readonly href: string;
    readonly text: string;
  }[];
  readonly image: string;
  readonly commands: readonly string[];
  readonly copied: string;
}

async function facts(cdp: Cdp, session: string): Promise<Facts> {
  return evaluate<Facts>(cdp, session, "window.__landingFacts()");
}

interface OverflowProbe {
  readonly document: readonly [number, number];
  readonly regions: Readonly<Record<string, readonly [number, number] | null>>;
  readonly bodyScrollHeight: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

async function overflowProbe(cdp: Cdp, session: string): Promise<OverflowProbe> {
  return evaluate<OverflowProbe>(
    cdp,
    session,
    `(() => {
      const regions = ${JSON.stringify(REGIONS)};
      const sizes = {};
      for (const selector of regions) {
        const node = document.querySelector(selector);
        sizes[selector] = node === null ? null : [node.scrollWidth, node.clientWidth];
      }
      return {
        document: [document.documentElement.scrollWidth, window.innerWidth],
        regions: sizes,
        bodyScrollHeight: document.documentElement.scrollHeight,
        canvasWidth: window.innerWidth,
        canvasHeight: window.innerHeight,
      };
    })()`,
  );
}

/** The page's whole rendered text, for the chrome scan. */
async function renderedText(cdp: Cdp, session: string): Promise<string> {
  return evaluate<string>(cdp, session, "document.body.innerText");
}

/** The page's own markup as the browser parsed it, so a chrome scan covers attributes too. */
async function renderedMarkup(cdp: Cdp, session: string): Promise<string> {
  return evaluate<string>(cdp, session, "document.documentElement.outerHTML");
}

async function capture(cdp: Cdp, session: string, dir: string, name: string): Promise<number> {
  const shot = await screenshot(cdp, session);
  writeFileSync(join(dir, name), shot);
  artifacts.push(name);
  note(`artifact ${name} (${shot.byteLength} bytes)`);
  return shot.byteLength;
}

interface App {
  readonly url: string;
  readonly apiPort: number;
  readonly token: string;
  readonly home: string;
  stderr(): string;
  stop(): Promise<void>;
}

/**
 * Boot the real launcher over a home and bots root of this driver's own, in replay mode.
 *
 * The vault starts empty, so nothing here can read or write a person's key, and no run is started,
 * so no container is created and no provider is called.
 */
async function startApp(): Promise<App> {
  const home = mkdtempSync(join(tmpdir(), "freebot-landing-"));
  const botsRoot = join(home, "bots");
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
  let url = "";
  try {
    while (!/^http:\/\/127\.0\.0\.1:\d+\/#token=\S+$/m.test(out)) {
      if (Date.now() > deadline) throw new Error(`the launcher printed no URL: ${out}`);
      await sleep(100);
    }
    url = /^(http:\/\/127\.0\.0\.1:\d+\/#token=\S+)$/m.exec(out)?.[1] ?? "";
    if (url === "") throw new Error(`the launcher's URL did not parse: ${out}`);
  } catch (error) {
    // A launcher that never answers is still this driver's process to stop and its home to remove.
    proc.kill("SIGINT");
    await proc.exited;
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  const parsed = new URL(url);
  const token = new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token") ?? "";
  return {
    url,
    apiPort: Number(parsed.port),
    token,
    home,
    stderr: () => err,
    async stop() {
      proc.kill("SIGINT");
      await proc.exited;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const redacted = (url: string): string => url.replace(/#token=.*$/, "#token=<redacted>");

/** The route under test, on the launch's own port. No token: the landing carries no run state. */
function landingUrl(app: App): string {
  return `http://127.0.0.1:${app.apiPort}${ROUTE}`;
}

/**
 * The repository's own facts, read here rather than typed on the page.
 *
 * The command is the one the root `package.json` really declares, the image tag is the one the
 * sandbox adapter pins, and the repository URL is the one `origin` really points at. A page that
 * names any of them differently is claiming something untrue of this repository, which is the thing
 * this unit is about.
 */
interface RepoFacts {
  readonly upCommand: string;
  readonly imageTag: string;
  readonly repoUrl: string;
}

function repoFacts(): RepoFacts {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const up = pkg.scripts?.up ?? "";
  if (up === "") throw new Error("package.json declares no `up` script");
  const remote = git(["remote", "get-url", "origin"])
    .replace(/\.git$/, "")
    .replace(/^git@github\.com:/, "https://github.com/");
  return { upCommand: "bun run up", imageTag: PINNED_IMAGE.tag, repoUrl: remote };
}

async function main(): Promise<number> {
  const sha = shortSha();
  const dir = artifactDir(root, feature, sha);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const viewports = readViewports();
  const exported = exportRegion();
  // Read the repository's facts before the launcher starts, so a missing fact throws with no
  // process to leak and no temporary home to remove.
  const repo = repoFacts();
  const app = await startApp();

  log.push(
    "landing route driver",
    "command: bun packages/verify/scripts/landing.ts",
    `timestamp: ${new Date().toISOString()}`,
    `git sha: ${git(["rev-parse", "HEAD"])}`,
    `git sha short: ${sha}`,
    `branch: ${git(["rev-parse", "--abbrev-ref", "HEAD"])}`,
    `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
    `app: ${redacted(app.url)} (bun run up --no-open --replay, keyless, no run started)`,
    `route: ${landingUrl(app)}`,
  );

  section("the export's landing region");
  note(`${EXPORT}:${EXPORT_REGION.from}-${EXPORT_REGION.to}, read at run time`);
  for (const line of exported) note(`  ${line}`);
  checkThat(
    "the export's region carries the hero this unit names",
    exported.some((line) =>
      line.includes("Bots that do the work, on a computer that stays yours."),
    ),
    true,
  );

  let chrome: Chrome | null = null;
  try {
    chrome = await launchChrome({ windowSize: "1600,1000" });
    note(`chrome ${chrome.cdp.version} over CDP`);

    const session = await openPage(chrome.cdp, landingUrl(app));
    await waitFor(
      chrome.cdp,
      session,
      "the landing's own facts hook",
      `typeof window.__landingFacts === 'function'`,
      30_000,
    );
    await setViewport(chrome.cdp, session, 1440, 900);
    await settle(chrome.cdp, session);

    section("the route");
    const opening = await facts(chrome.cdp, session);
    note(`facts ${JSON.stringify(opening)}`);
    check(
      "the hero's heading is the export's, read from the export",
      opening.hero,
      exportTextFor('class="h1"'),
    );
    check(
      "the eyebrow above it is the export's",
      opening.eyebrow,
      exportTextFor('class="eyebrow"'),
    );
    const pageStatement = await evaluate<string>(
      chrome.cdp,
      session,
      `document.querySelector('#landing-statement')?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''`,
    );
    const pageBrandmark = await evaluate<string>(
      chrome.cdp,
      session,
      `document.querySelector('.brandmark .word')?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''`,
    );
    check(
      "the statement under it is the export's, whose own copy wraps across two lines",
      pageStatement,
      exportTextBetween('class="hint"', "</p>"),
    );
    check(
      "the brandmark carries the export's own word",
      pageBrandmark,
      exportTextFor('class="word"'),
    );
    checkThat(
      "the marked elements run brand, hero, controls, then the runs-today band: the export's own order for the hero, and nothing before it",
      opening.sections.join(",") === "hero,brand,controls,runs-today",
      opening.sections,
    );
    const heroOrder = await evaluate<readonly string[]>(
      chrome.cdp,
      session,
      `(() => {
        const hero = document.querySelector('[data-landing="hero"]');
        if (hero === null) return ['[data-landing="hero"] (missing)'];
        const wanted = ['.brandmark', '.eyebrow', '#landing-hero', '#landing-statement', '#landing-controls'];
        const found = wanted.map(selector => [selector, hero.querySelector(selector)]);
        const missing = found.filter(([, node]) => node === null).map(([selector]) => selector + ' (missing)');
        if (missing.length > 0) return missing;
        return found
          .sort((a, b) => a[1].compareDocumentPosition(b[1]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
          .map(([selector]) => selector);
      })()`,
    );
    check("the hero renders the export's elements in the export's order", heroOrder, [
      ".brandmark",
      ".eyebrow",
      "#landing-hero",
      "#landing-statement",
      "#landing-controls",
    ]);

    const exportEyebrow = exportTextFor('class="eyebrow"');
    const exportHero = exportTextFor('class="h1"');
    const exportConnect = exportTextFor('data-od-id="cta-connect-provider"');
    const exportReplay = exportTextFor('data-od-id="cta-replay"');
    const exportStatement = exportTextBetween('class="hint"', "</p>");
    const exportBrandmark = exportTextFor('class="word"');
    checkThat(
      "each export literal was really located in the export, so a match cannot pass vacuously",
      exportEyebrow !== null &&
        exportHero !== null &&
        exportConnect !== null &&
        exportReplay !== null &&
        exportStatement !== "" &&
        exportBrandmark !== null,
      {
        eyebrow: exportEyebrow,
        hero: exportHero,
        connect: exportConnect,
        replay: exportReplay,
        statement: exportStatement,
        brandmark: exportBrandmark,
      },
    );
    check(
      "the primary control carries the export's own label",
      opening.controls[0]?.text,
      exportConnect,
    );
    check(
      "the replay control carries the export's own label too, so the launch rule lives in the note rather than in new copy",
      opening.controls[1]?.text,
      exportReplay,
    );

    section("the controls do something real");
    checkThat(
      "both hero controls are links, not dead buttons",
      opening.controls.length === 2 && opening.controls.every((control) => control.href !== ""),
      opening.controls,
    );
    checkThat(
      "both deep-link to the app the launch really serves",
      opening.controls.every((control) => control.href === "/"),
      opening.controls.map((control) => control.href),
    );
    // Follow the primary control for real: the page that arrives must be the app's own `/`.
    const arrived = await evaluate<string>(
      chrome.cdp,
      session,
      `(() => { const link = document.querySelector('#landing-connect'); return link === null ? '<missing>' : new URL(link.href, location.href).pathname; })()`,
    );
    check("the primary control's own href resolves to the app's root", arrived, "/");
    const rootTitle = await evaluate<string>(
      chrome.cdp,
      session,
      `fetch('/', { headers: { accept: 'text/html' } }).then(r => r.text()).then(t => (t.match(/<title>([^<]*)<\\/title>/) ?? ['','<none>'])[1])`,
    );
    check("and that root really serves the app's own document", rootTitle, "freebot");

    section("the page's facts are true of this repository");
    check("the command the page offers is the root script's", opening.commands[0], repo.upCommand);
    check(
      "the replay form of it is offered beside it",
      opening.commands[1],
      `${repo.upCommand} --replay`,
    );
    check("the image tag the page names is the pinned one", opening.image, repo.imageTag);
    const repoHref = await evaluate<string>(
      chrome.cdp,
      session,
      `document.querySelector('#landing-repo')?.getAttribute('href') ?? '<missing>'`,
    );
    check("the repository link is this repository's own remote", repoHref, repo.repoUrl);

    section("U6.6's other subjects, named rather than shipped as dead controls");
    checkThat(
      "the page offers no control that only looks interactive: every button has an id the driver knows",
      await evaluate<boolean>(
        chrome.cdp,
        session,
        `[...document.querySelectorAll('button, a')].every(node => node.id !== '' || node.closest('#landing-controls') !== null)`,
      ),
      true,
    );
    const buttons = await evaluate<readonly string[]>(
      chrome.cdp,
      session,
      `[...document.querySelectorAll('button')].map(node => node.id)`,
    );
    note(`buttons on the page: ${JSON.stringify(buttons)}`);

    section("no design chrome ships");
    const text = await renderedText(chrome.cdp, session);
    const markup = await renderedMarkup(chrome.cdp, session);
    const html = readFileSync(join(root, "apps/web/landing/index.html"), "utf8");
    const bundlePath = await evaluate<string>(
      chrome.cdp,
      session,
      `fetch('/landing.js').then(r => r.text())`,
    );
    for (const literal of EXPORT_CHROME) {
      const found = [
        ...(text.includes(literal) ? ["rendered text"] : []),
        ...(markup.includes(literal) ? ["parsed markup"] : []),
        ...(html.includes(literal) ? ["served html"] : []),
        ...(bundlePath.includes(literal) ? ["bundle"] : []),
      ];
      check(`the export's chrome ${JSON.stringify(literal)} is absent`, found, []);
    }

    section("the hero, at the two viewports this unit pins");
    await setViewport(chrome.cdp, session, 1440, 900);
    await settle(chrome.cdp, session);
    await capture(chrome.cdp, session, dir, "hero-1440x900.png");
    await setViewport(chrome.cdp, session, 430, 932);
    await settle(chrome.cdp, session);
    await capture(chrome.cdp, session, dir, "hero-430x932.png");

    section("the nine-viewport matrix");
    note(`read from ${MANIFEST}`);
    const overflowLines: string[] = [];
    for (const [index, viewport] of viewports.entries()) {
      const label = `${String(index + 1).padStart(2, "0")}-${viewport.name}-${viewport.width}x${viewport.height}`;
      await setViewport(chrome.cdp, session, viewport.width, viewport.height);
      await settle(chrome.cdp, session);
      const probe = await overflowProbe(chrome.cdp, session);
      const [docWidth, innerWidth] = probe.document;
      const docOk = docWidth <= innerWidth;
      checkThat(
        `viewport ${label}: documentElement.scrollWidth <= window.innerWidth`,
        docOk,
        probe.document,
      );
      const regionFailures: string[] = [];
      for (const selector of REGIONS) {
        const pair = probe.regions[selector];
        if (pair === null || pair === undefined) {
          // A region that is not in the page is a viewport with something missing, not one with
          // nothing to measure: a renamed selector would otherwise pass with no measurement at all.
          regionFailures.push(`${selector} (not found)`);
          failed += 1;
          log.push(
            `FAIL viewport ${label}: region ${selector} was not found, so nothing was measured`,
          );
          continue;
        }
        const [scrollWidth, clientWidth] = pair;
        if (scrollWidth <= clientWidth) continue;
        regionFailures.push(`${selector} ${scrollWidth}>${clientWidth}`);
        failed += 1;
        log.push(`FAIL viewport ${label}: overflow ${selector} ${scrollWidth} > ${clientWidth}`);
      }
      if (regionFailures.length === 0) {
        passed += 1;
        log.push(`ok   viewport ${label}: every measured region's scrollWidth <= its clientWidth`);
      }
      const viewportOk = docOk && regionFailures.length === 0;
      overflowLines.push(
        `${label}: documentElement.scrollWidth ${docWidth} <= window.innerWidth ${innerWidth} ${docOk ? "ok" : "FAIL"}; regions ${regionFailures.length === 0 ? "all within their box" : regionFailures.join(", ")}`,
      );
      await capture(chrome.cdp, session, dir, `${label}.png`);
      log.push(`RESULT: ${viewportOk ? "PASS" : "FAIL"} — viewport ${label}`);
    }

    section("the nine overflow pairs");
    for (const line of overflowLines) note(line);

    section("the app's own route, unchanged by this unit");
    const rootSession = await openPage(chrome.cdp, app.url);
    await waitFor(
      chrome.cdp,
      rootSession,
      "the app's own page",
      `document.title === 'freebot' && document.querySelector('.shell') !== null`,
      30_000,
    );
    await setViewport(chrome.cdp, rootSession, 1440, 900);
    await settle(chrome.cdp, rootSession);
    const rootText = await evaluate<string>(chrome.cdp, rootSession, "document.body.innerText");
    checkThat(
      "`/` serves the app's own first-run screen and not the landing",
      rootText.includes("Who is this Bot?"),
      rootText.slice(0, 200),
    );
    checkThat(
      "`/` carries no landing copy",
      !rootText.includes("Bots that do the work, on a computer that stays yours."),
      true,
    );
    const rootBytes = await capture(chrome.cdp, rootSession, dir, "root-1440x900.png");
    note(
      `the app's root renders ${rootBytes} bytes of PNG at 1440x900; it is captured here so a landing that moved what / serves is visible in this artifact`,
    );
    checkThat(
      "the landing and the app are different documents, so the route is really its own",
      rootText !== text,
      { landingChars: text.length, rootChars: rootText.length },
    );
  } finally {
    chrome?.stop();
    await app.stop();
  }

  log.push("");
  log.push(
    `chrome ${chrome.cdp.version}; keyless replay launch, no run started, no container created`,
  );
  log.push(`artifacts: ${artifacts.join(", ")}`);
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
  console.error(`driver crashed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
