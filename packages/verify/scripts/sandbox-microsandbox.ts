#!/usr/bin/env bun
/**
 * The U9.5 evidence driver: microsandbox answers U9.1's conformance suite on this Mac, once more
 * with two operations sabotaged, and end to end through a really launched app whose run executes a
 * command inside a microsandbox.
 *
 * Real: `bun run up` itself, spawned the way a person types it, on a `PATH` that holds no `docker`,
 * so the launcher's own backend selector is what reaches this backend. Its listeners, its oRPC
 * router, its run loop, its approval gate, the engine's own microVM and the pinned OCI image inside
 * it are all the launcher's. Nothing about the run path is injected, so the backend this artifact
 * names is the one the boot line printed, which is what U9.2 could not yet show.
 *
 * The model is pinned to the committed transcript, so the run path is deterministic and no live
 * provider is billed (order 9). Both runs therefore replay the same recorded bash turn: the first is
 * answered and finishes, the second is left parked at its gate, which is the sandbox the suite's
 * sweep must not touch.
 *
 * Run from the repo root: bun packages/verify/scripts/sandbox-microsandbox.ts
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUN_UNIT } from "../../../apps/server/src/run-ports.ts";
import {
  CONFORMANCE_OPERATIONS,
  type ConformanceDecoy,
  type ConformanceResult,
  DEFAULT_UNIT,
  MicrosandboxAdapter,
  type MicrosandboxDecoySpec,
  microsandboxConformanceSubject,
  runSandboxConformance,
  sabotageOperation,
} from "../../../packages/sandbox/src/index.ts";
import { msbCli, msbOutcome } from "../../../packages/sandbox/src/msb-cli.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const FEATURE = "sandbox-microsandbox";
/** Fixed names cannot collide with another run of this driver on the shared engine. */
const TOKEN = `${process.pid.toString(36)}-${randomBytes(3).toString("hex")}`;
const RUN_LABEL = `${DEFAULT_UNIT}-run-${TOKEN}`;
/** The one bash call the committed transcript records, which every replayed run therefore makes. */
const RECORDED_COMMAND = "native-should-not-run";
/** The two prompts. The text is the driver's own label for each run; the recorded turn is the same. */
const FINISHING_PROMPT = "u9.5 run one: a command answered at its gate, to completion";
const PARKED_PROMPT = "u9.5 run two: the same recorded turn, left parked at its gate";

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
    "60",
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

async function sandboxStatus(name: string): Promise<string> {
  const outcome = await msbOutcome(["inspect", name, "--format", "json"]);
  if (outcome.exitCode !== 0) return "gone";
  const parsed = JSON.parse(outcome.stdout.toString("utf8")) as { status?: unknown };
  const status = typeof parsed.status === "string" ? parsed.status : "unknown";
  return status.trim().toLowerCase() === "running" ? "running" : status.toLowerCase();
}

async function goneSync(name: string): Promise<boolean> {
  return (await sandboxStatus(name)) === "gone";
}

/** One sandbox's own account of itself: its liveness and the ownership labels it carries. */
async function inspectSandbox(name: string): Promise<{
  readonly running: boolean;
  readonly labels: Record<string, string>;
}> {
  const outcome = await msbOutcome(["inspect", name, "--format", "json"]);
  if (outcome.exitCode !== 0) return { running: false, labels: {} };
  const parsed = JSON.parse(outcome.stdout.toString("utf8")) as {
    status?: unknown;
    active_config?: { labels?: Record<string, string> };
    config?: { labels?: Record<string, string> };
  };
  return {
    running: typeof parsed.status === "string" && parsed.status.trim().toLowerCase() === "running",
    labels: parsed.active_config?.labels ?? parsed.config?.labels ?? {},
  };
}

/** The engine's own census under one ownership label: ``name=status`` per sandbox, sorted. */
async function census(label: string): Promise<string[]> {
  const listed = await msbCli(["ls", "--label", label, "-q"]);
  const names = listed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .sort();
  const facts: string[] = [];
  for (const name of names) facts.push(`${name}=${await sandboxStatus(name)}`);
  return facts;
}

