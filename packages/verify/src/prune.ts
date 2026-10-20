#!/usr/bin/env bun
/**
 * Prune the artifact tree: remove untracked runs, keep what the evidence index and git still name.
 *
 * `packages/verify/artifacts/<feature>/<run>/` holds two kinds of directory. A committed run is
 * history: a row may still name it, and order 49 keeps historical directories on disk. An untracked
 * run is a pass whose evidence was never committed, and the status routine leaves dozens of them
 * (order 31). This command removes only the second kind, and only where a newer run for the same
 * feature survives it.
 *
 * The rules, in order:
 *
 * 1. A run directory named by a row of `docs/VERIFICATION.md` is kept. The row is the authority.
 * 2. A run directory tracked by git is kept. Committed evidence is history, not litter.
 * 3. For each feature, every untracked run tied at the newest modification time is kept.
 * 4. Everything else is a deletion.
 *
 * A dot entry is outside the plan, because the ignored Chrome profile is not evidence. A file where
 * a run directory belongs is named and kept, never guessed at. `--path` narrows the plan to one
 * `<feature>/<run>` directory and refuses a path that is outside the tree, shallower than a run, or
 * absent.
 *
 * Usage:
 *   bun packages/verify/src/prune.ts --dry-run
 *   bun packages/verify/src/prune.ts --path packages/verify/artifacts/mvp-status/pass70-461dc46
 *
 * `--dry-run` prints every delete and every keep with its reason. Without it the command prints the
 * same report after applying the plan. A run that stops partway is safe to repeat: the next plan is
 * read from what is still on disk.
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactPaths, parseRows } from "../scripts/index-check.ts";

const ARTIFACTS_REL = join("packages", "verify", "artifacts");
const TABLE_REL = join("docs", "VERIFICATION.md");

export class PruneRefusal extends Error {}

/** One entry of the artifact tree: a run directory, or a feature-level entry that is not one. */
export interface RunEntry {
  readonly feature: string;
  /** The run directory's name, or null when the entry is not a run directory. */
  readonly run: string | null;
  /** The absolute path. */
  readonly absolute: string;
  /** The path printed in the plan, relative to the repo root. */
  readonly path: string;
  readonly tracked: boolean;
  readonly namedByRow: boolean;
  /** The directory's own modification time, which orders the untracked runs of a feature. */
  readonly mtimeMs: number;
}

export type KeepReason =
  | "named by docs/VERIFICATION.md"
  | "tracked in git"
  | "newest run for its feature"
  | "not a run directory";

export interface PrunePlan {
  readonly artifactsRoot: string;
  readonly delete: readonly RunEntry[];
  readonly keep: readonly { readonly entry: RunEntry; readonly reason: KeepReason }[];
}

export interface PlanOptions {
  readonly repoRoot: string;
  /** Defaults to `<repoRoot>/docs/VERIFICATION.md`. A missing table refuses the plan. */
  readonly tablePath?: string;
  readonly only?: string;
  /** Injected by tests; defaults to one `git ls-files` over the artifact tree. */
  readonly isTracked?: (feature: string, run: string) => boolean;
}

/** The run directories git tracks, as `feature/run`. No git answer is an empty set, never a guess. */
function trackedRuns(repoRoot: string): Set<string> {
  const proc = Bun.spawnSync(["git", "ls-files", "-z", "--", ARTIFACTS_REL], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "ignore",
  });
  const runs = new Set<string>();
  if (proc.exitCode !== 0) return runs;
  const prefix = "packages/verify/artifacts/";
  for (const path of proc.stdout.toString().split("\0")) {
    if (!path.startsWith(prefix)) continue;
    const [feature, run] = path.slice(prefix.length).split("/");
    if (feature !== undefined && run !== undefined) runs.add(`${feature}/${run}`);
  }
  return runs;
}

/** Every `feature/run` a table row names. The table is the authority on which runs must survive. */
function rowRuns(tablePath: string): Set<string> {
  const runs = new Set<string>();
  for (const row of parseRows(readFileSync(tablePath, "utf8")).rows) {
    for (const path of artifactPaths(row.artifactCell)) {
      const parts = path.slice(`${ARTIFACTS_REL.replaceAll(sep, "/")}/`.length).split("/");
      const [feature, run] = parts;
      if (feature !== undefined && run !== undefined) runs.add(`${feature}/${run}`);
    }
  }
  return runs;
}

