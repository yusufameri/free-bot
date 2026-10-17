#!/usr/bin/env bun
/**
 * The in-VM gateway for forge test A: the single process that owns Pi, mints the one seq at the
 * only place Pi's stdout is read, and carries every gate dialog to the host composer over the
 * U0.7 tunnel protocol.
 *
 * The gateway has no authority. It relays the question, and it relays the answer; it never
 * decides, and a control plane it cannot reach is a denial after `--gate-deadline-ms`, never an
 * allow. An in-flight gate request survives a tunnel death: it stays pending and is retransmitted
 * on rejoin, so the call resolves under the same policy once the control plane is back.
 *
 * Pi runs against the landed Gate 1 extension (`packages/pi-bridge/extension/tool-gate.ts`), whose
 * only answer path is the dialog the PiSession here resolves.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type PiInboundFrame,
  PiSession,
  spawnPiTransport,
  type ToolCallContext,
  type ToolGateDecision,
} from "@freebot/pi-bridge";
import { Outbox } from "@freebot/sandbox-agent";

interface Args {
  stateDir: string;
  piBin: string;
  url: string;
  stubBaseUrl?: string;
  prompt: string;
  gateDeadlineMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    stateDir: "",
    piBin: "",
    url: "",
    prompt: "",
    gateDeadlineMs: 90_000,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined) break;
    switch (flag) {
      case "--state-dir":
        args.stateDir = value;
        break;
      case "--pi-bin":
        args.piBin = value;
        break;
      case "--url":
        args.url = value;
        break;
      case "--stub-base-url":
        args.stubBaseUrl = value;
        break;
      case "--prompt":
        args.prompt = value;
        break;
      case "--gate-deadline-ms":
        args.gateDeadlineMs = Number(value);
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (args.stateDir === "") throw new Error("--state-dir is required");
  if (args.piBin === "") throw new Error("--pi-bin is required");
  if (args.url === "") throw new Error("--url is required");
  if (args.prompt === "") throw new Error("--prompt is required");
  return args;
}

const args = parseArgs(Bun.argv.slice(2));
const workspace = join(args.stateDir, "workspace");
const home = join(args.stateDir, "home");
const agentDir = join(args.stateDir, "agent");
for (const dir of [workspace, home, agentDir]) mkdirSync(dir, { recursive: true });
writeFileSync(join(args.stateDir, "gateway.pid"), `${process.pid}\n`);

if (args.stubBaseUrl !== undefined) {
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          stub: {
            baseUrl: args.stubBaseUrl,
            api: "openai-completions",
            apiKey: "keyless-stub-literal",
            models: [
              {
                id: "stub-1",
                name: "Keyless stub",
                input: ["text"],
                contextWindow: 128000,
                maxTokens: 4096,
                reasoning: false,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      null,
      2,
    ),
  );
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const piPidFile = join(args.stateDir, "pi.pid");
const command = [
  "sh",
  "-c",
  `echo $$ > ${piPidFile} && exec "$0" "$@"`,
  args.piBin,
  "--mode",
  "rpc",
  "--no-session",
  "--offline",
  "--no-approve",
  "--tools",
  "bash,write,spike_unknown",
  "--provider",
  "stub",
  "--model",
  "stub-1",
  "-e",
  join(root, "packages/pi-bridge/extension/tool-gate.ts"),
  "-e",
  join(root, "spikes/forge-test-a/unknown-tool.ts"),
];

const outbox = new Outbox<PiInboundFrame>();
let ws: WebSocket | null = null;
let tunnelOpen = false;
let reconnects = 0;
let seq = 0;
let gateSeq = 0;
let finished = false;

interface PendingGate {
  call: ToolCallContext;
  resolve: (decision: ToolGateDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingGates = new Map<string, PendingGate>();

function sendGateRequest(requestId: string, call: ToolCallContext): void {
  if (!tunnelOpen || ws === null) return;
  ws.send(JSON.stringify({ kind: "gate_request", requestId, call }));
}

/** Ask the control plane. No answer in time is a denial; the gateway has no other answer. */
function relayGate(call: ToolCallContext): Promise<ToolGateDecision> {
  const requestId = `gate-${++gateSeq}`;
  return new Promise<ToolGateDecision>((resolve) => {
    const timer = setTimeout(() => {
      pendingGates.delete(requestId);
      console.log(`[gateway] gate deadline id=${requestId} tool=${call.toolName}`);
      resolve({
        allow: false,
        reason: `gate unreachable: no decision within ${args.gateDeadlineMs}ms`,
      });
    }, args.gateDeadlineMs);
    pendingGates.set(requestId, { call, resolve, timer });
    sendGateRequest(requestId, call);
  });
}

