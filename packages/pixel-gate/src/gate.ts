/**
 * The run: one command, one browser, nine viewports, a statistic each.
 *
 * The order of operations is the gate's whole argument, so it is worth stating once here.
 *
 * 1. The app is booted the way a person boots it, and the export is served from the committed file.
 * 2. **One** Chrome instance is launched. The app, the export and the diff page are three targets in
 *    it, opened over one CDP connection. `Target.getTargets` is then read and each of the three URLs
 *    is asserted to be in that single list, which is the same-instance proof as a literal check
 *    rather than a claim about the source.
 * 3. Both pages are frozen: animations and transitions removed by an injected stylesheet, and every
 *    running animation cancelled. The export animates at rest, so this is what makes a second
 *    capture of the same page comparable to the first.
 * 4. Per viewport: both pages get the same device metrics, both are probed, the region map turns the
 *    probed boxes into rectangles, both are screenshotted, and both shots are handed to the diff page
 *    in the same browser. No file on disk is ever a comparison source.
 * 5. The chrome regions are summed into one statistic and checked against the tolerance; the content
 *    regions are summed into a second and reported with each region's named variance.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactDir } from "@freebot/verify";
import { settle, setViewport } from "@freebot/verify/cdp";
import { declaredBoxDelta } from "./deltas.ts";
import type { Comparison, RegionDiff } from "./diff.ts";
import {
  APP_READY,
  type Browser,
  beginShots,
  capture,
  compareShots,
  crop,
  dismissNotices,
  EXPORT_READY,
  type ExportUnderTest,
  OVERFLOW_SELECTORS,
  openDiffPage,
  type Probe,
  prepare,
  probe,
  putShot,
  redact,
  serveExport,
  startApp,
  startBrowser,
  targets,
} from "./page.ts";
import {
  BOX_TOLERANCE,
  type BoxMap,
  CHROME_TOLERANCE_DEFAULT,
  REGIONS,
  type Rect,
  type ResolvedRegion,
  resolveRegions,
  selectorsFor,
  type Viewport,
} from "./regions.ts";
import {
  canonicalJson,
  compareRuns,
  type ExtentPair,
  type FontFacts,
  type Overflow,
  type RegionReport,
  type Repeat,
  type RunReport,
  renderJson,
  renderText,
  sumDiffs,
  type ViewportReport,
} from "./report.ts";

export const FEATURE = "pixel-gate";
export const MANIFEST = "design/prototype-84c6b185/DESIGN-MANIFEST.json";
export const EXPORT_HTML = "design/prototype-84c6b185/freebot-prototype.html";

/** A chrome region is allowed this many differing pixels. The knob U6.7 calibrates. */
export const CHROME_TOLERANCE = CHROME_TOLERANCE_DEFAULT;

/** How much a chrome crop is magnified, so a one-pixel rule is visible to a person. */
export const CROP_SCALE = 6;

/** The diff page's shot names. Two pages, two names, and both a repeat pair copies. */
export const APP_SHOT = "app";
export const EXPORT_SHOT = "export";
const APP_REPEAT = "app-repeat";
const EXPORT_REPEAT = "export-repeat";

/** The nine viewports, read from the manifest. A different count is a refusal, not a warning. */
export function readViewports(root: string, manifest = MANIFEST): Viewport[] {
  const parsed = JSON.parse(readFileSync(join(root, manifest), "utf8")) as {
    responsiveViewports?: Viewport[];
  };
  const viewports = parsed.responsiveViewports ?? [];
  if (viewports.length !== 9) {
    throw new Error(`${manifest}: expected nine responsiveViewports, found ${viewports.length}`);
  }
  const wrong = viewports.filter((viewport) => viewport.width <= 0 || viewport.height <= 0);
  if (wrong.length > 0) {
    throw new Error(`${manifest}: viewports with no area: ${JSON.stringify(wrong)}`);
  }
  return viewports;
}