/**
 * A relative path that climbs out of its root. The check is a path segment, not a string prefix, so
 * a feature legitimately named `..foo` is a name rather than a traversal.
 */
function escapes(proximity: string): boolean {
  return proximity === ".." || proximity.startsWith(`..${sep}`) || isAbsolute(proximity);
}

/** Resolve `--path` and refuse anything that is not exactly one run directory in the tree. */
function onlyRun(artifactsRoot: string, only: string, repoRoot: string): string {
  const absolute = isAbsolute(only) ? resolve(only) : resolve(repoRoot, only);
  const proximity = relative(artifactsRoot, absolute);
  if (proximity === "") {
    throw new PruneRefusal(
      `refusing ${only}: name one <feature>/<run> directory, not the artifact tree`,
    );
  }
  if (escapes(proximity)) {
    throw new PruneRefusal(`refusing ${only}: it is outside ${ARTIFACTS_REL}`);
  }
  if (proximity.split(sep).length !== 2) {
    throw new PruneRefusal(
      `refusing ${only}: expected exactly <feature>/<run> under ${ARTIFACTS_REL}`,
    );
  }
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new PruneRefusal(`refusing ${only}: no such directory`);
  }
  return proximity;
}

/**
 * Read the tree and decide. Pure enough to test: it never writes, and `isTracked` replaces git.
 */
export function planPrune(options: PlanOptions): PrunePlan {
  const repoRoot = resolve(options.repoRoot);
  const artifactsRoot = join(repoRoot, ARTIFACTS_REL);
  const tablePath = options.tablePath ?? join(repoRoot, TABLE_REL);

  if (!existsSync(tablePath)) {
    throw new PruneRefusal(
      `refusing to prune without ${relative(repoRoot, tablePath)}: the rows are the authority on what must survive`,
    );
  }
  if (!existsSync(artifactsRoot) || !statSync(artifactsRoot).isDirectory()) {
    throw new PruneRefusal(`refusing to prune: ${ARTIFACTS_REL} is not a directory`);
  }

  const only = options.only === undefined ? null : onlyRun(artifactsRoot, options.only, repoRoot);
  const inScope = (entry: RunEntry): boolean =>
    only === null || `${entry.feature}/${entry.run}` === only;
  const named = rowRuns(tablePath);
  const trackedSet = options.isTracked === undefined ? trackedRuns(repoRoot) : null;
  const isTracked =
    options.isTracked ??
    ((feature: string, run: string) => trackedSet?.has(`${feature}/${run}`) === true);

  const entries: RunEntry[] = [];
  for (const featureEntry of readdirSync(artifactsRoot, { withFileTypes: true })) {
    if (featureEntry.name.startsWith(".")) continue;
    const featurePath = join(artifactsRoot, featureEntry.name);
    if (!featureEntry.isDirectory()) {
      entries.push(entryOf(featureEntry.name, null, featurePath, repoRoot, false, false));
      continue;
    }
    for (const runEntry of readdirSync(featurePath, { withFileTypes: true })) {
      if (runEntry.name.startsWith(".")) continue;
      const run = runEntry.name;
      if (!runEntry.isDirectory()) {
        entries.push(
          entryOf(featureEntry.name, null, join(featurePath, run), repoRoot, false, false),
        );
        continue;
      }
      entries.push(
        entryOf(
          featureEntry.name,
          run,
          join(featurePath, run),
          repoRoot,
          isTracked(featureEntry.name, run),
          named.has(`${featureEntry.name}/${run}`),
        ),
      );
    }
  }

  const keep: { entry: RunEntry; reason: KeepReason }[] = [];
  const candidates: RunEntry[] = [];
  for (const entry of entries) {
    if (entry.run === null) keep.push({ entry, reason: "not a run directory" });
    else if (entry.namedByRow) keep.push({ entry, reason: "named by docs/VERIFICATION.md" });
    else if (entry.tracked) keep.push({ entry, reason: "tracked in git" });
    else candidates.push(entry);
  }

  const newest = new Map<string, number>();
  for (const entry of candidates) {
    const current = newest.get(entry.feature);
    if (current === undefined || entry.mtimeMs > current) newest.set(entry.feature, entry.mtimeMs);
  }

  const remove: RunEntry[] = [];
  for (const entry of candidates) {
    if (entry.mtimeMs === newest.get(entry.feature)) {
      keep.push({ entry, reason: "newest run for its feature" });
    } else {
      remove.push(entry);
    }
  }

  return {
    artifactsRoot,
    delete: remove.filter(inScope).sort((a, b) => a.path.localeCompare(b.path)),
    keep: keep
      .filter((kept) => inScope(kept.entry))
      .sort((a, b) => a.entry.path.localeCompare(b.entry.path)),
  };
}

