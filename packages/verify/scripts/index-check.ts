#!/usr/bin/env bun
/**
 * The verification record checker: no row may disagree with its artifact, and the rendered index may
 * not disagree with the rows.
 *
 * `docs/verification/` is the record; `docs/VERIFICATION.md` is rendered from it. For every row
 * that names an artifact this checker asserts:
 *
 * 1. the artifact exists and is `artifacts/<feature>/<short-sha>/<file>`;
 * 2. the artifact directory's short sha is a prefix of the row's Commit cell;
 * 3. the artifact's own `git sha:` header equals that commit (a run that predates the header may
 *    declare `legacy-header`, and the artifact must then carry the commit itself or say nothing);
 * 4. the artifact's final `RESULT:` line is `PASS`;
 * 5. the count the row claims equals that line's tally, or the row declares `legacy-count` with the
 *    reason its old run carries no counted line. An undeclared claim with no tally fails, so a new
 *    row cannot repeat the four legacy rows' shape;
 * 6. the row's red-driver lines equal the drivers the governing sweep found red for it;
 * 7. a duplicated feature fails;
 * 8. the rendered index equals a fresh render of the record at the base the index records.
 *
 * Two rules are reported without failing, because the record cannot fix them and the index would go
 * red on evidence nobody is claiming:
 *
 * - an artifact newer than every named run of its feature is a FLAG: the newest evidence has no row;
 * - a row older than a newer run of the same feature gets an "Older run" note in its At main cell,
 *   which names the newer run and says this row keeps the run it certifies.
 *
 * `scaffold` and `type-gate` write a fresh artifact on every `bun run verify`, so failing on an
 * unreferenced newest run would red every unit's PR for a run that proves the same shape. That is
 * why the unreferenced rule flags rather than fails.
 *
 * Run from the repo root: `bun packages/verify/scripts/index-check.ts [--record <dir>] [--index <path>]`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ArtifactResult,
  artifactPaths,
  type CheckClaim,
  claimedCheckCount,
  describeClaim,
  INDEX_PATH,
  indexBase,
  loadRecord,
  RECORD_DIR,
  readResult,
  renderIndex,
  statedCommit,
  type VerificationRow,
} from "../src/verification-record.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");

export { artifactPaths, parseRows } from "../src/verification-record.ts";

const SHORT = 7;

type ArtifactCheck = {
  path: string;
  shortSha: string;
  result: ArtifactResult | null;
  stated: "header" | "mentioned" | "legacy" | "missing";
};

export type RowCheck = {
  row: VerificationRow;
  claimed: CheckClaim | null;
  artifacts: ArtifactCheck[];
  problems: string[];
  legacy: string[];
  notes: string[];
  behind: number | null;
};

export type Report = {
  record: string;
  index: string;
  base: string;
  rows: RowCheck[];
  tableProblems: string[];
  duplicates: string[];
  failures: string[];
  flags: string[];
  legacyCount: string[];
  legacyHeader: string[];
  checkedRows: number;
  artifactCount: number;
  checks: number;
  passed: number;
  ok: boolean;
};

export type CheckOptions = {
  recordDir?: string;
  indexPath?: string;
  base?: string;
  checkDrift?: boolean;
};

type SweepResult = { status: "PASS" | "FAIL" | "SKIP"; line: string; proof: string | null };

type Driver = { id: string; command: string };

type Run = { feature: string; sha: string };

type GitView = {
  /** Every commit reachable from the base, with its commit timestamp. */
  ancestors: Map<string, number>;
  /** The tracked artifact run directories. */
  runs: Run[];
  /** Commits in the base that are not in `sha`; null when `sha` is not an ancestor. */
  distance: (sha: string) => number | null;
  /** The full sha a run directory names, or null when it is not an ancestor of the base. */
  resolve: (short: string) => string | null;
  /** The newest tracked run of a feature that is an ancestor of the base. */
  newest: (feature: string) => string | null;
};

/** Resolve a run directory's name to the full commit it prefixes. */
export type ShortShaIndex = { resolve: (short: string) => string | null };

/**
 * Index full shas by their first seven characters, then match the whole name against those
 * candidates.
 *
 * `git rev-parse --short` returns more than seven characters when seven is ambiguous, so a run
 * directory can be named `abc1234d`. Indexing by the name itself would miss it. A name that matches
 * no ancestor, or more than one, resolves to null rather than to a guess.
 */
