/**
 * The run report: the shape a run produces and the two ways it is printed.
 *
 * One `RunReport` per run becomes three things on disk. `assert.txt` is the human transcript, one
 * section per viewport with the literal statistic on each line. `run.json` is the whole report, and
 * `NN-name.json` is one viewport of it, so a reviewer or a later gate can read a single viewport
 * without parsing the rest. The diff PNGs are written beside them.
 *
 * The chrome statistic is summed over the chrome regions and the content statistic over the content
 * regions, so a viewport's headline number is the shell's and the second number is what the records
 * painted. Both are printed with their denominator, because a share without a pixel count is not a
 * statistic a reviewer can check.
 */

import type { Rect, RegionDiff } from "./diff.ts";
import type { Box, BoxDelta, RegionKind, RegionStatus } from "./regions.ts";

/** A pair of content extents: what the element's content needs, and what it can show. */
export type ExtentPair = readonly [number, number];

export interface Overflow {
  /** `documentElement.scrollWidth` against `window.innerWidth`. */
  readonly document: ExtentPair;
  /** One pair per probed region, null where the selector is not on that page. */
  readonly regions: Readonly<Record<string, ExtentPair | null>>;
  /** The selectors whose content is wider than the box that holds it. */
  readonly overflowing: readonly string[];
}

export interface RegionReport {
  readonly id: string;
  readonly kind: RegionKind;
  readonly status: RegionStatus;
  readonly rect: Rect | null;
  readonly variance: string;
  readonly note: string;
  readonly boxDelta: BoxDelta | null;
  readonly sourceBox: Box | null;
  readonly counterpartBox: Box | null;
  readonly stat: RegionDiff | null;
  /** The highlighted crop's file name, when one was written. */
  readonly crop: string | null;
}

/**
 * The two captures of one viewport, diffed against each other.
 *
 * This is the determinism proof order 36d asks for, as a measurement rather than a paragraph: the
 * same page, the same viewport, captured twice in one run, with the literal differing-pixel count
 * between the two shots. A page that moved would show a non-zero count here whatever its chrome
 * statistic said about the export.
 */
export interface Repeat {
  /** The app's first capture against its second. */
  readonly app: RegionDiff;
  /** The export's first capture against its second. */
  readonly export: RegionDiff;
  /** True when both pairs are pixel-identical and both digests match. */
  readonly identical: boolean;
}

export interface ViewportReport {
  readonly index: number;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** `NN-name-WxH`, the label every file and section for this viewport carries. */
  readonly label: string;
  /** Summed over the chrome regions this viewport carries. */
  readonly chrome: RegionDiff;
  readonly content: RegionDiff;
  readonly chromeRegions: number;
  readonly contentRegions: number;
  readonly whole: RegionDiff;
  readonly regions: readonly RegionReport[];
  readonly overflow: Overflow;
  readonly digests: { readonly app: string; readonly export: string };
  readonly repeat: Repeat | null;
  readonly files: readonly string[];
}

export interface FontFacts {
  readonly appStack: string;
  readonly exportStack: string;
  /** True when both pages resolve the body family to the same stack. */
  readonly same: boolean;
  /** The advance width of a `'Geist'`-family string, and of a family that cannot exist. */
  readonly appGeistWidth: number;
  readonly appAbsentWidth: number;
  readonly exportGeistWidth: number;
  readonly exportAbsentWidth: number;
  /** True when the Geist-family string measures as the absent family does: the family has no face. */
  readonly geistResolves: boolean;
}

export interface RunReport {
  readonly feature: string;
  readonly command: string;
  readonly commit: string;
  readonly shortSha: string;
  readonly branch: string;
  readonly dirty: boolean;
  readonly startedAt: string;
  readonly runtime: string;
  readonly chrome: string;
  readonly fonts: FontFacts;
  readonly app: {
    readonly home: string;
    readonly url: string;
    readonly botId: string;
    readonly threadId: string;
    readonly provider: string;
    readonly vault: string;
  };
  readonly exportSource: {
    readonly file: string;
    readonly initialScreenReplacements: number;
    readonly servedAt: string;
  };
  readonly viewports: readonly ViewportReport[];
  readonly chromeTolerance: number;
  readonly repeatRequested: boolean;
  readonly verdict: "PASS" | "FAIL";
  readonly failures: readonly string[];
}

const ZERO: RegionDiff = {
  differing: 0,
  total: 0,
  share: 0,
  meanAbsolute: 0,
  maxChannel: 0,
  visible: 0,
};

