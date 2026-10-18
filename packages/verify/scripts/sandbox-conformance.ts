#!/usr/bin/env bun
/**
 * The U9.1 evidence driver: the sandbox conformance suite, run against Docker in a really launched
 * app, and twice more against a backend with one operation sabotaged so that a pass is a pass.
 *
 * The app is the real launcher, `bun run up --no-open`, spawned the way a person runs it, over a home
 * and a bots root this driver made, with the replay provider pinned in its environment. The driver
 * starts one run through that app's own `start_run`, so the app's containers are live on the shared
 * engine while the suite's label-scoped sweep runs: the sweep must leave them, and the suite's own
 * three decoys, exactly where they were.
 *
 * Real: the launcher, its listeners, its oRPC router, the run path, the container from the pinned
 * image, and the containers the suite creates. Replayed: the model's turns, because this driver pins
 * the replay provider so the run path is deterministic. Pinned: the sandbox image.
 *
 * Run from the repo root: bun packages/verify/scripts/sandbox-conformance.ts
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUN_UNIT as APP_UNIT } from "../../../apps/server/src/run-ports.ts";
import {
  CONFORMANCE_OPERATIONS,
  type ConformanceDecoy,
  type ConformanceResult,
  DEFAULT_UNIT,
  DockerAdapter,
  type DockerDecoySpec,
  dockerConformanceSubject,
  runSandboxConformance,
  sabotageOperation,
} from "../../../packages/sandbox/src/index.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const FEATURE = "sandbox-conformance";
/** Fixed names cannot collide with another run of this driver on the shared engine. */
const TOKEN = `${process.pid.toString(36)}-${randomBytes(3).toString("hex")}`;
const RUN_UNIT = `${DEFAULT_UNIT}-run-${TOKEN}`;

const lines: string[] = [];
const failures: string[] = [];

function record(line: string): void {
  lines.push(line);
  console.log(line);
}

function section(title: string): void {
  record("");
  record(`## ${title}`);
}

function expect(ok: boolean, line: string): void {
  record(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures.push(line);
}

function shell(args: string[], cwd = root): { out: string; err: string; code: number } {
  const proc = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    out: proc.stdout.toString().trim(),
    err: proc.stderr.toString().trim(),
    code: proc.exitCode ?? -1,
  };
}

function git(args: string[]): string {
  const result = shell(["git", ...args]);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.err}`);
  return result.out;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait for a fact, and report the timeout rather than throwing so the artifact is still written. */
async function settled(
  read: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await read()) return true;
    await sleep(100);
  }
  record(`timed out after ${timeoutMs}ms waiting for ${what}`);
  return false;
}

/** One oRPC arm, posted the way the page's own client posts it. */
function rpc(
  port: number,
  path: string,
  token: string,
  body: string,
): { status: string; body: string } {
  const result = shell([
    "curl",
    "-sS",
    "--max-time",
    "10",
    "-X",
    "POST",
    "-w",
    "\n%{http_code}",
    "-H",
    `origin: http://127.0.0.1:${port}`,
    "-H",
    `authorization: Bearer ${token}`,
    "-H",
    "content-type: application/json",
    "--data",
    body,
    `http://127.0.0.1:${port}${path}`,
  ]);
  const raw = `${result.out}${result.err}`;
  const cut = raw.lastIndexOf("\n");
  return { body: raw.slice(0, cut).trim(), status: raw.slice(cut + 1).trim() };
}

/** The containers the engine holds under one ownership label: `name=<id> <status>` per container. */
function census(unit: string): string[] {
  const listed = shell([
    "docker",
    "ps",
    "-a",
    "--filter",
    `label=freebot.unit=${unit}`,
    "--format",
    "{{.Names}}",
  ]);
  return listed.out
    .split("\n")
    .filter((name) => name !== "")
    .sort()
    .map((name) => `${name}=${containerFact(name)}`);
}

function containerFact(name: string): string {
  const raw = shell(["docker", "inspect", "--format", "{{.Id}} {{.State.Status}}", name]);
  return raw.code === 0 ? raw.out : "gone";
}