function sendFrame(entry: { seq: number; frame: PiInboundFrame }): void {
  if (!tunnelOpen || ws === null) return;
  ws.send(JSON.stringify({ kind: "frame", seq: entry.seq, frame: entry.frame }));
}

function connectTunnel(): void {
  const socket = new WebSocket(`${args.url}?last_seen_seq=${outbox.acked}`);
  ws = socket;
  socket.addEventListener("open", () => {
    if (ws !== socket) return;
    tunnelOpen = true;
    reconnects += 1;
    console.log(`[gateway] tunnel open last_seen_seq=${outbox.acked} reconnects=${reconnects}`);
    const pendingFrames = outbox.pending();
    for (const entry of pendingFrames) sendFrame(entry);
    console.log(
      `[gateway] replayed ${pendingFrames.length} unconfirmed frames and ${pendingGates.size} gate requests`,
    );
    for (const [requestId, entry] of pendingGates) sendGateRequest(requestId, entry.call);
  });
  socket.addEventListener("message", (event) => {
    if (ws !== socket) return;
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (message.kind === "ack" && typeof message.seq === "number") {
      outbox.ack(message.seq);
      return;
    }
    if (message.kind === "nack" && typeof message.lastSeq === "number") {
      const resend = outbox.since(message.lastSeq);
      console.log(`[gateway] nack lastSeq=${message.lastSeq}; resending ${resend.length} frames`);
      for (const entry of resend) sendFrame(entry);
      return;
    }
    if (message.kind === "gate_response" && typeof message.requestId === "string") {
      const entry = pendingGates.get(message.requestId);
      if (entry === undefined) return;
      pendingGates.delete(message.requestId);
      clearTimeout(entry.timer);
      console.log(`[gateway] gate answer id=${message.requestId} tool=${entry.call.toolName}`);
      entry.resolve(message.decision as ToolGateDecision);
      return;
    }
    if (message.kind === "error") {
      console.log(`[gateway] composer refused a message: ${String(message.message)}`);
    }
  });
  socket.addEventListener("close", () => {
    if (ws !== socket) return;
    tunnelOpen = false;
    ws = null;
    console.log("[gateway] tunnel closed; reconnecting in 250ms");
    setTimeout(connectTunnel, 250);
  });
  socket.addEventListener("error", () => {
    // `close` follows and owns the reconnect.
  });
}

const transport = spawnPiTransport({
  command,
  cwd: workspace,
  env: { HOME: home, PI_CODING_AGENT_DIR: agentDir },
});
const session = new PiSession(transport, { gate: relayGate, requestTimeoutMs: 60_000 });

transport.subscribe((event) => {
  if (event.kind === "error") {
    console.log(`[gateway] pi stream error: ${event.error.message}`);
    return;
  }
  if (event.kind === "closed") {
    console.log(`[gateway] pi closed: ${event.error?.message ?? "clean exit"}`);
    return;
  }
  seq += 1;
  outbox.push({ seq, frame: event.frame });
  sendFrame({ seq, frame: event.frame });
  if (event.frame.type === "agent_settled") {
    console.log(`[gateway] settled seq=${seq}`);
    finish();
  }
});

function piPid(): string {
  try {
    return Bun.spawnSync(["cat", piPidFile]).stdout.toString().trim();
  } catch {
    return "pending";
  }
}

function finish(): void {
  if (finished) return;
  finished = true;
  const version = Bun.spawnSync([args.piBin, "--version"]).stdout.toString().trim();
  writeFileSync(
    join(args.stateDir, "gateway-summary.json"),
    JSON.stringify(
      {
        toolGates: session.toolGates,
        protocolErrors: session.protocolErrors.length,
        piPid: piPid(),
        piVersion: version,
        seqMinted: seq,
        acked: outbox.acked,
        gateRequests: gateSeq,
      },
      null,
      2,
    ),
  );
  setTimeout(() => {
    try {
      session.close();
    } catch {
      // the transport is already gone
    }
    process.exit(0);
  }, 250);
}

connectTunnel();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[gateway] ${signal} received`);
    finish();
  });
}

await session.request({ id: "forge-boot", type: "get_state" });
console.log(`[gateway] boot ok pi_pid=${piPid()}`);
await session.request({ id: "prompt-1", type: "prompt", message: args.prompt });
console.log("[gateway] prompt sent id=prompt-1");

void transport.exited.then((code: number) => {
  if (!finished) console.log(`[gateway] pi exited code=${code}`);
});
