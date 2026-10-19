#!/usr/bin/env bun
/**
 * The sweep: every driver `driver-subjects.json` names, once, against the commit main is at.
 *
 * Each committed artifact under `packages/verify/artifacts/` certifies the commit it was produced
 * at and nothing later, so no artifact answers "does main still work". This command does: it
 * resolves `origin/main`, checks that commit out in a git worktree of its own, runs the runnable
 * drivers there one after another, and writes `sweep-main/<short sha>/sweep.txt` naming the commit,
 * each driver's own RESULT line and each skip's reason.
 *
 * The driver list is the manifest, not a second copy of it. `packages/verify/driver-subjects.json`
 * carries one block per driver, and its `sweep` block says how to run it, where its artifact lands,
 * and which host capabilities it needs. A driver the manifest names without a `sweep` block is a
 * named skip, so the summary cannot quietly lose a driver that nobody wired.
 *
 * Isolation is the worktree. Every driver derives its repo root from its own file URL and spawns
 * the app with that root as its cwd, so the code a driver boots, the fixtures it reads and the
 * `git rev-parse` it stamps its artifact with all resolve inside the isolated checkout. That
 * checkout gets its own `bun install --frozen-lockfile` from the swept lockfile, so a dirty or
 * half-migrated checkout of the caller cannot reach a driver's imports. The caller's tree supplies
 * two things only: the commit to sweep and the directory the artifact is written into.
 *
 * A driver that cannot run on this machine is a named skip with its reason, never a silent pass.
 * The capabilities are probed once, before any driver runs, and every manifest entry declares which
 * ones it needs: Docker and its daemon, the microsandbox toolchain with the pinned image, headless
 * Chrome at the path `src/cdp.ts` pins, the model key in the vault the drivers boot with, and a
 * live instance for the status capture. A subject whose backend is absent is skipped and counted in
 * the summary, so the arithmetic adds up and a green summary cannot hide a driver that never ran.
 *
 * A driver that fails exits the command non-zero and prints, for each failure, the driver, the path
 * of the text that proves it, and a line a coordinator can file as a unit. A red driver's proof is
 * the driver's own artifact text plus what it printed, captured whole into
 * `sweep-main/<short sha>/<driver>.log` and committed, because the isolated checkout the driver
 * wrote into is removed at the end of the run.
 *
 * One scheduled prompt is the whole integration:
 *
 *   `bun packages/verify/scripts/sweep-main.ts`; read its `runnable N, passed P, failed F, skipped
 *   S` line, and file the unit each `file a unit:` line proposes when F is not 0.
 *
 * Run from the repo root: `bun packages/verify/scripts/sweep-main.ts [--keep] [--base <ref>]`. The
 * base defaults to `origin/main`; `--base HEAD` sweeps the branch in the caller's worktree, which is
 * what a unit that changed a driver runs before it opens its PR.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_IMAGE } from "@freebot/sandbox";
import { CHROME } from "../src/cdp.ts";

export const FEATURE = "sweep-main";
export const DRIVER_TIMEOUT_MS = 20 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const CHECKOUT_TIMEOUT_MS = 10 * 60_000;

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");

/**
 * A precondition a driver cannot arrange for itself. Every capability is probed once per sweep and
 * every probe answers what it found, because that detail is what a skip's reason is built from.
 */
export type Capability = "docker" | "microsandbox" | "chrome" | "vaultKey" | "liveInstance";

/** What a capability is, in the words a skip line uses. */
export const CAPABILITY_NEED: Record<Capability, string> = {
  docker: "the Docker daemon the pinned image runs in",
  microsandbox: "the microsandbox toolchain (msb) with the pinned image",
  chrome: `headless Chrome at ${CHROME}`,
  vaultKey: "a model key in the vault the drivers boot with",
  liveInstance: "a live instance named by FREEBOT_STATUS_URL",
};

export const CAPABILITIES: Capability[] = [
  "docker",
  "microsandbox",
  "chrome",
  "vaultKey",
  "liveInstance",
];

export type HostFact = { present: boolean; detail: string };
export type HostFacts = Record<Capability, HostFact>;

/** One manifest entry's `sweep` block, validated at the boundary. */
export type SweepBlock = {
  argv: string[];
  artifactFile: string;
  subject: string;
  needs: Capability[][];
};