/** The three sandboxes the sweep must not touch, one per way a sandbox can be someone else's. */
function decoySpecs(token: string): readonly MicrosandboxDecoySpec[] {
  return [
    { name: `u92-decoy-foreign-unit-${token}`, unit: "u0.11", why: "another unit's label" },
    {
      name: `u92-decoy-sibling-run-${token}`,
      unit: `${DEFAULT_UNIT}-run-${token}x`,
      why: "a sibling run of this suite",
    },
    { name: `u92-decoy-bare-${token}`, unit: null, why: "no ownership label at all" },
  ];
}

/** One run of the suite over its own token, decoys and label, with a sabotage when asked for one. */
async function runSuite(
  token: string,
  scratch: string,
  sabotage: "upload" | "sweep" | null,
): Promise<ConformanceResult> {
  const specs = decoySpecs(token);
  const clean = microsandboxConformanceSubject({ token, decoys: specs });
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
    await new MicrosandboxAdapter({ unit: `${DEFAULT_UNIT}-run-${token}` }).sweep();
  } catch {
    // Which sandboxes are really gone is the census after this, not msb's exit code.
  }
  for (const decoy of decoys) shell(["msb", "rm", "-f", decoy.name]);
}

/**
 * A `PATH` with no `docker` on it, and the proof that it has none.
 *
 * Criterion 2 asks for Docker's absence to be shown rather than assumed, and hiding it by naming a
 * fixed short `PATH` would be an assumption about where this machine keeps its tools. This removes
 * every directory that actually resolves a `docker` executable and then re-resolves, so the fact
 * the artifact records is the result of the same lookup the launcher would do.
 */
