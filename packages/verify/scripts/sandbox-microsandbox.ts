#!/usr/bin/env bun
/**
 * The U9.2 evidence driver: microsandbox answers U9.1's conformance suite on this Mac, once more
 * with two operations sabotaged, and end to end through a really launched app whose run executes a
 * command inside a microsandbox.
 *
 * Real: the app's own server (`startServer` + `createRunService`, the pair `bun run up` boots), its
 * listeners, its oRPC router, its run loop, its approval gate, the engine's own microVM, and the
 * pinned OCI image inside it. Injected: the run's sandbox port is a microsandbox-backed one, because
 * the shipped `bun run up` still hardcodes the Docker adapter (a deviation this artifact records).
 * The model is whatever the vault selects: the keyed path when a key is present, the replay when not.
 *
 * Run from the repo root: bun packages/verify/scripts/sandbox-microsandbox.ts
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxPort } from "@freebot/core";
import { startServer } from "../../../apps/server/src/index.ts";
import {
  chooseProvider,
  createProviderPort,
  DEFAULT_TRANSCRIPT,
} from "../../../apps/server/src/provider.ts";
import {
  DockerRunSandbox,
  destructiveTool,
  governedTools,
  RUN_UNIT,
} from "../../../apps/server/src/run-ports.ts";
import { createRunService } from "../../../apps/server/src/run-service.ts";
import { describeVault, readVault } from "../../../apps/server/src/vault.ts";
import { botWorkspacePath } from "../../../apps/server/src/workspace-files.ts";
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
/** The nonce the keyed model is asked to write into this Bot's workspace. */
const LINE = `freebot-u9.2 ${randomBytes(6).toString("hex")}`;
/** The prompt whose run stays parked at its gate; it selects the recorded turn, not the model. */
const PARKED_PROMPT = "parked-run: run one gated command";

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

const botsRoot = mkdtempSync(join(tmpdir(), `freebot-u92-bots-${TOKEN}-`));
const scratch = mkdtempSync(join(tmpdir(), `freebot-u92-scratch-${TOKEN}-`));

/** The names the injected sandbox port created, so cleanup removes exactly those and nothing else. */
const createdSandboxes: string[] = [];
/** One engine fact per created sandbox, captured while it exists (the app destroys its own). */
const sandboxFacts = new Map<string, string>();

let server: ReturnType<typeof startServer> | null = null;
let socket: WebSocket | null = null;

