#!/usr/bin/env bun
/**
 * The type-gate probe: proves the root `bun run typecheck` is not blind.
 *
 * Three deliberate type errors, one per location the widened gate claims to cover. Each must fail
 * the root typecheck, and the restored tree must pass. The same three errors are then put in front
 * of the pre-widening include, which must accept them, so the fix is measured by contrast.
 *
 * The census carries as much weight as the exit codes. tsconfig `include` patterns fail open: brace
 * expansion is not supported in them, so a brace pattern matches nothing while the gate still exits
 * 0 with a smaller program. The census compares the include list against the nine patterns it ships,
 * measures one temporary `.tsx` file in each `.tsx` family, and asserts the covered files are in the
 * program, so a narrowing of the include list fails here even when every exit code looks healthy.
 *
 * Writes `packages/verify/artifacts/type-gate/<short-sha>/probe.txt`.
 *
 * Run from the repo root: `bun packages/verify/scripts/type-gate.ts`.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactDir } from "../src/index.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const feature = "type-gate";
const legacyConfig = "tsconfig.type-gate-legacy.json";

/** The include the gate shipped before this unit, copied from the U1.5 review that measured it. */
const LEGACY_INCLUDE = ["packages/*/src/**/*.ts", "packages/verify/*.ts", "apps/*/src/**/*.ts"];

/**
 * The include the root `tsconfig.json` must carry. Patterns fail open, so a dropped line, a brace
 * collapse or any other narrowing leaves every exit code healthy over a smaller program. The census
 * compares the config against this list, literal pattern for literal pattern.
 */
const EXPECTED_INCLUDE = [
  "packages/*/src/**/*.ts",
  "packages/*/src/**/*.tsx",
  "packages/*/scripts/**/*.ts",
  "packages/*/scripts/**/*.tsx",
  "packages/verify/*.ts",
  "apps/*/src/**/*.ts",
  "apps/*/src/**/*.tsx",
  "apps/*/scripts/**/*.ts",
  "apps/*/scripts/**/*.tsx",
];

/** The repro U1.5 measured: a plain type error that the gate must refuse anywhere it looks. */
const BROKEN = 'const broken: number = "this is a type error";\n';

type ProbeCase = { label: string; path: string };

const cases: ProbeCase[] = [
  { label: ".tsx under apps/web", path: "apps/web/scripts/__type-gate-probe.tsx" },
  { label: ".ts under apps/web/scripts", path: "apps/web/scripts/__type-gate-probe.ts" },
  { label: "a package script", path: "packages/protocol/scripts/__type-gate-probe.ts" },
];

/**
 * One temporary `.tsx` per `.tsx` pattern family, in the tree only while the census runs. No real
 * `.tsx` file exists yet, so a `.tsx` pattern that matched nothing would leave every exit code
 * healthy. The census measures each pattern against one of these files instead of the string alone.
 */
const tsxFamilies = [
  { pattern: "packages/*/src/**/*.tsx", path: "packages/core/src/__type-gate-census.tsx" },
  {
    pattern: "packages/*/scripts/**/*.tsx",
    path: "packages/protocol/scripts/__type-gate-census.tsx",
  },
  { pattern: "apps/*/src/**/*.tsx", path: "apps/server/src/__type-gate-census.tsx" },
  { pattern: "apps/*/scripts/**/*.tsx", path: "apps/web/scripts/__type-gate-census.tsx" },
];

/** Files the widened gate must see. A missing one means the include list narrowed. */
const covered = [
  "apps/server/src/app.ts",
  "apps/web/scripts/capture.ts",
  "apps/web/scripts/fixture.ts",
  "apps/web/scripts/fixture.test.ts",
  "apps/web/scripts/server.ts",
  "apps/web/scripts/thread.test.ts",
  "packages/core/src/run-store.ts",
  "packages/core/src/run-store.test.ts",
  "packages/pi-bridge/scripts/smoke.ts",
  "packages/protocol/scripts/verify.ts",
  "packages/providers/scripts/evidence.ts",
  "packages/verify/run.ts",
];