export interface RunOptions {
  readonly root: string;
  /** The exact command a person typed, recorded in the report. */
  readonly command: string;
  /** One viewport instead of nine, by name or by `WxH`. */
  readonly only?: string;
  /** Capture each viewport twice and report the two captures against each other. */
  readonly repeat: boolean;
  /** Write the artifact directory. Off for a run that only prints. */
  readonly write: boolean;
  /** Where the report goes, when a caller wants to override the artifact directory. */
  readonly dir?: string;
  readonly log?: (line: string) => void;
}

export interface RunResult {
  readonly report: RunReport;
  readonly dir: string | null;
  readonly exitCode: number;
}

function git(root: string, args: readonly string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

/** Select the viewports a run will visit, keeping the manifest's order. */
export function chooseViewports(all: readonly Viewport[], only?: string): Viewport[] {
  if (only === undefined || only === "") return [...all];
  const wanted = only.toLowerCase();
  const found = all.filter(
    (viewport) =>
      viewport.name.toLowerCase() === wanted ||
      `${viewport.width}x${viewport.height}` === wanted ||
      viewport.name.toLowerCase().includes(wanted),
  );
  if (found.length === 0) {
    throw new Error(
      `no viewport matches ${JSON.stringify(only)}; the manifest names ${all.map((viewport) => viewport.name).join(", ")}`,
    );
  }
  return found;
}

/** A statistic with no pixels: what an unmeasured comparison answers with. */
function emptyDiff(): RegionDiff {
  return { differing: 0, total: 0, share: 0, meanAbsolute: 0, maxChannel: 0, visible: 0 };
}

function overflowOf(probed: Probe): Overflow {
  const [scrollWidth, innerWidth] = probed.document;
  const regions: Record<string, ExtentPair | null> = {};
  const overflowing: string[] = [];
  for (const selector of OVERFLOW_SELECTORS) {
    const pair = probed.regions[selector] ?? null;
    regions[selector] = pair;
    if (pair !== null && pair[0] > pair[1]) overflowing.push(selector);
  }
  const documentPair: ExtentPair = [scrollWidth, innerWidth];
  if (scrollWidth > innerWidth) overflowing.push("documentElement");
  return { document: documentPair, regions, overflowing };
}

function fontFacts(app: Probe, exported: Probe): FontFacts {
  return {
    appStack: app.fonts.stack,
    exportStack: exported.fonts.stack,
    same: app.fonts.stack === exported.fonts.stack,
    appGeistWidth: app.fonts.geistWidth,
    appAbsentWidth: app.fonts.absentWidth,
    exportGeistWidth: exported.fonts.geistWidth,
    exportAbsentWidth: exported.fonts.absentWidth,
    geistResolves: app.fonts.geistWidth !== app.fonts.absentWidth,
  };
}

export const EMPTY_FONTS: FontFacts = {
  appStack: "",
  exportStack: "",
  same: false,
  appGeistWidth: 0,
  appAbsentWidth: 0,
  exportGeistWidth: 0,
  exportAbsentWidth: 0,
  geistResolves: false,
};

/**
 * The three targets of the one browser, checked by URL.
 *
 * This is the same-instance guarantee as a fact read out of the browser rather than a claim about
 * the source: every URL this run uses has to be a target of the one connection it holds. A second
 * Chrome process would make the app's or the export's URL absent from this list, and the run fails in
 * its first seconds rather than after nine viewports.
 */
async function assertOneInstance(
  browser: Browser,
  urls: { readonly app: string; readonly export: string; readonly diff: string },
  log: (line: string) => void,
): Promise<void> {
  const list = await targets(browser.cdp);
  const problems: string[] = [];
  let matched = 0;
  for (const [name, url] of Object.entries(urls)) {
    const found = list.find((target) => target.url === url);
    if (found === undefined) {
      problems.push(`${name}: ${redact(url)} is not a target of this browser`);
      continue;
    }
    matched += 1;
    log(`  ${name}: target ${found.targetId} (${found.type}) ${redact(found.url)}`);
  }
  log(
    `same instance: one Chrome ${browser.version} over one CDP connection with ${list.length} target(s); ${matched} of 3 belong to this run`,
  );
  if (problems.length > 0) {
    throw new Error(`the run was not same-instance: ${problems.join("; ")}`);
  }
}

export async function run(options: RunOptions): Promise<RunResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const root = options.root;
  const all = readViewports(root);
  const viewports = chooseViewports(all, options.only);
  const startedAt = new Date().toISOString();
  const commit = git(root, ["rev-parse", "HEAD"]);
  const shortSha = git(root, ["rev-parse", "--short", "HEAD"]);
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  // The commit is what the run's pixels belong to, so the working tree's cleanliness is reported
  // beside it. The run's own artifact directory is not evidence of a dirty tree: it is written after
  // this read on a first run and would make the second run of the same command disagree with the
  // first about the state of the code, which is exactly the drift the two-run proof is looking for.
  const dirty =
    git(root, [
      "status",
      "--porcelain",
      "--",
      ".",
      `:(exclude)packages/verify/artifacts/${FEATURE}`,
    ]) !== "";
  const conventional = artifactDir(root, FEATURE, shortSha);
  const dir = options.write ? (options.dir ?? conventional) : null;
  if (dir !== null) {
    // Only the run's own conventional directory is cleared, and only when it was chosen by
    // convention. A path a person passed for `--artifact` is never deleted, even when it spells out
    // the conventional path: a wrong path must not take the whole tree with it.
    if (options.dir === undefined) {
      rmSync(dir, { recursive: true, force: true });
    } else if (existsSync(dir) && readdirSync(dir).length > 0) {
      throw new Error(`--artifact ${dir} exists and is not empty; refusing to overwrite it`);
    }
    mkdirSync(join(dir, "shots"), { recursive: true });
  }

  log(
    `pixel gate: ${viewports.length} of ${all.length} viewport(s), ${REGIONS.length} regions, chrome tolerance ${CHROME_TOLERANCE}`,
  );
  log(`commit ${shortSha} on ${branch}${dirty ? " (working tree dirty)" : ""}`);
  if (dir !== null) log(`artifact: ${dir.replace(`${root}/`, "")}`);

  const app = await startApp(root, "run");
  const appSelectors = selectorsFor(REGIONS, "app");
  const exportSelectors = selectorsFor(REGIONS, "export");
  const reports: ViewportReport[] = [];
  const failures: string[] = [];
  let fonts: FontFacts = EMPTY_FONTS;
  let chromeVersion = "";
  let exported: ExportUnderTest | null = null;
  let browser: Browser | null = null;

  try {
    log(`app up ${redact(app.url)}`);
    log(`  home ${app.home}`);
    exported = serveExport(root, EXPORT_HTML);
    log(`export served ${exported.url} from ${exported.file}`);
    if (exported.replacements !== 1) {
      throw new Error(
        `the export's initial screen was replaced ${exported.replacements} time(s), expected exactly 1: ${EXPORT_HTML}`,
      );
    }
    browser = await startBrowser();
    chromeVersion = browser.version;
    log(`chrome ${browser.version}`);
    log(`  determinism flags ${browser.flags.join(" ")}`);

    const appSession = await openPageFor(browser, app.url, APP_READY, "app shell", log);
    const exportSession = await openPageFor(
      browser,
      exported.url,
      EXPORT_READY,
      "export app screen",
      log,
    );
    const diffSession = await openDiffPage(browser.cdp);
    log("diff page: a third target in the same browser, holding no DOM of its own");
    chromeVersion = browser.cdp.version;
    await assertOneInstance(
      browser,
      { app: app.url, export: exported.url, diff: "about:blank#freebot-pixel-gate-diff" },
      log,
    );

    const openingApp = await probe(browser.cdp, appSession, appSelectors, OVERFLOW_SELECTORS);
    const openingExport = await probe(browser.cdp, exportSession, exportSelectors, []);
    fonts = fontFacts(openingApp, openingExport);
    log(`fonts: app resolves to ${fonts.appStack}`);
    log(`  export resolves to ${fonts.exportStack}`);
    log(`  the two stacks ${fonts.same ? "are the same" : "differ"}`);
    log(
      `  a 'Geist' string measures ${fonts.appGeistWidth}px against an absent family's ${fonts.appAbsentWidth}px, so ${fonts.geistResolves ? "the vendored Geist face is in use on both pages" : "Geist has no face here and both pages render the stack's fallback"}`,
    );

    for (const [index, viewport] of viewports.entries()) {
      const label = `${String(index + 1).padStart(2, "0")}-${viewport.name}-${viewport.width}x${viewport.height}`;
      log("");
      log(`### ${label}`);
      const first = await visit({
        browser,
        appSession,
        exportSession,
        diffSession,
        appSelectors,
        exportSelectors,
        viewport,
        label,
        dir,
        log,
      });
      let repeat: Repeat | null = null;
      if (options.repeat) {
        // A second capture of the same two pages at the same viewport, then the first capture against
        // the second, pair by pair. This is the determinism proof: a page that moved between the two
        // captures shows a non-zero count here whatever its chrome statistic said about the export.
        const second = await visit({
          browser,
          appSession,
          exportSession,
          diffSession,
          appSelectors,
          exportSelectors,
          viewport,
          label: `${label}-repeat`,
          dir: null,
          log: () => {},
        });
        repeat = await repeatAgainst(browser, first, second, label);
        log(
          `  repeat: app-first against app-second ${repeat.app.differing}/${repeat.app.total} pixel(s) differ (max channel ${repeat.app.maxChannel}); export-first against export-second ${repeat.export.differing}/${repeat.export.total} (max channel ${repeat.export.maxChannel}); ${repeat.identical ? "pixel-identical" : "NOT pixel-identical"}`,
        );
      }
      reports.push(
        assemble({
          index: index + 1,
          label,
          viewport,
          repeat,
          first,
        }),
      );
      log(
        `  chrome ${first.chrome.differing}/${first.chrome.total} (${(first.chrome.share * 100).toFixed(4)}%), content ${first.content.differing}/${first.content.total} (${(first.content.share * 100).toFixed(4)}%), whole ${(first.comparison.whole.share * 100).toFixed(4)}%`,
      );
    }
  } finally {
    browser?.stop();
    exported?.stop();
    await app.stop();
  }

  if (exported === null) throw new Error("the run finished without its export");
  if (chromeVersion === "") throw new Error("the run finished without its browser");

  failures.push(...verdictFailures(reports, CHROME_TOLERANCE));

  const chromeTotal = sumDiffs(
    reports.flatMap((report) =>
      report.regions
        .filter((region) => region.kind === "chrome" && region.stat !== null)
        .map((region) => region.stat as RegionDiff),
    ),
  );

  const runReport: RunReport = {
    feature: FEATURE,
    command: options.command,
    commit,
    shortSha,
    branch,
    dirty,
    startedAt,
    runtime: `bun ${Bun.version} on ${process.platform} ${process.arch}`,
    chrome: `chrome ${chromeVersion}`,
    fonts,
    app: {
      home: app.home,
      url: redact(app.url),
      botId: app.botId,
      threadId: app.threadId,
      provider: app.providerMode,
      vault: app.vault,
    },
    exportSource: {
      file: exported.file,
      initialScreenReplacements: exported.replacements,
      servedAt: exported.url,
    },
    viewports: reports,
    chromeTolerance: CHROME_TOLERANCE,
    repeatRequested: options.repeat,
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    failures,
  };

  if (dir !== null) {
    writeFileSync(join(dir, "assert.txt"), renderText(runReport));
    writeFileSync(join(dir, "run.json"), `${canonicalJson(runReport)}\n`);
    writeFileSync(join(dir, "summary.json"), renderJson(runReport));
    log("");
    log(`wrote ${join(dir, "assert.txt").replace(`${root}/`, "")}`);
    log(`wrote ${join(dir, "run.json").replace(`${root}/`, "")}`);
    log(`wrote ${join(dir, "summary.json").replace(`${root}/`, "")}`);
  }

  log("");
  for (const line of renderText(runReport).split("\n")) {
    if (
      line.startsWith("| ") ||
      line.startsWith("### ") ||
      line.startsWith("chrome:") ||
      line.startsWith("content:") ||
      line.startsWith("whole frame:")
    ) {
      log(line);
    }
  }
  for (const failure of failures) log(`FAIL ${failure}`);
  log(
    `chrome overall: ${chromeTotal.differing}/${chromeTotal.total} pixels differ (${(chromeTotal.share * 100).toFixed(4)}%), tolerance ${CHROME_TOLERANCE} per region`,
  );
  log(`RESULT: ${runReport.verdict}`);

  return { report: runReport, dir, exitCode: exitCodeFor(failures) };
}

