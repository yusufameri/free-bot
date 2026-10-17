#!/usr/bin/env bun
/**
 * Forge test A harness (U0.9). One run proves the claim against the composed path:
 *
 *   host:  composer (U0.7 tunnel protocol + pi-bridge gate + U0.8 grant policy over a real store)
 *   VM:    the pinned sandbox image (U0.6) plus a spike gateway that owns Pi 1.3.0, mints the one
 *          seq, and relays every gate dialog to the host
 *
 * Every row ends with a literal read of a canary path inside the container, never the gate's
 * return value. Every deny row must leave the canary absent; the allow rows must write it exactly
 * once. Scenario i kills the tunnel relay and the composer mid-gated-call and re-runs the audit.
 *
 * Run: bun spikes/forge-test-a/run.ts
 * Artifact: packages/verify/artifacts/forge-test-a/<short-sha>/
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiInboundFrame } from "@freebot/pi-bridge";
import { type StubModel, startStubModel } from "./stub-model.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const CANARY_DIR = "/var/freebot-canary";
const PROMPT = "Follow the harness script: call the tool named in each turn.";

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

interface ControlOp {
  op: string;
  [key: string]: unknown;
}

interface Frame {
  seq: number;
  frame: PiInboundFrame;
  at: number;
}

interface Decision {
  at: number;
  requestId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  allow: boolean;
  code: string;
  reason: string;
}

interface RowCall {
  callId: string;
  expectCode: string;
  expectIsError: boolean;
  canaryAfter: "absent" | "present" | "unchanged";
  expectReasonIncludes?: string;
}

interface RowSpec {
  id: string;
  title: string;
  tool: string;
  args: unknown;
  setup: () => Promise<Record<string, unknown>>;
  calls: RowCall[];
  contentCheck?: string;
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

function dockerStrict(args: string[]): string {
  const result = docker(args);
  if (result.code !== 0) throw new Error(`docker ${args[0]} failed: ${result.out}`);
  return result.out;
}

function dockerExec(
  container: string,
  command: string,
  detached = false,
): { code: number; out: string } {
  return docker(["exec", ...(detached ? ["-d"] : []), container, "sh", "-c", command]);
}

function dockerExecStrict(container: string, command: string, detached = false): string {
  const result = dockerExec(container, command, detached);
  if (result.code !== 0) {
    throw new Error(`docker exec failed: ${result.out}\ncommand: ${command}`);
  }
  return result.out;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function shellIn(cwd: string, argv: string[], redirectTo: string): string {
  const line = argv.map(shQuote).join(" ");
  return `cd ${shQuote(cwd)} && exec ${line} > ${shQuote(redirectTo)} 2>&1`;
}

async function waitFor(label: string, condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timeout: ${label}`);
}

async function waitForAsync(
  label: string,
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(25);
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

function sha(): { short: string; full: string; branch: string } {
  return {
    short: run(["git", "rev-parse", "--short", "HEAD"]).out,
    full: run(["git", "rev-parse", "HEAD"]).out,
    branch: run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).out,
  };
}

function localAudit(frames: Frame[]): { gaps: number[]; duplicates: number[] } {
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

class Observer {
  readonly frames: Frame[] = [];
  readonly controlMessages: Array<Record<string, unknown>> = [];
  private socket: WebSocket | null = null;
  private port = 0;
  private stopped = false;

  connect(port: number): void {
    this.port = port;
    this.open();
  }

  private open(): void {
    const last = this.frames.at(-1)?.seq ?? 0;
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}/stream?last_seen_seq=${last}`);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
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
        this.frames.push({ seq: message.seq, frame: message.frame, at: Date.now() });
      } else {
        this.controlMessages.push(message as Record<string, unknown>);
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.stopped) return;
      setTimeout(() => {
        if (this.socket === null && !this.stopped) this.open();
      }, 250);
    });
    socket.addEventListener("error", () => {
      // `close` follows and owns the reconnect.
    });
  }

  reconnect(port: number): void {
    this.port = port;
    this.stop();
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
  }
}

interface Harness {
  container: string;
  scratch: string;
  hostOnly: string;
  controlToken: string;
  composerPort: number;
  relayPort: number;
  relay: Service;
  composer: Service;
  observer: Observer;
  stub: StubModel;
}

function decisionLines(path: string): Decision[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Decision);
}

function framesFileLines(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
}

async function main(): Promise<number> {
  const { short, full, branch } = sha();
  const artifactDir = join(root, "packages/verify/artifacts/forge-test-a", short);
  mkdirSync(artifactDir, { recursive: true });
  const checks: Check[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const numbers: Record<string, string | number> = {};
  const logTails: Record<string, string> = {};
  const assertLines: string[] = [];
  const seqAuditLines: string[] = [];
  let allOk = true;

  const check = (ok: boolean, label: string, detail = ""): void => {
    checks.push({ ok, label, detail });
    allOk = allOk && ok;
  };

  const u03Fixture = run([
    "bun",
    "test",
    "packages/pi-bridge/src/gate.test.ts",
    "-t",
    "throwing handler",
  ]);
  const u03Passes = Number(u03Fixture.out.match(/(\d+) pass/)?.[1] ?? "0");
  check(
    u03Fixture.code === 0 && u03Passes >= 1,
    "U0.3's landed fixture cited for the throwing-handler rule (packages/pi-bridge/src/gate.test.ts)",
    `bun test -t "throwing handler" -> exit ${u03Fixture.code}, ${u03Passes} pass, denial reason "gate handler threw: boom"`,
  );

  const dockerInfo = docker([
    "info",
    "--format",
    "{{.ServerVersion}} {{.Architecture}} {{.KernelVersion}}",
  ]);
  if (dockerInfo.code !== 0) {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "assert.txt"),
      `FAIL preflight: docker engine up (${dockerInfo.out})\n`,
    );
    console.log(`FAIL preflight: docker engine up (${dockerInfo.out})`);
    return 1;
  }
  const piPresent = existsSync(join(root, "node_modules/@earendil-works/pi-coding-agent"));
  if (!piPresent) {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "assert.txt"),
      "FAIL preflight: node_modules missing (run bun install --frozen-lockfile)\n",
    );
    console.log("FAIL preflight: node_modules missing (run bun install --frozen-lockfile)");
    return 1;
  }
  const spikeTypecheck = run(["bun", "x", "tsc", "-p", "spikes/forge-test-a/tsconfig.json"]);
  if (spikeTypecheck.code !== 0) {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "assert.txt"),
      `FAIL preflight: spike typecheck\n${spikeTypecheck.out.slice(-2000)}\n`,
    );
    console.log(`FAIL preflight: spike typecheck\n${spikeTypecheck.out.slice(-2000)}`);
    return 1;
  }

  const image = `freebot-forge-a:${short}`;
  const baseTag = `freebot-forge-a-base:${short}`;
  const baseBuild = docker([
    "build",
    "--platform",
    "linux/arm64",
    "-t",
    baseTag,
    "-f",
    "packages/sandbox/image/Dockerfile",
    "packages/sandbox/image",
  ]);
  const derivedBuild = docker([
    "build",
    "--platform",
    "linux/arm64",
    "--build-arg",
    `BASE_IMAGE=${baseTag}`,
    "-t",
    image,
    "-f",
    "spikes/forge-test-a/Dockerfile",
    "spikes/forge-test-a",
  ]);
  const baseId = docker(["image", "inspect", "--format", "{{.Id}}", baseTag]).out;
  const derivedId = docker(["image", "inspect", "--format", "{{.Id}}", image]).out;
  const pinnedDigest = docker([
    "image",
    "inspect",
    "--format",
    '{{index .Config.Labels "org.freebot.sandbox.node-base-digest"}}',
    image,
  ]).out;

  if (baseBuild.code !== 0 || derivedBuild.code !== 0) {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "assert.txt"),
      `FAIL preflight: docker build (base: ${baseBuild.code}, derived: ${derivedBuild.code})\n${baseBuild.out.slice(-800)}\n${derivedBuild.out.slice(-800)}\n`,
    );
    console.log("FAIL preflight: docker build");
    return 1;
  }

  const hostOnly = mkdtempSync(join(tmpdir(), "freebot-forge-a-host-"));
  const scratch = mkdtempSync(join(tmpdir(), "freebot-forge-a-scratch-"));
  const storePath = join(hostOnly, "grants.jsonl");
  const framesPath = join(hostOnly, "frames.jsonl");
  const decisionsPath = join(hostOnly, "decisions.jsonl");
  const container = `freebot-forge-a-${Date.now()}`;
  const controlToken = crypto.randomUUID();
  const containerState = "/scratch/state";

  const stub = startStubModel();
  let composerToken = controlToken;
  const startComposer = async (token: string): Promise<Service> => {
    const proc = Bun.spawn(
      [
        "bun",
        "spikes/forge-test-a/composer.ts",
        "--port-file",
        join(hostOnly, `composer-${token.slice(0, 8)}.port`),
        "--store",
        storePath,
        "--frames",
        framesPath,
        "--decisions",
        decisionsPath,
        "--control-token",
        token,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const service: Service = { port: 0, proc, lines: [], stop: () => proc.kill(9) };
    pumpLines(service);
    const portFile = join(hostOnly, `composer-${token.slice(0, 8)}.port`);
    const port = Number(await waitForFile(portFile, 15_000));
    service.port = port;
    return service;
  };

  let composer = await startComposer(composerToken);
  const relayPort = await freePort();
  const startRelay = async (): Promise<Service> => {
    const proc = Bun.spawn(
      [
        "bun",
        "spikes/tunnel/tcp-relay.ts",
        "--listen",
        String(relayPort),
        "--forward",
        String(composer.port),
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const service: Service = { port: relayPort, proc, lines: [], stop: () => proc.kill(9) };
    pumpLines(service);
    await waitFor(
      "relay listening line",
      () => service.lines.some((line) => line.includes("listening")),
      10_000,
    );
    return service;
  };
  let relay = await startRelay();

  const observer = new Observer();
  observer.connect(composer.port);
  await waitFor("observer attached", () => observer.controlMessages.length > 0, 5000);

  const fetchAudit = async (port: number): Promise<AuditShape> => {
    const response = await fetch(`http://127.0.0.1:${port}/audit`);
    return (await response.json()) as unknown as AuditShape;
  };

  const harness: Harness = {
    container,
    scratch,
    hostOnly,
    controlToken,
    composerPort: composer.port,
    relayPort,
    relay,
    composer,
    observer,
    stub,
  };

  const control = async (body: ControlOp): Promise<Record<string, unknown>> => {
    const response = await fetch(`http://127.0.0.1:${harness.composerPort}/control`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forge-control": composerToken },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`control ${body.op} -> ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  };

  const canaryRead = (path: string): string => {
    const result = dockerExec(container, `cat ${path} 2>/dev/null || echo ABSENT`);
    return result.out.trim();
  };

  const canaryList = (): string[] => {
    const out = dockerExec(container, `ls -1 ${CANARY_DIR} 2>/dev/null`).out.trim();
    return out.length === 0 ? [] : out.split("\n");
  };

  const plan = async (call: { callId: string; tool: string; args: unknown }): Promise<void> => {
    await fetch(`http://127.0.0.1:${stub.port}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        plan: { kind: "tool", toolName: call.tool, args: call.args, callId: call.callId },
      }),
    });
  };

  const endFrameFor = (callId: string): Frame | undefined =>
    observer.frames.find(
      (entry) => entry.frame.type === "tool_execution_end" && entry.frame.toolCallId === callId,
    );

  const waitForEnd = async (callId: string, timeoutMs: number): Promise<Frame> => {
    await waitFor(
      `tool_execution_end for ${callId}`,
      () => endFrameFor(callId) !== undefined,
      timeoutMs,
    );
    const frame = endFrameFor(callId);
    if (frame === undefined) throw new Error(`no end frame for ${callId}`);
    return frame;
  };

  const waitForDecision = async (callId: string, timeoutMs: number): Promise<Decision[]> => {
    await waitFor(
      `decision line for ${callId}`,
      () => decisionLines(decisionsPath).some((entry) => entry.toolCallId === callId),
      timeoutMs,
    );
    return decisionLines(decisionsPath).filter((entry) => entry.toolCallId === callId);
  };

  const describeEnd = (frame: Frame): string => {
    if (frame.frame.type !== "tool_execution_end") return "not an end frame";
    const end = frame.frame;
    const text = end.result.content
      .map((part) => part.text ?? "")
      .join(" ")
      .trim();
    return `isError=${end.isError} durationMs=${end.durationMs ?? "none"} result="${text}"`;
  };

  const runRow = async (spec: RowSpec): Promise<void> => {
    const canaryPath = `${CANARY_DIR}/${spec.id}.txt`;
    const notes: Array<Record<string, unknown>> = [];
    const row: Record<string, unknown> = { id: spec.id, title: spec.title };
    assertLines.push(`--- row ${spec.id}: ${spec.title} ---`);

    const before = canaryRead(canaryPath);
    check(
      before === "ABSENT",
      `row ${spec.id}: canary absent before the call`,
      `${canaryPath} -> ${JSON.stringify(before)}`,
    );

    const setup = await spec.setup();
    row.setup = setup;
    notes.push({ phase: "setup", ...setup });
    assertLines.push(`     setup: ${JSON.stringify(setup)}`);

    const results: Array<Record<string, unknown>> = [];
    for (const call of spec.calls) {
      const preRead = canaryRead(canaryPath);
      await plan({ callId: call.callId, tool: spec.tool, args: spec.args });
      const end = await waitForEnd(call.callId, 90_000);
      const decisions = await waitForDecision(call.callId, 30_000);
      const decision = decisions[0];
      if (decision === undefined) throw new Error(`no decision for ${call.callId}`);
      const after = canaryRead(canaryPath);
      const endText = describeEnd(end);

      check(
        decision.code === call.expectCode,
        `row ${spec.id} ${call.callId}: decision code`,
        `expected ${call.expectCode}, observed ${decision.code} (${decision.reason})`,
      );
      check(
        end.frame.type === "tool_execution_end" && end.frame.isError === call.expectIsError,
        `row ${spec.id} ${call.callId}: tool_execution_end isError`,
        `expected ${call.expectIsError}, observed ${endText}`,
      );
      if (call.expectIsError) {
        check(
          endText.includes(call.expectCode),
          `row ${spec.id} ${call.callId}: Pi's own error text names the code`,
          `expected "${call.expectCode}" in ${endText}`,
        );
      }
      if (call.expectReasonIncludes !== undefined) {
        check(
          decision.reason.includes(call.expectReasonIncludes),
          `row ${spec.id} ${call.callId}: the denial carries the thrown failure verbatim`,
          `expected ${JSON.stringify(call.expectReasonIncludes)} in ${JSON.stringify(decision.reason)}`,
        );
      }
      if (call.canaryAfter === "absent") {
        check(
          after === "ABSENT",
          `row ${spec.id} ${call.callId}: in-VM canary ABSENT`,
          `${canaryPath} -> ${JSON.stringify(after)}`,
        );
      } else if (call.canaryAfter === "present") {
        check(
          after !== "ABSENT",
          `row ${spec.id} ${call.callId}: in-VM canary PRESENT`,
          `${canaryPath} -> ${JSON.stringify(after)}`,
        );
      } else {
        check(
          after === preRead,
          `row ${spec.id} ${call.callId}: in-VM canary UNCHANGED`,
          `${JSON.stringify(preRead)} -> ${JSON.stringify(after)}`,
        );
      }
      if (spec.contentCheck !== undefined && call.canaryAfter === "present") {
        check(
          after === spec.contentCheck,
          `row ${spec.id}: canary content literal`,
          `expected ${JSON.stringify(spec.contentCheck)}, observed ${JSON.stringify(after)}`,
        );
      }
      results.push({
        callId: call.callId,
        expectCode: call.expectCode,
        observedCode: decision.code,
        reason: decision.reason,
        allow: decision.allow,
        isError: end.frame.type === "tool_execution_end" ? end.frame.isError : null,
        canaryAfter: after,
        endText,
      });
      assertLines.push(
        `     ${call.callId}: expected ${call.expectCode}, observed ${decision.code}; canary ${JSON.stringify(after)}; ${endText}`,
      );
    }
    row.calls = results;
    rows.push(row);
    assertLines.push("");
  };

  const grantsById = async (ids: string[]): Promise<Record<string, unknown>> => {
    const state = await control({ op: "state" });
    const grants = state.grants as Array<Record<string, unknown>>;
    const out: Record<string, unknown> = {};
    for (const id of ids) {
      const grant = grants.find((entry) => entry.id === id);
      if (grant !== undefined) out[id] = grant;
    }
    return out;
  };

  const grantFor = async (
    toolName: string,
    args: unknown,
    extra: Record<string, unknown> = {},
  ): Promise<string> => {
    const issued = await control({ op: "issue", toolName, args, ttlMs: 3_600_000, ...extra });
    return String(issued.grantId);
  };

  const trackGrant = async (label: string, grantId: string): Promise<Record<string, unknown>> => {
    const grants = await grantsById([grantId]);
    const grant = grants[grantId] as Record<string, unknown>;
    return {
      label,
      grantId,
      seq: grant?.seq,
      actionHash: grant?.actionHash,
      expiresAt: grant?.expiresAt,
    };
  };

  try {
    dockerStrict([
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
    ]);
    await waitFor(
      "container running",
      () => docker(["inspect", "--format", "{{.State.Running}}", container]).out === "true",
      15_000,
    );
    const gatewayCommand = `mkdir -p ${shQuote(containerState)} && ${shellIn(
      "/work",
      [
        "bun",
        "/work/spikes/forge-test-a/gateway.ts",
        "--state-dir",
        containerState,
        "--pi-bin",
        "/work/node_modules/.bin/pi",
        "--url",
        `ws://host.docker.internal:${relayPort}/tunnel`,
        "--stub-base-url",
        `http://host.docker.internal:${stub.port}/v1`,
        "--prompt",
        PROMPT,
      ],
      `${containerState}/gateway.log`,
    )}`;
    dockerExecStrict(container, gatewayCommand, true);
    await waitForFile(join(scratch, "state/gateway.pid"), 30_000);
    await waitFor("first frames", () => observer.frames.length > 0, 60_000);

    const piVersion = dockerExecStrict(container, "pi --version");
    check(piVersion === "1.3.0", "pi version inside the container", `pi --version -> ${piVersion}`);
    numbers.pi_version = piVersion;
    check(
      dockerExec(container, `ls -A ${CANARY_DIR}`).out.trim().length === 0,
      "canary directory is empty at boot",
      `docker exec ls -A ${CANARY_DIR} -> ""`,
    );

    const rowBGrant = { grantId: "" };
    const rowASpec: RowSpec = {
      id: "a",
      title: "no grant -> denied no_grant; canary ABSENT",
      tool: "bash",
      args: { command: "sh -c 'date +%s%N > /var/freebot-canary/a.txt'" },
      setup: async () => ({ grantsForTool: "none" }),
      calls: [
        { callId: "call_a_1", expectCode: "no_grant", expectIsError: true, canaryAfter: "absent" },
      ],
    };
    const rowBSpec: RowSpec = {
      id: "b",
      title: "grant exists for other args -> denied grant_mismatch; canary ABSENT",
      tool: "bash",
      args: { command: "sh -c 'date +%s%N > /var/freebot-canary/b.txt'" },
      setup: async () => {
        rowBGrant.grantId = await grantFor("bash", {
          command: "sh -c 'date +%s%N > /var/freebot-canary/b-other.txt'",
        });
        return trackGrant("grant for b-other.txt", rowBGrant.grantId);
      },
      calls: [
        {
          callId: "call_b_1",
          expectCode: "grant_mismatch",
          expectIsError: true,
          canaryAfter: "absent",
        },
      ],
    };
    let rowCGrantId = "";
    const rowCSpec: RowSpec = {
      id: "c",
      title: "expired grant -> denied grant_expired; canary ABSENT",
      tool: "write",
      args: { path: "/var/freebot-canary/c.txt", content: "forbidden-c" },
      setup: async () => {
        rowCGrantId = String(
          (
            await control({
              op: "issue",
              toolName: "write",
              args: { path: "/var/freebot-canary/c.txt", content: "forbidden-c" },
              ttlMs: 1000,
              now: Date.now() - 60_000,
            })
          ).grantId,
        );
        return trackGrant("grant already expired at issue", rowCGrantId);
      },
      calls: [
        {
          callId: "call_c_1",
          expectCode: "grant_expired",
          expectIsError: true,
          canaryAfter: "absent",
        },
      ],
    };
    let rowDGrantId = "";
    const rowDSpec: RowSpec = {
      id: "d",
      title:
        "matching grant -> one allow; second identical call denied grant_consumed; canary unchanged",
      tool: "bash",
      args: { command: "sh -c 'date +%s%N > /var/freebot-canary/d.txt'" },
      setup: async () => {
        rowDGrantId = await grantFor("bash", {
          command: "sh -c 'date +%s%N > /var/freebot-canary/d.txt'",
        });
        return trackGrant("matching grant", rowDGrantId);
      },
      calls: [
        { callId: "call_d_1", expectCode: "allow", expectIsError: false, canaryAfter: "present" },
        {
          callId: "call_d_2",
          expectCode: "grant_consumed",
          expectIsError: true,
          canaryAfter: "unchanged",
        },
      ],
    };
    let rowEGrantId = "";
    const rowESpec: RowSpec = {
      id: "e",
      title: "grant tombstoned by rewind -> denied grant_tombstoned; canary ABSENT",
      tool: "bash",
      args: { command: "sh -c 'date +%s%N > /var/freebot-canary/e.txt'" },
      setup: async () => {
        rowEGrantId = await grantFor("bash", {
          command: "sh -c 'date +%s%N > /var/freebot-canary/e.txt'",
        });
        const rewind = await control({ op: "rewind", seq: 0, reason: "rewind:0" });
        return {
          ...(await trackGrant("grant tombstoned after the call was queued", rowEGrantId)),
          rewind,
        };
      },
      calls: [
        {
          callId: "call_e_1",
          expectCode: "grant_tombstoned",
          expectIsError: true,
          canaryAfter: "absent",
        },
      ],
    };
    let rowFGrantId = "";
    const rowFSpec: RowSpec = {
      id: "f",
      title: "forged record (hash disagrees with content) -> denied grant_forged; canary ABSENT",
      tool: "write",
      args: { path: "/var/freebot-canary/f.txt", content: "forged-f" },
      setup: async () => {
        rowFGrantId = await grantFor("write", {
          path: "/var/freebot-canary/f.txt",
          content: "forged-f",
        });
        const forged = await control({
          op: "forge",
          grantId: rowFGrantId,
          args: { path: "/var/freebot-canary/f.txt", content: "tampered" },
        });
        return { ...(await trackGrant("forged grant", rowFGrantId)), forged };
      },
      calls: [
        {
          callId: "call_f_1",
          expectCode: "grant_forged",
          expectIsError: true,
          canaryAfter: "absent",
        },
      ],
    };
    const rowGSpec: RowSpec = {
      id: "g",
      title:
        "unknown tool outside the governed list, with a grant -> denied unknown_tool; canary ABSENT",
      tool: "spike_unknown",
      args: { path: "/var/freebot-canary/g.txt", content: "unknown-g" },
      setup: async () => {
        const grantId = await grantFor("spike_unknown", {
          path: "/var/freebot-canary/g.txt",
          content: "unknown-g",
        });
        return trackGrant("grant for a tool the gate does not govern", grantId);
      },
      calls: [
        {
          callId: "call_g_1",
          expectCode: "unknown_tool",
          expectIsError: true,
          canaryAfter: "absent",
        },
      ],
    };
    let rowHGrantId = "";
    const rowHSpec: RowSpec = {
      id: "h",
      title:
        "positive control: one allow, canary present exactly once, second call denied grant_consumed",
      tool: "bash",
      args: { command: "sh -c 'date +%s%N > /var/freebot-canary/h.txt'" },
      setup: async () => {
        rowHGrantId = await grantFor("bash", {
          command: "sh -c 'date +%s%N > /var/freebot-canary/h.txt'",
        });
        return trackGrant("matching grant", rowHGrantId);
      },
      calls: [
        { callId: "call_h_1", expectCode: "allow", expectIsError: false, canaryAfter: "present" },
        {
          callId: "call_h_2",
          expectCode: "grant_consumed",
          expectIsError: true,
          canaryAfter: "unchanged",
        },
      ],
    };
    const rowHwSpec: RowSpec = {
      id: "hw",
      title: "positive control for the file write surface: one allow, canary content literal",
      tool: "write",
      args: { path: "/var/freebot-canary/hw.txt", content: "allowed-write" },
      setup: async () => {
        const grantId = await grantFor("write", {
          path: "/var/freebot-canary/hw.txt",
          content: "allowed-write",
        });
        return trackGrant("matching grant", grantId);
      },
      calls: [
        { callId: "call_hw_1", expectCode: "allow", expectIsError: false, canaryAfter: "present" },
      ],
      contentCheck: "allowed-write",
    };

    const rowJSpec: RowSpec = {
      id: "j",
      title:
        "host policy throws -> denied fail-closed carrying the thrown text; canary ABSENT (U0.3's throwing-handler rule, on the composed path)",
      tool: "bash",
      args: { command: "sh -c 'date +%s%N > /var/freebot-canary/j.txt'" },
      setup: async () => await control({ op: "throw-next" }),
      calls: [
        {
          callId: "call_j_1",
          expectCode: "denied",
          expectIsError: true,
          canaryAfter: "absent",
          expectReasonIncludes: "gate handler threw: simulated policy explosion",
        },
      ],
    };

    await runRow(rowASpec);
    await runRow(rowBSpec);
    await runRow(rowCSpec);
    await runRow(rowDSpec);
    await runRow(rowESpec);
    await runRow(rowFSpec);
    await runRow(rowGSpec);
    await runRow(rowHSpec);
    await runRow(rowHwSpec);
    await runRow(rowJSpec);

    const consumed = (await control({
      op: "state",
    })) as unknown as { grants: Array<Record<string, unknown>> };
    const dGrant = consumed.grants.find((grant) => grant.id === rowDGrantId);
    const hGrant = consumed.grants.find((grant) => grant.id === rowHGrantId);
    check(
      dGrant?.consumedBy === "call_d_1",
      "row d: the matched grant was consumed by call_d_1",
      `consumedBy=${JSON.stringify(dGrant?.consumedBy)}`,
    );
    check(
      hGrant?.consumedBy === "call_h_1",
      "row h: the matched grant was consumed by call_h_1",
      `consumedBy=${JSON.stringify(hGrant?.consumedBy)}`,
    );
    check(
      dGrant?.consumedBy !== "call_d_2" && hGrant?.consumedBy !== "call_h_2",
      "rows d and h: the denied second calls consumed nothing",
      `consumedBy d=${JSON.stringify(dGrant?.consumedBy)} h=${JSON.stringify(hGrant?.consumedBy)}`,
    );

    const preKillState = (await control({ op: "state" })) as unknown as {
      grants: Array<Record<string, unknown>>;
      decisions: number;
      allows: number;
    };
    numbers.grants_before_kill = preKillState.grants.length;
    numbers.decisions_before_kill = preKillState.decisions;

    assertLines.push("--- row i: control plane unreachable mid-gated-call ---");
    await control({ op: "hold-next" });
    const rowIArgs = { command: "sh -c 'date +%s%N > /var/freebot-canary/i.txt'" };
    await plan({ callId: "call_i_1", tool: "bash", args: rowIArgs });
    await waitForAsync(
      "composer holds the gate request",
      async () => {
        const state = (await control({ op: "state" })) as unknown as { held: string | null };
        return state.held !== null;
      },
      30_000,
    );
    const heldState = (await control({ op: "state" })) as unknown as { held: string | null };
    check(
      heldState.held !== null,
      "row i: the composer holds the in-flight gate request",
      `held=${JSON.stringify(heldState.held)}`,
    );
    check(
      endFrameFor("call_i_1") === undefined,
      "row i: the call is unresolved while the control plane holds it",
      "no tool_execution_end before the kill",
    );
    const canaryParked = canaryRead(`${CANARY_DIR}/i.txt`);
    check(
      canaryParked === "ABSENT",
      "row i: in-VM canary ABSENT while the call is parked",
      `${CANARY_DIR}/i.txt -> ${JSON.stringify(canaryParked)}`,
    );
    const watermarkAtKill = framesFileLines(framesPath);
    numbers.seq_at_kill = watermarkAtKill;

    harness.relay.stop();
    harness.composer.stop();
    await Bun.sleep(400);
    const canaryUnreachable = canaryRead(`${CANARY_DIR}/i.txt`);
    check(
      canaryUnreachable === "ABSENT",
      "row i: in-VM canary ABSENT while the control plane is unreachable",
      `${CANARY_DIR}/i.txt -> ${JSON.stringify(canaryUnreachable)}`,
    );
    check(
      endFrameFor("call_i_1") === undefined,
      "row i: no side effect and no resolution while unreachable",
      "still no tool_execution_end",
    );
    check(
      framesFileLines(framesPath) === watermarkAtKill,
      "row i: the durable log did not move while the composer was dead",
      `frames on disk ${watermarkAtKill} -> ${framesFileLines(framesPath)}`,
    );

    composerToken = crypto.randomUUID();
    composer = await startComposer(composerToken);
    harness.composer = composer;
    harness.composerPort = composer.port;
    observer.reconnect(composer.port);
    relay = await startRelay();
    harness.relay = relay;

    const endI = await waitForEnd("call_i_1", 120_000);
    const decisionsI = await waitForDecision("call_i_1", 30_000);
    const canaryAfterI = canaryRead(`${CANARY_DIR}/i.txt`);
    const endIText = describeEnd(endI);
    check(
      decisionsI.length === 1,
      "row i: exactly one decision for the call, made after rejoin",
      `${decisionsI.length} decision line(s)`,
    );
    check(
      decisionsI[0]?.code === "grant_mismatch",
      "row i: the call resolves under the same policy after rejoin",
      `observed ${decisionsI[0]?.code} (${decisionsI[0]?.reason})`,
    );
    check(
      endI.frame.type === "tool_execution_end" && endI.frame.isError === true,
      "row i: Pi reports the rejoin resolution as an error result",
      endIText,
    );
    check(
      canaryAfterI === "ABSENT",
      "row i: in-VM canary ABSENT after rejoin",
      `${CANARY_DIR}/i.txt -> ${JSON.stringify(canaryAfterI)}`,
    );
    rows.push({
      id: "i",
      title:
        "control plane unreachable -> no side effect; after rejoin denied under the same policy (grant_mismatch: bash grants exist, none matches call_i_1's args)",
      setup: { hold: "armed", kill: "relay + composer mid-gated-call", watermarkAtKill },
      calls: [
        {
          callId: "call_i_1",
          expectCode: "grant_mismatch",
          observedCode: decisionsI[0]?.code,
          reason: decisionsI[0]?.reason,
          isError: endI.frame.type === "tool_execution_end" ? endI.frame.isError : null,
          canaryBefore: "ABSENT",
          canaryWhileUnreachable: canaryUnreachable,
          canaryAfter: canaryAfterI,
          endText: endIText,
        },
      ],
    });
    assertLines.push(
      `     call_i_1: expected grant_mismatch, observed ${decisionsI[0]?.code}; canary ${JSON.stringify(canaryAfterI)}; ${endIText}`,
    );
    assertLines.push("");

    const postKillState = (await control({ op: "state" })) as unknown as {
      grants: Array<Record<string, unknown>>;
    };
    const eGrant = postKillState.grants.find((grant) => grant.id === rowEGrantId);
    const fGrant = postKillState.grants.find((grant) => grant.id === rowFGrantId);
    check(
      postKillState.grants.length === preKillState.grants.length,
      "row i: the reloaded ledger holds every grant the pre-kill composer held",
      `${preKillState.grants.length} -> ${postKillState.grants.length}`,
    );
    check(
      eGrant?.tombstoned === "rewind:0",
      "row i: the reloaded ledger still tombstoned grant e",
      `tombstoned=${JSON.stringify(eGrant?.tombstoned)}`,
    );
    check(
      typeof fGrant?.actionHash === "string",
      "row i: the forged record survived the restart as it was (the gate still denies it)",
      `grant ${rowFGrantId} actionHash=${JSON.stringify(fGrant?.actionHash)}`,
    );

    await fetch(`http://127.0.0.1:${stub.port}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: { kind: "stop" } }),
    });
    await waitFor(
      "agent_settled",
      () => observer.frames.some((entry) => entry.frame.type === "agent_settled"),
      90_000,
    );
    const summaryPath = join(scratch, "state/gateway-summary.json");
    await waitForFile(summaryPath, 15_000);
    await Bun.sleep(700);
    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
      toolGates: Array<{ toolName: string | null; outcome: string; reason?: string }>;
      protocolErrors: number;
      piPid: string;
      piVersion: string;
      seqMinted: number;
      acked: number;
      gateRequests: number;
    };

    const audit = await fetchAudit(harness.composerPort);
    const local = localAudit(observer.frames);
    numbers.frames_logged = audit.count;
    numbers.last_seq = audit.lastSeq;
    check(audit.gaps.length === 0, "seq audit: zero gaps", JSON.stringify(audit.gaps));
    check(
      audit.duplicates.length === 0,
      "seq audit: zero duplicates",
      JSON.stringify(audit.duplicates),
    );
    check(audit.firstSeq === 1, "seq audit: the log starts at seq 1", `firstSeq ${audit.firstSeq}`);
    check(
      audit.lastSeq === audit.count,
      "seq audit: one sequence, 1..N, across the composer restart",
      `lastSeq ${audit.lastSeq}, count ${audit.count}`,
    );
    check(local.gaps.length === 0, "observer stream: zero gaps", JSON.stringify(local.gaps));
    check(
      local.duplicates.length === 0,
      "observer stream: zero duplicates",
      JSON.stringify(local.duplicates),
    );
    check(
      audit.rejected === 0,
      "seq audit: no payload was refused during the run",
      `${audit.rejected}`,
    );

    const decisions = decisionLines(decisionsPath);
    const ends = observer.frames.filter((entry) => entry.frame.type === "tool_execution_end");
    const allows = decisions.filter((entry) => entry.allow);
    check(
      ends.length === decisions.length,
      "funnel: every tool_execution_end has exactly one host decision",
      `${ends.length} ends, ${decisions.length} decisions`,
    );
    check(
      ends.every((entry) => {
        const frame = entry.frame;
        if (frame.type !== "tool_execution_end") return false;
        return (
          decisions.filter((decision) => decision.toolCallId === frame.toolCallId).length === 1
        );
      }),
      "funnel: every call joins to exactly one decision by toolCallId",
      `${ends.length} calls joined`,
    );
    check(
      allows.length === 3 &&
        ["call_d_1", "call_h_1", "call_hw_1"].every((id) =>
          allows.some((entry) => entry.toolCallId === id),
        ),
      "exactly three allows: the positive controls and nothing else",
      `allows=${JSON.stringify(allows.map((entry) => entry.toolCallId))}`,
    );
    check(
      summary.toolGates.length === decisions.length,
      "the VM-side gate trail matches the host decision log",
      `${summary.toolGates.length} VM entries, ${decisions.length} host decisions`,
    );
    check(
      summary.toolGates.filter((entry) => entry.outcome === "deny").length === decisions.length - 3,
      "every denial in the VM trail corresponds to a host denial",
      `${summary.toolGates.filter((entry) => entry.outcome === "deny").length} denials`,
    );
    const listed = canaryList();
    check(
      listed.length === 3 && ["d.txt", "h.txt", "hw.txt"].every((name) => listed.includes(name)),
      "the set of in-VM side effects equals the set of allows",
      `${CANARY_DIR} -> ${JSON.stringify(listed)}`,
    );
    check(
      summary.piVersion === "1.3.0" && summary.protocolErrors === 0,
      "the gateway reports pi 1.3.0 with zero protocol errors",
      `pi ${summary.piVersion}, protocolErrors ${summary.protocolErrors}`,
    );
    check(
      audit.count === audit.lastSeq && summary.seqMinted === audit.count,
      "the in-VM mint and the durable log agree",
      `minted ${summary.seqMinted}, logged ${audit.count} (seq 1..${audit.lastSeq}); gateway acked ${summary.acked} frames at exit, a delivery watermark that trails by the frames in flight when Pi settled`,
    );
    numbers.tool_calls = ends.length;
    numbers.host_decisions = decisions.length;
    numbers.allows = allows.length;
    numbers.pi_pid = summary.piPid;

    logTails["composer.log"] = [...harness.composer.lines].slice(-20).join("\n");
    logTails["relay.log"] = relay.lines.slice(-6).join("\n");
    logTails["gateway.log"] = dockerExec(container, `tail -n 24 ${containerState}/gateway.log`).out;
    logTails["frame kinds"] = [
      ...observer.frames
        .reduce((kinds, entry) => {
          kinds.set(entry.frame.type, (kinds.get(entry.frame.type) ?? 0) + 1);
          return kinds;
        }, new Map<string, number>())
        .entries(),
    ]
      .map(([kind, count]) => `${kind}: ${count}`)
      .join(", ");

    seqAuditLines.push(
      "seq audit: one monotonic sequence, one durable log, composer killed and restarted mid-gated-call",
      `timestamp: ${new Date().toISOString()}`,
      `git sha: ${full}`,
      "",
      `frames logged: ${audit.count} (seq 1..${audit.lastSeq})`,
      `gaps: ${audit.gaps.length} ${JSON.stringify(audit.gaps)}`,
      `duplicates: ${audit.duplicates.length} ${JSON.stringify(audit.duplicates)}`,
      `suppressed at ingest: ${audit.suppressedAtIngest.length} ${JSON.stringify(audit.suppressedAtIngest)}`,
      `gap events (refused, healed by resend): ${audit.gapEvents.length} ${JSON.stringify(audit.gapEvents.map((entry) => entry.got))}`,
      `rejected payloads: ${audit.rejected}`,
      `watermark at kill: ${watermarkAtKill}; the fresh composer reloaded the same log`,
      `observer stream: gaps ${JSON.stringify(local.gaps)}, duplicates ${JSON.stringify(local.duplicates)}`,
      `audit invariant: ${audit.gaps.length === 0 && audit.duplicates.length === 0 ? "OK (zero gaps, zero duplicates)" : "VIOLATED"}`,
      "",
    );

    writeFileSync(join(artifactDir, "seq-audit.txt"), `${seqAuditLines.join("\n")}\n`);
  } catch (error) {
    check(
      false,
      "harness completed every step",
      error instanceof Error ? error.message : String(error),
    );
    assertLines.push(
      `     harness error: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (existsSync(decisionsPath)) {
      writeFileSync(join(artifactDir, "decisions.jsonl"), readFileSync(decisionsPath, "utf8"));
    }
    writeFileSync(
      join(artifactDir, "transcript.jsonl"),
      `${observer.frames.map((entry) => JSON.stringify({ seq: entry.seq, at: entry.at, frame: entry.frame })).join("\n")}\n`,
    );
    try {
      writeFileSync(
        join(artifactDir, "gateway-summary.json"),
        dockerExec(container, `cat ${containerState}/gateway-summary.json`).out,
      );
    } catch {
      // the gateway never settled
    }
    writeFileSync(join(artifactDir, "matrix.json"), `${JSON.stringify(rows, null, 2)}\n`);
    // `bun run lint` formats this directory too, so the artifact leaves the run in the repo's own
    // formatting. Best effort: a formatter failure is reported, never fatal to the run.
    const formatted = run(["bun", "x", "biome", "format", "--write", artifactDir]);
    if (formatted.code !== 0) {
      console.log(`[harness] biome format on the artifact failed: ${formatted.out}`);
    }
    composer.stop();
    relay.stop();
    observer.stop();
    stub.stop();
    docker(["rm", "-f", container]);
  }

  const header = [
    "feature: forge test A (a gated call cannot produce an in-VM side effect without a matching, unexpired grant)",
    "command: bun spikes/forge-test-a/run.ts",
    `timestamp: ${new Date().toISOString()}`,
    `git sha: ${full}`,
    `git sha short: ${short}`,
    `branch: ${branch}`,
    `runtime: bun ${Bun.version} on ${process.platform} ${process.arch}, docker ${dockerInfo.out}`,
    `base image: ${baseTag} ${baseId} (pinned node digest label ${pinnedDigest})`,
    `derived image: ${image} ${derivedId}`,
    `image base: packages/sandbox/image/Dockerfile (U0.6, unmodified), derived FROM it with bun added`,
    `pi version: ${numbers.pi_version ?? "unknown"}`,
    "model decisions: a keyless scripted stub (spikes/forge-test-a/stub-model.ts), no BYOK key, no live",
    "  provider, no network egress beyond the host stub; nothing here is live-model traffic",
    "host: composer owns one SeqLog and U0.8's grant policy over a real GrantStore; the VM only relays",
    "",
    ...assertLines,
    "--- every check ---",
    ...checks.map((entry) => `${entry.ok ? "ok  " : "FAIL"} ${entry.label} (${entry.detail})`),
    "",
    ...[
      "--- log tails ---",
      ...Object.entries(logTails).flatMap(([name, tail]) => [`[${name}]`, tail, ""]),
    ],
    `RESULT: ${allOk ? "PASS" : "FAIL"} (${checks.filter((entry) => entry.ok).length}/${checks.length})`,
    "",
  ];
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "assert.txt"), `${header.join("\n")}\n`);
  if (!existsSync(join(artifactDir, "seq-audit.txt"))) {
    writeFileSync(join(artifactDir, "seq-audit.txt"), "run aborted before the seq audit\n");
  }
  console.log(`[harness] artifact: ${artifactDir}/assert.txt`);
  console.log(
    checks
      .filter((entry) => !entry.ok)
      .map((entry) => `FAIL ${entry.label} (${entry.detail})`)
      .join("\n"),
  );
  console.log(
    `RESULT: ${allOk ? "PASS" : "FAIL"} (${checks.filter((entry) => entry.ok).length}/${checks.length})`,
  );
  return allOk ? 0 : 1;
}

try {
  process.exit(await main());
} catch (error) {
  console.error(`[harness] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
