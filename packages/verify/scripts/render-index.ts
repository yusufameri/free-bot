#!/usr/bin/env bun
/**
 * Render `docs/VERIFICATION.md` from the row files under `docs/verification/`.
 *
 * The table is generated, never hand-merged. Run this after adding or editing a row file:
 *
 *   bun packages/verify/scripts/render-index.ts
 *
 * The base marker in the rendered file is the commit the row distances were measured from. Re-run
 * with `--base <sha>` only to regenerate a historical copy; the checker renders against the marker,
 * so the committed file stays stable as main advances.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { INDEX_PATH, loadRecord, RECORD_DIR, renderIndex } from "../src/verification-record.ts";
import { atMainNotes } from "./index-check.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString().trim()}`);
  return proc.stdout.toString().trim();
}

function distance(commit: string, base: string): number | null {
  const ancestor = Bun.spawnSync(["git", "merge-base", "--is-ancestor", commit, base], {
    cwd: repoRoot,
    stdout: "ignore",
    stderr: "ignore",
  });
  if (ancestor.exitCode !== 0) return null;
  const count = Bun.spawnSync(["git", "rev-list", "--count", `${commit}..${base}`], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "ignore",
  });
  return count.exitCode === 0 ? Number(count.stdout.toString().trim()) : null;
}

const args = Bun.argv.slice(2);
const baseFlag = args.indexOf("--base");
const base =
  baseFlag >= 0 && args[baseFlag + 1] !== undefined
    ? (args[baseFlag + 1] as string)
    : git(["rev-parse", "HEAD"]);

const loaded = loadRecord(repoRoot, RECORD_DIR);
if (loaded.problems.length > 0) {
  for (const problem of loaded.problems) console.error(`${problem.file}: ${problem.message}`);
  process.exitCode = 1;
} else {
  const notes = atMainNotes(repoRoot, loaded.rows, base);
  const text = renderIndex(loaded.rows, {
    base,
    behind: (row) => distance(row.commit, base),
    notes: (row) => notes.get(row.file) ?? [],
  });
  writeFileSync(join(repoRoot, INDEX_PATH), text);
  console.log(
    `rendered ${INDEX_PATH} from ${loaded.rows.length} row files at base ${base.slice(0, 7)}`,
  );
}