async function openPageFor(
  browser: Browser,
  url: string,
  ready: string,
  describe: string,
  log: (line: string) => void,
): Promise<string> {
  const { openPage } = await import("@freebot/verify/cdp");
  const session = await openPage(browser.cdp, url);
  const stopped = await prepare(
    browser.cdp,
    session,
    { name: "boot", width: 1440, height: 900 },
    ready,
    describe,
  );
  log(`${describe} loaded and frozen (${stopped} running animation(s) cancelled)`);
  return session;
}

interface VisitInput {
  readonly browser: Browser;
  readonly appSession: string;
  readonly exportSession: string;
  readonly diffSession: string;
  readonly appSelectors: readonly string[];
  readonly exportSelectors: readonly string[];
  readonly viewport: Viewport;
  readonly label: string;
  readonly dir: string | null;
  readonly log: (line: string) => void;
}

interface Visit {
  readonly comparison: Comparison;
  readonly chrome: RegionDiff;
  readonly content: RegionDiff;
  readonly chromeRegions: number;
  readonly contentRegions: number;
  readonly regions: readonly RegionReport[];
  readonly overflow: Overflow;
  readonly files: readonly string[];
  /** The two shots, kept so a repeat can be diffed against them after the fact. */
  readonly shots: { readonly app: Buffer; readonly export: Buffer };
  /** The diff page this visit used. The same one for the whole run. */
  readonly diffSession: string;
}