export function shortShaIndex(shas: Iterable<string>): ShortShaIndex {
  const all = new Set<string>();
  const byPrefix = new Map<string, string[]>();
  for (const sha of shas) {
    all.add(sha);
    const prefix = sha.slice(0, SHORT);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), sha]);
  }
  return {
    resolve: (short) => {
      if (all.has(short)) return short;
      const matches = (byPrefix.get(short.slice(0, SHORT)) ?? []).filter((sha) =>
        sha.startsWith(short),
      );
      return matches.length === 1 ? (matches[0] ?? null) : null;
    },
  };
}

function git(root: string, args: string[]): string | null {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "ignore" });
  return proc.exitCode === 0 ? proc.stdout.toString().trim() : null;
}

/** The artifact run directories git tracks, so an untracked local verify run is not evidence. */
function trackedRuns(root: string): Run[] {
  const listing = git(root, ["ls-files", "-z", "--", "packages/verify/artifacts"]);
  if (listing === null) return [];
  const prefix = "packages/verify/artifacts/";
  const seen = new Set<string>();
  const runs: Run[] = [];
  for (const path of listing.split("\0")) {
    if (!path.startsWith(prefix)) continue;
    const [feature, sha] = path.slice(prefix.length).split("/");
    if (feature === undefined || sha === undefined || !/^[0-9a-f]{7,40}$/.test(sha)) continue;
    if (seen.has(`${feature}/${sha}`)) continue;
    seen.add(`${feature}/${sha}`);
    runs.push({ feature, sha });
  }
  return runs;
}

/**
 * One git pass over the base's ancestry. The sweep and every run directory are ordered from this
 * map, and only a row's exact distance costs another call, so a record of 55 rows is seconds rather
 * than one `git` per artifact directory.
 */
function gitView(root: string, base: string): GitView {
  const ancestors = new Map<string, number>();
  const listing = git(root, ["rev-list", "--timestamp", base]);
  if (listing !== null) {
    for (const line of listing.split("\n")) {
      const [timestamp, sha] = line.trim().split(/\s+/);
      if (timestamp !== undefined && sha !== undefined) ancestors.set(sha, Number(timestamp));
    }
  }
  const shortIndex = shortShaIndex(ancestors.keys());
  const resolve = shortIndex.resolve;

  const distances = new Map<string, number | null>();
  const distance = (sha: string): number | null => {
    const key = resolve(sha) ?? sha;
    if (distances.has(key)) return distances.get(key) ?? null;
    let value: number | null = null;
    if (ancestors.has(key)) {
      const count = git(root, ["rev-list", "--count", `${key}..${base}`]);
      value = count === null ? null : Number(count);
    }
    distances.set(key, value);
    return value;
  };

  const runs = trackedRuns(root);
  const newestCache = new Map<string, string | null>();
  const newest = (feature: string): string | null => {
    if (newestCache.has(feature)) return newestCache.get(feature) ?? null;
    let best: { sha: string; timestamp: number } | null = null;
    for (const run of runs) {
      if (run.feature !== feature) continue;
      const full = resolve(run.sha);
      if (full === null) continue;
      const timestamp = ancestors.get(full) ?? 0;
      if (best === null || timestamp > best.timestamp) best = { sha: run.sha, timestamp };
    }
    const value = best?.sha ?? null;
    newestCache.set(feature, value);
    return value;
  };

  return { ancestors, runs, distance, resolve, newest };
}

function loadDrivers(root: string): Driver[] {
  try {
    const parsed = JSON.parse(
      readFileSync(join(root, "packages/verify/driver-subjects.json"), "utf8"),
    ) as {
      drivers?: Array<{ id?: unknown; command?: unknown }>;
    };
    return (parsed.drivers ?? []).flatMap((entry) =>
      typeof entry.id === "string" && typeof entry.command === "string"
        ? [{ id: entry.id, command: entry.command }]
        : [],
    );
  } catch {
    return [];
  }
}

function commandPaths(text: string): string[] {
  return [...text.matchAll(/[A-Za-z0-9_./@-]+\.tsx?/g)]
    .map((match) => match[0])
    .filter((path) => path.startsWith("packages/") || path.startsWith("apps/"));
}