export type ManifestEntry = {
  id: string;
  command: string;
  artifact: string;
  subjects: string[];
  sweep: SweepBlock | null;
};

/** A manifest entry turned into something the runner can act on. */
export type PlannedDriver = {
  driver: string;
  /** May carry `{checkout}`, `{shortSha}`, `{statusUrl}` or `{artifactOut}` placeholders. */
  argv: string[];
  artifact: { dir: string; file: string };
  subject: string;
  needs: Capability[][];
  /** Non-null when the manifest entry cannot be swept at all. */
  missing: string | null;
};

export type Subject = {
  driver: string;
  argv: string[];
  artifact: { dir: string; file: string };
  subject: string;
  needs: Capability[][];
  missing: string | null;
};

export type Classification = { kind: "runnable" } | { kind: "skipped"; reason: string };

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value as string[];
}

/**
 * Read the manifest at the boundary. A malformed block fails by driver and field rather than
 * becoming a skip, because a typo in the manifest is a defect in the sweep's coverage.
 */
export function parseManifest(text: string): ManifestEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `driver-subjects.json is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Array.isArray((raw as { drivers?: unknown }).drivers)
  ) {
    throw new Error("driver-subjects.json must carry a drivers array");
  }

  return (raw as { drivers: unknown[] }).drivers.map((value, index) => {
    if (typeof value !== "object" || value === null) {
      throw new Error(`driver-subjects.json drivers[${index}] is not an object`);
    }
    const entry = value as Record<string, unknown>;
    const id = entry.id;
    if (typeof id !== "string" || id === "") {
      throw new Error(`driver-subjects.json drivers[${index}] has no id`);
    }
    const command = typeof entry.command === "string" ? entry.command : "";
    const artifact = entry.artifact;
    if (typeof artifact !== "string" || artifact === "") {
      throw new Error(`driver ${id}: artifact must be a path`);
    }

    let sweep: SweepBlock | null = null;
    if (entry.sweep !== undefined) {
      if (typeof entry.sweep !== "object" || entry.sweep === null) {
        throw new Error(`driver ${id}: sweep must be an object`);
      }
      const block = entry.sweep as Record<string, unknown>;
      const argv = stringArray(block.argv, `driver ${id}: sweep.argv`);
      if (argv.length === 0) throw new Error(`driver ${id}: sweep.argv must not be empty`);
      const subject = block.subject;
      if (typeof subject !== "string" || subject === "") {
        throw new Error(`driver ${id}: sweep.subject must be a sentence`);
      }
      const artifactFile = block.artifactFile ?? "assert.txt";
      if (typeof artifactFile !== "string" || artifactFile === "") {
        throw new Error(`driver ${id}: sweep.artifactFile must be a file name`);
      }
      const needs = block.needs ?? [];
      if (!Array.isArray(needs)) throw new Error(`driver ${id}: sweep.needs must be an array`);
      const groups = needs.map((group, at) => {
        const list = stringArray(group, `driver ${id}: sweep.needs[${at}]`);
        for (const capability of list) {
          if (!CAPABILITIES.includes(capability as Capability)) {
            throw new Error(
              `driver ${id}: sweep.needs[${at}] names unknown capability ${capability}`,
            );
          }
        }
        return list as Capability[];
      });
      sweep = { argv, artifactFile, subject, needs: groups };
    }

    return {
      id,
      command,
      artifact,
      subjects: Array.isArray(entry.subjects)
        ? stringArray(entry.subjects, `driver ${id}: subjects`)
        : [],
      sweep,
    };
  });
}

export function planDrivers(entries: readonly ManifestEntry[]): PlannedDriver[] {
  return entries.map((entry) => {
    if (entry.sweep === null) {
      return {
        driver: entry.id,
        argv: [],
        artifact: { dir: entry.artifact, file: "assert.txt" },
        subject: entry.command,
        needs: [],
        missing: "driver-subjects.json carries no sweep block for it",
      };
    }
    return {
      driver: entry.id,
      argv: entry.sweep.argv,
      artifact: { dir: entry.artifact, file: entry.sweep.artifactFile },
      subject: entry.sweep.subject,
      needs: entry.sweep.needs,
      missing: null,
    };
  });
}

/** Fill a manifest command's placeholders with values known only after the checkout exists. */
export function resolveArgv(argv: readonly string[], values: Record<string, string>): string[] {
  return argv.map((arg) =>
    arg.replace(/\{([A-Za-z]+)\}/g, (whole, key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`command placeholder ${whole} has no value`);
      return value;
    }),
  );
}

/** The ref the sweep checks out: `--base <ref>`, defaulting to `origin/main`. */
export function resolveBase(argv: readonly string[]): string {
  const index = argv.indexOf("--base");
  const ref = index >= 0 ? argv[index + 1] : undefined;
  return ref === undefined || ref === "" ? "origin/main" : ref;
}

export function resolveSubject(plan: PlannedDriver, values: Record<string, string>): Subject {
  return {
    driver: plan.driver,
    argv: plan.missing === null ? resolveArgv(plan.argv, values) : [],
    artifact: plan.artifact,
    subject: plan.subject,
    needs: plan.needs,
    missing: plan.missing,
  };
}

/**
 * Runnable, or skipped with the reason. A requirement group is satisfied when any capability it
 * lists is present; the reason names every capability the group offered and what each probe found,
 * so a skip line reads as the fix: install Docker, or materialize the image, or add the key.
 */
export function classify(subject: Subject, host: HostFacts): Classification {
  if (subject.missing !== null) return { kind: "skipped", reason: subject.missing };
  for (const group of subject.needs) {
    if (group.some((capability) => host[capability].present)) continue;
    const offered = group.map(
      (capability) => `${CAPABILITY_NEED[capability]} (${host[capability].detail})`,
    );
    return { kind: "skipped", reason: `needs ${offered.join(" or ")}` };
  }
  return { kind: "runnable" };
}

/**
 * The driver's own verdict line: its last `RESULT:` line, or failing that its last bare `PASS` or
 * `FAIL` line, because three drivers (type-gate, sandbox-conformance, sandbox-microsandbox) end
 * their artifact with `${ok ? "PASS" : "FAIL"} <feature>` instead. Read from the driver's own
 * artifact rather than from its console, so the line captured here is the one the driver committed.
 */
export function driverVerdict(text: string): string | null {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (/^RESULT:\s*(PASS|FAIL|STABLE|UNSTABLE)\b/.test(line)) return line;
    if (/^(PASS|FAIL|STABLE|UNSTABLE)\b/.test(line)) return line;
  }
  return null;
}

export function isGreen(verdict: string | null): boolean {
  if (verdict === null) return false;
  const status = verdict.replace(/^RESULT:\s*/, "").split(/\s/)[0];
  return status === "PASS" || status === "STABLE";
}

export type Outcome =
  | { kind: "skipped"; reason: string }
  | { kind: "passed"; verdict: string; seconds: number }
  | {
      kind: "failed";
      verdict: string | null;
      code: number;
      proof: string;
      proposed: string;
      seconds: number;
    };

export type DriverRun = { subject: Subject; outcome: Outcome };
export type SweepCounts = { runnable: number; passed: number; failed: number; skipped: number };

export type Sweep = {
  commit: string;
  shortSha: string;
  branch: string;
  ranAt: string;
  checkout: string;
  host: HostFacts;
  runs: DriverRun[];
  counts: SweepCounts;
  arithmetic: boolean;
  ok: boolean;
};

export type SweepOptions = {
  checkout: string;
  commit: string;
  shortSha: string;
  branch: string;
  host: HostFacts;
  subjects: Subject[];
  /** Where `sweep.txt` and one `<driver>.log` per runnable driver go. */
  artifactDir: string;
  /** The same directory, repo-relative, as the printed proof paths spell it. */
  artifactLabel: string;
  /** Vault values a driver must never print. The sweep refuses to commit a log carrying one. */
  secrets?: string[];
  timeoutMs?: number;
};

type Command = { code: number; text: string; timedOut: boolean };

/** Run a command to completion, bounded, with both streams captured whole. */
async function run(argv: string[], cwd: string, timeoutMs: number): Promise<Command> {
  try {
    const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);
    return { code, text: `${out}${err}`.trim(), timedOut };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { code: 127, text: `${argv.join(" ")}: ${reason}`, timedOut: false };
  }
}

function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim();
}

/** Bun prints a long run's summary last, so keep both ends of anything a driver produced. */
function truncate(text: string, max = 8_000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 2);
  return `${text.slice(0, head)}\n[...]\n${text.slice(-(max - head))}`;
}

/** The vault the drivers reach when they launch with no `FREEBOT_HOME` of their own. */
export function vaultFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.FREEBOT_HOME ?? join(homedir(), ".freebot"), "provider.env");
}

/**
 * The secret values in a vault file, for the refusal below. Only key-shaped names are read, so a
 * base URL or model name cannot turn a harmless line into a false leak. Values never leave this
 * function except as a boolean answer.
 */
export function vaultSecrets(path: string = vaultFile()): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && line.includes("="))
    .flatMap((line) => {
      const at = line.indexOf("=");
      const name = line.slice(0, at);
      const value = line.slice(at + 1).trim();
      return /(KEY|TOKEN|SECRET|PASSWORD)/i.test(name) && value.length >= 8 ? [value] : [];
    });
}

/** A key-shaped literal, or any vault value the driver could have read. */
export function leaksSecret(text: string, secrets: readonly string[]): boolean {
  if (/FREEBOT_BYOK_KEY=\S{8,}/.test(text)) return true;
  return secrets.some((secret) => secret.length >= 8 && text.includes(secret));
}

/** One line per capability: what was probed and what answered. Never the status URL's value. */
export async function probeHost(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HostFacts> {
  const docker = await run(
    ["docker", "version", "--format", "{{.Server.Version}}"],
    cwd,
    PROBE_TIMEOUT_MS,
  );
  const msb = await run(["msb", "--version"], cwd, PROBE_TIMEOUT_MS);
  const doctor = await run(["msb", "doctor"], cwd, PROBE_TIMEOUT_MS);
  const cached = await run(["msb", "image", "list", "-q"], cwd, PROBE_TIMEOUT_MS);
  const images = cached.code === 0 ? cached.text.split("\n").map((line) => line.trim()) : [];
  const pinned = PINNED_IMAGE.tag;

  const vault = vaultFile(env);
  const statusUrl = (env.FREEBOT_STATUS_URL ?? "").trim();
  return {
    docker:
      docker.code === 0 && !docker.timedOut
        ? { present: true, detail: `docker ${firstLine(docker.text)}` }
        : { present: false, detail: `docker: ${firstLine(docker.text) || "no answer"}` },
    microsandbox:
      msb.code === 0 && doctor.code === 0 && images.includes(pinned)
        ? { present: true, detail: `${firstLine(msb.text)}, ${pinned} ready` }
        : {
            present: false,
            detail:
              msb.code !== 0
                ? `msb: ${firstLine(msb.text) || "no answer"}`
                : `${pinned} is not cached`,
          },
    chrome: existsSync(CHROME)
      ? { present: true, detail: CHROME }
      : { present: false, detail: `${CHROME} absent` },
    vaultKey: existsSync(vault)
      ? { present: true, detail: "a model key is present in the vault the drivers boot with" }
      : { present: false, detail: "the vault the drivers boot with is absent" },
    liveInstance:
      statusUrl === ""
        ? { present: false, detail: "FREEBOT_STATUS_URL is not set" }
        : { present: true, detail: "FREEBOT_STATUS_URL is set" },
  };
}

/** The line a coordinator reads: one driver count each, the four numbers the brief names. */
export function summaryLine(counts: SweepCounts): string {
  return `runnable ${counts.runnable}, passed ${counts.passed}, failed ${counts.failed}, skipped ${counts.skipped}`;
}

/**
 * The line a coordinator files as a unit. It names the title, what failed, the driver, and the
 * artifact that proves it, because the isolated checkout the driver wrote into is gone by the time
 * anyone reads this.
 */
export function proposeUnit(
  subject: Subject,
  failed: { verdict: string | null; code: number; proof: string },
  swept: string,
): string {
  const ran = failed.code === 124 ? "timed out" : `exited ${failed.code}`;
  const said = failed.verdict === null ? "and printed no verdict line" : `with "${failed.verdict}"`;
  return [
    `file a unit: "sweep-main: ${subject.driver} is red against ${swept}".`,
    `The ${subject.driver} driver (\`${subject.argv.join(" ")}\`, ${subject.subject})`,
    `${ran} ${said} at ${swept}.`,
    `Proof ${failed.proof}.`,
  ].join(" ");
}