/**
 * One viewport, captured and compared.
 *
 * The app's and the export's device metrics are set together, both are re-probed and re-settled, then
 * both are screenshotted back to back, so nothing can move between the probe that defines a rectangle
 * and the shot that rectangle is cut from.
 */
async function visit(input: VisitInput): Promise<Visit> {
  const { browser, appSession, exportSession, diffSession, viewport, label, dir } = input;
  await Promise.all([
    setViewport(browser.cdp, appSession, viewport.width, viewport.height),
    setViewport(browser.cdp, exportSession, viewport.width, viewport.height),
  ]);
  await Promise.all([
    settle(browser.cdp, appSession, 250),
    settle(browser.cdp, exportSession, 250),
  ]);
  // Both pages may paint a notice after the ready predicate; clear both stacks before the probe so
  // the shell's band is the shell's, not the notice surface's.
  const dismissed = await Promise.all([
    dismissNotices(browser.cdp, appSession),
    dismissNotices(browser.cdp, exportSession),
  ]);
  if (dismissed[0] + dismissed[1] > 0) {
    input.log(`  notices dismissed: ${dismissed[0]} app, ${dismissed[1]} export`);
  }
  await Promise.all([
    settle(browser.cdp, appSession, 100),
    settle(browser.cdp, exportSession, 100),
  ]);
  const appProbe = await probe(browser.cdp, appSession, input.appSelectors, OVERFLOW_SELECTORS);
  const exportProbe = await probe(browser.cdp, exportSession, input.exportSelectors, []);
  for (const [side, probed] of [
    ["app", appProbe],
    ["export", exportProbe],
  ] as const) {
    if (!probed.frozen) throw new Error(`${label}: the ${side} page is not frozen`);
  }

  const sides: { app: BoxMap; export: BoxMap } = {
    app: appProbe.boxes,
    export: exportProbe.boxes,
  };
  const resolved = resolveRegions(REGIONS, sides, viewport);
  const measurable = resolved.filter(
    (region): region is ResolvedRegion & { rect: Rect } => region.rect !== null,
  );

  const [appShot, exportShot] = await Promise.all([
    capture(browser.cdp, appSession, viewport),
    capture(browser.cdp, exportSession, viewport),
  ]);

  await beginShots(browser.cdp, diffSession);
  await putShot(browser.cdp, diffSession, APP_SHOT, appShot.shot);
  await putShot(browser.cdp, diffSession, EXPORT_SHOT, exportShot.shot);
  const comparison = await compareShots(
    browser.cdp,
    diffSession,
    APP_SHOT,
    EXPORT_SHOT,
    measurable.map((region) => ({ id: region.id, kind: region.kind, rect: region.rect })),
  );
  if (comparison.width !== viewport.width || comparison.height !== viewport.height) {
    throw new Error(
      `${label}: the shots are ${comparison.width}x${comparison.height}, expected ${viewport.width}x${viewport.height}`,
    );
  }

  const byId = new Map(comparison.regions.map((region) => [region.id, region]));
  const files: string[] = [];
  const regionReports: RegionReport[] = [];
  for (const region of resolved) {
    const stat = byId.get(region.id) ?? null;
    const failing =
      region.kind === "chrome" && stat !== null && stat.stat.differing > CHROME_TOLERANCE;
    let cropName: string | null = null;
    if (dir !== null && region.rect !== null && (region.kind === "chrome" || failing)) {
      cropName = `${label}.${region.id}.png`;
      writeFileSync(
        join(dir, "shots", cropName),
        await crop(browser.cdp, diffSession, APP_SHOT, EXPORT_SHOT, region.rect, CROP_SCALE),
      );
      files.push(cropName);
    }
    regionReports.push({
      id: region.id,
      kind: region.kind,
      status: region.status,
      rect: region.rect,
      variance: region.variance,
      note: region.note,
      boxDelta: region.boxDelta,
      sourceBox: region.sourceBox,
      counterpartBox: region.counterpartBox,
      stat: stat?.stat ?? null,
      crop: cropName,
    });
  }

  if (dir !== null) {
    const appName = `${label}.app.png`;
    const exportName = `${label}.export.png`;
    writeFileSync(join(dir, "shots", appName), appShot.shot);
    writeFileSync(join(dir, "shots", exportName), exportShot.shot);
    files.push(appName, exportName);
  }

  const chromeRegions = regionReports.filter(
    (region) => region.kind === "chrome" && region.status !== "absent",
  );
  const contentRegions = regionReports.filter(
    (region) => region.kind === "content" && region.status !== "absent",
  );

  input.log(
    `  regions: ${regionReports.filter((region) => region.status === "absent").length} absent, ${chromeRegions.length} chrome, ${contentRegions.length} content; shots ${comparison.width}x${comparison.height}`,
  );
  for (const region of regionReports) {
    const delta = region.boxDelta;
    const boxes =
      delta === null
        ? "no counterpart"
        : `box delta ${delta.left},${delta.top},${delta.width},${delta.height}${delta.agree ? "" : " BOXES-DIFFER"}`;
    const pixels =
      region.stat === null
        ? "no statistic"
        : `${region.stat.differing}/${region.stat.total} differ`;
    input.log(
      `    ${region.kind.padEnd(7)} ${region.id.padEnd(28)} ${region.status.padEnd(8)} ${pixels.padEnd(22)} ${boxes}`,
    );
  }
  const overflowing = overflowOf(appProbe).overflowing;
  input.log(`  overflow (app): ${overflowing.length === 0 ? "none" : overflowing.join(", ")}`);

  return {
    comparison,
    chrome: sumDiffs(
      chromeRegions
        .map((region) => region.stat)
        .filter((stat): stat is RegionDiff => stat !== null),
    ),
    content: sumDiffs(
      contentRegions
        .map((region) => region.stat)
        .filter((stat): stat is RegionDiff => stat !== null),
    ),
    chromeRegions: chromeRegions.length,
    contentRegions: contentRegions.length,
    regions: regionReports,
    overflow: overflowOf(appProbe),
    files,
    shots: { app: appShot.shot, export: exportShot.shot },
    diffSession,
  };
}

