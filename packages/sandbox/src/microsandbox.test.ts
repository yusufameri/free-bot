/**
 * The microsandbox integration suite: U9.1's one conformance suite, driven against a real `msb` on
 * this host.
 *
 *   bun test packages/sandbox/src/microsandbox.test.ts
 *   FREEBOT_MSB_TESTS=require bun test packages/sandbox/src/microsandbox.test.ts   # a skip fails
 *
 * `microsandboxTestsPrecondition` decides before any sandbox exists, and the two absences it names
 * are the only skips: no `msb` that answers `doctor`, and no pinned image in the engine's cache
 * (`msb image list -q`) with no OCI archive to import. Both print the command that fixes them and
 * are recorded as a `skip:` line, so a machine without microsandbox still passes the repo's gates.
 * Anything else is loud: `msb` present but broken throws rather than skipping.
 *
 * The evidence driver, `packages/verify/scripts/sandbox-microsandbox.ts`, is what commits an artifact
 * and the end-to-end run; this suite proves the adapter against the suite in the repo's own `bun
 * test`, and writes its lines to the same feature directory as `integration.txt`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactDir } from "@freebot/verify";
import {
  CONFORMANCE_OPERATIONS,
  type ConformanceResult,
  DEFAULT_UNIT,
  MicrosandboxAdapter,
  type MicrosandboxDecoySpec,
  microsandboxConformanceSubject,
  REPO_ROOT,
  runSandboxConformance,
} from "./index.ts";

const RUN = `${process.pid.toString(36)}-${randomBytes(3).toString("hex")}`;
const RUN_UNIT = `${DEFAULT_UNIT}-run-${RUN}`;
const scratchRoot = join(tmpdir(), `freebot-u92-unit-${RUN}-`);

function msb(args: readonly string[]): string {
  try {
    const proc = Bun.spawnSync(["msb", ...args], { stdout: "pipe", stderr: "pipe" });
    return `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
  } catch (error) {
    return `msb is not runnable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function msbCode(args: readonly string[]): number {
  try {
    return Bun.spawnSync(["msb", ...args], { stdout: "pipe", stderr: "pipe" }).exitCode ?? -1;
  } catch {
    return -1;
  }
}

type Tests = { readonly run: true } | { readonly run: false; readonly why: string };

function skip(why: string): Tests {
  if (process.env.FREEBOT_MSB_TESTS === "require") {
    throw new Error(`FREEBOT_MSB_TESTS=require and the suite cannot run: ${why}`);
  }
  return { run: false, why };
}

function precondition(): Tests {
  if (msbCode(["doctor"]) !== 0) {
    return skip(
      `no working msb on PATH: msb doctor exited non-zero (${msb(["doctor"]).split("\n")[0] ?? ""})`,
    );
  }
  const listed = msbCode(["image", "list", "-q"]);
  if (listed !== 0) throw new Error(`msb image list -q exited ${listed} while msb doctor passes`);
  if (
    !msb(["image", "list", "-q"])
      .split("\n")
      .map((line) => line.trim())
      .includes("freebot-sandbox:u0.6")
  ) {
    return skip(
      'the pinned image freebot-sandbox:u0.6 is not in the engine\'s cache; import it with "msb image load -i <oci-archive> --tag freebot-sandbox:u0.6"',
    );
  }
  return { run: true };
}

const git = (args: string[]): string =>
  Bun.spawnSync(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe" })
    .stdout.toString()
    .trim();

const SHORT_SHA = git(["rev-parse", "--short", "HEAD"]);
const ARTIFACT_DIR = artifactDir(REPO_ROOT, "sandbox-microsandbox", SHORT_SHA);
const ARTIFACT = join(ARTIFACT_DIR, "integration.txt");
const lines: string[] = [];

function record(line: string): void {
  lines.push(line);
  console.log(line);
}

const decoys: readonly MicrosandboxDecoySpec[] = [
  { name: `u92-unit-decoy-foreign-${RUN}`, unit: "u0.11", why: "another unit's label" },
  {
    name: `u92-unit-decoy-sibling-${RUN}`,
    unit: `${DEFAULT_UNIT}-run-${RUN}x`,
    why: "a sibling run",
  },
  { name: `u92-unit-decoy-bare-${RUN}`, unit: null, why: "no ownership label at all" },
];

const tests = precondition();
if (!tests.run) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(ARTIFACT, `feature: sandbox-microsandbox\nskip: ${tests.why}\n`);
  console.log(`skip microsandbox adapter (integration): ${tests.why}`);
}

describe.skipIf(!tests.run)("microsandbox adapter (integration)", () => {
  const adapter = new MicrosandboxAdapter({ unit: RUN_UNIT });
  let scratch = "";
  let result: ConformanceResult | null = null;

  beforeAll(() => {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    mkdirSync(scratchRoot, { recursive: true });
    scratch = mkdtempSync(join(scratchRoot, "scratch-"));
    record("feature: sandbox-microsandbox");
    record("command: bun test packages/sandbox/src/microsandbox.test.ts");
    record(`timestamp: ${new Date().toISOString()}`);
    record(`git short sha: ${SHORT_SHA} (branch ${git(["rev-parse", "--abbrev-ref", "HEAD"])})`);
    record(`runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`);
    record(`msb: ${msb(["--version"])}`);
    record(`run token: ${RUN} (this run owns freebot.unit=${RUN_UNIT})`);
    record("");
  });

  afterAll(async () => {
    await adapter.sweep().catch(() => []);
    for (const decoy of decoys) Bun.spawnSync(["msb", "rm", "-f", decoy.name]);
    rmSync(scratchRoot, { recursive: true, force: true });
    const left = msb(["ls", "--label", `freebot.unit=${RUN_UNIT}`, "-q"]);
    record(`sandboxes left under ${RUN_UNIT}: ${left === "" ? 0 : left.split("\n").length}`);
    writeFileSync(ARTIFACT, `${[...lines, ""].join("\n")}`);
  }, 60_000);

  test("the suite passes every operation", async () => {
    result = await runSandboxConformance(microsandboxConformanceSubject({ token: RUN, decoys }), {
      scratch,
      report: (line) => record(line),
    });
    expect(result.operations.map((it) => it.operation).join(" ")).toBe(
      CONFORMANCE_OPERATIONS.join(" "),
    );
    expect(result.operations.filter((it) => !it.ok)).toEqual([]);
    expect(result.ok).toBe(true);
  }, 600_000);
});
