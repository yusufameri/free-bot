/**
 * The verification record as data.
 *
 * `docs/verification/` holds one file per row. Each file is written by the unit that produced the
 * row. `docs/VERIFICATION.md` is rendered from those files by `scripts/render-index.ts`; nobody
 * edits the table. This module owns the file format, the renderer and the artifact readers the
 * checker shares with the prune.
 *
 * The row format is one `key: value` per line. A value is one table cell, reproduced in the
 * rendered table, so it may not carry a pipe (that would break the table) or a newline (the format
 * is line-oriented).
 */

import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const RECORD_DIR = join("docs", "verification");
export const INDEX_PATH = join("docs", "VERIFICATION.md");

export const ARTIFACT_PATH = /packages\/verify\/artifacts\/[A-Za-z0-9._/-]+/g;
export const ARTIFACT_SHAPE = /^packages\/verify\/artifacts\/([^/]+)\/([^/]+)\/([^/]+)$/;
export const SHORT_SHA = /^[0-9a-f]{7,40}$/;
export const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * A row's own statement that its driver is red against the sweep at `sweep`.
 *
 * The checker compares this set with the governing sweep artifact, so the line cannot be kept
 * after a green sweep and cannot be omitted while the driver is red.
 */
export type RedDriver = { driver: string; sweep: string };

export type VerificationRow = {
  /** The file's basename, which is the row's stable identity in the record. */
  file: string;
  feature: string;
  script: string;
  verdict: string;
  artifact: string;
  commit: string;
  date: string;
  /**
   * A count claim this run cannot back with a counted `RESULT:` line. The reason is prose a reader
   * checks; its presence is what makes the row legacy rather than a new unbacked claim.
   */
  legacyCount: string | null;
  /** An artifact that predates the writer's commit header. Same contract as `legacyCount`. */
  legacyHeader: string | null;
  redDrivers: RedDriver[];
};

export type RecordProblem = { file: string; message: string };

const REQUIRED = ["feature", "script", "verdict", "artifact", "commit", "date"] as const;
const OPTIONAL = ["legacy-count", "legacy-header", "red-driver"] as const;
const KEYS = new Set<string>([...REQUIRED, ...OPTIONAL]);

/** A cell that cannot be a table cell is a parse error, not something the renderer has to escape. */
function badCell(value: string): boolean {
  return value.includes("|") || value.includes("\n") || value.includes("\r");
}

/**
 * Parse one row file. Every unknown key, missing key and malformed value is reported; the caller
 * decides whether to keep the row. A duplicated non-repeatable key is a problem, because the last
 * value would otherwise win silently.
 */
export function parseRow(
  file: string,
  text: string,
): {
  row: VerificationRow | null;
  problems: RecordProblem[];
} {
  const problems: RecordProblem[] = [];
  const values = new Map<string, string>();
  const redDrivers: RedDriver[] = [];

  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = line.match(/^([a-z][a-z-]*):\s*(.*)$/);
    if (match === null) {
      problems.push({
        file,
        message: `line ${index + 1}: expected "key: value", found ${JSON.stringify(line)}`,
      });
      continue;
    }
    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    if (!KEYS.has(key)) {
      problems.push({ file, message: `line ${index + 1}: unknown key "${key}"` });
      continue;
    }
    if (key === "red-driver") {
      const claim = value.match(/^([a-z0-9-]+)@([0-9a-f]{7,40})$/);
      if (claim === null) {
        problems.push({
          file,
          message: `line ${index + 1}: red-driver must read "<driver>@<short-sha>", found ${JSON.stringify(value)}`,
        });
        continue;
      }
      redDrivers.push({ driver: claim[1] ?? "", sweep: claim[2] ?? "" });
      continue;
    }
    if (values.has(key)) {
      problems.push({ file, message: `line ${index + 1}: "${key}" appears more than once` });
      continue;
    }
    if (badCell(value)) {
      problems.push({ file, message: `line ${index + 1}: "${key}" carries a pipe or a newline` });
      continue;
    }
    values.set(key, value);
  }

  for (const key of REQUIRED) {
    if (!values.has(key)) problems.push({ file, message: `missing "${key}"` });
  }
  const commit = values.get("commit") ?? "";
  if (commit !== "" && !FULL_SHA.test(commit)) {
    problems.push({ file, message: `commit "${commit}" is not a full 40-character git sha` });
  }
  const date = values.get("date") ?? "";
  if (date !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    problems.push({ file, message: `date "${date}" is not YYYY-MM-DD` });
  }

  if (problems.length > 0) return { row: null, problems };
  return {
    row: {
      file,
      feature: values.get("feature") ?? "",
      script: values.get("script") ?? "",
      verdict: values.get("verdict") ?? "",
      artifact: values.get("artifact") ?? "",
      commit,
      date,
      legacyCount: values.get("legacy-count") ?? null,
      legacyHeader: values.get("legacy-header") ?? null,
      redDrivers,
    },
    problems,
  };
}