/**
 * The first capture against the second, page by page.
 *
 * Both pairs are compared with the same in-page arithmetic the main comparison uses, and the region
 * list is one whole-frame rectangle, because the question here is whether the page moved at all
 * rather than whether a named region matches the export.
 */
async function repeatAgainst(
  browser: Browser,
  first: Visit,
  second: Visit,
  label: string,
): Promise<Repeat> {
  const whole: Rect = {
    x: 0,
    y: 0,
    width: first.comparison.width,
    height: first.comparison.height,
  };
  const regions = [{ id: "whole", kind: "chrome" as const, rect: whole }];
  await beginShots(browser.cdp, second.diffSession);
  await putShot(browser.cdp, second.diffSession, APP_SHOT, first.shots.app);
  await putShot(browser.cdp, second.diffSession, APP_REPEAT, second.shots.app);
  await putShot(browser.cdp, second.diffSession, EXPORT_SHOT, first.shots.export);
  await putShot(browser.cdp, second.diffSession, EXPORT_REPEAT, second.shots.export);
  const app = await compareShots(browser.cdp, second.diffSession, APP_SHOT, APP_REPEAT, regions);
  const exported = await compareShots(
    browser.cdp,
    second.diffSession,
    EXPORT_SHOT,
    EXPORT_REPEAT,
    regions,
  );
  const appStat = app.regions[0]?.stat ?? emptyDiff();
  const exportStat = exported.regions[0]?.stat ?? emptyDiff();
  const identical =
    app.digests.left === app.digests.right &&
    exported.digests.left === exported.digests.right &&
    appStat.differing === 0 &&
    exportStat.differing === 0;
  if (!identical) {
    throw new Error(
      `${label}: the two captures of the same page are not identical, so this run is not a determinism proof (app ${appStat.differing}/${appStat.total}, export ${exportStat.differing}/${exportStat.total})`,
    );
  }
  return { app: appStat, export: exportStat, identical };
}

