/**
 * The Docker integration suite: the live surface of `packages/sandbox` against a real daemon, from
 * the pinned image.
 *
 *   bash packages/sandbox/image/run.sh                                          # materialize the image
 *   bun test packages/sandbox/src/docker.test.ts
 *   FREEBOT_DOCKER_TESTS=require bun test packages/sandbox/src/docker.test.ts    # a skip fails instead
 *
 * Since U9.1 the interface's operations are asserted once, in `conformance.ts`, and this file drives
 * that suite against the Docker subject: create from the pinned image, exec (buffered, streamed,
 * detached), upload and download, the tunnel echo and its typed failure, snapshot and resume, the
 * idle cut, and the label-scoped sweep with its decoy census. The one operation that stays here is
 * `exposePort`, whose Docker implementation is a host-side loopback bridge that no other backend
 * shares; `docs/sandbox-conformance.md` names that boundary and the interface gaps.
 *
 * `dockerTestsPrecondition` decides before any container exists. A daemon alone is the wrong
 * precondition: GitHub's ubuntu runner has one, but not the pinned image, and the image is arm64-only
 * (order 18: this Mac builds), so a linux/amd64 runner cannot materialize it. The suite runs only
 * where a daemon answers `docker version` and `freebot-sandbox:u0.6` resolves on that daemon. Those
 * two absences are the only skips; each prints its reason with the command that fixes it, and each is
 * recorded as a `skip:` line in that run's artifact. Everything else is loud: a daemon that answers
 * `version` and then fails `image ls` throws, a resolvable image always runs (so a drifted layer set
 * or a broken adapter fails the suite rather than skipping it), and FREEBOT_DOCKER_TESTS accepts only
 * `require` or nothing, failing on any other value.
 *
 * Two suites may run on the shared engine at the same time, so every container this run creates
 * carries one run token: `u91-<case>-<token>` for the name, and `freebot.unit=u1.2-run-<token>` for
 * the ownership label. Fixed names cannot collide and the order-22 sweep, label-scoped and unchanged,
 * reaches exactly this run's containers. The token is this process's pid in base 36 plus six random
 * hex digits.
 *
 * Every check writes a literal line to `packages/verify/artifacts/sandbox-provider/<sha>/assert.txt`,
 * including the decoy census before and after the sweep (order 22). That path is per-worktree, which
 * is per-agent (order 3), so the shared engine is the only shared resource.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactDir } from "@freebot/verify";
import {
  CONFORMANCE_OPERATIONS,
  type ConformanceResult,
  containerName,
  DEFAULT_STATE_DIR,
  DEFAULT_UNIT,
  DockerAdapter,
  type DockerDecoySpec,
  dockerConformanceSubject,
  ensurePinnedImage,
  PINNED_IMAGE,
  REPO_ROOT,
  runSandboxConformance,
} from "./index.ts";

/** The sandbox the Docker-only `exposePort` test runs its server in. */
const EXPOSE_PORT = 8125;

/** Pid in base 36 plus six random hex digits: unique per process, readable in `docker ps`. */
function runToken(): string {
  return `${process.pid.toString(36)}-${randomBytes(3).toString("hex")}`;
}

const RUN = runToken();

function runId(name: string): string {
  return `${name}-${RUN}`;
}

/** This run's ownership label value. `sweep()` is scoped to it and to nothing else. */
const RUN_UNIT = `${DEFAULT_UNIT}-run-${RUN}`;
/** A different run of this same suite; its containers must survive this run's sweep. */
const SIBLING_UNIT = `${DEFAULT_UNIT}-run-${randomBytes(3).toString("hex")}`;
/** Another unit on the same engine; its containers must survive this run's sweep. */
const FOREIGN_UNIT = "u0.11";

/** The containers this run must not sweep, standing in for the ones it does not own. */
const DECOYS: readonly DockerDecoySpec[] = [
  { name: runId("u91-decoy-foreign-unit"), unit: FOREIGN_UNIT, why: "another unit's label" },
  { name: runId("u91-decoy-sibling-run"), unit: SIBLING_UNIT, why: "a sibling run of this suite" },
  { name: runId("u91-decoy-bare"), unit: null, why: "no labels at all" },
];

function cli(args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = spawnSync(process.env.FREEBOT_DOCKER_BIN ?? "docker", args, { encoding: "utf8" });
  return {
    code: proc.status ?? -1,
    stdout: (proc.stdout ?? "").trim(),
    stderr: (proc.stderr ?? proc.error?.message ?? "").trim(),
  };
}

/** `require` turns a would-be skip into a failure, unset keeps the skip, and anything else is a typo. */
function dockerTestsRequired(): boolean {
  const mode = process.env.FREEBOT_DOCKER_TESTS;
  if (mode === undefined || mode === "") return false;
  if (mode === "require") return true;
  throw new Error(
    `FREEBOT_DOCKER_TESTS=${JSON.stringify(mode)} is not a mode; use unset or "require"`,
  );
}

const DOCKER_TESTS_REQUIRED = dockerTestsRequired();

type DockerTests = { readonly run: true } | { readonly run: false; readonly why: string };

/** A missing precondition skips, unless the caller demands the suite run. */
function skip(why: string): DockerTests {
  if (DOCKER_TESTS_REQUIRED) {
    throw new Error(`FREEBOT_DOCKER_TESTS=require and the suite cannot run: ${why}`);
  }
  return { run: false, why };
}

/**
 * Why the suite will run or skip, decided before any container exists. `image ls -q` prints an id
 * when the ref resolves and nothing when it does not, so absence is read from empty stdout instead of
 * docker's wording; a non-zero exit there is a broken CLI or daemon, which is not absence, and throws.
 */