export function formatSweep(sweep: Sweep, artifactLabel: string): string {
  const lines: string[] = [];
  lines.push(
    `${FEATURE}: every driver the subject manifest names, once, against one commit (origin/main by default)`,
  );
  lines.push("command: bun packages/verify/scripts/sweep-main.ts");
  lines.push(`timestamp: ${sweep.ranAt}`);
  lines.push(`commit: ${sweep.commit}`);
  lines.push(`commit short: ${sweep.shortSha}`);
  lines.push(`base: ${sweep.branch}`);
  lines.push(
    `checkout: ${sweep.checkout} (detached at the commit, bun install from its own lockfile)`,
  );
  lines.push(`runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`);
  for (const capability of CAPABILITIES) {
    const fact = sweep.host[capability];
    lines.push(`host ${capability}: ${fact.present ? fact.detail : `absent, ${fact.detail}`}`);
  }
  lines.push("");

  for (const { subject, outcome } of sweep.runs) {
    if (outcome.kind === "skipped") {
      lines.push(`SKIP ${subject.driver}: ${outcome.reason}`);
      continue;
    }
    if (outcome.kind === "passed") {
      lines.push(`PASS ${subject.driver}: ${outcome.verdict} (${outcome.seconds}s)`);
      continue;
    }
    lines.push(
      `FAIL ${subject.driver}: ${outcome.verdict ?? `no verdict line (exit ${outcome.code})`} (${outcome.seconds}s)`,
    );
    lines.push(`  proof: ${outcome.proof}`);
    lines.push(`  ${outcome.proposed}`);
  }

  lines.push("");
  lines.push(`artifact: ${artifactLabel}/sweep.txt`);
  lines.push(summaryLine(sweep.counts));
  lines.push(
    `arithmetic: ${sweep.counts.runnable} = ${sweep.counts.passed} + ${sweep.counts.failed} (passed + failed), ${sweep.runs.length} = ${sweep.counts.runnable} + ${sweep.counts.skipped} (runnable + skipped)`,
  );
  lines.push(
    `RESULT: ${sweep.ok ? "PASS" : "FAIL"} (${sweep.counts.passed}/${sweep.counts.runnable})`,
  );
  return lines.join("\n");
}

