#!/usr/bin/env bun
/**
 * U10.8's evidence: the canonical tag starts on an off-pin image, the real `ensurePinnedImage`
 * repairs it with one `docker tag`, and a container created afterwards runs.
 *
 * Real: the Docker CLI and daemon, a probe image this driver builds, the canonical tag, and a
 * container from the pinned image. Nothing about the sandbox is faked. The driver reads no model,
 * no provider, and no vault file, so there is no key to leak.
 *
 * Cleanup is label- and name-scoped to what this run created (order 22). The tag is restored to a
 * layer-matching image, and the probe image is removed.
 *
 * Run from the repo root: bun packages/verify/scripts/sandbox-pin-repair.ts
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  containerName,
  DEFAULT_STATE_DIR,
  DockerAdapter,
  dockerImageEngine,
  ensurePinnedImage,
  PINNED_IMAGE,
  type PinnedImage,
} from "../../../packages/sandbox/src/index.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const FEATURE = "sandbox-pin-repair";
const TOKEN = `${process.pid.toString(36)}-${randomBytes(3).toString("hex")}`;
const RUN_UNIT = `u10.8-run-${TOKEN}`;
const SANDWICH = `u108-run-${TOKEN}`;
const PROBE_REF = `freebot-u10.8-off-pin:${TOKEN}`;
const DOCKER = process.env.FREEBOT_DOCKER_BIN ?? "docker";

const lines: string[] = [];
let checks = 0;
let passed = 0;

function record(line: string): void {
  lines.push(line);
  console.log(line);
}

function expect(ok: boolean, line: string): void {
  checks += 1;
  if (ok) passed += 1;
  record(`${ok ? "PASS" : "FAIL"} ${line}`);
}

function spawn(args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode ?? -1,
    out: proc.stdout.toString().trim(),
    err: proc.stderr.toString().trim(),
  };
}

function docker(args: string[]): { code: number; out: string; err: string } {
  return spawn([DOCKER, ...args]);
}

function git(args: string[]): string {
  const result = spawn(["git", ...args]);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.err}`);
  return result.out;
}

const shortId = (id: string): string => id.replace(/^sha256:/, "").slice(0, 12);

function matchesPin(
  image: { readonly layers: readonly string[] },
  expected: readonly string[],
): boolean {
  return (
    image.layers.length === expected.length &&
    image.layers.every((layer, index) => layer === expected[index])
  );
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Key-shaped literals only. The driver reads no vault file, so this scan is the whole custody claim. */
const KEY_SHAPED =
  /(sk-[A-Za-z0-9_-]{16,}|FREEBOT_FAKE_KEY_CANARY_[0-9a-f]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

function keyScan(dir: string): { files: string[]; hits: string[] } {
  const files: string[] = [];
  const hits: string[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(full);
        if (KEY_SHAPED.test(readFileSync(full, "utf8"))) hits.push(full);
      }
    }
  };
  walk(dir);
  return { files, hits };
}

const expected = [...PINNED_IMAGE.layers];
const engine = dockerImageEngine();
const inventory = await engine.inspect(await engine.listIds());
const localMatches = inventory.filter((image) => matchesPin(image, expected));
record(
  `inventory: ${inventory.length} local images, ${localMatches.length} carry the pinned layer set (${localMatches.map((image) => shortId(image.id)).join(", ")})`,
);
expect(localMatches.length > 0, "a local image carries the pinned layer set before the tag moves");

const scratch = mkdtempSync(join(tmpdir(), `freebot-u108-${TOKEN}-`));
const dockerfile = join(scratch, "Dockerfile");
writeFileSync(dockerfile, `FROM scratch\nLABEL freebot.u10.8.probe="${TOKEN}"\n`);

const adapter = new DockerAdapter({ unit: RUN_UNIT });
let handle: Awaited<ReturnType<DockerAdapter["create"]>> | null = null;
let probeId: string | null = null;
let restoreId: string | null = localMatches[0]?.id ?? null;
let sandboxId: string | null = null;
let fatal: string | null = null;