/** Add statistics together, so a group of regions has one headline number. */
export function sumDiffs(diffs: readonly RegionDiff[]): RegionDiff {
  if (diffs.length === 0) return ZERO;
  let differing = 0;
  let total = 0;
  let weighted = 0;
  let visible = 0;
  let maxChannel = 0;
  for (const diff of diffs) {
    differing += diff.differing;
    total += diff.total;
    weighted += diff.meanAbsolute * diff.total * 4;
    visible += diff.visible;
    if (diff.maxChannel > maxChannel) maxChannel = diff.maxChannel;
  }
  return {
    differing,
    total,
    share: total === 0 ? 0 : differing / total,
    meanAbsolute: total === 0 ? 0 : weighted / (total * 4),
    maxChannel,
    visible,
  };
}

function percent(share: number): string {
  return `${(share * 100).toFixed(4)}%`;
}

function stat(text: string): string {
  return text.padEnd(9);
}

/**
 * One region's line. The numbers are printed with their denominator, the box delta against the other
 * page, and the reason the region may vary, because order 36 asks for a statistic a reader can
 * attribute to a cause.
 */
function regionLine(region: RegionReport): string {
  const delta =
    region.boxDelta === null
      ? "box delta: no counterpart rectangle on the other page"
      : `box delta: left ${region.boxDelta.left}, top ${region.boxDelta.top}, width ${region.boxDelta.width}, height ${region.boxDelta.height} ${region.boxDelta.agree ? "(boxes agree)" : "(BOXES DIFFER)"}; ${region.boxDelta.detail}`;
  if (region.status === "absent") {
    return `${stat("absent")} ${region.kind.padEnd(7)} ${region.id.padEnd(28)} the region is not on this viewport, so it has no pixel statistic; ${delta}`;
  }
  const where = region.rect === null ? "no rect" : `${region.rect.width}x${region.rect.height}`;
  const at = region.rect === null ? "" : ` at ${region.rect.x},${region.rect.y}`;
  const diff = region.stat;
  if (diff === null) {
    return `${stat("FAIL")} ${region.kind.padEnd(7)} ${region.id.padEnd(28)} measured ${where}${at} and no statistic was produced; ${delta}`;
  }
  const clipped = region.status === "clipped" ? " (clipped to the viewport)" : "";
  const why = region.variance === "" ? "" : `\n             named variance: ${region.variance}`;
  return `${stat(diff.differing === 0 ? "same" : "DIFF")} ${region.kind.padEnd(7)} ${region.id.padEnd(28)} measured ${where}${at}${clipped}: ${diff.differing}/${diff.total} pixels differ (${percent(diff.share)}), mean|delta| ${diff.meanAbsolute.toFixed(3)}, max channel ${diff.maxChannel}, over-threshold ${diff.visible}; ${delta}${why}`;
}

function overflowLine(overflow: Overflow, side: string): string {
  const [scrollWidth, innerWidth] = overflow.document;
  const ok = scrollWidth <= innerWidth;
  const over = overflow.overflowing.length === 0 ? "none" : overflow.overflowing.join(", ");
  return `overflow ${side}: documentElement.scrollWidth ${scrollWidth} <= window.innerWidth ${innerWidth} ${ok ? "ok" : "FAIL"}; regions with content wider than their box: ${over}`;
}