/** The whole sweep: classify, run what can run, capture each driver's own text, write the artifact. */
export async function runSweep(options: SweepOptions): Promise<Sweep> {
  const artifactDir = options.artifactDir;
  mkdirSync(artifactDir, { recursive: true });
  const timeoutMs = options.timeoutMs ?? DRIVER_TIMEOUT_MS;
  const secrets = options.secrets ?? [];
  const runs: DriverRun[] = [];

  for (const subject of options.subjects) {
    const classification = classify(subject, options.host);
    if (classification.kind === "skipped") {
      console.log(`SKIP ${subject.driver}: ${classification.reason}`);
      runs.push({ subject, outcome: { kind: "skipped", reason: classification.reason } });
      continue;
    }

    const proof = `${options.artifactLabel}/${subject.driver}.log`;
    const startedAt = Date.now();
    console.log(`run ${subject.driver}: ${subject.argv.join(" ")}`);
    const command = await run(subject.argv, options.checkout, timeoutMs);
    const seconds = Math.round((Date.now() - startedAt) / 1000);

    const artifactFile = join(
      options.checkout,
      subject.artifact.dir,
      options.shortSha,
      subject.artifact.file,
    );
    const written = existsSync(artifactFile) ? readFileSync(artifactFile, "utf8") : null;
    const verdict = driverVerdict(written ?? command.text);
    const leaked = leaksSecret(command.text, secrets) || leaksSecret(written ?? "", secrets);

    const log = [
      `driver: ${subject.driver}`,
      `subject: ${subject.subject}`,
      `command: ${subject.argv.join(" ")}`,
      `commit: ${options.commit} (${options.shortSha})`,
      `ran in: ${options.checkout}`,
      `exit: ${command.timedOut ? "killed after the driver timeout" : command.code}`,
      `verdict: ${verdict ?? "(none)"}`,
      `seconds: ${seconds}`,
      "",
      `--- the driver's own artifact: ${subject.artifact.dir}/${options.shortSha}/${subject.artifact.file} ---`,
      "",
      written === null
        ? "(the driver wrote no artifact at that path)"
        : leaked
          ? "(refused: a vault value was in this driver's output)"
          : truncate(written),
      "",
      "--- captured output (stdout and stderr) ---",
      "",
      leaked ? "(refused: a vault value was in this driver's output)" : truncate(command.text),
      "",
    ].join("\n");
    writeFileSync(join(artifactDir, `${subject.driver}.log`), log);

    if (leaked) {
      const failed = { verdict, code: command.timedOut ? 124 : command.code, proof };
      const proposed = `${proposeUnit(subject, failed, options.shortSha)} It printed a vault value into its own output, which order 8 forbids.`;
      console.log(`FAIL ${subject.driver}: printed a vault value (${seconds}s)`);
      console.log(`  proof: ${proof}`);
      console.log(`  ${proposed}`);
      runs.push({ subject, outcome: { kind: "failed", ...failed, proposed, seconds } });
      continue;
    }

    if (command.timedOut) {
      const failed = { verdict, code: 124, proof };
      const proposed = `${proposeUnit(subject, failed, options.shortSha)} The sweep kills a driver after ${Math.round(timeoutMs / 60_000)} minutes.`;
      console.log(`FAIL ${subject.driver}: killed after ${Math.round(timeoutMs / 60_000)} minutes`);
      console.log(`  proof: ${proof}`);
      console.log(`  ${proposed}`);
      runs.push({ subject, outcome: { kind: "failed", ...failed, proposed, seconds } });
      continue;
    }

    // The exit code is not enough on its own. A driver that exits 0 while its own artifact ends
    // FAIL is a red driver whose exit code went missing, and a driver that prints no verdict at all
    // cannot be read as green.
    if (command.code === 0 && isGreen(verdict)) {
      console.log(`PASS ${subject.driver}: ${verdict} (${seconds}s)`);
      runs.push({ subject, outcome: { kind: "passed", verdict: verdict as string, seconds } });
      continue;
    }

    const failed = { verdict, code: command.code, proof };
    let proposed = proposeUnit(subject, failed, options.shortSha);
    if (verdict === null && command.code === 0) {
      proposed = `${proposed} It exited 0 without printing a verdict line.`;
    } else if (command.code === 0 && !isGreen(verdict)) {
      proposed = `${proposed} It exited 0 while its own artifact ends "${verdict}", so the driver and its exit code disagree.`;
    } else if (command.code !== 0 && isGreen(verdict)) {
      proposed = `${proposed} Its artifact says PASS while it exited ${command.code}.`;
    }
    console.log(`FAIL ${subject.driver}: ${verdict ?? `exit ${command.code}`} (${seconds}s)`);
    console.log(`  proof: ${proof}`);
    console.log(`  ${proposed}`);
    runs.push({ subject, outcome: { kind: "failed", ...failed, proposed, seconds } });
  }

  const counts: SweepCounts = {
    runnable: runs.filter((entry) => entry.outcome.kind !== "skipped").length,
    passed: runs.filter((entry) => entry.outcome.kind === "passed").length,
    failed: runs.filter((entry) => entry.outcome.kind === "failed").length,
    skipped: runs.filter((entry) => entry.outcome.kind === "skipped").length,
  };
  const arithmetic =
    counts.runnable === counts.passed + counts.failed &&
    runs.length === counts.runnable + counts.skipped;

  const sweep: Sweep = {
    commit: options.commit,
    shortSha: options.shortSha,
    branch: options.branch,
    ranAt: new Date().toISOString(),
    checkout: options.checkout,
    host: options.host,
    runs,
    counts,
    arithmetic,
    ok: arithmetic && counts.failed === 0,
  };
  writeFileSync(join(artifactDir, "sweep.txt"), `${formatSweep(sweep, options.artifactLabel)}\n`);
  return sweep;
}