function driverIds(row: VerificationRow, drivers: Driver[]): string[] {
  const paths = commandPaths(row.script);
  return drivers
    .filter((driver) => commandPaths(driver.command).some((path) => paths.includes(path)))
    .map((driver) => driver.id);
}

/** The newest tracked sweep artifact that is an ancestor of the base. */
function governingSweep(
  root: string,
  view: GitView,
): { sha: string; results: Map<string, SweepResult> } | null {
  const sha = view.newest("sweep-main");
  if (sha === null) return null;

  const text = readFileSync(
    join(root, "packages/verify/artifacts/sweep-main", sha, "sweep.txt"),
    "utf8",
  );
  const results = new Map<string, SweepResult>();
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(PASS|FAIL|SKIP) ([a-z0-9-]+):\s*(.*)$/);
    if (match === null) continue;
    const proofLine = lines[index + 1]?.match(/^\s+proof:\s*(\S+)/);
    results.set(match[2] ?? "", {
      status: match[1] as SweepResult["status"],
      line: (match[3] ?? "").trim(),
      proof: proofLine?.[1] ?? null,
    });
  }
  return { sha, results };
}

function redNote(driver: string, sweep: string, result: SweepResult): string {
  const verdict = result.line.match(/RESULT:\s*(?:PASS|FAIL)\s*\([^)]*\)/)?.[0] ?? result.line;
  const proof = result.proof === null ? "" : ` (proof ${result.proof})`;
  return `Red at main: the ${driver} driver failed ${verdict} in sweep ${sweep}${proof}`;
}

/**
 * The sentences a row's At main cell carries beyond its distance from the base: a red driver the
 * governing sweep found, and a newer run of the same feature that another row certifies.
 */
function rowNotes(
  row: VerificationRow,
  rows: VerificationRow[],
  drivers: Driver[],
  sweep: ReturnType<typeof governingSweep>,
  sweepView: GitView | null,
  view: GitView,
): { notes: string[]; problems: string[] } {
  const notes: string[] = [];
  const problems: string[] = [];

  const declared = new Map(row.redDrivers.map((entry) => [entry.driver, entry.sweep]));
  const expected = new Set<string>();

  if (sweep && sweepView?.ancestors.has(row.commit)) {
    for (const id of driverIds(row, drivers)) {
      const result = sweep.results.get(id);
      if (result?.status === "FAIL") expected.add(id);
    }
  }

  for (const id of expected) {
    if (!declared.has(id)) {
      problems.push(
        `row "${row.feature}": its ${id} driver is red in the governing sweep ${sweep?.sha.slice(0, SHORT)}, but the row carries no "red-driver: ${id}@${sweep?.sha.slice(0, SHORT)}"`,
      );
    }
  }
  for (const [id, declaredSweep] of declared) {
    if (!expected.has(id)) {
      problems.push(
        `row "${row.feature}": carries red-driver ${id}@${declaredSweep}, but that driver is not red for this row in the governing sweep${sweep === null ? " (no sweep found)" : ` ${sweep.sha.slice(0, SHORT)}`}; remove the line when the driver is green`,
      );
      continue;
    }
    if (sweep !== null && declaredSweep !== sweep.sha.slice(0, SHORT)) {
      problems.push(
        `row "${row.feature}": red-driver ${id} cites sweep ${declaredSweep}, but the governing sweep is ${sweep.sha.slice(0, SHORT)}`,
      );
      continue;
    }
    const result = sweep?.results.get(id);
    if (result !== undefined && sweep !== null)
      notes.push(redNote(id, sweep.sha.slice(0, SHORT), result));
  }

  const feature = firstArtifactFeature(row);
  if (feature !== null) {
    const newer = rows
      .filter((entry) => entry.file !== row.file && firstArtifactFeature(entry) === feature)
      .map((entry) => ({ entry, ahead: view.distance(entry.commit) }))
      .filter(
        (candidate): candidate is { entry: VerificationRow; ahead: number } =>
          candidate.ahead !== null,
      )
      .sort((a, b) => a.ahead - b.ahead)[0];
    const mine = view.distance(row.commit);
    if (newer !== undefined && mine !== null && newer.ahead < mine) {
      notes.push(
        `Older run: "${newer.entry.feature}" at ${newer.entry.commit.slice(0, SHORT)} re-ran this driver; this row keeps the run it certifies`,
      );
    }
  }

  return { notes, problems };
}