/**
 * Files in the tree that no included root reaches, each with its follow-up in docs/type-gate.md.
 * The census asserts this list is exactly the tree-minus-program difference, so it is complete by
 * construction and a new unreached file fails the probe.
 *
 * An import pulls a file into a program whatever the include list says, which is why
 * `packages/pi-bridge/extension/tool-gate.ts` is not here despite living outside `src` and
 * `scripts`: `packages/pi-bridge/src/gate.test.ts` imports it.
 */
const blind = [
  "apps/web/host/main.ts",
  "packages/pi-bridge/extension/smoke-echo.ts",
  "packages/sandbox/image/replay-ext.ts",
  "packages/ui/browser/library.ts",
  "packages/ui/browser/render.ts",
  "packages/ui/browser/shell.ts",
];

type Outcome = { code: number; ok: boolean; output: string };

function sh(cmd: string[]): Outcome {
  const proc = Bun.spawnSync(cmd, { cwd: root, stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode ?? 1,
    ok: proc.exitCode === 0,
    output: `${proc.stdout.toString()}${proc.stderr.toString()}`.trim(),
  };
}

function tsc(args: string[]): Outcome {
  return sh([join(root, "node_modules", ".bin", "tsc"), ...args]);
}

/** The gate under test is the root script, not a re-assembled tsc invocation. */
function gate(): Outcome {
  return sh(["bun", "run", "typecheck"]);
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString().trim();
}

/**
 * Every `.ts`/`.tsx` file under `packages/` and `apps/`, repo-relative. The census diffs this
 * against the program, so this list has to be the whole tree, not a subset.
 */
function treeFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(entry.name)) found.push(abs.slice(root.length + 1));
    }
  };
  for (const top of ["packages", "apps"]) walk(join(root, top));
  return found.sort();
}