function assemble(input: {
  readonly index: number;
  readonly label: string;
  readonly viewport: Viewport;
  readonly repeat: Repeat | null;
  readonly first: Visit;
}): ViewportReport {
  const first = input.first;
  return {
    index: input.index,
    name: input.viewport.name,
    width: input.viewport.width,
    height: input.viewport.height,
    label: input.label,
    chrome: first.chrome,
    content: first.content,
    chromeRegions: first.chromeRegions,
    contentRegions: first.contentRegions,
    whole: first.comparison.whole,
    regions: first.regions,
    overflow: first.overflow,
    digests: {
      app: first.comparison.digests.left,
      export: first.comparison.digests.right,
    },
    repeat: input.repeat,
    files: first.files,
  };
}

export interface StabilityRequest {
  readonly first: RunReport;
  readonly second: RunReport;
  readonly epsilon: number;
}

/** The two-run proof, exposed so the CLI can print it and a test can drive it. */
export function stability(request: StabilityRequest): ReturnType<typeof compareRuns> {
  return compareRuns(request.first, request.second, request.epsilon);
}

/**
 * Every chrome region whose differing-pixel count is over the tolerance, by name.
 *
 * Exposed so the failure path is driven by a test with a fake report rather than by damaging a real
 * page. The run's exit code is a function of this list, and `exitCodeFor` is that function.
 */