try {
  section("the engine, and the image it caches");
  const doctor = shell(["msb", "doctor"]);
  record(`msb --version: ${shell(["msb", "--version"]).out}`);
  record(`msb doctor exit: ${doctor.code}`);
  expect(doctor.code === 0, "msb doctor reports a ready host");

  section("the app, started with a microsandbox-backed run sandbox");
  const vault = readVault();
  const choice = chooseProvider({ mode: "auto", vault });
  const described = describeVault();
  record(
    `the vault at ${described.path} is ${described.present ? `present, mode ${described.mode ?? "unknown"}` : "absent"}`,
  );
  record(
    choice.kind === "keyed"
      ? `the run's model: keyed, ${choice.model} via ${new URL(choice.baseUrl).host}; this driver never reads the key's value`
      : `the run's model: replaying the committed transcript (${choice.why}); the recorded turn echoes rather than writing a file`,
  );

  server = startServer({
    service: createRunService({
      sandbox: (): SandboxPort => {
        const port = new DockerRunSandbox(new MicrosandboxAdapter({ unit: RUN_UNIT }));
        return {
          create: async (spec) => {
            createdSandboxes.push(spec.name);
            await port.create(spec);
            // The app destroys a run's sandbox as the run settles, so the engine's own account of it
            // is captured here, while it exists, rather than after the run.
            sandboxFacts.set(
              spec.name,
              shell(["msb", "inspect", spec.name, "--format", "json"]).out,
            );
          },
          execute: (call) => port.execute(call),
          destroy: () => port.destroy(),
        };
      },
      // The run that is meant to stay parked uses the recorded turn, so the park this driver asserts
      // does not depend on a live model's timing; every other run uses the vault's own choice.
      provider: async (prompt) =>
        await createProviderPort(
          prompt === PARKED_PROMPT
            ? { kind: "replay", transcript: DEFAULT_TRANSCRIPT, why: "asked-for-replay" }
            : choice,
          {
            prompt,
            destructive: (name) => destructiveTool(name),
            tools: governedTools(),
          },
        ),
      botsRoot,
    }),
  });
  const page = await fetch(`http://127.0.0.1:${server.apiPort}/`);
  record(
    `GET http://127.0.0.1:${server.apiPort}/#token=<redacted> -> ${page.status} ${page.headers.get("content-type") ?? ""}`,
  );
  expect(page.status === 200, `the launched app serves its own URL: ${page.status}`);

  const bot = rpc(server.apiPort, "/rpc/create_bot", server.token, '{"json":{"name":"Micro Bot"}}');
  const botId = /"botId":"([a-z0-9-]+)"/.exec(bot.body)?.[1];
  expect(bot.status === "200" && botId !== undefined, `create_bot -> ${bot.status} ${bot.body}`);
  const thread = rpc(
    server.apiPort,
    "/rpc/create_thread",
    server.token,
    `{"json":{"botId":"${botId ?? ""}"}}`,
  );
  const threadId = /"threadId":"([a-z0-9-]+)"/.exec(thread.body)?.[1];
  expect(
    thread.status === "200" && threadId !== undefined,
    `create_thread -> ${thread.status} ${thread.body}`,
  );

  section("the run: a real approval answered on the app's own stream, inside a microsandbox");
  socket = new WebSocket(
    `ws://127.0.0.1:${server.apiPort}/events?token=${server.token}&thread_id=${threadId ?? ""}&last_seen_seq=0`,
  );
  const frames: Array<{ type?: unknown; runId?: unknown; payload?: Record<string, unknown> }> = [];
  let finished = false;
  /** The only run whose approvals this driver answers; the parked run's are left waiting. */
  let answerForRun = "";
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as {
      type?: unknown;
      runId?: unknown;
      payload?: Record<string, unknown>;
    };
    frames.push(message);
    if (message.type === "approval.requested" && message.runId === answerForRun) {
      const approvalId = message.payload?.approvalId;
      if (typeof approvalId === "string") {
        socket?.send(JSON.stringify({ type: "answer", decision: "allow", approvalId }));
        record(
          `answered approval ${approvalId} with allow, for command ${JSON.stringify(message.payload?.command ?? "")}`,
        );
      }
    }
    if (message.type === "run.finished" || message.type === "run.failed") finished = true;
  };
  await settled(() => socket?.readyState === WebSocket.OPEN, "the events socket to open", 10_000);
  const writePrompt = `Use the bash tool to write exactly this, and nothing else, into the file /workspace/note.txt: '${LINE}' followed by a newline. Create no other file and read nothing. Then reply with one short sentence.`;
  const started = rpc(
    server.apiPort,
    "/rpc/start_run",
    server.token,
    `{"json":{"prompt":${JSON.stringify(writePrompt)},"botId":"${botId ?? ""}","threadId":"${threadId ?? ""}"}}`,
  );
  const runId = /"runId":"([a-z0-9-]+)"/.exec(started.body)?.[1];
  answerForRun = runId ?? "";
  expect(
    started.status === "200" && runId !== undefined,
    `start_run -> ${started.status} ${started.body}`,
  );
  const runSettled = await settled(() => finished, "the run's terminal frame", 300_000);
  record(`frames this run produced: ${frames.map((frame) => String(frame.type)).join(", ")}`);
  record(`the run's sandbox names: ${createdSandboxes.join(", ")}`);
  expect(
    runSettled,
    `the run reached its terminal frame on the app's own stream: ${String(frames.at(-1)?.type ?? "(no frame)")}`,
  );
  const results = frames.filter((frame) => frame.type === "tool_call.result");
  for (const result of results) record(`tool_call.result: ${JSON.stringify(result.payload)}`);
  // The socket follows this thread, so answering here would answer the parked run's approval too.
  // From here on the driver leaves every approval waiting, which is what keeps the next run parked.
  answerForRun = "";

  section("the sandbox the app's run used is a microsandbox, not a container");
  const runSandboxName = createdSandboxes[0] ?? "";
  const runFact = sandboxFacts.get(runSandboxName) ?? "";
  expect(
    runFact.includes('"freebot.provider": "microsandbox"') &&
      runFact.includes(`"freebot.sandbox": ${JSON.stringify(runSandboxName)}`),
    `the run's sandbox ${runSandboxName} carried freebot.provider=microsandbox and its own name when the run created it`,
  );

  section("the file the run wrote: through the app's route, and off the host");
  const workspace = botWorkspacePath(botsRoot, botId ?? "");
  const onDiskPath = join(workspace, "note.txt");
  const onDisk = (() => {
    try {
      return statSync(onDiskPath).isFile() ? readFileSync(onDiskPath, "utf8") : null;
    } catch {
      return null;
    }
  })();
  record(`read off the host at ${onDiskPath}: ${JSON.stringify(onDisk)}`);
  const read = rpc(
    server.apiPort,
    "/rpc/read_file",
    server.token,
    `{"json":{"botId":"${botId ?? ""}","path":"note.txt"}}`,
  );
  record(`read_file -> ${read.status} ${read.body}`);
  if (choice.kind === "keyed") {
    expect(
      onDisk?.includes(LINE) === true,
      `the keyed model's file carries this run's nonce, read off the host: ${JSON.stringify(onDisk)}`,
    );
    let routeText = "";
    try {
      routeText = (JSON.parse(read.body) as { json: { text: string } }).json.text;
    } catch {
      routeText = "";
    }
    expect(
      routeText.includes(LINE),
      `the app's read_file route returns the same bytes: ${JSON.stringify(routeText)}`,
    );
  } else {
    // The committed transcript's recorded turn runs `echo native-should-not-run`: it runs inside the
    // microVM but writes nothing, so the file claim is not made and the command claim is.
    const ranInSandbox = results.some((frame) =>
      JSON.stringify(frame.payload ?? {}).includes("native-should-not-run"),
    );
    record(
      "the vault holds no key, so this run replayed; the recorded turn writes no file and the command claim is asserted instead",
    );
    expect(ranInSandbox, "the replayed turn's own command ran inside the microsandbox");
  }

  section(
    "a second run of the app, parked at its gate, so the sweep meets a sandbox it does not own",
  );
  const parked = rpc(
    server.apiPort,
    "/rpc/start_run",
    server.token,
    `{"json":{"prompt":${JSON.stringify(PARKED_PROMPT)},"botId":"${botId ?? ""}","threadId":"${threadId ?? ""}"}}`,
  );
  const parkedId = /"runId":"([a-z0-9-]+)"/.exec(parked.body)?.[1];
  expect(parked.status === "200", `the parked run started -> ${parked.status} ${parked.body}`);
  const parkedParked = await settled(
    () =>
      frames.some(
        (frame) =>
          frame.runId === parkedId &&
          (frame.type === "approval.requested" ||
            frame.type === "run.finished" ||
            frame.type === "run.failed"),
      ),
    "the parked run to reach its gate",
    120_000,
  );
  const parkedApproval = frames.find(
    (frame) => frame.type === "approval.requested" && frame.runId === parkedId,
  );
  record(
    parkedApproval === undefined
      ? "the parked run ended without parking"
      : `the parked run is waiting on approval ${JSON.stringify(parkedApproval.payload?.approvalId ?? "")} for ${JSON.stringify(parkedApproval.payload?.command ?? "")}, unanswered`,
  );
  expect(
    parkedParked && parkedApproval !== undefined,
    "the parked run is really parked at its own gate, unanswered, while the suite runs",
  );
  const parkedLive = await settled(
    async () =>
      createdSandboxes.length >= 2 && (await census(`freebot.unit=${RUN_UNIT}`)).length === 1,
    "the parked run's own sandbox, with the finished run's gone",
    60_000,
  );
  expect(parkedLive, `the parked run created its own sandbox: ${createdSandboxes.join(", ")}`);
  const appCensusBefore = await census(`freebot.unit=${RUN_UNIT}`);
  for (const entry of appCensusBefore) record(`the engine holds, under ${RUN_UNIT}: ${entry}`);

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
    appCensusAfter.length === 1 &&
      appCensusAfter[0]?.startsWith(`${createdSandboxes[1] ?? ""}=`) === true,
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
  section("cleanup: the app, its run's sandbox, and every sandbox this driver made");
  socket?.close();
  server?.stop();
  server?.service.close();
  for (const name of createdSandboxes) shell(["msb", "rm", "-f", name]);
  await settled(
    async () => {
      const left = await Promise.all(createdSandboxes.map((name) => goneSync(name)));
      return left.every((it) => it);
    },
    "the app's run sandboxes to be gone",
    60_000,
  );
  await cleanUp(TOKEN, decoySpecs(TOKEN));
  const survives = await census(`freebot.unit=${RUN_LABEL}`);
  record(`sandboxes left under the suite's label ${RUN_LABEL}: ${survives.length}`);
  expect(survives.length === 0, `nothing survives under the suite's label ${RUN_LABEL}`);
  const decoysGone = await Promise.all(decoySpecs(TOKEN).map((spec) => goneSync(spec.name)));
  expect(
    decoysGone.every((it) => it),
    "the driver's own cleanup removed every decoy it created",
  );
  for (const dir of [botsRoot, scratch]) rmSync(dir, { recursive: true, force: true });
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
