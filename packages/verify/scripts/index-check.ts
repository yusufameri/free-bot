#!/usr/bin/env bun
/**
 * The verification index checker: no row may disagree with its artifact.
 *
 * `docs/VERIFICATION.md` carries one table row per verified feature, and every row that names an
 * artifact also names the commit that artifact was produced at. Nothing compared those cells with
 * the files they name, which is how two wrong check counts survived to main. This checker reads the
 * table and, for every row carrying an artifact path:
 *
 * 1. asserts the artifact file exists;
 * 2. asserts the artifact directory's short sha is a prefix of the row's Commit cell;
 * 3. asserts the check count the row claims equals the count in the artifact's own last `RESULT:`
 *    line.
 *
 * A row with no artifact path, the glossary for instance, is docs-only. It is skipped by name and
 * reported as skipped, never folded into the pass count. A row whose count claim cannot be compared
 * because its artifact carries no counted `RESULT:` line is reported as count-unverified rather
 * than failing: the claim is unknown, not contradicted. Four rows are in that state today, and the
 * report names every one.
 *
 * The claim is read from the Verdict cell. Three shapes count, in order: an explicit `N/N total`, a
 * fraction attached to a count noun (`39/39 assertions`, `7/7 browser probes`), and a bare
 * `N checks` or `N-check`. A fraction not attached to a count noun is not a claim: the
 * connector-credentials row says another driver "passes 57/57 at this head" while its own artifact
 * is the 37-check driver. The explicit total is what makes the composio row's `76/76 total` beat
 * its `19 new checks` in the same sentence.
 *
 * Run from the repo root: `bun packages/verify/scripts/index-check.ts [--table <path>]`.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");

const ARTIFACT_PATH =
  /packages\/verify\/artifacts\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/g;
const ARTIFACT_SHAPE = /^packages\/verify\/artifacts\/([^/]+)\/([^/]+)\/([^/]+)$/;
const SHORT_SHA = /^[0-9a-f]{7,40}$/;

export type TableRow = {
  feature: string;
  verdict: string;
  artifactCell: string;
  commit: string;
  line: number;
};

export type ArtifactResult =
  | { kind: "counted"; line: string; passed: number; total: number }
  | { kind: "uncounted"; line: string };

export type ArtifactCheck = {
  path: string;
  shortSha: string;
  result: ArtifactResult | null;
};

export type RowCheck = {
  row: TableRow;
  claimed: number | null;
  artifacts: ArtifactCheck[];
  problems: string[];
  countUnverified: boolean;
};

export type Report = {
  table: string;
  rows: RowCheck[];
  tableProblems: string[];
  failures: string[];
  docsOnly: string[];
  countUnverified: string[];
  checkedRows: number;
  artifactCount: number;
  checks: number;
  passed: number;
  ok: boolean;
};

/** The data rows of the table, in table order. Header and separator lines are not rows. */
export function parseRows(table: string): { rows: TableRow[]; problems: string[] } {
  const rows: TableRow[] = [];
  const problems: string[] = [];

  table.split("\n").forEach((line, index) => {
    if (!line.startsWith("|")) return;
    const cells = line
      .slice(1, line.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((cell) => cell.trim());
    if (cells[0] === "Feature") return;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return;
    if (cells.length !== 6) {
      problems.push(`line ${index + 1}: expected 6 table cells, found ${cells.length}`);
      return;
    }
    rows.push({
      feature: cells[0] ?? "",
      verdict: cells[2] ?? "",
      artifactCell: cells[3] ?? "",
      commit: cells[4] ?? "",
      line: index + 1,
    });
  });

  return { rows, problems };
}

/** Every artifact path the cell names. A cell may carry more than one, as the microsandbox row does. */
export function artifactPaths(cell: string): string[] {
  return [...cell.matchAll(ARTIFACT_PATH)].map((match) => match[0]);
}

/** The artifact's last top-level `RESULT:` line, counted when it carries `(n/n)`. */
export function readResult(body: string): ArtifactResult | null {
  const lines = body.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (!/^RESULT:\s*(PASS|FAIL)\b/.test(line)) continue;
    const count = line.match(/\((\d+)\s*\/\s*(\d+)/);
    if (count === null) return { kind: "uncounted", line };
    return { kind: "counted", line, passed: Number(count[1]), total: Number(count[2]) };
  }
  return null;
}

/** The check count a Verdict cell claims, or null when it claims none. */
export function claimedCheckCount(verdict: string): number | null {
  const total = verdict.match(/\b(\d+)\s*\/\s*(\d+)\s+total\b/);
  if (total !== null && total[1] === total[2] && Number(total[1]) > 0) {
    return Number(total[1]);
  }

  for (const match of verdict.matchAll(
    /\b(\d+)\s*\/\s*(\d+)\s+(?:[A-Za-z][A-Za-z-]*\s+)?(?:checks?|assertions?|tests?|probes?)\b/g,
  )) {
    if (match[1] === match[2] && Number(match[1]) > 0) return Number(match[1]);
  }

  const single = verdict.match(/\b(\d+)(?:-|\s+(?:[A-Za-z][A-Za-z-]*\s+)?)checks?\b/);
  return single === null ? null : Number(single[1]);
}

/**
 * Read the table and check every row that carries an artifact path. Artifact paths resolve against
 * `root`, not against the table's own directory, so a planted table in a temp directory can point
 * at the committed artifacts.
 */
export function checkIndex(root: string, tablePath: string): Report {
  let checks = 0;
  const failures: string[] = [];
  const record = (ok: boolean, message: string): void => {
    checks += 1;
    if (!ok) failures.push(message);
  };

  let table: string;
  try {
    table = readFileSync(tablePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      table: tablePath,
      rows: [],
      tableProblems: [`cannot read ${tablePath}: ${reason}`],
      failures: [`cannot read ${tablePath}: ${reason}`],
      docsOnly: [],
      countUnverified: [],
      checkedRows: 0,
      artifactCount: 0,
      checks: 1,
      passed: 0,
      ok: false,
    };
  }

  const parsed = parseRows(table);
  for (const problem of parsed.problems) record(false, problem);

  const rows: RowCheck[] = [];
  const docsOnly: string[] = [];
  const countUnverified: string[] = [];
  let checkedRows = 0;
  let artifactCount = 0;

  for (const row of parsed.rows) {
    const claimed = claimedCheckCount(row.verdict);
    const paths = artifactPaths(row.artifactCell);

    if (paths.length === 0) {
      const problems: string[] = [];
      if (row.artifactCell.includes("packages/verify/artifacts")) {
        const problem = `row "${row.feature}": the Artifact cell names a path that is not artifacts/<feature>/<short-sha>/<file>`;
        problems.push(problem);
        record(false, problem);
      } else {
        docsOnly.push(row.feature);
      }
      rows.push({ row, claimed, artifacts: [], problems, countUnverified: false });
      continue;
    }

    checkedRows += 1;
    const artifacts: ArtifactCheck[] = [];
    const problems: string[] = [];
    let rowUnverified = false;

    for (const path of paths) {
      artifactCount += 1;
      const shape = path.match(ARTIFACT_SHAPE);
      if (shape === null) {
        const problem = `row "${row.feature}": ${path} is not artifacts/<feature>/<short-sha>/<file>`;
        problems.push(problem);
        record(false, problem);
        artifacts.push({ path, shortSha: "", result: null });
        continue;
      }

      const shortSha = shape[2] ?? "";
      const shaOk = SHORT_SHA.test(shortSha) && row.commit.startsWith(shortSha);
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

      let result: ArtifactResult | null = null;
      if (exists) {
        try {
          result = readResult(readFileSync(absolute, "utf8"));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const readProblem = `row "${row.feature}": cannot read artifact — ${path}: ${reason}`;
          problems.push(readProblem);
          record(false, readProblem);
        }
      }

      if (claimed !== null) {
        if (result === null || result.kind === "uncounted") {
          rowUnverified = true;
        } else {
          const countOk = claimed === result.passed;
          const countProblem = `row "${row.feature}": claimed ${claimed} checks, artifact says ${result.passed}/${result.total} — ${path}`;
          if (!countOk) problems.push(countProblem);
          record(countOk, countProblem);
        }
      }

      artifacts.push({ path, shortSha, result });
    }

    if (rowUnverified) countUnverified.push(row.feature);
    rows.push({ row, claimed, artifacts, problems, countUnverified: rowUnverified });
  }

  const ok = failures.length === 0;
  return {
    table: tablePath,
    rows,
    tableProblems: parsed.problems,
    failures,
    docsOnly,
    countUnverified,
    checkedRows,
    artifactCount,
    checks,
    passed: checks - failures.length,
    ok,
  };
}

export function formatReport(report: Report, root: string): string {
  const lines: string[] = [];
  const table = report.table.startsWith(`${root}/`)
    ? report.table.slice(root.length + 1)
    : report.table;
  lines.push(`index-check: ${table}`);

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

    if (row.countUnverified) {
      lines.push(
        `UNVERIFIED row "${name}": artifact exists at the commit, but claimed ${row.claimed} checks and the artifact carries no counted RESULT line — ${row.artifacts.map((artifact) => artifact.path).join(", ")}`,
      );
      continue;
    }

    const counts =
      row.claimed === null
        ? []
        : row.artifacts.flatMap((artifact) => {
            if (artifact.result === null || artifact.result.kind !== "counted") return [];
            return [`${artifact.result.passed}/${artifact.result.total}`];
          });
    const checked = counts.length > 0 ? `${counts.join(", ")} checks` : "artifact and commit agree";
    lines.push(
      `PASS row "${name}": ${checked} — ${row.artifacts.map((artifact) => artifact.path).join(", ")}`,
    );
  }

  for (const problem of report.tableProblems) lines.push(`FAIL ${problem}`);

  const docs = report.docsOnly.length === 0 ? "none" : report.docsOnly.join(", ");
  const unverified =
    report.countUnverified.length === 0 ? "none" : report.countUnverified.join(", ");
  lines.push(
    "",
    `checked rows: ${report.checkedRows} (${report.artifactCount} artifacts)`,
    `skipped rows: ${report.docsOnly.length} (docs-only: ${docs})`,
    `count unverified: ${report.countUnverified.length} (${unverified})`,
    `RESULT: ${report.ok ? "PASS" : "FAIL"} (${report.passed}/${report.checks})`,
  );
  return lines.join("\n");
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const flag = args.indexOf("--table");
  const table =
    flag >= 0 && args[flag + 1] !== undefined
      ? resolve(args[flag + 1] as string)
      : join(repoRoot, "docs", "VERIFICATION.md");
  const report = checkIndex(repoRoot, table);
  console.log(formatReport(report, repoRoot));
  process.exitCode = report.ok ? 0 : 1;
}