function firstArtifactFeature(row: VerificationRow): string | null {
  const path = artifactPaths(row.artifact)[0];
  if (path === undefined) return null;
  return path.match(/^packages\/verify\/artifacts\/([^/]+)\//)?.[1] ?? null;
}

/**
 * The At main notes for every row, computed exactly the way the checker computes them. The renderer
 * calls this so the committed table and the checker's fresh render agree by construction.
 */
export function atMainNotes(
  root: string,
  rows: VerificationRow[],
  base: string,
): Map<string, string[]> {
  const drivers = loadDrivers(root);
  const view = gitView(root, base);
  const sweep = governingSweep(root, view);
  const sweepView = sweep === null ? null : gitView(root, sweep.sha);
  const notes = new Map<string, string[]>();
  for (const row of rows) {
    notes.set(row.file, rowNotes(row, rows, drivers, sweep, sweepView, view).notes);
  }
  return notes;
}

function resolvePath(root: string, path: string): string {
  return isAbsolute(path) ? path : join(root, path);
}

/** Read the record and check every row, then the rendered index. */
export function checkRecord(root: string, options: CheckOptions = {}): Report {
  let checks = 0;
  const failures: string[] = [];
  const flags: string[] = [];
  const record = (ok: boolean, message: string): void => {
    checks += 1;
    if (!ok) failures.push(message);
  };

  const recordPath = resolvePath(root, options.recordDir ?? RECORD_DIR);
  const index = resolvePath(root, options.indexPath ?? INDEX_PATH);
  const loaded = loadRecord(root, recordPath);
  for (const problem of loaded.problems) record(false, `${problem.file}: ${problem.message}`);

  let indexText = "";
  try {
    indexText = readFileSync(index, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    record(false, `cannot read ${index}: ${reason}`);
  }

  const base =
    options.base ?? indexBase(indexText) ?? git(root, ["rev-parse", "HEAD"]) ?? "0".repeat(40);
  const drivers = loadDrivers(root);
  const view = gitView(root, base);
  const sweep = governingSweep(root, view);
  const sweepView = sweep === null ? null : gitView(root, sweep.sha);

  const duplicates: string[] = [];
  const byFeature = new Map<string, string[]>();
  for (const row of loaded.rows) {
    byFeature.set(row.feature, [...(byFeature.get(row.feature) ?? []), row.file]);
  }
  for (const [feature, files] of byFeature) {
    if (files.length > 1) {
      duplicates.push(feature);
      record(false, `duplicate feature "${feature}" in ${files.join(", ")}; one row per feature`);
    }
  }

  const rows: RowCheck[] = [];
  const legacyCount: string[] = [];
  const legacyHeader: string[] = [];
  let checkedRows = 0;
  let artifactCount = 0;

  for (const row of loaded.rows) {
    const claimed = claimedCheckCount(row.verdict);
    const paths = artifactPaths(row.artifact);
    const problems: string[] = [];
    const legacy: string[] = [];
    const artifacts: ArtifactCheck[] = [];

    const noted = rowNotes(row, loaded.rows, drivers, sweep, sweepView, view);
    problems.push(...noted.problems);
    for (const problem of noted.problems) record(false, problem);

    if (paths.length === 0) {
      if (row.artifact.includes("packages/verify/artifacts")) {
        const problem = `row "${row.feature}": the Artifact cell names a path that is not artifacts/<feature>/<short-sha>/<file>`;
        problems.push(problem);
        record(false, problem);
      }
      const behind = view.distance(row.commit);
      rows.push({ row, claimed, artifacts, problems, legacy, notes: noted.notes, behind });
      continue;
    }

    checkedRows += 1;

    for (const path of paths) {
      artifactCount += 1;
      const shape = path.match(/^packages\/verify\/artifacts\/([^/]+)\/([^/]+)\/([^/]+)$/);
      if (shape === null) {
        const problem = `row "${row.feature}": ${path} is not artifacts/<feature>/<short-sha>/<file>`;
        problems.push(problem);
        record(false, problem);
        artifacts.push({ path, shortSha: "", result: null, stated: "missing" });
        continue;
      }

      const shortSha = shape[2] ?? "";
      const shaOk = /^[0-9a-f]{7,40}$/.test(shortSha) && row.commit.startsWith(shortSha);
      const shaProblem = `row "${row.feature}": artifact directory short sha ${shortSha || "(empty)"} is not a prefix of commit ${row.commit || "(empty)"} — ${path}`;
      if (!shaOk) problems.push(shaProblem);
      record(shaOk, shaProblem);

      const absolute = join(root, path);
      let exists = false;
      try {
        exists = existsSync(absolute) && statSync(absolute).isFile();
      } catch {
        exists = false;
      }
      const missingProblem = `row "${row.feature}": artifact not found — ${path}`;
      if (!exists) problems.push(missingProblem);
      record(exists, missingProblem);

      let body = "";
      let result: ArtifactResult | null = null;
      if (exists) {
        try {
          body = readFileSync(absolute, "utf8");
          result = readResult(body);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const readProblem = `row "${row.feature}": cannot read artifact — ${path}: ${reason}`;
          problems.push(readProblem);
          record(false, readProblem);
        }
      }

      let stated: ArtifactCheck["stated"] = "missing";
      if (exists) {
        const said = statedCommit(body);
        if (said?.kind === "header") {
          stated = "header";
          const headerOk = said.sha === row.commit;
          const headerProblem = `row "${row.feature}": artifact header says commit ${said.sha}, the row says ${row.commit} — ${path}`;
          if (!headerOk) problems.push(headerProblem);
          record(headerOk, headerProblem);
        } else if (said?.kind === "mentioned" && !body.includes(row.commit)) {
          const headerProblem = `row "${row.feature}": artifact names commit ${said.sha}, the row says ${row.commit} — ${path}`;
          problems.push(headerProblem);
          record(false, headerProblem);
        } else if (body.includes(row.commit)) {
          stated = "mentioned";
        } else if (row.legacyHeader !== null && row.legacyHeader.trim() !== "") {
          stated = "legacy";
          legacy.push(`commit header: ${row.legacyHeader}`);
          legacyHeader.push(row.feature);
        } else {
          const headerProblem = `row "${row.feature}": the artifact carries no commit header matching ${row.commit} and the row declares no legacy-header — ${path}`;
          problems.push(headerProblem);
          record(false, headerProblem);
        }
      }

      if (result !== null) {
        const statusOk = result.status === "PASS";
        const statusProblem = `row "${row.feature}": artifact's final result is ${result.status} — ${path}: ${result.line}`;
        if (!statusOk) problems.push(statusProblem);
        record(statusOk, statusProblem);
      }

      if (claimed !== null) {
        if (result !== null && result.kind === "counted") {
          const countOk =
            claimed.passed === result.passed &&
            (claimed.total === null || claimed.total === result.total);
          const countProblem = `row "${row.feature}": ${describeClaim(claimed)}, artifact says ${result.passed}/${result.total} — ${path}`;
          if (!countOk) problems.push(countProblem);
          record(countOk, countProblem);
        } else if (row.legacyCount !== null && row.legacyCount.trim() !== "") {
          legacy.push(`count: ${row.legacyCount}`);
          if (!legacyCount.includes(row.feature)) legacyCount.push(row.feature);
        } else {
          const countProblem = `row "${row.feature}": ${describeClaim(claimed)}, but the artifact carries no counted RESULT line — ${path}; a new row must carry one, and legacy-count is only for a run that predates the tally`;
          problems.push(countProblem);
          record(false, countProblem);
        }
      }

      artifacts.push({ path, shortSha, result, stated });
    }

    if (row.legacyCount !== null && row.legacyCount.trim() === "") {
      const problem = `row "${row.feature}": legacy-count is empty; it must say why the run carries no counted RESULT line`;
      problems.push(problem);
      record(false, problem);
    }
    if (row.legacyHeader !== null && row.legacyHeader.trim() === "") {
      const problem = `row "${row.feature}": legacy-header is empty; it must say why the run carries no commit header`;
      problems.push(problem);
      record(false, problem);
    }

    const behind = view.distance(row.commit);
    if (behind === null) {
      const problem = `row "${row.feature}": commit ${row.commit} is not an ancestor of the index base ${base}`;
      problems.push(problem);
      record(false, problem);
    }

    rows.push({ row, claimed, artifacts, problems, legacy, notes: noted.notes, behind });
  }

  const namedRuns = new Set<string>();
  for (const row of loaded.rows) {
    for (const path of artifactPaths(row.artifact)) {
      const shape = path.match(/^packages\/verify\/artifacts\/([^/]+)\/([^/]+)\//);
      if (shape !== null) namedRuns.add(`${shape[1]}/${shape[2]}`);
    }
  }
  const features = new Set([...namedRuns].map((entry) => entry.split("/")[0] ?? ""));
  for (const feature of features) {
    if (feature === "") continue;
    const sha = view.newest(feature);
    if (sha !== null && !namedRuns.has(`${feature}/${sha}`)) {
      flags.push(
        `unreferenced artifact ${feature}/${sha.slice(0, SHORT)}: no row names the newest run of this feature`,
      );
    }
  }

  if (options.checkDrift !== false) {
    const rendered = renderIndex(loaded.rows, {
      base,
      behind: (row) => view.distance(row.commit),
      notes: (row) => rows.find((entry) => entry.row.file === row.file)?.notes ?? [],
    });
    const driftOk = rendered === indexText;
    record(
      driftOk,
      `generated index ${index} differs from a fresh render of ${recordPath} at base ${base}; run bun packages/verify/scripts/render-index.ts`,
    );
  }

  const ok = failures.length === 0;
  return {
    record: recordPath,
    index,
    base,
    rows,
    tableProblems: loaded.problems.map((problem) => `${problem.file}: ${problem.message}`),
    duplicates,
    failures,
    flags,
    legacyCount,
    legacyHeader,
    checkedRows,
    artifactCount,
    checks,
    passed: checks - failures.length,
    ok,
  };
}

export function formatReport(report: Report, root: string): string {
  const lines: string[] = [];
  const shown = (path: string): string =>
    path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  lines.push(
    `index-check: ${shown(report.record)} → ${shown(report.index)} (base ${report.base.slice(0, SHORT)})`,
  );

  for (const row of report.rows) {
    const name = row.row.feature;
    if (row.artifacts.length === 0) {
      if (row.problems.length === 0) {
        lines.push(`SKIP row "${name}": docs-only, no artifact path`);
      } else {
        for (const problem of row.problems) lines.push(`FAIL ${problem}`);
      }
      continue;
    }

    if (row.problems.length > 0) {
      for (const problem of row.problems) lines.push(`FAIL ${problem}`);
      continue;
    }

    if (row.legacy.length > 0) {
      const noted = row.legacy.map((entry) => `${entry}`).join("; ");
      lines.push(
        `LEGACY row "${name}": ${noted} — ${row.artifacts.map((artifact) => artifact.path).join(", ")}`,
      );
      continue;
    }

    const counts = row.artifacts.flatMap((artifact) =>
      artifact.result !== null && artifact.result.kind === "counted"
        ? [`${artifact.result.passed}/${artifact.result.total}`]
        : [],
    );
    const checked = counts.length > 0 ? `${counts.join(", ")} checks` : "artifact and commit agree";
    lines.push(
      `PASS row "${name}": ${checked} — ${row.artifacts.map((artifact) => artifact.path).join(", ")}`,
    );
  }

  for (const flag of report.flags) lines.push(`FLAG ${flag}`);
  for (const problem of report.tableProblems) lines.push(`FAIL ${problem}`);

  const legacyCount = report.legacyCount.length === 0 ? "none" : report.legacyCount.join(", ");
  const legacyHeader = report.legacyHeader.length === 0 ? "none" : report.legacyHeader.join(", ");
  lines.push(
    "",
    `checked rows: ${report.checkedRows} (${report.artifactCount} artifacts)`,
    `flags: ${report.flags.length}`,
    `legacy count rows: ${report.legacyCount.length} (${legacyCount})`,
    `legacy header rows: ${report.legacyHeader.length} (${legacyHeader})`,
    `duplicates: ${report.duplicates.length === 0 ? "none" : report.duplicates.join(", ")}`,
    `RESULT: ${report.ok ? "PASS" : "FAIL"} (${report.passed}/${report.checks})`,
  );
  return lines.join("\n");
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const record = flag("--record");
  const index = flag("--index");
  const base = flag("--base");
  const report = checkRecord(repoRoot, {
    ...(record === undefined ? {} : { recordDir: resolve(record) }),
    ...(index === undefined ? {} : { indexPath: resolve(index) }),
    ...(base === undefined ? {} : { base }),
  });
  console.log(formatReport(report, repoRoot));
  process.exitCode = report.ok ? 0 : 1;
}
