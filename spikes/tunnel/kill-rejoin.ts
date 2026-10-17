#!/usr/bin/env bun
/**
 * Kill/rejoin harness for the tunnel spike (U0.7). One run, two scenarios, one artifact directory.
 *
 * Scenario a: Pi runs in a container, its supervisor mints seqs, the tunnel agent forwards them
 * through a TCP relay to apps/server. Mid-burst, the relay is SIGKILLed (the tunnel dies, agent
 * and Pi live on) and the agent rejoins naming its `last_seen_seq`.
 *
 * Scenario b: same path, but the tunnel agent process itself is SIGKILLed mid-exchange while the
 * supervisor and Pi keep running. A fresh agent process attaches, replays from the supervisor's
 * watermark, and the exchange completes on the same Pi pid.
 *
 * Run: bun spikes/tunnel/kill-rejoin.ts
 * Artifact: packages/verify/artifacts/tunnel/<short-sha>/
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiInboundFrame } from "@freebot/pi-bridge";
import { type StubModel, startStubModel } from "./stub-model.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const PROMPT = "Run the spike exchange: call spike_echo three times, then summarize.";

type Scenario = "a" | "b";

interface Check {
  ok: boolean;
  label: string;
  detail: string;
}

interface Service {
  port: number;
  proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  lines: string[];
  stop(): void;
}

class Evidence {
  readonly frames: Array<{ seq: number; frame: PiInboundFrame; at: number }> = [];
  readonly notes: Array<Record<string, unknown>> = [];
  readonly checks: Check[] = [];
  readonly numbers: Record<string, number | string> = {};
  readonly lists: Record<string, number[]> = {};
  readonly logTails: Record<string, string> = {};
  /** Wall-clock instant the harness severed the tunnel or the agent. */
  killAt = 0;

  constructor(readonly scenario: Scenario) {}

  check(ok: boolean, label: string, detail = ""): void {
    this.checks.push({ ok, label, detail });
  }

  note(note: Record<string, unknown>): void {
    this.notes.push({ at: Date.now(), ...note });
  }

  get passed(): boolean {
    return this.checks.every((entry) => entry.ok);
  }
}