/** The three containers the sweep must not touch, one per way a container can be someone else's. */
function decoySpecs(token: string): readonly DockerDecoySpec[] {
  return [
    { name: `u91-decoy-foreign-unit-${token}`, unit: "u0.11", why: "another unit's label" },
    {
      name: `u91-decoy-sibling-run-${token}`,
      unit: `${DEFAULT_UNIT}-run-${token}x`,
      why: "a sibling run of this suite",
    },
    { name: `u91-decoy-bare-${token}`, unit: null, why: "no labels at all" },
  ];
}

interface App {
  readonly port: number;
  readonly token: string;
  readonly url: string;
  readonly stdout: () => string;
  readonly stderr: () => string;
  stop(): void;
  exited(): Promise<number>;
}

/** `bun run up --no-open`, exactly as a person types it, over a home and a bots root of our own. */
async function launchApp(home: string, botsRoot: string): Promise<App> {
  const proc = Bun.spawn(["bun", "run", "up", "--no-open"], {
    cwd: root,
    env: {
      ...process.env,
      FREEBOT_PROVIDER: "replay",
      FREEBOT_HOME: home,
      FREEBOT_WORKSPACE: botsRoot,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  let err = "";
  for (const [stream, keep] of [
    [proc.stdout, (text: string) => (out += text)],
    [proc.stderr, (text: string) => (err += text)],
  ] as const) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) keep(decoder.decode(chunk));
    })();
  }
  let url = "";
  const launched = await settled(
    () => {
      url = /^(http:\/\/127\.0\.0\.1:\d+\/#token=\S+)$/m.exec(out)?.[1] ?? "";
      return url !== "";
    },
    "the launcher's one URL line",
    30_000,
  );
  if (!launched) throw new Error(`the launcher printed no URL; its output was:\n${out}\n${err}`);
  const parsed = new URL(url);
  return {
    port: Number(parsed.port),
    token: new URLSearchParams(parsed.hash.replace(/^#/, "")).get("token") ?? "",
    url,
    stdout: () => out,
    stderr: () => err,
    stop: () => proc.kill("SIGINT"),
    exited: async () => await proc.exited,
  };
}

/** One run of the suite over its own token, decoys and label, with a sabotage when asked for one. */
async function runSuite(
  token: string,
  scratch: string,
  sabotage: "upload" | "sweep" | null,
): Promise<ConformanceResult> {
  const specs = decoySpecs(token);
  const clean = dockerConformanceSubject({ token, decoys: specs });
  const subject =
    sabotage === null
      ? clean
      : sabotageOperation(
          clean,
          sabotage,
          specs.map((spec) => ({ name: spec.name, why: spec.why })),
        );
  return await runSandboxConformance(subject, {
    scratch,
    report: (line) => record(line),
  });
}

/** Order-22 cleanup for one token: its own label first, then the decoys it created. */
async function cleanUp(token: string, decoys: readonly ConformanceDecoy[]): Promise<void> {
  try {
    await new DockerAdapter({ unit: `${DEFAULT_UNIT}-run-${token}` }).sweep();
  } catch {
    // Which containers are really gone is the census after this, not docker's exit code.
  }
  for (const decoy of decoys) shell(["docker", "rm", "-f", decoy.name]);
}

const home = mkdtempSync(join(tmpdir(), `freebot-u91-home-${TOKEN}-`));
const botsRoot = mkdtempSync(join(tmpdir(), `freebot-u91-bots-${TOKEN}-`));
const scratch = mkdtempSync(join(tmpdir(), `freebot-u91-scratch-${TOKEN}-`));

let app: App | null = null;
let suiteResult: ConformanceResult | null = null;
let appBefore: readonly string[] = [];

try {
  section("the app, launched the way a person launches it");
  app = await launchApp(home, botsRoot);
  const shown = app.url.replace(/token=\S+/, "token=<redacted>");
  record(`launcher line: ${shown}`);
  for (const line of `${app.stdout()}\n${app.stderr()}`
    .split("\n")
    .filter((it) => it.startsWith("freebot up:"))
    .slice(0, 12)) {
    record(`launcher said: ${line}`);
  }
  const page = await fetch(app.url);
  record(`GET ${shown} -> ${page.status} ${page.headers.get("content-type") ?? ""}`);
  expect(page.status === 200, `the launched app serves its own printed URL: ${page.status}`);

  section("the app's own run, so the sweep meets containers it does not own");
  const bot = rpc(app.port, "/rpc/create_bot", app.token, '{"json":{"name":"Conformance Bot"}}');
  const botId = /"botId":"([a-z0-9-]+)"/.exec(bot.body)?.[1];
  expect(bot.status === "200" && botId !== undefined, `create_bot -> ${bot.status} ${bot.body}`);
  const thread = rpc(
    app.port,
    "/rpc/create_thread",
    app.token,
    `{"json":{"botId":"${botId ?? ""}"}}`,
  );
  const threadId = /"threadId":"([a-z0-9-]+)"/.exec(thread.body)?.[1];
  expect(
    thread.status === "200" && threadId !== undefined,
    `create_thread -> ${thread.status} ${thread.body}`,
  );
  const run = rpc(
    app.port,
    "/rpc/start_run",
    app.token,
    `{"json":{"prompt":"run one gated command","botId":"${botId ?? ""}","threadId":"${threadId ?? ""}"}}`,
  );
  const runId = /"runId":"([a-z0-9-]+)"/.exec(run.body)?.[1];
  expect(run.status === "200" && runId !== undefined, `start_run -> ${run.status} ${run.body}`);
  const appRun = await settled(
    () => census(APP_UNIT).length > 0,
    `the app's own ${APP_UNIT} container for ${runId ?? "the run"}`,
    60_000,
  );
  appBefore = census(APP_UNIT);
  for (const entry of appBefore) record(`the app's own container: ${entry}`);
  expect(appRun, `the launched app's run holds a container under ${APP_UNIT}`);

  section("the conformance suite, against Docker");
  suiteResult = await runSuite(TOKEN, scratch, null);
  for (const operation of suiteResult.operations) {
    record(
      `${operation.ok ? "PASS" : "FAIL"} operation ${operation.operation}${operation.ok ? "" : `: ${operation.error}`}`,
    );
  }
  expect(
    suiteResult.operations.map((it) => it.operation).join(" ") === CONFORMANCE_OPERATIONS.join(" "),
    `the suite ran all ${CONFORMANCE_OPERATIONS.length} operations in order: ${suiteResult.operations.map((it) => it.operation).join(" ")}`,
  );
  expect(
    suiteResult.ok,
    `the Docker backend passes all ${CONFORMANCE_OPERATIONS.length} operations`,
  );

  section("the sweep's census, including the containers the app owns");
  const appAfter = census(APP_UNIT);
  for (const entry of appAfter) record(`the app's own container after the suite: ${entry}`);
  expect(
    appAfter.join(", ") === appBefore.join(", "),
    `the app's own containers are unchanged by the suite's sweep: ${appBefore.length} before, ${appAfter.length} after`,
  );
  expect(
    census(RUN_UNIT).length === 0,
    `the suite's own label ${RUN_UNIT} holds nothing after its sweep`,
  );
  const specs = decoySpecs(TOKEN);
  const decoysAfter = specs.map((spec) => `${spec.name}=${containerFact(spec.name)}`);
  for (const entry of decoysAfter) record(`decoy held after the suite: ${entry}`);
  expect(
    decoysAfter.every((entry) => entry.endsWith(" running")),
    `all ${specs.length} decoys of the suite's census survived the sweep and are still running`,
  );
  await cleanUp(TOKEN, suiteResult.decoys);
  expect(
    specs.every((spec) => containerFact(spec.name) === "gone"),
    "the driver's own cleanup removed every decoy it created",
  );

  section("the negative control: one operation sabotaged, twice");
  const uploadToken = `${TOKEN}b`;
  const uploadResult = await runSuite(uploadToken, scratch, "upload");
  record(
    `sabotaged upload: ${uploadResult.operations.map((it) => `${it.operation}:${it.ok}`).join(" ")}`,
  );
  const uploadFailed = uploadResult.operations.at(-1);
  expect(
    uploadResult.ok === false && uploadFailed?.operation === "upload",
    `the suite reports the sabotaged upload: ${uploadFailed?.operation ?? "(none)"} failed`,
  );
  record(`sabotaged upload, literal: ${uploadFailed?.error ?? "(no error)"}`);
  await cleanUp(uploadToken, uploadResult.decoys);

  const sweepToken = `${TOKEN}s`;
  const sweepResult = await runSuite(sweepToken, scratch, "sweep");
  record(
    `sabotaged sweep: ${sweepResult.operations.map((it) => `${it.operation}:${it.ok}`).join(" ")}`,
  );
  const sweepFailed = sweepResult.operations.at(-1);
  expect(
    sweepResult.ok === false && sweepFailed?.operation === "sweep",
    `the suite reports the sabotaged sweep: ${sweepFailed?.operation ?? "(none)"} failed`,
  );
  expect(
    sweepResult.operations.slice(0, -1).every((it) => it.ok),
    `every operation before the sabotaged sweep passed: ${sweepResult.operations.length - 1} of ${CONFORMANCE_OPERATIONS.length - 1}`,
  );
  record(`sabotaged sweep, literal: ${sweepFailed?.error ?? "(no error)"}`);
  await cleanUp(sweepToken, sweepResult.decoys);
} catch (error) {
  expect(false, `the driver threw: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  section("cleanup: the launched app, stopped the way a person stops it");
  if (app !== null) {
    app.stop();
    const code = await app.exited();
    record(`launcher exited with ${code}`);
    await settled(() => census(APP_UNIT).length === 0, "the app's containers to be reaped", 60_000);
    expect(census(APP_UNIT).length === 0, "the launched app reaped its own containers on SIGINT");
    let listening = true;
    try {
      await fetch(app.url);
    } catch {
      listening = false;
    }
    expect(!listening, "nothing answers the printed URL after the app stopped");
  }
  await cleanUp(TOKEN, decoySpecs(TOKEN));
  expect(census(RUN_UNIT).length === 0, `nothing survives under the suite's label ${RUN_UNIT}`);
  for (const dir of [home, botsRoot, scratch]) rmSync(dir, { recursive: true, force: true });
  record("this driver left no container behind");
}

const report = [
  `feature: ${FEATURE}`,
  "command: bun packages/verify/scripts/sandbox-conformance.ts",
  `timestamp: ${new Date().toISOString()}`,
  `git sha: ${git(["rev-parse", "HEAD"])}`,
  `git sha short: ${git(["rev-parse", "--short", "HEAD"])}`,
  `branch: ${git(["rev-parse", "--abbrev-ref", "HEAD"])}`,
  `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
  `docker server: ${shell(["docker", "version", "--format", "{{.Server.Version}}"]).out}`,
  `run token: ${TOKEN} (this run owns freebot.unit=${RUN_UNIT}; the launched app owns ${APP_UNIT})`,
  "",
  ...lines,
  "",
  `${failures.length === 0 ? "PASS" : "FAIL"} ${FEATURE}`,
  ...failures.map((line) => `failed: ${line}`),
  "",
].join("\n");

const dir = join(
  root,
  "packages",
  "verify",
  "artifacts",
  FEATURE,
  git(["rev-parse", "--short", "HEAD"]),
);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "assert.txt"), report);
console.log(
  `artifact: packages/verify/artifacts/${FEATURE}/${git(["rev-parse", "--short", "HEAD"])}/assert.txt`,
);
console.log(`${failures.length === 0 ? "PASS" : "FAIL"} ${FEATURE}`);
process.exitCode = failures.length === 0 ? 0 : 1;