/** Check `origin/main` out in a worktree of its own and install the swept lockfile there. */
async function isolate(commit: string): Promise<{ checkout: string; temporary: string }> {
  const temporary = mkdtempSync(join(tmpdir(), "freebot-sweep-main-"));
  const checkout = join(temporary, "checkout");
  const added = await run(
    ["git", "worktree", "add", "--detach", checkout, commit],
    repoRoot,
    CHECKOUT_TIMEOUT_MS,
  );
  if (added.code !== 0) {
    throw new Error(`git worktree add --detach ${checkout} ${commit} failed: ${added.text}`);
  }
  const installed = await run(
    ["bun", "install", "--frozen-lockfile"],
    checkout,
    CHECKOUT_TIMEOUT_MS,
  );
  if (installed.code !== 0) {
    throw new Error(
      `bun install --frozen-lockfile in the isolated checkout failed: ${installed.text}`,
    );
  }
  const head = await run(["git", "rev-parse", "HEAD"], checkout, 30_000);
  if (head.text !== commit) {
    throw new Error(`the isolated checkout is at ${head.text}, not ${commit}`);
  }
  return { checkout, temporary };
}

async function discard(checkout: string, temporary: string): Promise<void> {
  const removed = await run(["git", "worktree", "remove", "--force", checkout], repoRoot, 120_000);
  rmSync(temporary, { recursive: true, force: true });
  await run(["git", "worktree", "prune"], repoRoot, 60_000);
  if (removed.code !== 0) {
    console.log(`note: git worktree remove said ${removed.text}; the tree is gone either way`);
  }
}