function run(command: string[]): { code: number; out: string } {
  const proc = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  return {
    code: proc.exitCode,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`.trim(),
  };
}

function docker(args: string[]): { code: number; out: string } {
  return run(["docker", ...args]);
}

function dockerStrict(args: string[], what: string): string {
  const result = docker(args);
  if (result.code !== 0) throw new Error(`docker ${what} failed: ${result.out}`);
  return result.out;
}

function dockerExec(
  container: string,
  command: string,
  detached = false,
): { code: number; out: string } {
  return docker(["exec", ...(detached ? ["-d"] : []), container, "sh", "-c", command]);
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** One sh -c string: cd, then exec the argv, with every argument quoted. */
function shellIn(cwd: string, argv: string[], redirectTo?: string, append = false): string {
  const line = argv.map(shQuote).join(" ");
  const operator = append ? ">>" : ">";
  const redirect = redirectTo === undefined ? "" : ` ${operator} ${shQuote(redirectTo)} 2>&1`;
  return `cd ${shQuote(cwd)} && exec ${line}${redirect}`;
}

function dockerExecStrict(container: string, command: string, detached = false): string {
  const result = dockerExec(container, command, detached);
  if (result.code !== 0) {
    throw new Error(`docker exec failed: ${result.out}\ncommand: ${command}`);
  }
  return result.out;
}

async function waitForContainer(container: string, timeoutMs: number): Promise<void> {
  await waitFor(
    "container running",
    () => docker(["inspect", "--format", "{{.State.Running}}", container]).out === "true",
    timeoutMs,
  );
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "0.0.0.0", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(
  label: string,
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await Bun.sleep(10);
  }
  throw new Error(`timeout: ${label}`);
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value.length > 0) return value;
    } catch {
      // not written yet
    }
    await Bun.sleep(25);
  }
  throw new Error(`timeout: file never appeared: ${path}`);
}

function pumpLines(service: Service): void {
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) service.lines.push(line);
        newline = buffer.indexOf("\n");
      }
    }
  };
  void consume(service.proc.stdout);
  void consume(service.proc.stderr);
}

async function startServer(): Promise<Service> {
  const proc = Bun.spawn(["bun", "apps/server/src/index.ts"], {
    cwd: root,
    env: { ...process.env, PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const service: Service = { port: 0, proc, lines: [], stop: () => proc.kill(9) };
  pumpLines(service);
  await waitFor(
    "server listening line",
    () => service.lines.some((line) => line.includes("listening on")),
    15_000,
  );
  const match = service.lines.join("\n").match(/http:\/\/127\.0\.0\.1:(\d+)/);
  if (match?.[1] === undefined) throw new Error("server never reported a port");
  service.port = Number(match[1]);
  return service;
}

async function startRelay(listenPort: number, forwardPort: number): Promise<Service> {
  const proc = Bun.spawn(
    [
      "bun",
      "spikes/tunnel/tcp-relay.ts",
      "--listen",
      String(listenPort),
      "--forward",
      String(forwardPort),
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const service: Service = { port: listenPort, proc, lines: [], stop: () => proc.kill(9) };
  pumpLines(service);
  await waitFor(
    "relay listening line",
    () => service.lines.some((line) => line.includes("listening")),
    10_000,
  );
  return service;
}

async function fetchJson(port: number, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return (await response.json()) as Record<string, unknown>;
}

interface AuditShape {
  firstSeq: number | null;
  lastSeq: number;
  count: number;
  gaps: number[];
  duplicates: number[];
  suppressedAtIngest: number[];
  gapEvents: Array<{ expected: number; got: number }>;
  rejected: number;
}

async function auditOf(port: number): Promise<AuditShape> {
  return (await fetchJson(port, "/audit")) as unknown as AuditShape;
}

function localAudit(frames: Array<{ seq: number }>): { gaps: number[]; duplicates: number[] } {
  const seen = new Set<number>();
  const gaps: number[] = [];
  const duplicates: number[] = [];
  let previous: number | null = null;
  for (const entry of frames) {
    if (seen.has(entry.seq)) duplicates.push(entry.seq);
    seen.add(entry.seq);
    if (previous !== null && entry.seq !== previous + 1) gaps.push(previous + 1);
    previous = entry.seq;
  }
  return { gaps, duplicates };
}

function frameKinds(frames: Array<{ frame: PiInboundFrame }>): Map<string, number> {
  const kinds = new Map<string, number>();
  for (const entry of frames) {
    kinds.set(entry.frame.type, (kinds.get(entry.frame.type) ?? 0) + 1);
  }
  return kinds;
}

function inFlightToolCalls(frames: Array<{ frame: PiInboundFrame }>): string[] {
  const open = new Set<string>();
  for (const { frame } of frames) {
    if (frame.type === "tool_execution_start") open.add(frame.toolCallId);
    if (frame.type === "tool_execution_end") open.delete(frame.toolCallId);
  }
  return [...open];
}

function containerStat(container: string, pid: string): { pid: number; starttime: string } | null {
  const result = dockerExec(container, `cat /proc/${pid}/stat 2>/dev/null`);
  if (result.code !== 0 || result.out.length === 0) return null;
  const rest = result.out.slice(result.out.lastIndexOf(")") + 2).split(" ");
  return { pid: Number(pid), starttime: rest[19] ?? "unknown" };
}

function containerAlive(container: string, pid: string): boolean {
  return dockerExec(
    container,
    `kill -0 ${pid} 2>/dev/null && echo alive || echo dead`,
  ).out.includes("alive");
}

function sha(): { short: string; full: string; branch: string } {
  return {
    short: run(["git", "rev-parse", "--short", "HEAD"]).out,
    full: run(["git", "rev-parse", "HEAD"]).out,
    branch: run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).out,
  };
}

interface ScenarioResult {
  evidence: Evidence;
  transcriptPath: string;
}

async function runScenario(scenario: Scenario, image: string): Promise<ScenarioResult> {
  const evidence = new Evidence(scenario);
  const scratch = mkdtempSync(join(tmpdir(), `freebot-tunnel-${scenario}-`));
  mkdirSync(join(scratch, "state"), { recursive: true });
  const container = `freebot-tunnel-spike-${scenario}-${Date.now()}`;
  const stateDir = join(scratch, "state");
  /** The same directory as the container sees it; the commands below run inside. */
  const containerState = "/scratch/state";
  const stub: StubModel = startStubModel((note) => evidence.note({ stub: note }));
  const server = await startServer();
  const relayPort = await freePort();
  let relay = await startRelay(relayPort, server.port);
  const observerMessages: Array<{ kind: string; seq?: number }> = [];
  const observer = new WebSocket(`ws://127.0.0.1:${server.port}/stream?last_seen_seq=0`);
  observer.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      kind: string;
      seq?: number;
      frame?: PiInboundFrame;
    };
    if (
      message.kind === "frame" &&
      typeof message.seq === "number" &&
      message.frame !== undefined
    ) {
      evidence.frames.push({ seq: message.seq, frame: message.frame, at: Date.now() });
    } else {
      observerMessages.push(message);
    }
  });
  await waitFor("observer attached", () => observerMessages.length > 0, 5000);

  try {
    dockerStrict(
      [
        "run",
        "-d",
        "--name",
        container,
        "-v",
        `${scratch}:/scratch`,
        "-v",
        `${root}:/work`,
        "-w",
        "/work",
        image,
        "sleep",
        "infinity",
      ],
      "run",
    );
    await waitForContainer(container, 15_000);
    const supervisorCommand = shellIn(
      "/work",
      [
        "bun",
        "apps/sandbox-agent/src/supervisor.ts",
        "--state-dir",
        containerState,
        "--pi-bin",
        "/work/node_modules/.bin/pi",
        "--stub-base-url",
        `http://host.docker.internal:${stub.port}/v1`,
        "--prompt",
        PROMPT,
        "--ext",
        "/work/spikes/tunnel/echo-ext.ts",
      ],
      `${containerState}/supervisor.log`,
    );
    dockerExecStrict(container, supervisorCommand, true);
    const piPid = await waitForFile(join(stateDir, "pi.pid"), 30_000);
    await waitForFile(join(stateDir, "supervisor.port"), 30_000);
    const piBefore = containerStat(container, piPid);
    evidence.numbers.pi_pid = Number(piPid);
    evidence.numbers.pi_starttime_before = piBefore?.starttime ?? "missing";

    const agentCommand = shellIn(
      "/work",
      [
        "bun",
        "apps/sandbox-agent/src/agent.ts",
        "--server",
        `ws://host.docker.internal:${relayPort}/tunnel`,
        "--supervisor-port-file",
        `${containerState}/supervisor.port`,
        "--pid-file",
        `${containerState}/agent.pid`,
      ],
      `${containerState}/agent.log`,
      true,
    );
    dockerExec(container, agentCommand, true);
    const agentPid = await waitForFile(join(stateDir, "agent.pid"), 30_000);
    evidence.numbers.agent_pid_first = Number(agentPid);

    // Kill trigger a: inside a paced text-delta burst of the second turn.
    // Kill trigger b: while the second tool call is executing, so a tool call is provably in flight.
    const trigger =
      scenario === "a"
        ? () => {
            const firstEnd = evidence.frames.findIndex(
              (entry) => entry.frame.type === "tool_execution_end",
            );
            if (firstEnd === -1) return false;
            const updates = evidence.frames
              .slice(firstEnd)
              .filter((entry) => entry.frame.type === "message_update").length;
            return updates >= 3;
          }
        : () =>
            evidence.frames.filter((entry) => entry.frame.type === "tool_execution_start").length >=
            2;

    await waitFor("first frames", () => evidence.frames.length > 0, 30_000);
    await waitFor(`kill window (${scenario})`, trigger, 60_000);
    const lastSeqAtKill = (await auditOf(server.port)).lastSeq;
    const framesAtKill = evidence.frames.length;
    const inFlightAtKill = inFlightToolCalls(evidence.frames);
    evidence.killAt = Date.now();
    evidence.numbers.last_seq_at_kill = lastSeqAtKill;
    evidence.numbers.frames_delivered_at_kill = framesAtKill;
    evidence.note({ moment: "kill", lastSeqAtKill, framesAtKill, inFlight: inFlightAtKill });

    if (scenario === "a") {
      relay.stop();
      evidence.note({ killed: "tunnel relay (SIGKILL)", relayPid: relay.proc.pid });
      await Bun.sleep(150);
      relay = await startRelay(relayPort, server.port);
    } else {
      dockerExec(container, `kill -9 ${agentPid}`);
      await waitFor("agent process dead", () => !containerAlive(container, agentPid), 10_000);
      const piDuring = containerStat(container, piPid);
      evidence.check(
        containerAlive(container, piPid),
        "pi survived the agent kill",
        `pi pid ${piPid}`,
      );
      evidence.check(
        piDuring?.starttime === piBefore?.starttime,
        "pi is the same process while the agent is gone",
        `starttime ${piBefore?.starttime} -> ${piDuring?.starttime}`,
      );
      dockerExec(container, agentCommand, true);
      await waitFor(
        "a fresh agent pid",
        () => {
          try {
            return readFileSync(join(stateDir, "agent.pid"), "utf8").trim() !== agentPid;
          } catch {
            return false;
          }
        },
        30_000,
      );
      const freshPid = readFileSync(join(stateDir, "agent.pid"), "utf8").trim();
      evidence.numbers.agent_pid_second = Number(freshPid);
      evidence.check(
        freshPid !== agentPid,
        "the reattached agent is a fresh process",
        `agent pid ${agentPid} -> ${freshPid}`,
      );
    }

    await waitFor(
      "agent_settled after the kill",
      () => evidence.frames.some((entry) => entry.frame.type === "agent_settled"),
      90_000,
    );
    await Bun.sleep(700);

    const audit = await auditOf(server.port);
    const local = localAudit(evidence.frames);
    const finalCount = evidence.frames.length;
    const afterKill = evidence.frames.filter((entry) => entry.at > evidence.killAt).length;
    evidence.numbers.frames_logged = audit.count;
    evidence.numbers.gaps = audit.gaps.length;
    evidence.numbers.duplicates = audit.duplicates.length;
    evidence.numbers.suppressed_at_ingest = audit.suppressedAtIngest.length;
    evidence.numbers.gap_events = audit.gapEvents.length;
    evidence.numbers.rejected = audit.rejected;
    evidence.numbers.frames_after_kill = afterKill;
    evidence.lists.gaps = audit.gaps;
    evidence.lists.duplicates = audit.duplicates;
    evidence.lists.suppressed_at_ingest = audit.suppressedAtIngest;
    evidence.lists.gap_events = audit.gapEvents.map((entry) => entry.got);

    evidence.check(audit.gaps.length === 0, "log has zero gaps", JSON.stringify(audit.gaps));
    evidence.check(
      audit.duplicates.length === 0,
      "log has zero duplicates",
      JSON.stringify(audit.duplicates),
    );
    evidence.check(audit.firstSeq === 1, "log starts at seq 1", `firstSeq ${audit.firstSeq}`);
    evidence.check(
      local.gaps.length === 0,
      "observer stream has zero gaps",
      JSON.stringify(local.gaps),
    );
    evidence.check(
      local.duplicates.length === 0,
      "observer stream has zero duplicates",
      JSON.stringify(local.duplicates),
    );
    evidence.check(
      audit.count === finalCount && audit.lastSeq === finalCount,
      "one sequence, 1..N, across the whole run",
      `logged ${audit.count}, lastSeq ${audit.lastSeq}, delivered ${finalCount}`,
    );
    evidence.check(
      evidence.frames.every((entry, index) => entry.seq === index + 1),
      "the stream is exactly 1..N in order",
      `${finalCount} frames`,
    );
    evidence.check(
      lastSeqAtKill > 0 && finalCount - framesAtKill >= 10,
      "the kill landed mid-stream",
      `last seq at kill ${lastSeqAtKill}, ${finalCount - framesAtKill} frames arrived after the kill instant`,
    );
    evidence.check(
      audit.rejected === 0,
      "no payload was refused during the run",
      `${audit.rejected}`,
    );

    const toolStarts = evidence.frames.filter(
      (entry) => entry.frame.type === "tool_execution_start",
    );
    const toolEnds = evidence.frames.filter((entry) => entry.frame.type === "tool_execution_end");
    evidence.check(
      toolStarts.length >= 3 && toolEnds.length >= 3,
      "a 3+ step exchange ran",
      `${toolStarts.length} tool calls`,
    );

    const tailStart = lastSeqAtKill;
    const unary = (await fetchJson(
      server.port,
      `/events?last_seen_seq=${tailStart}`,
    )) as unknown as {
      frames: Array<{ seq: number; frame: PiInboundFrame }>;
      reply_is_exact: boolean;
    };
    const streamTail = evidence.frames.filter((entry) => entry.seq > tailStart);
    const unaryMatches =
      unary.frames.length === streamTail.length &&
      unary.frames.every(
        (entry, index) =>
          entry.seq === streamTail[index]?.seq &&
          JSON.stringify(entry.frame) === JSON.stringify(streamTail[index]?.frame),
      );
    evidence.check(
      unaryMatches && unary.reply_is_exact,
      "the unary endpoint and the stream share one log",
      `GET /events?last_seen_seq=${tailStart} returned ${unary.frames.length} frames identical to the stream's tail`,
    );

    if (scenario === "a") {
      const before = await auditOf(server.port);
      await injectTruncated(server.port);
      const after = await auditOf(server.port);
      evidence.check(
        after.rejected === before.rejected + 4 && after.lastSeq === before.lastSeq,
        "truncated and malformed frames are refused without touching the log",
        `rejected ${before.rejected} -> ${after.rejected}, lastSeq ${before.lastSeq} -> ${after.lastSeq}`,
      );
      evidence.check(
        after.gaps.length === 0 && after.duplicates.length === 0,
        "the log is still clean after the injections",
        JSON.stringify({ gaps: after.gaps, duplicates: after.duplicates }),
      );
    }

    if (scenario === "b") {
      const piAfter = containerStat(container, piPid);
      evidence.numbers.pi_starttime_after = piAfter?.starttime ?? "missing";
      evidence.check(
        piAfter?.starttime === piBefore?.starttime && containerAlive(container, piPid),
        "pi never restarted across the agent kill and reattach",
        `pid ${piPid}, starttime ${piBefore?.starttime} -> ${piAfter?.starttime}`,
      );
      const inFlight = inFlightAtKill[0];
      const closed = evidence.frames.some(
        (entry) =>
          entry.frame.type === "tool_execution_end" &&
          inFlight !== undefined &&
          entry.frame.toolCallId === inFlight &&
          entry.at > evidence.killAt,
      );
      evidence.check(
        inFlight !== undefined && closed,
        "the tool call in flight at the kill completed after reattach",
        `toolCallId ${inFlight ?? "none"} ended after the kill`,
      );
    }

    const agentLog = readFileSync(join(stateDir, "agent.log"), "utf8");
    const rejoins = agentLog.split("\n").filter((line) => line.includes("tunnel open"));
    evidence.logTails["agent.log"] = agentLog.split("\n").slice(-14).join("\n");
    evidence.logTails["supervisor.log"] = readFileSync(join(stateDir, "supervisor.log"), "utf8")
      .split("\n")
      .slice(-14)
      .join("\n");
    evidence.logTails["server.log"] = server.lines.slice(-12).join("\n");
    evidence.logTails["relay.log"] =
      relay.lines.length > 0
        ? relay.lines.slice(-6).join("\n")
        : "(relay replaced; original killed)";
    if (scenario === "a") {
      evidence.numbers.agent_pid_second = Number(agentPid);
      evidence.check(
        containerAlive(container, agentPid),
        "the scenario-a kill left the agent process alive",
        `agent pid ${agentPid} still running`,
      );
    }
    evidence.check(
      rejoins.length >= 2,
      "the tunnel was re-opened after the kill",
      rejoins.join(" | "),
    );
    const lastRejoin = rejoins.at(-1) ?? "";
    const rejoinSeq = Number(lastRejoin.match(/last_seen_seq=(\d+)/)?.[1] ?? -1);
    evidence.numbers.rejoin_last_seen_seq = rejoinSeq;
    // The acked watermark may legitimately sit one or more frames past the kill-time sample:
    // ack(seq) only exists after the server ingested seq. Bounded by the final watermark instead.
    evidence.check(
      rejoinSeq >= 0 && rejoinSeq <= audit.lastSeq,
      "the rejoin named a last_seen_seq inside the one log",
      `${lastRejoin.trim()} (kill-time watermark ${lastSeqAtKill}, final ${audit.lastSeq})`,
    );

    const kinds = frameKinds(evidence.frames);
    evidence.numbers.total_frames = evidence.frames.length;
    evidence.logTails["frame kinds"] = [...kinds.entries()]
      .map(([kind, count]) => `${kind}: ${count}`)
      .join(", ");

    const transcriptLines = [
      JSON.stringify({ scenario, at: Date.now(), note: "run start", checks: evidence.numbers }),
      ...evidence.notes.map((note) => JSON.stringify({ scenario, ...note })),
      ...evidence.frames.map((entry) =>
        JSON.stringify({ scenario: scenario, at: entry.at, seq: entry.seq, frame: entry.frame }),
      ),
    ];
    const transcriptPath = join(scratch, `transcript-${scenario}.jsonl`);
    writeFileSync(transcriptPath, `${transcriptLines.join("\n")}\n`);

    docker(["logs", container]);
    return { evidence, transcriptPath };
  } finally {
    relay.stop();
    observer.close();
    stub.stop();
    server.stop();
    docker(["rm", "-f", container]);
  }
}

