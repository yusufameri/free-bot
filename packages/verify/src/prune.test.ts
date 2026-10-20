/**
 * The prune contract: the newest untracked run of a feature survives with everything a row or git
 * still names, a deletion reaches nothing else, and an unclear path is refused by name.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPrune, PruneRefusal, planPrune } from "./prune.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");

type Tree = {
  root: string;
  artifacts: string;
  table: string;
  tracked: Set<string>;
  isTracked: (feature: string, run: string) => boolean;
};

/** A throwaway repo: the artifact tree, a table, and a caller-named set of tracked runs. */
function tree(rowRun?: string): Tree {
  const root = mkdtempSync(join(tmpdir(), "freebot-prune-"));
  const artifacts = join(root, "packages", "verify", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  const table = join(root, "docs", "VERIFICATION.md");
  mkdirSync(join(root, "docs"), { recursive: true });
  const rows =
    rowRun === undefined
      ? ""
      : `| named | bun driver | unit-verified (one row) | \`packages/verify/artifacts/${rowRun}/assert.txt\` | 1234567 | 2026-10-20 |\n`;
  writeFileSync(
    table,
    `| Feature | Driver | Verdict | Artifact | Commit | Date |\n| --- | --- | --- | --- | --- | --- |\n${rows}`,
  );
  const tracked = new Set<string>();
  return {
    root,
    artifacts,
    table,
    tracked,
    isTracked: (feature, run) => tracked.has(`${feature}/${run}`),
  };
}

function run(root: string, feature: string, name: string, seconds: number): string {
  const path = join(root, "packages", "verify", "artifacts", feature, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "assert.txt"), "RESULT: PASS (1/1)\n");
  const time = new Date(seconds * 1000);
  utimesSync(path, time, time);
  return path;
}