/** Every file the given project puts in its program, repo-local only. */
function program(config: string): string[] {
  const out = tsc(["-p", config, "--listFilesOnly"]);
  if (!out.ok) throw new Error(`tsc -p ${config} --listFilesOnly failed: ${out.output}`);
  return out.output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${root}/`) && !line.includes("/node_modules/"));
}

function includeOf(config: string): string[] {
  const parsed = JSON.parse(readFileSync(join(root, config), "utf8")) as { include: string[] };
  return parsed.include;
}

const log: string[] = [];
const checks: Array<{ label: string; pass: boolean }> = [];

function section(title: string): void {
  log.push("", `== ${title} ==`);
}

function check(label: string, pass: boolean, hint = ""): void {
  checks.push({ label, pass });
  log.push(`${pass ? "ok  " : "FAIL"} ${label}${pass || hint === "" ? "" : ` [${hint}]`}`);
}

function show(command: string, out: Outcome): void {
  log.push(`$ ${command}`, `exit ${out.code}`);
  if (out.output !== "") log.push(...out.output.split("\n"));
}

const placed: string[] = [];

function place(path: string): void {
  writeFileSync(join(root, path), BROKEN);
  placed.push(path);
}

function clear(): void {
  for (const path of placed.splice(0)) rmSync(join(root, path), { force: true });
}

let ok = false;
let headSha = "";
let shortSha = "";
let branch = "";

try {
  headSha = git(["rev-parse", "HEAD"]);
  shortSha = git(["rev-parse", "--short", "HEAD"]);
  branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);

  log.push(
    "type gate probe",
    "command: bun packages/verify/scripts/type-gate.ts",
    `timestamp: ${new Date().toISOString()}`,
    `git sha: ${headSha}`,
    `git sha short: ${shortSha}`,
    `branch: ${branch}`,
    `include, root tsconfig.json: ${JSON.stringify(includeOf("tsconfig.json"))}`,
    `include, pre-widening: ${JSON.stringify(LEGACY_INCLUDE)}`,
  );

  section("clean tree");
  const clean = gate();
  show("bun run typecheck", clean);
  check("the restored tree passes the root typecheck", clean.ok);

  section("coverage census");
  const include = includeOf("tsconfig.json");
  check(
    "the root include is exactly the nine patterns this gate ships",
    [...include].sort().join("\n") === [...EXPECTED_INCLUDE].sort().join("\n"),
    `root include is ${JSON.stringify(include)}`,
  );

  const widened = program("tsconfig.json");
  writeFileSync(
    join(root, legacyConfig),
    `${JSON.stringify({ extends: "./tsconfig.base.json", include: LEGACY_INCLUDE }, null, 2)}\n`,
  );
  const legacy = program(legacyConfig);
  log.push(`program files: ${widened.length} widened, ${legacy.length} pre-widening`);
  check("the widening grew the program", widened.length > legacy.length);
  const inProgram = new Set(widened);
  for (const path of covered) {
    check(`in program: ${path}`, inProgram.has(join(root, path)), "the include narrowed");
  }

  for (const family of tsxFamilies) place(family.path);
  const withStubs = new Set(program("tsconfig.json"));
  clear();
  for (const family of tsxFamilies) {
    check(
      `${family.pattern} reaches a real .tsx file`,
      withStubs.has(join(root, family.path)),
      "the pattern matches nothing",
    );
  }

  const unreached = treeFiles().filter((path) => !inProgram.has(join(root, path)));
  log.push(
    `unreached .ts/.tsx files under packages/ and apps/: ${unreached.length}`,
    ...unreached.map((path) => `  ${path}`),
  );
  check(
    "the blind set is exactly the documented set",
    unreached.join("\n") === blind.join("\n"),
    "update docs/type-gate.md and the blind list",
  );

  section("the hole, owned by the pre-widening include");
  for (const probeCase of cases) place(probeCase.path);
  log.push(
    "$ git status --porcelain -- <probe paths>",
    git(["status", "--porcelain", "--", ...cases.map((c) => c.path)]),
  );
  const beforeRun = tsc(["-p", legacyConfig]);
  show(`tsc -p ${legacyConfig}   (all three deliberate errors are in the tree)`, beforeRun);
  check(
    "the pre-widening include accepts all three deliberate errors",
    beforeRun.ok && !beforeRun.output.includes("error TS"),
  );
  const legacyDuring = new Set(program(legacyConfig));
  for (const probeCase of cases) {
    check(
      `the pre-widening include does not reach ${probeCase.path}`,
      !legacyDuring.has(join(root, probeCase.path)),
    );
  }
  clear();

  for (const probeCase of cases) {
    section(`probe: ${probeCase.label} (${probeCase.path})`);
    place(probeCase.path);
    const broken = gate();
    show("bun run typecheck", broken);
    check(`${probeCase.label}: the root typecheck fails`, !broken.ok);
    check(`${probeCase.label}: the failure names the file`, broken.output.includes(probeCase.path));
    check(`${probeCase.label}: the failure is a type error`, broken.output.includes("error TS"));
    clear();

    const restored = gate();
    show("bun run typecheck (probe file removed)", restored);
    check(`${probeCase.label}: the restored tree passes`, restored.ok);
  }

  section("after");
  const after = gate();
  show("bun run typecheck", after);
  check("the tree passes with every probe file removed", after.ok);
  const residue = git([
    "status",
    "--porcelain",
    "--",
    ...cases.map((c) => c.path),
    ...tsxFamilies.map((f) => f.path),
  ]);
  check("the probe left no residue", residue === "");
} finally {
  clear();
  rmSync(join(root, legacyConfig), { force: true });
}

const failures = checks.filter((entry) => !entry.pass);
ok = failures.length === 0;

log.push(
  "",
  "== summary ==",
  `${checks.length - failures.length}/${checks.length} checks passed`,
  ...failures.map((entry) => `FAIL ${entry.label}`),
  "",
  `${ok ? "PASS" : "FAIL"} ${feature}`,
  "",
);

const dir = artifactDir(root, feature, shortSha);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "probe.txt"), log.join("\n"));

console.log(log.slice(log.indexOf("== summary ==")).join("\n").trimEnd());
console.log(`artifact: packages/verify/artifacts/${feature}/${shortSha}/probe.txt`);
process.exitCode = ok ? 0 : 1;
