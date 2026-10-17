/**
 * The Docker integration suite: the live surface of `packages/sandbox` against a real daemon, from
 * the pinned image.
 *
 *   bash packages/sandbox/image/run.sh                                          # materialize the image
 *   bun test packages/sandbox/src/docker.test.ts
 *   FREEBOT_DOCKER_TESTS=require bun test packages/sandbox/src/docker.test.ts    # a skip fails instead
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
 * carries one run token: `freebot-sbx-<case>-<token>` for the name, and `freebot.unit=u1.2-run-<token>`
 * for the ownership label. Fixed names cannot collide and the order-22 sweep, unchanged and still
 * label-scoped, reaches exactly this run's containers. The token is this process's pid in base 36
 * plus six random hex digits.
 *
 * Every check writes a literal line to `packages/verify/artifacts/sandbox-provider/<sha>/assert.txt`,
 * including the container lists before and after the label-scoped sweep (order 22). That path is
 * per-worktree, which is per-agent (order 3), so the shared engine is the only shared resource.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { encodeLine, splitLines } from "@freebot/sandbox-agent";
import { artifactDir } from "@freebot/verify";
import {
  containerName,
  DEFAULT_UNIT,
  DockerAdapter,
  ensurePinnedImage,
  PINNED_IMAGE,
  PROVIDER_LABEL,
  REPO_ROOT,
  SANDBOX_LABEL,
  SandboxError,
  UNIT_LABEL,
} from "./index.ts";

const WORK = `/var/freebot`;
const PEER_DIR = `${WORK}/link-peer`;

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

/** A container this run must not sweep, standing in for one it does not own. */
interface Decoy {
  readonly name: string;
  /** The ownership label value it carries; null means it carries no labels at all. */
  readonly unit: string | null;
}

const DECOYS: readonly Decoy[] = [
  { name: runId("u12-decoy-foreign-unit"), unit: FOREIGN_UNIT },
  { name: runId("u12-decoy-sibling-run"), unit: SIBLING_UNIT },
  { name: runId("u12-decoy-bare"), unit: null },
];

function decoyRunArgs(decoy: Decoy): string[] {
  if (decoy.unit === null) return [];
  return [
    "--label",
    `${UNIT_LABEL}=${decoy.unit}`,
    "--label",
    `${SANDBOX_LABEL}=${decoy.name}`,
    "--label",
    `${PROVIDER_LABEL}=docker`,
  ];
}

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

/** Container status by docker container name. */
function rawStatus(name: string): string {
  return cli(["inspect", "--format", "{{.State.Status}}", name]).stdout;
}

function containerStatus(id: string): string {
  return rawStatus(containerName(id));
}

/** id + running state per name; uptime text is not comparable across two ps calls. */
function decoyState(): string {
  return DECOYS.map((decoy) => {
    const inspected = cli(["inspect", "--format", "{{.Id}} {{.State.Status}}", decoy.name]).stdout;
    return `${decoy.name}=${inspected}`;
  }).join(", ");
}

function ps(filter: string[] = [], format = "{{.ID}}|{{.Names}}|{{.Status}}"): string {
  return cli(["ps", "-a", ...filter.flatMap((value) => ["--filter", value]), "--format", format])
    .stdout;
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
    `run token: ${RUN} (this run owns ${UNIT_LABEL}=${RUN_UNIT})`,
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

/** One JSONL line per call, off a duplex, with the same framing the link itself uses. */
function lineReader(stream: Duplex): (timeoutMs?: number) => Promise<string> {
  let buffer = "";
  const queued: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  stream.on("data", (chunk: Buffer) => {
    const split = splitLines(buffer, chunk.toString("utf8"));
    buffer = split.rest;
    for (const line of split.lines) {
      const waiter = waiters.shift();
      if (waiter === undefined) queued.push(line);
      else waiter(line);
    }
  });
  return (timeoutMs = 5000) => {
    const ready = queued.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no line within timeout")), timeoutMs);
      waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  };
}

async function waitFor(read: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await read()) return true;
    await Bun.sleep(100);
  }
  return false;
}