function dockerTestsPrecondition(): DockerTests {
  const daemon = cli(["version", "--format", "{{.Server.Version}}"]);
  if (daemon.code !== 0 || daemon.stdout === "") {
    return skip(
      `no reachable Docker daemon: docker version exited ${daemon.code} (${daemon.stderr === "" ? "no stderr" : daemon.stderr})`,
    );
  }
  const listed = cli(["image", "ls", "-q", PINNED_IMAGE.tag]);
  if (listed.code !== 0) {
    throw new Error(
      `docker image ls -q ${PINNED_IMAGE.tag} exited ${listed.code} while the daemon answers docker version ${daemon.stdout} (${listed.stderr === "" ? "no stderr" : listed.stderr}); fix the daemon rather than skipping the suite`,
    );
  }
  if (listed.stdout === "") {
    return skip(
      `the pinned image ${PINNED_IMAGE.tag} is not on this daemon; materialize it with "bash packages/sandbox/image/run.sh"`,
    );
  }
  return { run: true };
}

const git = (args: string[]): string =>
  spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();

const SHORT_SHA = git(["rev-parse", "--short", "HEAD"]);
const ARTIFACT_DIR = artifactDir(REPO_ROOT, "sandbox-provider", SHORT_SHA);
const ARTIFACT = join(ARTIFACT_DIR, "assert.txt");

function artifactHeader(): string {
  return [
    "feature: sandbox-provider",
    "command: bun test packages/sandbox/src/docker.test.ts",
    `timestamp: ${new Date().toISOString()}`,
    `git short sha: ${SHORT_SHA} (branch ${git(["rev-parse", "--abbrev-ref", "HEAD"])})`,
    `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
    `docker server: ${cli(["version", "--format", "{{.Server.Version}}"]).stdout}`,
    `run token: ${RUN} (this run owns freebot.unit=${RUN_UNIT})`,
    "",
  ].join("\n");
}

function record(line: string): void {
  appendFileSync(ARTIFACT, `${line}\n`);
  console.log(line);
}

const dockerTests = dockerTestsPrecondition();
if (!dockerTests.run) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(ARTIFACT, `${artifactHeader()}skip: ${dockerTests.why}\n`);
  console.log(`skip docker adapter (integration): ${dockerTests.why}`);
}

describe.skipIf(!dockerTests.run)("docker adapter (integration)", () => {
  const adapter = new DockerAdapter({ unit: RUN_UNIT });
  const scratch = mkdtempSync(join(tmpdir(), `freebot-u91-${RUN}-`));
  let pinned: Awaited<ReturnType<typeof ensurePinnedImage>>;
  let result: ConformanceResult | null = null;

  beforeAll(async () => {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    writeFileSync(ARTIFACT, artifactHeader());
    pinned = await ensurePinnedImage();
    record(
      `check pinned image: tag=${pinned.ref} id=${pinned.imageId} layers=${pinned.layers.length}/${PINNED_IMAGE.layers.length} matching docs/sandbox-image.md`,
    );
    // A fresh token finds nothing, so this is the run's own label and never a leftover of another.
    const leftovers = await adapter.sweep();
    record(
      `check pre-suite sweep (this run's unit label ${RUN_UNIT} only, a fresh token finds nothing): removed=${leftovers.length}`,
    );
  }, 60_000);

  afterAll(async () => {
    await adapter.sweep();
    for (const decoy of DECOYS) cli(["rm", "-f", decoy.name]);
    rmSync(scratch, { recursive: true, force: true });
  }, 60_000);

  test("the interface's operations pass the conformance suite", async () => {
    const subject = dockerConformanceSubject({ token: RUN, decoys: DECOYS });
    result = await runSandboxConformance(subject, { scratch, report: record });
    for (const operation of result.operations) {
      record(
        `${operation.ok ? "PASS" : "FAIL"} operation ${operation.operation}${operation.ok ? "" : `: ${operation.error}`}`,
      );
    }
    record(
      `conformance suite: ${result.operations.filter((it) => it.ok).length}/${CONFORMANCE_OPERATIONS.length} operations passed, ok=${result.ok}`,
    );
    expect(result.operations.map((it) => `${it.operation}:${it.ok}`)).toEqual([
      "create:true",
      "exec:true",
      "upload:true",
      "download:true",
      "tunnel:true",
      "snapshot-resume:true",
      "idle-kill:true",
      "sweep:true",
    ]);
    expect(result.ok).toBe(true);
  }, 300_000);

  test("exposePort forwards a loopback URL to a port inside the sandbox", async () => {
    // Docker-only: the forward is one `docker exec` byte bridge per connection, which no other
    // backend shares, so it is asserted here rather than in the suite.
    const handle = await adapter.create({
      name: runId("u91-expose"),
      image: pinned.ref,
      stateDir: DEFAULT_STATE_DIR,
    });
    await adapter.exec(
      handle,
      [
        "node",
        "-e",
        `const http = require("node:http"); http.createServer((request, response) => response.end("exposed-body")).listen(${EXPOSE_PORT}, "127.0.0.1");`,
      ],
      { detached: true },
    );
    const url = await adapter.exposePort(handle, EXPOSE_PORT);
    expect(url.startsWith("http://127.0.0.1:")).toBe(true);
    let body = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && body === "") {
      try {
        body = await (await fetch(url)).text();
      } catch {
        await Bun.sleep(100);
      }
    }
    expect(body).toBe("exposed-body");
    record(`check exposePort: ${url} -> ${JSON.stringify(body)}`);
    await adapter.delete(handle);
    expect(cli(["inspect", "--format", "{{.Id}}", containerName(handle.id)]).code).not.toBe(0);
    record(`check exposePort delete: ${handle.id} is gone from the engine`);
  }, 60_000);
});