function dockerFreePath(): { readonly path: string; readonly removed: readonly string[] } {
  const removed: string[] = [];
  const kept = (process.env.PATH ?? "").split(":").filter((dir) => {
    if (dir === "") return false;
    const candidate = join(dir, "docker");
    if (!existsSync(candidate)) return true;
    removed.push(dir);
    return false;
  });
  return { path: kept.join(":"), removed };
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

/**
 * `bun run up --sandbox microsandbox`, exactly as a person types it, over a home and a bots root of
 * our own, on a `PATH` this driver has proved holds no `docker`. The launcher's own selector is what
 * reaches this backend, so the backend the boot line prints is the one the run really used.
 *
 * The model is pinned to the committed transcript: this driver asserts the run path, not a model,
 * and a replay bills nobody (order 9).
 */
async function launchApp(home: string, bots: string, path: string): Promise<App> {
  const proc = Bun.spawn(["bun", "run", "up", "--no-open", "--sandbox", "microsandbox"], {
    cwd: root,
    env: {
      ...process.env,
      PATH: path,
      FREEBOT_PROVIDER: "replay",
      FREEBOT_HOME: home,
      FREEBOT_WORKSPACE: bots,
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
    60_000,
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

const home = mkdtempSync(join(tmpdir(), `freebot-u95-home-${TOKEN}-`));
const botsRoot = mkdtempSync(join(tmpdir(), `freebot-u95-bots-${TOKEN}-`));
const scratch = mkdtempSync(join(tmpdir(), `freebot-u95-scratch-${TOKEN}-`));

/**
 * The sandboxes the launched app created for this driver's own runs, by name.
 *
 * A sandbox is claimed only when it is both listed under the app's unit label and named for a run
 * this driver itself started, so a concurrent launch of something else is never in scope (order 22).
 * Names, never a pattern: whatever this driver does not see it does not touch.
 */
const appSandboxes = new Set<string>();
/** One engine fact per claimed sandbox, captured while it existed. */
const sandboxFacts = new Map<string, string>();

let app: App | null = null;
let socket: WebSocket | null = null;

try {
  section("the engine, and the proof that Docker is not reachable for this launch");
  const doctor = shell(["msb", "doctor"]);
  record(`msb --version: ${shell(["msb", "--version"]).out}`);
  record(`msb doctor exit: ${doctor.code}`);
  expect(doctor.code === 0, "msb doctor reports a ready host");
  const hostDocker = shell(["sh", "-c", "command -v docker || true"]).out;
  record(`docker on this driver's own PATH: ${hostDocker === "" ? "(absent)" : hostDocker}`);
  const { path: sandboxPath, removed } = dockerFreePath();
  record(
    `PATH directories dropped because they resolve a docker executable: ${removed.length === 0 ? "(none)" : removed.join(", ")}`,
  );
  const stillThere = shell([
    "sh",
    "-c",
    `PATH=${JSON.stringify(sandboxPath)} command -v docker || true`,
  ]).out;
  record(
    `docker on the launched app's PATH after the drop: ${stillThere === "" ? "(absent)" : stillThere}`,
  );
  expect(
    stillThere === "",
    "the PATH the launched app gets resolves no docker executable, so its backend cannot be Docker",
  );

  section("the app, launched by `bun run up --sandbox microsandbox` on that PATH");
  app = await launchApp(home, botsRoot, sandboxPath);
  const shown = app.url.replace(/token=\S+/, "token=<redacted>");
  record(`launcher line: ${shown}`);
  const bootLines = `${app.stdout()}\n${app.stderr()}`
    .split("\n")
    .filter((it) => it.startsWith("freebot up:"));
  for (const line of bootLines) record(`launcher said: ${line}`);
  const backendLine = bootLines.find((it) => it.includes("sandbox backend")) ?? "";
  expect(
    backendLine.includes("sandbox backend microsandbox") &&
      backendLine.includes("--sandbox=microsandbox"),
    `the launcher's own boot line names microsandbox and why: ${JSON.stringify(backendLine)}`,
  );
  const page = await fetch(app.url);
  record(`GET ${shown} -> ${page.status} ${page.headers.get("content-type") ?? ""}`);
  expect(page.status === 200, `the launched app serves its own printed URL: ${page.status}`);

  const bot = rpc(app.port, "/rpc/create_bot", app.token, '{"json":{"name":"Micro Bot"}}');
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

  section("run one: a real approval answered on the app's own stream, inside a microsandbox");
  socket = new WebSocket(
    `ws://127.0.0.1:${app.port}/events?token=${app.token}&thread_id=${threadId ?? ""}&last_seen_seq=0`,
  );
  const frames: Array<{ type?: unknown; runId?: unknown; payload?: Record<string, unknown> }> = [];
  socket.onmessage = (event) => {
    frames.push(
      JSON.parse(String(event.data)) as {
        type?: unknown;
        runId?: unknown;
        payload?: Record<string, unknown>;
      },
    );
  };
  await settled(() => socket?.readyState === WebSocket.OPEN, "the events socket to open", 10_000);

  /**
   * Claim the sandbox a run this driver started created, and read the engine's own account of it
   * while it is still alive. The name is matched against the run id the app just handed back, so a
   * sandbox belonging to anything else is never claimed (order 22).
   */
  async function claimSandbox(runId: string): Promise<string> {
    let claimed = "";
    await settled(
      async () => {
        const names = await census(`freebot.unit=${RUN_UNIT}`);
        const mine = names.find((entry) => entry.startsWith(`${runId}-`));
        if (mine === undefined) return false;
        claimed = mine.slice(0, mine.indexOf("="));
        if (!appSandboxes.has(claimed)) {
          appSandboxes.add(claimed);
          sandboxFacts.set(claimed, JSON.stringify(await inspectSandbox(claimed)));
        }
        return true;
      },
      `the sandbox the app's run ${runId} created`,
      120_000,
    );
    return claimed;
  }

  const startRun = (prompt: string): { status: string; runId: string } => {
    const started = rpc(
      app?.port ?? 0,
      "/rpc/start_run",
      app?.token ?? "",
      `{"json":{"prompt":${JSON.stringify(prompt)},"botId":"${botId ?? ""}","threadId":"${threadId ?? ""}"}}`,
    );
    const runId = /"runId":"([a-z0-9-]+)"/.exec(started.body)?.[1] ?? "";
    expect(
      started.status === "200" && runId !== "",
      `start_run(${JSON.stringify(prompt.slice(0, 24))}...) -> ${started.status} ${started.body}`,
    );
    return { status: started.status, runId };
  };

  const runOne = startRun(FINISHING_PROMPT);
  const gateOne = await settled(
    () => frames.some((f) => f.type === "approval.requested" && f.runId === runOne.runId),
    "run one to reach its gate",
    180_000,
  );
  const approvalOne = frames.find(
    (f) => f.type === "approval.requested" && f.runId === runOne.runId,
  );
  const approvalId = approvalOne?.payload?.approvalId;
  expect(
    gateOne && typeof approvalId === "string",
    `run one is parked at its own gate: ${JSON.stringify(approvalOne?.payload?.command ?? "(no approval)")}`,
  );

  section("the sandbox the app's run used is a microsandbox, inspected while it lived");
  const runOneSandbox = await claimSandbox(runOne.runId);
  const runOneFact = (JSON.parse(sandboxFacts.get(runOneSandbox) ?? "{}") ?? {}) as {
    labels?: Record<string, string>;
    running?: boolean;
  };
  record(
    `inspect ${runOneSandbox}, while it lived: ${sandboxFacts.get(runOneSandbox) ?? "(none)"}`,
  );
  expect(
    runOneFact.labels?.["freebot.provider"] === "microsandbox",
    `the run's sandbox ${runOneSandbox} carried freebot.provider=microsandbox while the run was in it`,
  );
  expect(
    runOneFact.labels?.["freebot.sandbox"] === runOneSandbox,
    `the run's sandbox carried its own name as freebot.sandbox: ${JSON.stringify(runOneFact.labels?.["freebot.sandbox"])}`,
  );
  expect(
    runOneFact.running === true,
    `the run's sandbox was really running: ${runOneFact.running}`,
  );

  // Run two starts before run one is answered, and on purpose. Both runs replay the same recorded
  // turn, so the same `bash` call: the grant run one's answer mints would satisfy run two's call and
  // it would never park. Started while run one is still waiting, run two parks on its own, and the
  // answer below names run one's approval id, so run two is left waiting — which is the app-owned
  // sandbox the suite's sweep must not touch.
  section(
    "run two: the same recorded turn, left parked, so the sweep meets a sandbox it does not own",
  );
  const runTwo = startRun(PARKED_PROMPT);
  const gateTwo = await settled(
    () => frames.some((f) => f.type === "approval.requested" && f.runId === runTwo.runId),
    "run two to reach its gate",
    180_000,
  );
  const approvalTwo = frames.find(
    (f) => f.type === "approval.requested" && f.runId === runTwo.runId,
  );
  record(
    `run two is waiting on approval ${JSON.stringify(approvalTwo?.payload?.approvalId ?? "")} for ${JSON.stringify(approvalTwo?.payload?.command ?? "")}, unanswered`,
  );
  expect(
    gateTwo && approvalTwo !== undefined,
    "run two is really parked at its own gate, unanswered, while the suite runs",
  );
  expect(
    approvalTwo?.payload?.approvalId !== approvalId,
    `the two runs parked on their own approvals: ${JSON.stringify(approvalId)} and ${JSON.stringify(approvalTwo?.payload?.approvalId)}`,
  );
  const runTwoSandbox = await claimSandbox(runTwo.runId);
  record(`the app's sandboxes this driver claimed: ${[...appSandboxes].join(", ")}`);
  expect(
    runTwoSandbox !== "" && runOneSandbox !== "" && runTwoSandbox !== runOneSandbox,
    `each of the app's two runs created its own sandbox: ${runOneSandbox}, ${runTwoSandbox}`,
  );
  expect(
    (await census(`freebot.unit=${RUN_UNIT}`)).length >= 1,
    `the parked run's own sandbox is alive for the suite to find: ${JSON.stringify(await census(`freebot.unit=${RUN_UNIT}`))}`,
  );

  section("run one's gate answer: only that run's approval, so run two stays parked");
  if (typeof approvalId === "string") {
    socket.send(JSON.stringify({ type: "answer", decision: "allow", approvalId }));
    record(
      `answered approval ${approvalId} with allow; ${JSON.stringify(approvalTwo?.payload?.approvalId ?? "")} stays unanswered`,
    );
  }
  const runOneSettled = await settled(
    () => frames.some((f) => f.runId === runOne.runId && f.type === "run.finished"),
    "run one's terminal frame",
    300_000,
  );
  record(`frames run one produced: ${frames.map((f) => String(f.type)).join(", ")}`);
  expect(runOneSettled, "run one reached run.finished on the app's own stream");
  const results = frames.filter((f) => f.type === "tool_call.result");
  for (const result of results) record(`tool_call.result: ${JSON.stringify(result.payload)}`);
  expect(
    results.some((f) => JSON.stringify(f.payload ?? {}).includes(RECORDED_COMMAND)),
    `the recorded turn's own command ran inside the microsandbox: ${RECORDED_COMMAND}`,
  );
  expect(
    !frames.some((f) => f.runId === runTwo.runId && f.type === "run.finished"),
    "run two did not finish: its approval is still the one nobody answered",
  );
  // The run loop emits `run.finished` before its own `finally` destroys the sandbox, so the census
  // is read through the same bounded wait the reaper uses rather than sampled the instant the frame
  // lands: a fact that is still converging is not yet a leak.
  const runOneReaped = await settled(
    async () => (await census(`freebot.unit=${RUN_UNIT}`)).length === 1,
    "run one's own sandbox to be destroyed with its run",
    60_000,
  );
  const appCensusBefore = await census(`freebot.unit=${RUN_UNIT}`);
  for (const entry of appCensusBefore) record(`the engine holds, under ${RUN_UNIT}: ${entry}`);
  expect(
    runOneReaped &&
      appCensusBefore.length === 1 &&
      appCensusBefore[0]?.startsWith(`${runTwoSandbox}=`) === true,
    `run one's own sandbox is gone with its run, leaving run two's: ${JSON.stringify(appCensusBefore)}`,
  );

  section("the conformance suite, against microsandbox");
  const suiteResult = await runSuite(TOKEN, scratch, null);
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
    `the microsandbox backend passes all ${CONFORMANCE_OPERATIONS.length} operations`,
  );

  section("the sweep's decoy census, and the app-owned sandbox the sweep must leave alone");
  const appCensusAfter = await census(`freebot.unit=${RUN_UNIT}`);
  for (const entry of appCensusAfter)
    record(`the app's parked run's sandbox after the suite: ${entry}`);
  expect(
    appCensusAfter.join(", ") === appCensusBefore.join(", "),
    `the app's own sandbox is unchanged by the suite's sweep: ${appCensusBefore.length} before, ${appCensusAfter.length} after`,
  );
  expect(
    appCensusAfter.length === 1 && appCensusAfter[0]?.startsWith(`${runTwoSandbox}=`) === true,
    `the sandbox the sweep left alone is the app's parked run's own: ${JSON.stringify(appCensusAfter)}`,
  );
  expect(
    (await census(`freebot.unit=${RUN_LABEL}`)).length === 0,
    `the suite's own label ${RUN_LABEL} holds nothing after its sweep`,
  );
  const specs = decoySpecs(TOKEN);
  const decoysAfter: string[] = [];
  for (const spec of specs) decoysAfter.push(`${spec.name}=${await sandboxStatus(spec.name)}`);
  for (const entry of decoysAfter) record(`decoy held after the suite: ${entry}`);
  expect(
    decoysAfter.every((entry) => entry.endsWith("=running")),
    `all ${specs.length} decoys of the suite's census survived the sweep and are still running`,
  );
  await cleanUp(TOKEN, suiteResult.decoys);
  const decoysGone = await Promise.all(specs.map((spec) => goneSync(spec.name)));
  expect(
    decoysGone.every((it) => it),
    "the driver's own cleanup removed every decoy it created",
  );

  section("the negative control: two operations sabotaged, each where it must fail");
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

  // U9.5's fix: the sweep arm removes its decoys through the subject's own ownership port, so the
  // same defect Docker's drill seeds is seeded here and the census catches it.
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
  section("cleanup: the launched app stops the way a person stops it, and reaps its own sandboxes");
  socket?.close();
  if (app !== null) {
    // Ctrl-C is the path this asserts: the launcher's own reaper, over the backend it chose, is what
    // removes the runs' sandboxes. Anything this driver removes by hand afterwards is named, never a
    // pattern (order 22).
    app.stop();
    record(`launcher exited with ${await app.exited()}`);
    const reaped = await settled(
      async () =>
        (await Promise.all([...appSandboxes].map((name) => goneSync(name)))).every((it) => it),
      "the launcher's own reaper to remove the sandboxes it created",
      90_000,
    );
    const removalLines = `${app.stdout()}\n${app.stderr()}`
      .split("\n")
      .filter((it) => it.includes("removed sandbox") || it.includes("FAILED to remove sandbox"));
    for (const line of removalLines) record(`launcher said: ${line}`);
    for (const entry of await census(`freebot.unit=${RUN_UNIT}`)) {
      record(`still held under ${RUN_UNIT} after the app stopped: ${entry}`);
    }
    const left = await Promise.all([...appSandboxes].map((name) => goneSync(name)));
    record(
      `of the ${appSandboxes.size} sandboxes this driver claimed, gone after the app's own reap: ${left.filter((it) => it).length}`,
    );
    expect(
      reaped && left.every((it) => it),
      `the launched app reaped every sandbox it created: ${[...appSandboxes].join(", ")}`,
    );
    let listening = true;
    try {
      await fetch(app.url);
    } catch {
      listening = false;
    }
    expect(!listening, "nothing answers the printed URL after the app stopped");
  }
  await cleanUp(TOKEN, decoySpecs(TOKEN));
  const survives = await census(`freebot.unit=${RUN_LABEL}`);
  record(`sandboxes left under the suite's label ${RUN_LABEL}: ${survives.length}`);
  expect(survives.length === 0, `nothing survives under the suite's label ${RUN_LABEL}`);
  const decoysGone = await Promise.all(decoySpecs(TOKEN).map((spec) => goneSync(spec.name)));
  expect(
    decoysGone.every((it) => it),
    "the driver's own cleanup removed every decoy it created",
  );
  for (const dir of [home, botsRoot, scratch]) rmSync(dir, { recursive: true, force: true });
  record("this driver left no sandbox behind");
}

const short = git(["rev-parse", "--short", "HEAD"]);
const report = [
  `feature: ${FEATURE}`,
  "command: bun packages/verify/scripts/sandbox-microsandbox.ts",
  `timestamp: ${new Date().toISOString()}`,
  `git sha: ${git(["rev-parse", "HEAD"])}`,
  `git sha short: ${short}`,
  `branch: ${git(["rev-parse", "--abbrev-ref", "HEAD"])}`,
  `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}`,
  `msb: ${shell(["msb", "--version"]).out}`,
  `run token: ${TOKEN} (this run owns freebot.unit=${RUN_LABEL}; the app's run owns ${RUN_UNIT})`,
  "",
  ...lines,
  "",
  `${failures.length === 0 ? "PASS" : "FAIL"} ${FEATURE}`,
  ...failures.map((line) => `failed: ${line}`),
  "",
].join("\n");

const dir = join(root, "packages", "verify", "artifacts", FEATURE, short);
mkdirSync(dir, { recursive: true });
if (/FREEBOT_BYOK_KEY=\S{8,}/.test(report)) {
  throw new Error("refusing to write an artifact that carries a key-shaped literal");
}
writeFileSync(join(dir, "assert.txt"), report);
console.log(`artifact: packages/verify/artifacts/${FEATURE}/${short}/assert.txt`);
console.log(`${failures.length === 0 ? "PASS" : "FAIL"} ${FEATURE}`);
process.exitCode = failures.length === 0 ? 0 : 1;