export function chromeFailures(
  reports: readonly ViewportReport[],
  tolerance = CHROME_TOLERANCE,
): string[] {
  const failures: string[] = [];
  for (const report of reports) {
    for (const region of report.regions) {
      if (region.kind !== "chrome" || region.status === "absent") continue;
      if (region.stat === null) {
        failures.push(`${report.label} ${region.id}: measured with no statistic`);
        continue;
      }
      if (region.stat.differing > tolerance) {
        failures.push(
          `${report.label} ${region.id}: ${region.stat.differing} differing pixel(s) over a tolerance of ${tolerance} (max channel ${region.stat.maxChannel})`,
        );
      }
    }
  }
  return failures;
}

/**
 * Every box that moved without a matching declaration.
 *
 * A box that moved is a finding even when the pixels inside the chosen rectangle happen to match,
 * which is exactly why `resolveRegions` prints the delta beside every region. The chrome regions
 * must agree outright. A content region is allowed to differ only through an entry in the
 * contract's list, and only by the pixels that entry records.
 */
export function boxFailures(
  reports: readonly ViewportReport[],
  tolerance = BOX_TOLERANCE,
): string[] {
  const failures: string[] = [];
  for (const report of reports) {
    for (const region of report.regions) {
      const delta = region.boxDelta;
      if (delta === null || delta.agree) continue;
      const shown = `left ${delta.left}, top ${delta.top}, width ${delta.width}, height ${delta.height}`;
      if (region.kind === "chrome") {
        failures.push(`${report.label} ${region.id}: chrome box delta (${shown}) is not zero`);
        continue;
      }
      const declared = declaredBoxDelta(region.id);
      if (declared === undefined) {
        failures.push(
          `${report.label} ${region.id}: box delta (${shown}) is not declared in docs/DESIGN-CONTRACT.md`,
        );
        continue;
      }
      const expected = declared.pixels[report.name];
      if (expected === undefined) {
        failures.push(
          `${report.label} ${region.id}: the declaration has no pixels for viewport ${report.name}`,
        );
        continue;
      }
      const moved = (["left", "top", "width", "height"] as const).filter(
        (axis) => Math.abs(delta[axis] - expected[axis]) > tolerance,
      );
      if (moved.length > 0) {
        failures.push(
          `${report.label} ${region.id}: box delta (${shown}) moved from the declared (left ${expected.left}, top ${expected.top}, width ${expected.width}, height ${expected.height}) on ${moved.join(", ")}`,
        );
      }
    }
  }
  return failures;
}

/** The one place a failure list becomes a process exit code. */
export function exitCodeFor(failures: readonly string[]): number {
  return failures.length === 0 ? 0 : 1;
}

/** A viewport that scrolls horizontally is a failure, not a note, per the manifest's flag. */
export function overflowFailures(reports: readonly ViewportReport[]): string[] {
  const failures: string[] = [];
  for (const report of reports) {
    const [scrollWidth, innerWidth] = report.overflow.document;
    if (scrollWidth > innerWidth) {
      failures.push(
        `${report.label}: documentElement.scrollWidth ${scrollWidth} > window.innerWidth ${innerWidth}`,
      );
    }
    for (const selector of report.overflow.overflowing) {
      failures.push(`${report.label}: ${selector} has content wider than its box`);
    }
  }
  return failures;
}

/** Both checks in the order the run reports them. */
export function verdictFailures(
  reports: readonly ViewportReport[],
  chromeTolerance = CHROME_TOLERANCE,
  boxTolerance = BOX_TOLERANCE,
): string[] {
  return [
    ...chromeFailures(reports, chromeTolerance),
    ...boxFailures(reports, boxTolerance),
    ...overflowFailures(reports),
  ];
}