describe("the artifact prune", () => {
  test("keeps the newest untracked run, a row's run and a tracked run, and deletes only the rest", () => {
    const planted = tree("alpha/row");
    run(planted.root, "alpha", "row", 500);
    run(planted.root, "alpha", "old", 1_000);
    run(planted.root, "alpha", "new", 2_000);
    const trackedPath = run(planted.root, "alpha", "tracked", 100);
    run(planted.root, "beta", "solo", 300);
    planted.tracked.add("alpha/tracked");

    const plan = planPrune({
      repoRoot: planted.root,
      tablePath: planted.table,
      isTracked: planted.isTracked,
    });

    expect(plan.delete.map((entry) => entry.path)).toEqual(["packages/verify/artifacts/alpha/old"]);
    expect(plan.keep.map((kept) => `${kept.entry.run}: ${kept.reason}`)).toEqual([
      "new: newest run for its feature",
      "row: named by docs/VERIFICATION.md",
      "tracked: tracked in git",
      "solo: newest run for its feature",
    ]);
    expect(existsSync(trackedPath)).toBe(true);
  });

  test("applying the plan removes the named directory and nothing else", () => {
    const planted = tree();
    run(planted.root, "alpha", "old", 1_000);
    run(planted.root, "alpha", "new", 2_000);

    const plan = planPrune({
      repoRoot: planted.root,
      tablePath: planted.table,
      isTracked: planted.isTracked,
    });
    expect(applyPrune(plan)).toEqual(["packages/verify/artifacts/alpha/old"]);

    expect(existsSync(join(planted.artifacts, "alpha", "old"))).toBe(false);
    expect(existsSync(join(planted.artifacts, "alpha", "new"))).toBe(true);
  });

  test("runs tied at the newest modification time are all kept rather than one being guessed", () => {
    const planted = tree();
    run(planted.root, "gamma", "pass-a", 4_000);
    run(planted.root, "gamma", "pass-b", 4_000);
    run(planted.root, "gamma", "older", 3_000);

    const plan = planPrune({
      repoRoot: planted.root,
      tablePath: planted.table,
      isTracked: planted.isTracked,
    });

    expect(plan.delete.map((entry) => entry.run)).toEqual(["older"]);
    expect(plan.keep.map((kept) => kept.entry.run)).toEqual(["pass-a", "pass-b"]);
  });

  test("a file where a run directory belongs is named and kept, not deleted", () => {
    const planted = tree();
    run(planted.root, "delta", "new", 2_000);
    writeFileSync(join(planted.artifacts, "delta", "notes.txt"), "not a run\n");

    const plan = planPrune({
      repoRoot: planted.root,
      tablePath: planted.table,
      isTracked: planted.isTracked,
    });

    expect(plan.delete).toEqual([]);
    expect(plan.keep.map((kept) => `${kept.entry.path}: ${kept.reason}`)).toContain(
      `packages/verify/artifacts/delta/notes.txt: not a run directory`,
    );
  });

  test("a path outside the artifact tree is refused by name", () => {
    const planted = tree();
    run(planted.root, "alpha", "new", 2_000);

    expect(() =>
      planPrune({
        repoRoot: planted.root,
        tablePath: planted.table,
        only: join(planted.root, "docs"),
      }),
    ).toThrow(/outside packages\/verify\/artifacts/);
  });

  test("the artifact tree itself is refused as too broad", () => {
    const planted = tree();
    expect(() =>
      planPrune({ repoRoot: planted.root, tablePath: planted.table, only: planted.artifacts }),
    ).toThrow(/name one <feature>\/<run> directory/);
  });

  test("a feature directory is refused as too shallow", () => {
    const planted = tree();
    run(planted.root, "alpha", "new", 2_000);
    expect(() =>
      planPrune({
        repoRoot: planted.root,
        tablePath: planted.table,
        only: join(planted.artifacts, "alpha"),
      }),
    ).toThrow(/expected exactly <feature>\/<run>/);
  });

  test("a feature whose name starts with two dots is not refused as a traversal", () => {
    const planted = tree();
    run(planted.root, "..alpha", "old", 1_000);
    run(planted.root, "..alpha", "new", 2_000);

    const plan = planPrune({
      repoRoot: planted.root,
      tablePath: planted.table,
      only: join(planted.artifacts, "..alpha", "old"),
      isTracked: planted.isTracked,
    });

    expect(plan.delete).toEqual([]);
  });

  test("a path that names no directory is refused instead of read as nothing to do", () => {
    const planted = tree();
    expect(() =>
      planPrune({
        repoRoot: planted.root,
        tablePath: planted.table,
        only: join(planted.artifacts, "alpha", "missing"),
      }),
    ).toThrow(/no such directory/);
  });

  test("a missing evidence table refuses the plan", () => {
    const planted = tree();
    expect(() =>
      planPrune({ repoRoot: planted.root, tablePath: join(planted.root, "docs", "absent.md") }),
    ).toThrow(/authority/);
  });

  test("the committed index names no run this plan deletes", () => {
    const plan = planPrune({ repoRoot });
    expect(plan.delete.filter((entry) => entry.namedByRow)).toEqual([]);
    expect(plan.delete.filter((entry) => entry.tracked)).toEqual([]);
    expect(plan.keep.some((kept) => kept.reason === "named by docs/VERIFICATION.md")).toBe(true);
  });
});

test("an out-of-tree plan is refused again at the point of deletion", () => {
  const planted = tree();
  const outside = join(planted.root, "docs");
  expect(() =>
    applyPrune({
      artifactsRoot: planted.artifacts,
      keep: [],
      delete: [
        {
          feature: "alpha",
          run: "new",
          absolute: outside,
          path: "docs",
          tracked: false,
          namedByRow: false,
          mtimeMs: 0,
        },
      ],
    }),
  ).toThrow(PruneRefusal);
});

test("a prune of one run directory leaves its siblings alone", () => {
  const planted = tree();
  run(planted.root, "alpha", "old", 1_000);
  run(planted.root, "alpha", "new", 2_000);
  const plan = planPrune({
    repoRoot: planted.root,
    tablePath: planted.table,
    only: join(planted.artifacts, "alpha", "old"),
    isTracked: planted.isTracked,
  });
  expect(plan.delete.map((entry) => entry.run)).toEqual(["old"]);
  expect(plan.keep).toEqual([]);
  applyPrune(plan);
  expect(existsSync(join(planted.artifacts, "alpha", "new"))).toBe(true);
});
