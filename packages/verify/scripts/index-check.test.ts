/**
 * The index checker's contract: the record and its artifacts agree, the rendered index is a fresh
 * render, and the two rows that reached main with a wrong count are caught when put back.
 *
 * Every planted record is a copy of the committed one with named cells rewritten, so every other
 * row, artifact and commit in the run is real. Artifacts resolve against the repo root, which is
 * why the planted record can live in a temp directory.
 */

import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactPaths, loadRecord } from "../src/verification-record.ts";
import { checkRecord } from "./index-check.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const realRecord = join(repoRoot, "docs", "verification");
const realIndex = join(repoRoot, "docs", "VERIFICATION.md");

function plantedRecord(): string {
  const dir = mkdtempSync(join(tmpdir(), "freebot-record-"));
  cpSync(realRecord, dir, { recursive: true });
  return dir;
}

function rowPath(dir: string, feature: string): string {
  for (const name of readdirSync(dir).filter(
    (entry) => entry.endsWith(".md") && entry !== "README.md",
  )) {
    const path = join(dir, name);
    const text = readFileSync(path, "utf8");
    if (text.includes(`\nfeature: ${feature}\n`) || text.startsWith(`feature: ${feature}\n`))
      return path;
  }
  throw new Error(`no row file for ${feature}`);
}

function rewrite(dir: string, feature: string, edit: (text: string) => string): void {
  const path = rowPath(dir, feature);
  writeFileSync(path, edit(readFileSync(path, "utf8")));
}

/** The launch row as it stood before U8.x: 114 claimed against an artifact that says 116/116. */
function plantLaunch(dir: string): void {
  rewrite(dir, "launch (U10.13)", (text) =>
    text.replace("live-ui-verified (116/116 checks", "live-ui-verified (114 checks"),
  );
}

/** The files surface row as it stood: 53 claimed against an artifact that says 54/54. */
function plantFilesSurface(dir: string): void {
  rewrite(dir, "files surface", (text) =>
    text.replace("live-ui-verified (54 checks", "live-ui-verified (53 checks"),
  );
}