/** Every row file in the record, in filename order. `README.md` is the narrative, not a row. */
export function loadRecord(
  root: string,
  directory = RECORD_DIR,
): { rows: VerificationRow[]; problems: RecordProblem[] } {
  const absolute = isAbsolute(directory) ? directory : join(root, directory);
  let names: string[];
  try {
    names = readdirSync(absolute);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      rows: [],
      problems: [{ file: directory, message: `cannot read ${directory}: ${reason}` }],
    };
  }

  const rows: VerificationRow[] = [];
  const problems: RecordProblem[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".md")).sort()) {
    if (name === "README.md") continue;
    const parsed = parseRow(name, readFileSync(join(absolute, name), "utf8"));
    problems.push(...parsed.problems);
    if (parsed.row !== null) rows.push(parsed.row);
  }
  return { rows, problems };
}

/** The base the committed index was rendered at, from its generated marker. */
export function indexBase(text: string): string | null {
  return text.match(/<!-- verification-index base: ([0-9a-f]{40}) -->/)?.[1] ?? null;
}

export type RenderContext = {
  base: string;
  /** Commits between the row's commit and the base, or null when the commit is not an ancestor. */
  behind: (row: VerificationRow) => number | null;
  /** Extra sentences for the row's At main cell: a red driver, or a newer run that supersedes it. */
  notes: (row: VerificationRow) => string[];
};

function dayOf(row: VerificationRow): string {
  return row.date;
}