/** Send the exact shapes a killed write or a broken peer would: none may reach the log. */
async function injectTruncated(serverPort: number): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/tunnel?last_seen_seq=0`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("injection connection failed")));
  });
  ws.send('{"kind":"frame","seq":999999,"fra'); // the truncated tail of a killed write
  ws.send("not json at all");
  ws.send('{"kind":"frame","seq":0,"frame":{}}');
  ws.send('{"kind":"frame"}');
  await Bun.sleep(300);
  ws.close();
  await Bun.sleep(100);
}

async function main(): Promise<number> {
  const { short, full, branch } = sha();
  const artifactDir = join(root, "packages/verify/artifacts/tunnel", short);
  mkdirSync(artifactDir, { recursive: true });
  const image = `freebot-tunnel-spike:${short}`;

  const preflight: Check[] = [];
  const dockerInfo = docker([
    "info",
    "--format",
    "{{.ServerVersion}} {{.Architecture}} {{.KernelVersion}}",
  ]);
  preflight.push({ ok: dockerInfo.code === 0, label: "docker engine up", detail: dockerInfo.out });
  const piPresent = existsSync(join(root, "node_modules/@earendil-works/pi-coding-agent"));
  preflight.push({
    ok: piPresent,
    label: "node_modules present (bun install)",
    detail: piPresent ? "found" : "missing: run bun install --frozen-lockfile",
  });
  const spikeTypecheck = run(["bun", "x", "tsc", "-p", "spikes/tunnel/tsconfig.json"]);
  preflight.push({
    ok: spikeTypecheck.code === 0,
    label: "spike typecheck",
    detail: spikeTypecheck.out.slice(-400),
  });
  if (!preflight.every((entry) => entry.ok)) {
    for (const entry of preflight)
      writeFileSync(
        join(artifactDir, "assert.txt"),
        `${entry.ok ? "ok  " : "FAIL"} ${entry.label}: ${entry.detail}\n`,
      );
    return 1;
  }

  const build = docker(["build", "--platform", "linux/arm64", "-t", image, "spikes/tunnel"]);
  const imageId = docker(["image", "inspect", "--format", "{{.Id}}", image]).out;
  const buildOk = build.code === 0;

  let results: ScenarioResult[] = [];
  if (buildOk) {
    results = [await runScenario("a", image), await runScenario("b", image)];
  }

  const assertLines: string[] = [
    "feature: tunnel kill/rejoin (Pi in a container over the wire, one seq, one log)",
    `command: bun spikes/tunnel/kill-rejoin.ts`,
    `timestamp: ${new Date().toISOString()}`,
    `git sha: ${full}`,
    `git sha short: ${short}`,
    `branch: ${branch}`,
    `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}, docker ${dockerInfo.out}`,
    `image: ${image} ${imageId}`,
    "",
  ];
  const auditLines: string[] = [
    "seq audit: one monotonic sequence from one event log, killed and rejoined twice",
    `timestamp: ${new Date().toISOString()}`,
    `git sha: ${full}`,
    "",
  ];

  for (const entry of preflight) {
    assertLines.push(
      `${entry.ok ? "ok  " : "FAIL"} preflight: ${entry.label} (${entry.detail.split("\n").at(-1) ?? ""})`,
    );
  }
  assertLines.push(
    `${buildOk ? "ok  " : "FAIL"} preflight: docker build (${build.out.split("\n").at(-1) ?? ""})`,
  );
  assertLines.push("");

  let allPassed = buildOk;
  for (const { evidence, transcriptPath } of results) {
    allPassed = allPassed && evidence.passed;
    assertLines.push(`--- scenario ${evidence.scenario} ---`);
    assertLines.push(`transcript: ${transcriptPath}`);
    for (const check of evidence.checks) {
      assertLines.push(
        `${check.ok ? "ok  " : "FAIL"} ${check.label}${check.detail.length > 0 ? ` (${check.detail})` : ""}`,
      );
    }
    assertLines.push("");
    assertLines.push(`--- scenario ${evidence.scenario} log tails ---`);
    for (const [name, tail] of Object.entries(evidence.logTails)) {
      assertLines.push(`[${name}]`);
      assertLines.push(tail);
    }
    assertLines.push("");

    const audit = {
      gaps: evidence.numbers.gaps,
      duplicates: evidence.numbers.duplicates,
      suppressed_at_ingest: evidence.numbers.suppressed_at_ingest,
      gap_events: evidence.numbers.gap_events,
      rejected: evidence.numbers.rejected,
    };
    auditLines.push(
      `scenario ${evidence.scenario}: ${evidence.scenario === "a" ? "tunnel relay SIGKILLed mid-burst" : "tunnel agent SIGKILLed mid-tool-call"}`,
      `  frames logged: ${evidence.numbers.total_frames ?? 0} (seq 1..${evidence.numbers.frames_logged ?? 0})`,
      `  gaps: ${evidence.numbers.gaps ?? "?"} ${JSON.stringify(evidence.lists.gaps ?? [])}`,
      `  duplicates: ${evidence.numbers.duplicates ?? "?"} ${JSON.stringify(evidence.lists.duplicates ?? [])}`,
      `  suppressed at ingest (replayed frames the log already held): ${evidence.numbers.suppressed_at_ingest ?? "?"} ${JSON.stringify(evidence.lists.suppressed_at_ingest ?? [])}`,
      `  gap events (refused, healed by resend): ${evidence.numbers.gap_events ?? "?"} ${JSON.stringify(evidence.lists.gap_events ?? [])}`,
      `  rejected payloads: ${evidence.numbers.rejected ?? "?"}`,
      `  kill point: last seq at kill ${evidence.numbers.last_seq_at_kill ?? "?"}; ${evidence.numbers.frames_after_kill ?? "?"} frames arrived after the kill instant`,
      `  rejoin last_seen_seq: ${evidence.numbers.rejoin_last_seen_seq ?? "?"} (log watermark at kill: ${evidence.numbers.last_seq_at_kill ?? "?"})`,
      `  pi pid: ${evidence.numbers.pi_pid ?? "?"} (starttime ${evidence.numbers.pi_starttime_before ?? "?"} -> ${evidence.numbers.pi_starttime_after ?? "unchanged"})`,
      `  agent pid: ${evidence.numbers.agent_pid_first ?? "?"} -> ${evidence.numbers.agent_pid_second ?? "?"}`,
      `  audit invariant: ${audit.gaps === 0 && audit.duplicates === 0 ? "OK (zero gaps, zero duplicates)" : "VIOLATED"}`,
      "",
    );
  }

  assertLines.push(
    `RESULT: ${allPassed ? "PASS" : "FAIL"} (${results.reduce((sum, entry) => sum + entry.evidence.checks.filter((check) => check.ok).length, 0)}/${results.reduce((sum, entry) => sum + entry.evidence.checks.length, 0)} scenario checks green)`,
  );

  writeFileSync(join(artifactDir, "assert.txt"), `${assertLines.join("\n")}\n`);
  writeFileSync(join(artifactDir, "seq-audit.txt"), `${auditLines.join("\n")}\n`);
  for (const { evidence, transcriptPath } of results) {
    writeFileSync(
      join(artifactDir, `transcript-${evidence.scenario}.jsonl`),
      readFileSync(transcriptPath, "utf8"),
    );
  }
  const combined = results
    .map(({ transcriptPath }) => readFileSync(transcriptPath, "utf8").trim())
    .join("\n");
  writeFileSync(join(artifactDir, "transcript.jsonl"), `${combined}\n`);

  console.log(`[harness] artifact: ${artifactDir}/assert.txt`);
  console.log(
    assertLines
      .filter(
        (line) => line.startsWith("ok  ") || line.startsWith("FAIL") || line.startsWith("RESULT"),
      )
      .join("\n"),
  );
  return allPassed ? 0 : 1;
}

try {
  process.exit(await main());
} catch (error) {
  console.error(`[harness] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