describe("the verification record checker", () => {
  test("the committed record agrees with every artifact and with its rendered index", () => {
    const report = checkRecord(repoRoot);
    const loaded = loadRecord(repoRoot);

    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.rows).toHaveLength(loaded.rows.length);
    expect(report.checkedRows).toBe(
      loaded.rows.filter((row) => artifactPaths(row.artifact).length > 0).length,
    );
    expect(report.rows.find((row) => row.row.feature === "glossary")?.artifacts).toEqual([]);
    expect(report.duplicates).toEqual([]);
    expect(report.legacyCount).toHaveLength(4);
    expect(report.legacyHeader.length).toBeGreaterThan(0);
  });

  test("the glossary is skipped by name, not counted as checked", () => {
    const report = checkRecord(repoRoot);

    expect(report.rows.find((row) => row.row.feature === "glossary")?.artifacts).toEqual([]);
  });

  test("the launch row's old 114 is caught by name against its 116/116 artifact", () => {
    const dir = plantedRecord();
    plantLaunch(dir);

    const report = checkRecord(repoRoot, { recordDir: dir, checkDrift: false });

    expect(report.ok).toBe(false);
    const failures = report.failures.join("\n");
    expect(failures).toContain('row "launch (U10.13)"');
    expect(failures).toContain("claimed 114 checks");
    expect(failures).toContain("artifact says 116/116");
  });

  test("the files surface row's old 53 is caught by name against its 54/54 artifact", () => {
    const dir = plantedRecord();
    plantFilesSurface(dir);

    const report = checkRecord(repoRoot, { recordDir: dir, checkDrift: false });

    expect(report.ok).toBe(false);
    const failures = report.failures.join("\n");
    expect(failures).toContain('row "files surface"');
    expect(failures).toContain("claimed 53 checks");
    expect(failures).toContain("artifact says 54/54");
  });

  test("both wrong rows at once are reported one by one", () => {
    const dir = plantedRecord();
    plantLaunch(dir);
    plantFilesSurface(dir);

    const report = checkRecord(repoRoot, { recordDir: dir, checkDrift: false });

    expect(report.ok).toBe(false);
    expect(report.failures.filter((line) => line.includes("artifact says"))).toHaveLength(2);
    const failures = report.failures.join("\n");
    expect(failures).toContain('row "launch (U10.13)"');
    expect(failures).toContain('row "files surface"');
  });

  test("an undeclared count claim with no counted RESULT line fails as a new row, not a legacy one", () => {
    const dir = plantedRecord();
    rewrite(dir, "pi-rpc-spike", (text) =>
      text
        .split("\n")
        .filter((line) => !line.startsWith("legacy-count:"))
        .join("\n"),
    );

    const report = checkRecord(repoRoot, { recordDir: dir, checkDrift: false });

    expect(report.ok).toBe(false);
    expect(report.failures.join("\n")).toContain(
      'row "pi-rpc-spike": claimed 39/39 checks, but the artifact carries no counted RESULT line',
    );
    expect(report.legacyCount).not.toContain("pi-rpc-spike");
  });

  test("a declared legacy count passes and is reported as legacy", () => {
    const report = checkRecord(repoRoot);
    const piRpc = report.rows.find((row) => row.row.feature === "pi-rpc-spike");

    expect(report.ok).toBe(true);
    expect(report.legacyCount).toContain("pi-rpc-spike");
    expect(piRpc?.legacy.some((line) => line.startsWith("count:"))).toBe(true);
  });

  test("a duplicated feature fails by name", () => {
    const dir = plantedRecord();
    copyFileSync(rowPath(dir, "launch (U10.13)"), join(dir, "launch-duplicate.md"));

    const report = checkRecord(repoRoot, { recordDir: dir, checkDrift: false });

    expect(report.ok).toBe(false);
    expect(report.duplicates).toContain("launch (U10.13)");
    expect(report.failures.join("\n")).toContain('duplicate feature "launch (U10.13)"');
  });

  test("an artifact header that disagrees with the row's commit fails even when the short sha matches", () => {
    const dir = plantedRecord();
    rewrite(dir, "launch (U10.13)", (text) =>
      text.replace(/^commit: [0-9a-f]{40}$/m, `commit: b917c1f${"0".repeat(33)}`),
    );

    const report = checkRecord(repoRoot, { recordDir: dir, checkDrift: false });

    expect(report.ok).toBe(false);
    expect(report.failures.join("\n")).toContain("artifact header says commit");
  });

  test("an artifact with no commit header and no legacy-header declaration fails", () => {
    const dir = plantedRecord();
    rewrite(dir, "web chat surface", (text) =>
      text
        .split("\n")
        .filter((line) => !line.startsWith("legacy-header:"))
        .join("\n"),
    );

    const report = checkRecord(repoRoot, { recordDir: dir, checkDrift: false });

    expect(report.ok).toBe(false);
    expect(report.failures.join("\n")).toContain(
      'row "web chat surface": the artifact carries no commit header',
    );
  });

  test("the rendered index drifting from the record fails", () => {
    const dir = plantedRecord();
    const index = join(mkdtempSync(join(tmpdir(), "freebot-index-")), "VERIFICATION.md");
    writeFileSync(index, `${readFileSync(realIndex, "utf8")}\n`);

    const report = checkRecord(repoRoot, { recordDir: dir, indexPath: index });

    expect(report.ok).toBe(false);
    expect(report.failures.join("\n")).toContain("differs from a fresh render");
  });

  test("a red driver the governing sweep reports must be named by the row", () => {
    const dir = plantedRecord();
    rewrite(dir, "composio adapter", (text) =>
      text
        .split("\n")
        .filter((line) => !line.startsWith("red-driver:"))
        .join("\n"),
    );

    const report = checkRecord(repoRoot, { recordDir: dir, checkDrift: false });

    expect(report.ok).toBe(false);
    expect(report.failures.join("\n")).toContain(
      "its connectors driver is red in the governing sweep",
    );
  });

  test("a red line kept for a green driver fails when the driver is green again", () => {
    const dir = plantedRecord();
    rewrite(dir, "launch (U10.13)", (text) => `${text.trim()}\nred-driver: landing@74186ed\n`);

    const report = checkRecord(repoRoot, { recordDir: dir, checkDrift: false });

    expect(report.ok).toBe(false);
    expect(report.failures.join("\n")).toContain("but that driver is not red for this row");
  });

  test("an unreferenced newest artifact is flagged without failing the record", () => {
    const report = checkRecord(repoRoot);

    expect(report.ok).toBe(true);
    expect(report.flags.some((flag) => flag.startsWith("unreferenced artifact "))).toBe(true);
  });

  test("a row whose artifact does not exist fails", () => {
    const dir = plantedRecord();
    rewrite(dir, "launch (U10.13)", (text) =>
      text.replace("artifacts/launch/b917c1f/assert.txt", "artifacts/launch/b917c1f/missing.txt"),
    );

    const report = checkRecord(repoRoot, { recordDir: dir, checkDrift: false });

    expect(report.ok).toBe(false);
    expect(report.failures.join("\n")).toContain("artifact not found");
  });
});
