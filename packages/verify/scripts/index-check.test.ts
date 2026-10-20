/**
 * The index checker's own contract: the two rows that reached main with a wrong count are put back,
 * one at a time and together, and each mismatch is caught by the row's name.
 *
 * The planted tables are copies of the committed index with only the named cells rewritten, so
 * every other row, artifact and commit in the run is the real one.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkIndex } from "./index-check.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const realIndex = join(repoRoot, "docs", "VERIFICATION.md");

type Plant = { feature: string; from: string; to: string };

/** A copy of the committed index with the named cells rewritten. */
function plant(...changes: Plant[]): string {
  const lines = readFileSync(realIndex, "utf8").split("\n");
  for (const change of changes) {
    const index = lines.findIndex((line) => line.startsWith(`| ${change.feature} |`));
    if (index < 0) throw new Error(`no table row for ${change.feature}`);
    const line = lines[index] ?? "";
    if (!line.includes(change.from)) {
      throw new Error(`row ${change.feature} does not carry ${change.from}`);
    }
    lines[index] = line.replace(change.from, change.to);
  }
  const path = join(mkdtempSync(join(tmpdir(), "freebot-index-check-")), "VERIFICATION.md");
  writeFileSync(path, lines.join("\n"));
  return path;
}

/** The launch row as it stood before U8.x: 114 claimed against an artifact that says 116/116. */
const launchClaim: Plant = {
  feature: "launch",
  from: "live-ui-verified (116 checks",
  to: "live-ui-verified (114 checks",
};

/** The files surface row as it stood: 53 claimed against an artifact that says 54/54. */
const filesSurfaceClaim: Plant = {
  feature: "files surface",
  from: "live-ui-verified (54 checks",
  to: "live-ui-verified (53 checks",
};

describe("the verification index checker", () => {
  test("the committed index agrees with every artifact it names", () => {
    const report = checkIndex(repoRoot, realIndex);

    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.docsOnly).toContain("glossary");
    expect(report.checkedRows).toBe(report.rows.length - report.docsOnly.length);
    expect(report.artifactCount).toBe(
      report.rows.reduce((total, row) => total + row.artifacts.length, 0),
    );

    for (const feature of report.countUnverified) {
      const row = report.rows.find((entry) => entry.row.feature === feature);
      expect(row?.claimed).not.toBeNull();
    }
  });

  test("the glossary is skipped by name, not counted as checked", () => {
    const report = checkIndex(repoRoot, realIndex);

    expect(report.docsOnly).toContain("glossary");
    expect(report.rows.find((row) => row.row.feature === "glossary")?.artifacts).toEqual([]);
  });

  test("the launch row's old 114 is caught by name against its 116/116 artifact", () => {
    const report = checkIndex(repoRoot, plant(launchClaim));

    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
    const failures = report.failures.join("\n");
    expect(failures).toContain('row "launch"');
    expect(failures).toContain("claimed 114 checks");
    expect(failures).toContain("artifact says 116/116");
  });

  test("the files surface row's old 53 is caught by name against its 54/54 artifact", () => {
    const report = checkIndex(repoRoot, plant(filesSurfaceClaim));

    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
    const failures = report.failures.join("\n");
    expect(failures).toContain('row "files surface"');
    expect(failures).toContain("claimed 53 checks");
    expect(failures).toContain("artifact says 54/54");
  });

  test("both wrong rows at once are reported one by one", () => {
    const report = checkIndex(repoRoot, plant(launchClaim, filesSurfaceClaim));

    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(2);
    const failures = report.failures.join("\n");
    expect(failures).toContain('row "launch"');
    expect(failures).toContain('row "files surface"');
  });

  test("a Commit cell that does not start with the artifact's short sha is caught", () => {
    const lines = readFileSync(realIndex, "utf8").split("\n");
    const index = lines.findIndex((line) => line.startsWith("| launch |"));
    if (index < 0) throw new Error("no launch row");
    const commit = (lines[index] ?? "").match(/\b[0-9a-f]{40}\b/)?.[0];
    expect(commit).toBeDefined();

    const report = checkIndex(
      repoRoot,
      plant({ feature: "launch", from: commit as string, to: "0".repeat(40) }),
    );

    expect(report.ok).toBe(false);
    expect(report.failures.join("\n")).toContain('row "launch"');
    expect(report.failures.join("\n")).toContain("is not a prefix");
  });

  test("a malformed artifact reference is rejected instead of read as its own prefix", () => {
    const lines = readFileSync(realIndex, "utf8").split("\n");
    const launch = lines.find((line) => line.startsWith("| launch |")) ?? "";
    const artifact = launch.match(
      /packages\/verify\/artifacts\/launch\/[0-9a-f]+\/assert\.txt/,
    )?.[0];
    if (artifact === undefined) throw new Error("the launch row carries no artifact reference");

    const report = checkIndex(
      repoRoot,
      plant({
        feature: "launch",
        from: artifact,
        to: `${artifact}/missing`,
      }),
    );

    expect(report.ok).toBe(false);
    const failures = report.failures.join("\n");
    expect(failures).toContain('row "launch"');
    expect(failures).toContain("not artifacts/<feature>/<short-sha>/<file>");
  });

  test("an unequal fraction is a claim, not a denominator the bare-count fallback can read", () => {
    const report = checkIndex(
      repoRoot,
      plant({
        feature: "launch",
        from: "live-ui-verified (116 checks",
        to: "live-ui-verified (115/116 checks",
      }),
    );

    expect(report.ok).toBe(false);
    const failures = report.failures.join("\n");
    expect(failures).toContain('row "launch"');
    expect(failures).toContain("claimed 115/116 checks");
    expect(failures).toContain("artifact says 116/116");
  });

  test("a fraction whose denominator disagrees with the artifact is a mismatch", () => {
    const report = checkIndex(
      repoRoot,
      plant({
        feature: "launch",
        from: "live-ui-verified (116 checks",
        to: "live-ui-verified (116/117 checks",
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.failures.join("\n")).toContain("claimed 116/117 checks");
  });

  test("an artifact whose final result is FAIL is rejected, with or without a count claim", () => {
    const root = mkdtempSync(join(tmpdir(), "freebot-index-fail-"));
    const dir = join(root, "packages", "verify", "artifacts", "demo", "abc1234");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "assert.txt"), "some output\nRESULT: FAIL (2/3)\n");
    writeFileSync(join(dir, "uncounted.txt"), "some output\nRESULT: FAIL\n");
    const header = "| Feature | Script | Verdict | Artifact | Commit | Date |";
    const rule = "| --- | --- | --- | --- | --- | --- |";
    const counted =
      "| demo counted | `bun demo` | unit-test-verified (2 checks) | `packages/verify/artifacts/demo/abc1234/assert.txt` | abc1234 | 2026-10-19 |";
    const uncounted =
      "| demo uncounted | `bun demo` | docs-only | `packages/verify/artifacts/demo/abc1234/uncounted.txt` | abc1234 | 2026-10-19 |";
    const table = join(root, "VERIFICATION.md");
    writeFileSync(table, `${[header, rule, counted, uncounted].join("\n")}\n`);

    const report = checkIndex(root, table);

    expect(report.ok).toBe(false);
    const failures = report.failures.join("\n");
    expect(failures).toContain('row "demo counted"');
    expect(failures).toContain('row "demo uncounted"');
    expect(report.failures.filter((line) => line.includes("final result is FAIL"))).toHaveLength(2);
  });
});