/** The index, rendered deterministically. The six authored cells are reproduced verbatim. */
export function renderIndex(rows: VerificationRow[], context: RenderContext): string {
  const ordered = [...rows].sort((a, b) => {
    if (dayOf(a) !== dayOf(b)) return dayOf(a) < dayOf(b) ? -1 : 1;
    if (a.feature !== b.feature) return a.feature < b.feature ? -1 : 1;
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
  });

  const lines = [
    "# Verification index",
    "",
    `<!-- verification-index base: ${context.base} -->`,
    "",
    "One row per verified run, per plan 9.3. Each row is a file under `docs/verification/`, written",
    "by the feature's own unit; this table is rendered from those files by",
    "`bun packages/verify/scripts/render-index.ts`. Edit the row file, never this table. A row names",
    "the commit its artifact was produced at, and the last column says how many commits behind this",
    "file's base that commit is. The narrative that used to sit beside these rows is in",
    "`docs/verification/README.md`.",
    "",
    "| Feature | Script | Verdict | Artifact | Commit | Date | At main |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const row of ordered) {
    const behind = context.behind(row);
    const notes = context.notes(row);
    const atMain = [
      behind === null ? "commit is not an ancestor of the base" : `${behind}`,
      ...notes,
    ].join("; ");
    lines.push(
      `| ${row.feature} | ${row.script} | ${row.verdict} | ${row.artifact} | ${row.commit} | ${row.date} | ${atMain} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

/** The data rows of a rendered table, for the prune and for old-table comparisons. */
export type TableRow = {
  feature: string;
  verdict: string;
  artifactCell: string;
  commit: string;
  atMain: string;
  line: number;
};

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
    if (cells.length !== 6 && cells.length !== 7) {
      problems.push(`line ${index + 1}: expected 6 or 7 table cells, found ${cells.length}`);
      return;
    }
    rows.push({
      feature: cells[0] ?? "",
      verdict: cells[2] ?? "",
      artifactCell: cells[3] ?? "",
      commit: cells[4] ?? "",
      atMain: cells[6] ?? "",
      line: index + 1,
    });
  });

  return { rows, problems };
}

/** Every artifact path the cell names. A cell may carry more than one, as the microsandbox row does. */
export function artifactPaths(cell: string): string[] {
  return [...cell.matchAll(ARTIFACT_PATH)].map((match) => match[0]);
}

export type ArtifactResult =
  | { kind: "counted"; line: string; status: "PASS" | "FAIL"; passed: number; total: number }
  | { kind: "uncounted"; line: string; status: "PASS" | "FAIL" };

/** A Verdict cell's claim: `total` is null for a bare `N checks`, set for a fraction. */
export type CheckClaim = { passed: number; total: number | null };

/** The artifact's last top-level `RESULT:` line, counted when it carries `(n/n)`. */
export function readResult(body: string): ArtifactResult | null {
  const lines = body.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    const verdict = line.match(/^RESULT:\s*(PASS|FAIL)\b/);
    if (verdict === null) continue;
    const status = verdict[1] === "FAIL" ? "FAIL" : "PASS";
    const count = line.match(/\((\d+)\s*\/\s*(\d+)/);
    if (count === null) return { kind: "uncounted", line, status };
    return {
      kind: "counted",
      line,
      status,
      passed: Number(count[1]),
      total: Number(count[2]),
    };
  }
  return null;
}

/**
 * The check count a Verdict cell claims, or null when it claims none.
 *
 * A fraction attached to a count noun is a claim whatever its two sides are, so `115/116 checks`
 * claims 115 of 116 and never falls through to the bare-count fallback. A bare `N checks` claims N
 * passed with the total unknown.
 */
export function claimedCheckCount(verdict: string): CheckClaim | null {
  const total = verdict.match(/\b(\d+)\s*\/\s*(\d+)\s+total\b/);
  if (total !== null && Number(total[1]) > 0 && Number(total[2]) > 0) {
    return { passed: Number(total[1]), total: Number(total[2]) };
  }

  for (const match of verdict.matchAll(
    /\b(\d+)\s*\/\s*(\d+)\s+(?:[A-Za-z][A-Za-z-]*\s+)?(?:checks?|assertions?|tests?|probes?)\b/g,
  )) {
    if (Number(match[1]) > 0 && Number(match[2]) > 0) {
      return { passed: Number(match[1]), total: Number(match[2]) };
    }
  }

  const single = verdict.match(/\b(\d+)(?:-|\s+(?:[A-Za-z][A-Za-z-]*\s+)?)checks?\b/);
  return single === null ? null : { passed: Number(single[1]), total: null };
}

/** How a claim reads in a failure line, so a fraction is quoted as the fraction it is. */
export function describeClaim(claim: CheckClaim): string {
  return claim.total === null
    ? `claimed ${claim.passed} checks`
    : `claimed ${claim.passed}/${claim.total} checks`;
}

/** The full commit the artifact states, from a `git sha:` header or any full sha it prints. */
export function statedCommit(body: string): { sha: string; kind: "header" | "mentioned" } | null {
  const header = body.match(/^git sha:\s*([0-9a-f]{40})\s*$/m);
  if (header !== null) return { sha: header[1] ?? "", kind: "header" };
  const mentioned = body.match(/\b([0-9a-f]{40})\b/);
  if (mentioned !== null) return { sha: mentioned[1] ?? "", kind: "mentioned" };
  return null;
}