describe.skipIf(!dockerTests.run)("docker adapter (integration)", () => {
  const adapter = new DockerAdapter({ unit: RUN_UNIT });
  const scratch = mkdtempSync(join(tmpdir(), `freebot-u12-${RUN}-`));
  let pinned: Awaited<ReturnType<typeof ensurePinnedImage>>;

  beforeAll(async () => {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    writeFileSync(ARTIFACT, artifactHeader());
    pinned = await ensurePinnedImage();
    record(
      `check pinned image: tag=${pinned.ref} id=${pinned.imageId} layers=${pinned.layers.length}/${PINNED_IMAGE.layers.length} matching docs/sandbox-image.md`,
    );
    const leftovers = await adapter.sweep();
    record(
      `check pre-suite sweep (this run's unit label ${RUN_UNIT} only, a fresh token finds nothing): removed=${leftovers.length}`,
    );
    for (const decoy of DECOYS) {
      cli([
        "run",
        "-d",
        "--name",
        decoy.name,
        ...decoyRunArgs(decoy),
        PINNED_IMAGE.tag,
        "sleep",
        "infinity",
      ]);
    }
    record(
      `check decoys created: ${DECOYS.map((decoy) => `${decoy.name} (unit=${decoy.unit ?? "none"})`).join(", ")} status=${DECOYS.map((decoy) => rawStatus(decoy.name)).join(", ")}`,
    );
  }, 60_000);

  afterAll(async () => {
    await adapter.sweep();
    for (const decoy of DECOYS) cli(["rm", "-f", decoy.name]);
    rmSync(scratch, { recursive: true, force: true });
  }, 60_000);

  test("create runs the pinned image and labels the container for order-22 cleanup", async () => {
    const handle = await adapter.create({ name: runId("u12-main") });
    expect(handle).toEqual({ provider: "docker", id: runId("u12-main") });
    const raw = cli([
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      containerName(runId("u12-main")),
    ]);
    const labels = JSON.parse(raw.stdout) as Record<string, string>;
    expect(labels[SANDBOX_LABEL]).toBe(runId("u12-main"));
    expect(labels[UNIT_LABEL]).toBe(RUN_UNIT);
    expect(labels[PROVIDER_LABEL]).toBe("docker");
    expect(containerStatus(runId("u12-main"))).toBe("running");
    const layers = JSON.parse(
      cli(["image", "inspect", "--format", "{{json .RootFS.Layers}}", PINNED_IMAGE.tag]).stdout,
    ) as string[];
    expect(layers).toEqual([...PINNED_IMAGE.layers]);
    record(`check create: handle=${JSON.stringify(handle)} labels=${JSON.stringify(labels)}`);
    record(
      `check container image content: ${layers.length} RootFS layers equal the U0.6-recorded set`,
    );
  }, 60_000);

  test("exec returns literal stdout, streams, and the command's own exit code", async () => {
    const handle = { provider: "docker", id: runId("u12-main") } as const;
    const plain = await adapter.exec(handle, ["bash", "-c", "echo hello-from-sandbox"]);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout.toString().trim()).toBe("hello-from-sandbox");
    const streamed = await adapter.exec(
      handle,
      ["bash", "-c", "printf 'stream-one\\nstream-two\\n'"],
      {
        stream: true,
      },
    );
    let chunks = "";
    streamed.stdout.on("data", (chunk: Buffer) => {
      chunks += chunk.toString("utf8");
    });
    const outcome = await streamed.result;
    expect(outcome.exitCode).toBe(0);
    expect(chunks).toBe("stream-one\nstream-two\n");
    const failed = await adapter.exec(handle, ["bash", "-c", "exit 7"]);
    expect(failed.exitCode).toBe(7);
    record(
      `check exec echo: exit=${plain.exitCode} stdout=${JSON.stringify(plain.stdout.toString().trim())}`,
    );
    record(`check exec stream: exit=${outcome.exitCode} streamed=${JSON.stringify(chunks)}`);
    record(`check exec exit code: exit=${failed.exitCode} for "exit 7"`);
  }, 60_000);

  test("detached exec outlives the call", async () => {
    const handle = { provider: "docker", id: runId("u12-main") } as const;
    const started = await adapter.exec(
      handle,
      ["bash", "-c", `sleep 0.5 && printf detached-marker > ${WORK}/detached.txt`],
      { detached: true },
    );
    expect(started).toEqual({ started: true });
    let content = "";
    const appeared = await waitFor(async () => {
      const read = await adapter.exec(handle, ["cat", `${WORK}/detached.txt`]);
      content = read.exitCode === 0 ? read.stdout.toString() : "";
      return content !== "";
    }, 10_000);
    expect(appeared).toBe(true);
    expect(content).toBe("detached-marker");
    record(`check detached exec: {started:true} then marker=${JSON.stringify(content)}`);
  }, 60_000);

  test("upload and download round-trip 4096 random bytes", async () => {
    const handle = { provider: "docker", id: runId("u12-main") } as const;
    const bytes = randomBytes(4096);
    const localUp = join(scratch, "up.bin");
    writeFileSync(localUp, bytes);
    await adapter.upload(handle, localUp, `${WORK}/up.bin`);
    const sha = await adapter.exec(handle, ["sha256sum", `${WORK}/up.bin`]);
    const remoteSha = sha.stdout.toString().trim().split(/\s+/)[0];
    const localSha = createHash("sha256").update(bytes).digest("hex");
    expect(remoteSha).toBe(localSha);
    const localDown = join(scratch, "down.bin");
    await adapter.download(handle, `${WORK}/up.bin`, localDown);
    const downloaded = readFileSync(localDown);
    expect(downloaded.length).toBe(4096);
    expect(downloaded.equals(bytes)).toBe(true);
    record(
      `check upload/download: bytes=4096 sha256=${localSha} same-in-sandbox=${remoteSha === localSha} round-trip-equal=${downloaded.equals(bytes)}`,
    );
  }, 60_000);

  test("tunnel carries link frames to an agent link inside the sandbox", async () => {
    const handle = { provider: "docker", id: runId("u12-main") } as const;
    await adapter.exec(handle, ["mkdir", "-p", PEER_DIR]);
    await adapter.upload(
      handle,
      join(REPO_ROOT, "apps/sandbox-agent/src/link.ts"),
      `${PEER_DIR}/link.ts`,
    );
    await adapter.upload(
      handle,
      join(REPO_ROOT, "packages/sandbox/src/link-peer.fixture.mjs"),
      `${PEER_DIR}/peer.mjs`,
    );
    await adapter.exec(
      handle,
      [
        "bash",
        "-c",
        `node ${PEER_DIR}/peer.mjs ${WORK}/supervisor.port > ${PEER_DIR}/peer.log 2>&1`,
      ],
      { detached: true },
    );
    const portFile = await waitFor(async () => {
      const read = await adapter.exec(handle, ["cat", `${WORK}/supervisor.port`]);
      return read.exitCode === 0 && read.stdout.toString().trim() !== "";
    }, 10_000);
    expect(portFile).toBe(true);
    let duplex: Duplex;
    try {
      duplex = await adapter.tunnel(handle);
    } catch (error) {
      const log = await adapter.exec(handle, ["cat", `${PEER_DIR}/peer.log`]);
      record(`peer.log before the tunnel error:\n${log.stdout.toString()}${log.stderr.toString()}`);
      throw error;
    }
    try {
      expect(duplex).toBeInstanceOf(Duplex);
      const readLine = lineReader(duplex);
      const handshake = await readLine();
      expect(JSON.parse(handshake)).toEqual({ kind: "attached", acked: 0, lastSeq: 0 });
      duplex.write(encodeLine({ kind: "ack", seq: 7 }));
      const echo = await readLine();
      expect(JSON.parse(echo)).toEqual({ kind: "frame", seq: 7, frame: { type: "agent_settled" } });
      record(`check tunnel handshake: ${handshake}`);
      record(`check tunnel echo: wrote ack seq=7, read back ${echo}`);
    } finally {
      // Destroying the composite aborts any read in flight; that error belongs to the caller.
      duplex.on("error", () => {});
      duplex.destroy();
    }
  }, 60_000);

  test("tunnel fails typed when no link is running", async () => {
    const handle = await adapter.create({ name: runId("u12-no-link") });
    const error = await adapter.tunnel(handle).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(SandboxError);
    const typed = error as SandboxError;
    expect(typed.code).toBe("link_error");
    expect(
      typed.message.startsWith(
        `no supervisor link in ${containerName(runId("u12-no-link"))}: ${WORK}/supervisor.port is not readable`,
      ),
    ).toBe(true);
    await adapter.delete(handle);
    record(
      `check tunnel without a link: code=${typed.code} message=${JSON.stringify(typed.message)}`,
    );
  }, 60_000);

  test("exposePort forwards a loopback URL to a port inside the sandbox", async () => {
    const handle = { provider: "docker", id: runId("u12-main") } as const;
    await adapter.exec(
      handle,
      [
        "node",
        "-e",
        'const http = require("node:http"); http.createServer((request, response) => response.end("exposed-body")).listen(8125, "127.0.0.1");',
      ],
      { detached: true },
    );
    const url = await adapter.exposePort(handle, 8125);
    expect(url.startsWith("http://127.0.0.1:")).toBe(true);
    let body = "";
    const served = await waitFor(async () => {
      try {
        const response = await fetch(url);
        body = await response.text();
        return body !== "";
      } catch {
        return false;
      }
    }, 10_000);
    expect(served).toBe(true);
    expect(body).toBe("exposed-body");
    record(`check exposePort: ${url} -> ${JSON.stringify(body)}`);
  }, 60_000);

  test("snapshot, stop, resume round trip keeps the disk state", async () => {
    const handle = { provider: "docker", id: runId("u12-main") } as const;
    await adapter.exec(handle, [
      "bash",
      "-c",
      "printf 'round-trip-marker\\n' > /workspace/marker.txt",
    ]);
    const snapshot = await adapter.snapshot(handle, "u12-round-trip");
    expect(snapshot.ref.startsWith("sha256:")).toBe(true);
    expect(snapshot.tag).toBe(`freebot-snapshot/${runId("u12-main")}:u12-round-trip`);
    expect(snapshot.provider).toBe("docker");
    await adapter.stop(handle);
    expect(containerStatus(runId("u12-main"))).toBe("exited");
    await adapter.resume(handle);
    expect(containerStatus(runId("u12-main"))).toBe("running");
    const marker = await adapter.exec(handle, ["cat", "/workspace/marker.txt"]);
    expect(marker.stdout.toString()).toBe("round-trip-marker\n");
    const restored = await adapter.create({ name: runId("u12-from-snap"), image: snapshot.ref });
    const restoredMarker = await adapter.exec(restored, ["cat", "/workspace/marker.txt"]);
    expect(restoredMarker.stdout.toString()).toBe("round-trip-marker\n");
    record(
      `check snapshot: tag=${snapshot.tag} ref=${snapshot.ref} createdAt=${snapshot.createdAt}`,
    );
    record(
      `check stop/resume: exited -> running, marker=${JSON.stringify(marker.stdout.toString())}`,
    );
    record(
      `check disk-only restore: ${restored.id} from the snapshot reads marker=${JSON.stringify(restoredMarker.stdout.toString())}`,
    );
  }, 120_000);

  test("idle-kill stops the sandbox after its ttl, but not while the sandbox is being used", async () => {
    const idler = await adapter.create({ name: runId("u12-idle"), idleTtlMs: 600 });
    const startedAt = Date.now();
    const stopped = await waitFor(
      async () => containerStatus(runId("u12-idle")) === "exited",
      15_000,
    );
    expect(stopped).toBe(true);
    record(
      `check idle-kill: ${runId("u12-idle")} (idleTtlMs=600) stopped after ${Date.now() - startedAt}ms with no adapter call (docker stop -t 2)`,
    );
    await adapter.resume(idler);
    for (let index = 0; index < 4; index += 1) {
      await adapter.exec(idler, ["true"]);
      await Bun.sleep(200);
    }
    expect(containerStatus(runId("u12-idle"))).toBe("running");
    record(
      "check idle-touch: still running after 4 exec calls at 200ms intervals against a 600ms ttl",
    );
  }, 60_000);

  test("the label-scoped sweep removes this run's containers and nothing else", async () => {
    expect(containerStatus(runId("u12-idle"))).toBe("running");
    const unitBefore = ps([`label=${UNIT_LABEL}=${RUN_UNIT}`]);
    const foreignBefore = ps([`label=${UNIT_LABEL}=${FOREIGN_UNIT}`]);
    const siblingBefore = ps([`label=${UNIT_LABEL}=${SIBLING_UNIT}`]);
    const bareBefore = ps([`name=${runId("u12-decoy-bare")}`]);
    const decoysBefore = decoyState();
    record(`containers before sweep (label ${UNIT_LABEL}=${RUN_UNIT}):\n${unitBefore}`);
    record(`containers before sweep (foreign unit ${FOREIGN_UNIT}):\n${foreignBefore}`);
    record(`containers before sweep (a sibling run of this suite):\n${siblingBefore}`);
    record(`containers before sweep (unlabelled decoy):\n${bareBefore}`);
    // The run owns main, from-snap and idle: no-link was deleted by its own test, and nothing else
    // in this file creates a container.
    const ownedBefore = ps([`label=${UNIT_LABEL}=${RUN_UNIT}`], "{{.Names}}")
      .split("\n")
      .filter((line) => line !== "")
      .sort();
    expect(ownedBefore).toEqual(
      [runId("u12-from-snap"), runId("u12-idle"), runId("u12-main")].map(containerName).sort(),
    );
    const removed = await adapter.sweep();
    expect(removed.length).toBe(3);
    const unitAfter = ps([`label=${UNIT_LABEL}=${RUN_UNIT}`]);
    expect(unitAfter).toBe("");
    expect(decoyState()).toBe(decoysBefore);
    for (const decoy of DECOYS) expect(rawStatus(decoy.name)).toBe("running");
    record(
      `check sweep removed ${removed.length} containers with label ${UNIT_LABEL}=${RUN_UNIT}: ${removed.join(", ")}`,
    );
    record(
      `containers after sweep (label ${UNIT_LABEL}=${RUN_UNIT}):\n${unitAfter === "" ? "(none)" : unitAfter}`,
    );
    record(`containers after sweep, unchanged: ${decoysBefore}`);
  }, 120_000);
});