async function main(): Promise<number> {
  const keep = Bun.argv.slice(2).includes("--keep");
  const base = resolveBase(Bun.argv.slice(2));

  if (base === "origin/main") {
    const fetched = await run(["git", "fetch", "origin", "main"], repoRoot, 120_000);
    if (fetched.code !== 0) {
      console.log("note: git fetch origin main failed, sweeping the origin/main already here");
    }
  }
  const resolved = await run(
    ["git", "rev-parse", "--verify", `${base}^{commit}`],
    repoRoot,
    30_000,
  );
  if (resolved.code !== 0) {
    console.error(`cannot resolve ${base} to a commit: ${resolved.text}`);
    return 1;
  }
  const commit = resolved.text;
  const shortSha = commit.slice(0, 7);
  const artifactLabel = `packages/verify/artifacts/${FEATURE}/${shortSha}`;
  const artifactDir = join(repoRoot, "packages", "verify", "artifacts", FEATURE, shortSha);

  let isolated: { checkout: string; temporary: string };
  try {
    isolated = await isolate(commit);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  console.log(`sweeping ${commit} in ${isolated.checkout}`);

  // The manifest belongs to the commit being swept, not to the caller: `--base` may name an older
  // head whose driver inventory differs, and running the caller's list against it would misreport
  // both the set of drivers and their commands.
  const manifest = join(isolated.checkout, "packages", "verify", "driver-subjects.json");
  let entries: ManifestEntry[];
  try {
    entries = parseManifest(readFileSync(manifest, "utf8"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const plans = planDrivers(entries);
  if (plans.length === 0) {
    console.error(`${manifest} names no drivers, so there is nothing to sweep`);
    return 1;
  }

  const host = await probeHost(repoRoot);
  for (const capability of CAPABILITIES) {
    const fact = host[capability];
    console.log(`host ${capability}: ${fact.present ? fact.detail : `absent, ${fact.detail}`}`);
  }

  try {
    const values = {
      checkout: isolated.checkout,
      shortSha,
      statusUrl: (process.env.FREEBOT_STATUS_URL ?? "").trim(),
      artifactOut: join(isolated.checkout, "packages", "verify", "artifacts", FEATURE, shortSha),
    };
    const subjects = plans.map((plan) => resolveSubject(plan, values));
    const sweep = await runSweep({
      checkout: isolated.checkout,
      commit,
      shortSha,
      branch: `${base} (${commit.slice(0, 7)})`,
      host,
      subjects,
      artifactDir,
      artifactLabel,
      secrets: vaultSecrets(),
    });
    console.log("");
    console.log(formatSweep(sweep, artifactLabel));
    if (!sweep.arithmetic) {
      console.error(
        "the summary's arithmetic does not add up, so this run's verdict is not trustworthy",
      );
    }
    return sweep.ok ? 0 : 1;
  } finally {
    if (keep) {
      console.log(`--keep: the isolated checkout is at ${isolated.checkout}`);
    } else {
      await discard(isolated.checkout, isolated.temporary);
    }
  }
}

if (import.meta.main) {
  process.exit(await main());
}