function entryOf(
  feature: string,
  run: string | null,
  absolute: string,
  repoRoot: string,
  tracked: boolean,
  namedByRow: boolean,
): RunEntry {
  return {
    feature,
    run,
    absolute,
    path: relative(repoRoot, absolute),
    tracked,
    namedByRow,
    mtimeMs: run === null ? 0 : statSync(absolute).mtimeMs,
  };
}

/**
 * Delete the plan's directories. The scope check runs again here: a plan built by hand must not be
 * able to reach outside the artifact tree, and a path is only ever one `<feature>/<run>` deep.
 */
export function applyPrune(plan: PrunePlan): string[] {
  const root = resolve(plan.artifactsRoot);
  for (const entry of plan.delete) {
    const absolute = resolve(entry.absolute);
    const proximity = relative(root, absolute);
    if (proximity === "" || escapes(proximity) || proximity.split(sep).length !== 2) {
      throw new PruneRefusal(`refusing to delete ${entry.absolute}: not one run under ${root}`);
    }
    rmSync(absolute, { recursive: true });
  }
  return plan.delete.map((entry) => entry.path);
}

/** The report a dry run prints: every deletion, every keep, and the tally that follows from them. */
export function formatPlan(plan: PrunePlan, applied: boolean): string {
  const lines: string[] = [`prune: ${ARTIFACTS_REL} (${applied ? "applied" : "dry run"})`];
  for (const entry of plan.delete) lines.push(`DELETE ${entry.path}`);
  for (const kept of plan.keep) lines.push(`KEEP   ${kept.entry.path}: ${kept.reason}`);

  const count = (reason: KeepReason): number =>
    plan.keep.filter((kept) => kept.reason === reason).length;
  const keptParts = [
    `${count("newest run for its feature")} newest`,
    `${count("named by docs/VERIFICATION.md")} named by a row`,
    `${count("tracked in git")} tracked`,
    `${count("not a run directory")} not a run`,
  ];
  lines.push(
    "",
    `${applied ? "deleted" : "would delete"} ${plan.delete.length} run directories, kept ${plan.keep.length} (${keptParts.join(", ")})`,
  );
  return lines.join("\n");
}

const USAGE =
  "usage: bun packages/verify/src/prune.ts [--dry-run] [--path <feature>/<run>] [--table <path>]";

export interface Arguments {
  readonly dryRun: boolean;
  readonly only?: string;
  readonly table?: string;
}

/** Parse the CLI at the boundary, so a typo refuses before anything is read or removed. */
export function parseArgs(argv: readonly string[]): Arguments {
  let dryRun = false;
  let only: string | undefined;
  let table: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--dry-run":
        dryRun = true;
        break;
      case "--path":
        if (value === undefined) throw new PruneRefusal(`--path needs a value\n${USAGE}`);
        only = value;
        index += 1;
        break;
      case "--table":
        if (value === undefined) throw new PruneRefusal(`--table needs a value\n${USAGE}`);
        table = value;
        index += 1;
        break;
      default:
        throw new PruneRefusal(`unknown argument ${JSON.stringify(flag)}\n${USAGE}`);
    }
  }

  return { dryRun, only, table };
}

if (import.meta.main) {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
  try {
    const args = parseArgs(Bun.argv.slice(2));
    const plan = planPrune({
      repoRoot,
      only: args.only,
      ...(args.table === undefined ? {} : { tablePath: args.table }),
    });
    if (args.dryRun) {
      console.log(formatPlan(plan, false));
    } else {
      applyPrune(plan);
      console.log(formatPlan(plan, true));
    }
  } catch (error) {
    console.error(`prune: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