try {
  const built = docker(["build", "-t", PROBE_REF, "-f", dockerfile, scratch]);
  if (built.code !== 0) {
    throw new Error(`docker build of the probe image exited ${built.code}: ${built.err}`);
  }
  const probe = (await engine.inspect((await engine.resolveRef(PROBE_REF)).slice(0, 1)))[0];
  if (probe === undefined) throw new Error(`the probe image ${PROBE_REF} did not resolve`);
  probeId = probe.id;
  const probeImageId = probe.id;
  probeId = probeImageId;
  expect(
    !matchesPin(probe, expected),
    `the probe image ${shortId(probeImageId)} is off-pin (${probe.layers.length} layers against the pin's ${expected.length})`,
  );

  let repaired: PinnedImage | null = null;
  for (let attempt = 1; attempt <= 5 && repaired === null; attempt += 1) {
    docker(["tag", probeImageId, PINNED_IMAGE.tag]);
    const pointed = (
      await engine.inspect((await engine.resolveRef(PINNED_IMAGE.tag)).slice(0, 1))
    )[0];
    if (pointed === undefined || pointed.id !== probeImageId) {
      await sleep(50);
      continue;
    }
    const beforeBuild = new Set(await engine.listIds());
    const repairLog: string[] = [];
    const pinned = await ensurePinnedImage({ engine, log: (line) => repairLog.push(line) });
    if (!repairLog.some((line) => line.includes(`pointed at ${shortId(probeImageId)}`))) {
      // Something re-pointed the tag between the read and the call. Try the bracket again.
      await sleep(50);
      continue;
    }
    record(
      `bracket: attempt ${attempt} started with ${PINNED_IMAGE.tag} at ${shortId(pointed.id)} (${pointed.layers.length} layers), read through docker images`,
    );
    for (const line of repairLog) record(`ensurePinnedImage: ${line}`);
    const afterIds = await engine.listIds();
    const added = afterIds.filter((id) => !beforeBuild.has(id));
    expect(
      repairLog.some((line) => line.includes("re-pointed it at")),
      "the check repaired the tag and said so in one line",
    );
    expect(
      matchesPin(pinned, expected),
      `the returned image ${shortId(pinned.imageId)} carries the pinned layer set (${pinned.layers.length}/${expected.length})`,
    );
    expect(
      localMatches.some((image) => image.id === pinned.imageId),
      `the returned image is one of the local layer matches, not a build`,
    );
    expect(
      (await engine.resolveRef(PINNED_IMAGE.tag))[0] === pinned.imageId,
      `the tag resolves to ${shortId(pinned.imageId)} after the repair`,
    );
    expect(
      added.length === 0,
      `the repair added no image id, so it did not build (${added.length} new ids)`,
    );
    restoreId = pinned.imageId;
    repaired = pinned;
  }
  expect(repaired !== null, "the tag started off-pin and the check repaired it within 5 attempts");
  if (repaired === null) throw new Error("the tag never stayed off-pin long enough to repair");

  handle = await adapter.create({
    name: SANDWICH,
    image: repaired.ref,
    stateDir: DEFAULT_STATE_DIR,
  });
  sandboxId = handle.id;
  const ran = await adapter.exec(handle, ["node", "--version"]);
  expect(
    ran.exitCode === 0 && ran.stdout.toString().trim() === "v24.22.0",
    `a container from ${PINNED_IMAGE.tag} after the repair runs node --version -> v24.22.0 (stdout ${JSON.stringify(ran.stdout.toString().trim())}, exit ${ran.exitCode})`,
  );
  await adapter.delete(handle);
  handle = null;
  const gone = docker(["inspect", "--format", "{{.Id}}", containerName(sandboxId)]);
  expect(gone.code !== 0, `the run's own container ${containerName(sandboxId)} is gone`);
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  expect(false, `driver completed without throwing: ${fatal}`);
} finally {
  if (handle !== null) {
    try {
      await adapter.delete(handle);
    } catch (error) {
      record(
        `cleanup: adapter.delete failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const leftovers = await adapter.sweep();
  record(`cleanup: label-scoped sweep under ${RUN_UNIT} removed ${leftovers.length} container(s)`);
  if (restoreId !== null) {
    docker(["tag", restoreId, PINNED_IMAGE.tag]);
    const restored = (
      await engine.inspect((await engine.resolveRef(PINNED_IMAGE.tag)).slice(0, 1))
    )[0];
    expect(
      restored !== undefined && matchesPin(restored, expected),
      `cleanup: ${PINNED_IMAGE.tag} points at a layer-matching image (${restored === undefined ? "unset" : shortId(restored.id)})`,
    );
  }
  if (probeId !== null) {
    const removed = docker(["image", "rm", PROBE_REF]);
    const probeGone = docker(["image", "inspect", "--format", "{{.Id}}", probeId]);
    expect(
      removed.code === 0 && probeGone.code !== 0,
      `cleanup: the probe image ${shortId(probeId)} is gone from the engine`,
    );
  }
  rmSync(scratch, { recursive: true, force: true });
}

const shortSha = git(["rev-parse", "--short", "HEAD"]);
const artifactDir = join(root, "packages", "verify", "artifacts", FEATURE, shortSha);
mkdirSync(artifactDir, { recursive: true });
const artifact = join(artifactDir, "assert.txt");
const header = [
  `feature: ${FEATURE}`,
  "command: bun packages/verify/scripts/sandbox-pin-repair.ts",
  `timestamp: ${new Date().toISOString()}`,
  `git commit: ${git(["rev-parse", "HEAD"])}`,
  `git short sha: ${shortSha} (branch ${git(["rev-parse", "--abbrev-ref", "HEAD"])})`,
  `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
  `docker server: ${docker(["version", "--format", "{{.Server.Version}}"]).out}`,
  `run unit label: ${RUN_UNIT}`,
  "",
];
writeFileSync(artifact, `${header.join("\n")}${lines.join("\n")}\n`);

const scan = keyScan(artifactDir);
expect(
  scan.hits.length === 0,
  `key scan: ${scan.files.length} file(s) under ${artifactDir.replace(`${root}/`, "")} carry no key-shaped literal`,
);

writeFileSync(
  artifact,
  `${header.join("\n")}${lines.join("\n")}\nRESULT: ${passed === checks ? "PASS" : "FAIL"} (${passed}/${checks})\n`,
);
console.log(`artifact: ${artifact}`);
process.exit(passed === checks ? 0 : 1);