/** The whole run as the human transcript. */
export function renderText(report: RunReport): string {
  const lines: string[] = [];
  lines.push(`# pixel gate`);
  lines.push("");
  lines.push(`feature: ${report.feature}`);
  lines.push(`command: ${report.command}`);
  lines.push(
    `commit: ${report.commit} (${report.shortSha}) on ${report.branch}${report.dirty ? ", working tree dirty" : ""}`,
  );
  lines.push(`started: ${report.startedAt}`);
  lines.push(`runtime: ${report.runtime}`);
  lines.push(`chrome: ${report.chrome}`);
  lines.push(`chrome tolerance: ${report.chromeTolerance} differing pixel(s) per chrome region`);
  lines.push("");
  lines.push(`app: ${report.app.url}`);
  lines.push(`  home ${report.app.home}`);
  lines.push(
    `  bot ${report.app.botId}, thread ${report.app.threadId}, provider mode ${report.app.provider}, vault ${report.app.vault}`,
  );
  lines.push(
    `export: ${report.exportSource.file}, served at ${report.exportSource.servedAt}, its initial screen replaced ${report.exportSource.initialScreenReplacements} time(s)`,
  );
  lines.push("");
  lines.push(
    `fonts: the app resolves to ${report.fonts.appStack}; the export resolves to ${report.fonts.exportStack}`,
  );
  lines.push(
    `  the two stacks ${report.fonts.same ? "are the same" : "differ"}; a 'Geist' string measures ${report.fonts.appGeistWidth}px against an absent family's ${report.fonts.appAbsentWidth}px on the app and ${report.fonts.exportGeistWidth}px against ${report.fonts.exportAbsentWidth}px on the export, so Geist ${report.fonts.geistResolves ? "has a face of its own on this machine" : "has no face on this machine and both pages render the stack's fallback"}`,
  );
  lines.push("");
  lines.push(
    "same instance, same run: one Chrome process, one CDP connection, three targets in it (the app, the export, and the page that diffs them). The export is never screenshotted in a second process and no stored image is ever read.",
  );
  lines.push("");

  lines.push("## the matrix");
  for (const viewport of report.viewports) {
    lines.push(
      `${viewport.label}: ${viewport.width}x${viewport.height}, ${viewport.chromeRegions} chrome region(s), ${viewport.contentRegions} content region(s)`,
    );
  }
  lines.push("");

  lines.push("## per viewport");
  for (const viewport of report.viewports) {
    lines.push("");
    lines.push(`### ${viewport.label}`);
    lines.push(
      `chrome: ${viewport.chrome.differing}/${viewport.chrome.total} pixels differ (${percent(viewport.chrome.share)}), mean|delta| ${viewport.chrome.meanAbsolute.toFixed(3)}, max channel ${viewport.chrome.maxChannel}, over-threshold ${viewport.chrome.visible}`,
    );
    lines.push(
      `content: ${viewport.content.differing}/${viewport.content.total} pixels differ (${percent(viewport.content.share)}), mean|delta| ${viewport.content.meanAbsolute.toFixed(3)}, max channel ${viewport.content.maxChannel}, over-threshold ${viewport.content.visible}`,
    );
    lines.push(
      `whole frame: ${viewport.whole.differing}/${viewport.whole.total} pixels differ (${percent(viewport.whole.share)}), mean|delta| ${viewport.whole.meanAbsolute.toFixed(3)}`,
    );
    if (viewport.chromeRegions === 0) {
      // A zero over zero reads as a perfect score. It is not one: at this width both stylesheets
      // stand every chrome column down, so there is no shell furniture on either page to compare and
      // the shell's own verdict is carried by the content regions and the box deltas instead.
      lines.push(
        "chrome: this viewport carries no chrome region, because both pages stand the sidebar, the resizer and the pane down below their breakpoints. A 0/0 here is an empty set, not a pass; the shell's evidence at this width is the box deltas below.",
      );
    }
    lines.push(`digests: app ${viewport.digests.app}, export ${viewport.digests.export}`);
    for (const region of viewport.regions) lines.push(regionLine(region));
    lines.push(overflowLine(viewport.overflow, "app"));
    if (viewport.repeat === null) {
      lines.push("repeat: this run captured each viewport once");
    } else {
      const { app, export: exported } = viewport.repeat;
      lines.push(
        `repeat: a second capture of the same viewport differs from the first by ${app.differing}/${app.total} app pixel(s) (max channel ${app.maxChannel}) and ${exported.differing}/${exported.total} export pixel(s) (max channel ${exported.maxChannel}), so both captures are ${viewport.repeat.identical ? "pixel-identical" : "NOT pixel-identical"} across two shots`,
      );
    }
    lines.push(`files: ${viewport.files.join(", ")}`);
  }

  lines.push("");
  lines.push("## the box deltas");
  lines.push(
    "One line per region, the source rectangle against the same rectangle on the other page. This is where a structural difference between the two pages becomes a number.",
  );
  for (const viewport of report.viewports) {
    const rows = viewport.regions.filter((region) => region.boxDelta !== null);
    const differing = rows.filter((region) => region.boxDelta?.agree === false);
    lines.push(
      `${viewport.label}: ${rows.length} region(s) comparable, ${differing.length} with differing boxes${differing.length === 0 ? "" : ` (${differing.map((region) => region.id).join(", ")})`}`,
    );
    for (const region of differing) {
      const delta = region.boxDelta;
      if (delta === null) continue;
      lines.push(
        `  ${region.kind.padEnd(7)} ${region.id.padEnd(28)} left ${delta.left}, top ${delta.top}, width ${delta.width}, height ${delta.height}`,
      );
    }
  }

  lines.push("");
  lines.push("## the summary table");
  lines.push(
    "| # | viewport | chrome regions | chrome differing | chrome share | content regions | content share | whole share | boxes differing |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const viewport of report.viewports) {
    const boxes = viewport.regions.filter((region) => region.boxDelta?.agree === false).length;
    lines.push(
      `| ${viewport.index} | ${viewport.name} ${viewport.width}x${viewport.height} | ${viewport.chromeRegions} | ${viewport.chrome.differing}/${viewport.chrome.total} | ${percent(viewport.chrome.share)} | ${viewport.contentRegions} | ${percent(viewport.content.share)} | ${percent(viewport.whole.share)} | ${boxes} |`,
    );
  }

  lines.push("");
  lines.push("## verdict");
  if (report.failures.length === 0) {
    lines.push(
      "no chrome region exceeded its tolerance and every chrome region's counterpart agreed",
    );
  } else {
    for (const failure of report.failures) lines.push(`FAIL ${failure}`);
  }
  lines.push("");
  lines.push(`RESULT: ${report.verdict}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/** The machine-readable summary: one line per viewport, plus the verdict. */
export interface JsonSummary {
  readonly command: string;
  readonly commit: string;
  readonly shortSha: string;
  readonly chrome: string;
  readonly chromeTolerance: number;
  readonly verdict: "PASS" | "FAIL";
  readonly failures: readonly string[];
  readonly viewports: readonly {
    readonly label: string;
    readonly name: string;
    readonly width: number;
    readonly height: number;
    readonly chromeDiffering: number;
    readonly chromeTotal: number;
    readonly chromeShare: number;
    readonly contentDiffering: number;
    readonly contentTotal: number;
    readonly contentShare: number;
    readonly wholeShare: number;
    readonly boxesDiffering: number;
    readonly chromeRegions: readonly {
      readonly id: string;
      readonly status: RegionStatus;
      readonly differing: number | null;
      readonly total: number | null;
      readonly maxChannel: number | null;
    }[];
  }[];
}

export function renderJson(report: RunReport): string {
  const summary: JsonSummary = {
    command: report.command,
    commit: report.commit,
    shortSha: report.shortSha,
    chrome: report.chrome,
    chromeTolerance: report.chromeTolerance,
    verdict: report.verdict,
    failures: report.failures,
    viewports: report.viewports.map((viewport) => ({
      label: viewport.label,
      name: viewport.name,
      width: viewport.width,
      height: viewport.height,
      chromeDiffering: viewport.chrome.differing,
      chromeTotal: viewport.chrome.total,
      chromeShare: viewport.chrome.share,
      contentDiffering: viewport.content.differing,
      contentTotal: viewport.content.total,
      contentShare: viewport.content.share,
      wholeShare: viewport.whole.share,
      boxesDiffering: viewport.regions.filter((region) => region.boxDelta?.agree === false).length,
      chromeRegions: viewport.regions
        .filter((region) => region.kind === "chrome")
        .map((region) => ({
          id: region.id,
          status: region.status,
          differing: region.stat?.differing ?? null,
          total: region.stat?.total ?? null,
          maxChannel: region.stat?.maxChannel ?? null,
        })),
    })),
  };
  return `${JSON.stringify(summary, null, 2)}\n`;
}

export interface Stability {
  readonly same: boolean;
  readonly epsilon: number;
  readonly lines: readonly string[];
}

/**
 * Compare two runs' chrome statistics, viewport by viewport and region by region.
 *
 * This is the two-run proof order 36's acceptance asks for, as a command rather than a paragraph.
 * The verdict is exact equality of the differing-pixel count, with the largest channel difference
 * reported beside it so a reader can see that a zero came from identical pixels and not from a
 * region that was never compared.
 */
export function compareRuns(left: RunReport, right: RunReport, epsilon = 0): Stability {
  const lines: string[] = [];
  let same = true;
  const byLabel = new Map(right.viewports.map((viewport) => [viewport.label, viewport]));
  for (const a of left.viewports) {
    const b = byLabel.get(a.label);
    if (b === undefined) {
      same = false;
      lines.push(`FAIL ${a.label}: the second run has no such viewport`);
      continue;
    }
    for (const region of a.regions.filter((entry) => entry.kind === "chrome")) {
      const twin = b.regions.find((entry) => entry.id === region.id);
      const mine = region.stat;
      const theirs = twin?.stat ?? null;
      if (mine === null || theirs === null) {
        const both = mine === null && theirs === null;
        if (!both) same = false;
        lines.push(
          `${both ? "ok  " : "FAIL"} ${a.label} ${region.id}: ${mine === null ? "absent" : "measured"} then ${theirs === null ? "absent" : "measured"}`,
        );
        continue;
      }
      const delta = Math.abs(mine.differing - theirs.differing);
      const ok = delta <= epsilon;
      if (!ok) same = false;
      lines.push(
        `${ok ? "ok  " : "FAIL"} ${a.label} ${region.id}: ${mine.differing}/${mine.total} then ${theirs.differing}/${theirs.total}, differing-pixel delta ${delta}; max channel ${mine.maxChannel} then ${theirs.maxChannel}`,
      );
    }
    const chromeA = a.chrome;
    const chromeB = b.chrome;
    const ok = Math.abs(chromeA.differing - chromeB.differing) <= epsilon;
    if (!ok) same = false;
    lines.push(
      `${ok ? "ok  " : "FAIL"} ${a.label} chrome total: ${chromeA.differing}/${chromeA.total} then ${chromeB.differing}/${chromeB.total}, delta ${Math.abs(chromeA.differing - chromeB.differing)}`,
    );
  }
  return { same, epsilon, lines };
}
