#!/usr/bin/env bun
/**
 * The in-sandbox supervisor for the MVP smoke dry run (U0.11), copied-with-attribution from
 * apps/sandbox-agent/src/supervisor.ts (U0.7) and extended with the host->Pi gate-dialog path
 * that forced U0.9's own gateway (spikes/forge-test-a follow-up 1).
 *
 * It still owns Pi, mints the one seq at the only place frames are read, keeps the replay
 * buffer, and serves the loopback link any tunnel agent can attach to. New here: Pi runs under
 * a `PiSession` whose gate asks the control plane over the link (`gate_request`), and the
 * control plane's `gate_answer` is written back into Pi's stdin as the extension-UI response.
 * The supervisor never decides; an unreachable host is a denial after `--gate-deadline-ms`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { SeqLog } from "@freebot/core";
import {
  type PiInboundFrame,
  PiSession,
  spawnPiTransport,
  type ToolCallContext,
  type ToolGateDecision,
} from "@freebot/pi-bridge";
import { type AgentToSupervisor, encodeLine, type SupervisorToAgent, splitLines } from "./link.ts";

interface Args {
  stateDir: string;
  piBin: string;
  listenPort: number;
  provider: string;
  model: string;
  stubBaseUrl?: string;
  prompt?: string;
  tools: string;
  extensions: string[];
  gateDeadlineMs: number;
}

function parseArgs(argv: string[]): Args {
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const args: Args = {
    stateDir: "",
    piBin: join(repoRoot, "node_modules/.bin/pi"),
    listenPort: 0,
    provider: "stub",
    model: "stub-1",
    tools: "bash,write",
    extensions: [],
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
      case "--listen-port":
        args.listenPort = Number(value);
        break;
      case "--provider":
        args.provider = value;
        break;
      case "--model":
        args.model = value;
        break;
      case "--stub-base-url":
        args.stubBaseUrl = value;
        break;
      case "--prompt":
        args.prompt = value;
        break;
      case "--tools":
        args.tools = value;
        break;
      case "--ext":
        args.extensions.push(value);
        break;
      case "--gate-deadline-ms":
        args.gateDeadlineMs = Number(value);
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (args.stateDir === "") throw new Error("--state-dir is required");
  return args;
}

const args = parseArgs(Bun.argv.slice(2));
const workspace = join(args.stateDir, "workspace");
const home = join(args.stateDir, "home");
const agentDir = join(args.stateDir, "agent");
for (const dir of [workspace, home, agentDir]) mkdirSync(dir, { recursive: true });
writeFileSync(join(args.stateDir, "supervisor.pid"), `${process.pid}\n`);

if (args.stubBaseUrl !== undefined) {
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          [args.provider]: {
            baseUrl: args.stubBaseUrl,
            api: "openai-completions",
            apiKey: "keyless-stub-literal",
            models: [
              {
                id: args.model,
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

const pidFile = join(args.stateDir, "pi.pid");
// `exec` keeps the pid: the file holds Pi's own pid, not the sh that seeded it.
const piCommand = [
  "sh",
  "-c",
  `echo $$ > ${pidFile} && exec "$0" "$@"`,
  args.piBin,
  "--mode",
  "rpc",
  "--no-session",
  "--offline",
  "--no-approve",
  "--no-builtin-tools",
  "--tools",
  args.tools,
  "--provider",
  args.provider,
  "--model",
  args.model,
  ...args.extensions.flatMap((extension) => ["-e", extension]),
];

const transport = spawnPiTransport({
  command: piCommand,
  cwd: workspace,
  env: { HOME: home, PI_CODING_AGENT_DIR: agentDir },
});

const log = new SeqLog<PiInboundFrame>();
const peers = new Set<Socket>();
const buffers = new Map<Socket, string>();
let seq = 0;
let acked = 0;
let gateSeq = 0;
let finished = false;

interface PendingGate {
  call: ToolCallContext;
  resolve: (decision: ToolGateDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingGates = new Map<string, PendingGate>();

function sendToAgents(message: SupervisorToAgent): void {
  const line = encodeLine(message);
  for (const peer of peers) peer.write(line);
}

/** Ask the control plane over the link. No answer within the deadline is a denial. */
function relayGate(call: ToolCallContext): Promise<ToolGateDecision> {
  const requestId = `gate-${++gateSeq}`;
  console.log(`[supervisor] gate ask id=${requestId} tool=${call.toolName}`);
  return new Promise<ToolGateDecision>((resolve) => {
    const timer = setTimeout(() => {
      pendingGates.delete(requestId);
      console.log(`[supervisor] gate deadline id=${requestId} tool=${call.toolName}`);
      resolve({
        allow: false,
        reason: `gate unreachable: no decision within ${args.gateDeadlineMs}ms`,
      });
    }, args.gateDeadlineMs);
    pendingGates.set(requestId, { call, resolve, timer });
    sendToAgents({ kind: "gate_request", requestId, call });
  });
}

const session = new PiSession(transport, { gate: relayGate, requestTimeoutMs: 60_000 });

const server = createServer((peer) => {
  peers.add(peer);
  buffers.set(peer, "");
  const attached: SupervisorToAgent = { kind: "attached", acked, lastSeq: log.lastSeq };
  peer.write(encodeLine(attached));
  const replay = log.since(acked);
  for (const entry of replay) {
    peer.write(encodeLine({ kind: "frame", seq: entry.seq, frame: entry.frame }));
  }
  for (const [requestId, entry] of pendingGates) {
    peer.write(encodeLine({ kind: "gate_request", requestId, call: entry.call }));
  }
  console.log(
    `[supervisor] agent attached acked=${acked} replay=${replay.length} last_seq=${log.lastSeq}`,
  );
  peer.on("data", (chunk) => {
    const split = splitLines(buffers.get(peer) ?? "", chunk.toString("utf8"));
    buffers.set(peer, split.rest);
    for (const line of split.lines) {
      const message = JSON.parse(line) as AgentToSupervisor;
      if (message.kind === "ack" && message.seq > acked) acked = message.seq;
      if (message.kind === "gate_answer") {
        const entry = pendingGates.get(message.requestId);
        if (entry === undefined) continue;
        pendingGates.delete(message.requestId);
        clearTimeout(entry.timer);
        console.log(`[supervisor] gate answer id=${message.requestId} tool=${entry.call.toolName}`);
        entry.resolve(message.decision);
      }
    }
  });
  peer.on("close", () => {
    peers.delete(peer);
    buffers.delete(peer);
    console.log(`[supervisor] agent detached acked=${acked}`);
  });
  peer.on("error", () => {});
});

server.listen(args.listenPort, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  writeFileSync(join(args.stateDir, "supervisor.port"), `${port}\n`);
  console.log(`[supervisor] listening host=127.0.0.1 port=${port}`);
});

transport.subscribe((event) => {
  if (event.kind === "error") {
    console.log(`[supervisor] pi stream error: ${event.error.message}`);
    return;
  }
  if (event.kind === "closed") {
    console.log(`[supervisor] pi closed: ${event.error?.message ?? "clean exit"}`);
    return;
  }
  const frame = event.frame;
  seq += 1;
  log.append(seq, frame);
  const line = encodeLine({ kind: "frame", seq, frame });
  for (const peer of peers) peer.write(line);

  if (frame.type === "agent_settled") {
    console.log(`[supervisor] pi settled seq=${seq}`);
    finish();
  }
});

function piPid(): string {
  try {
    return readFileSync(pidFile, "utf8").trim();
  } catch {
    return "pending";
  }
}

function finish(): void {
  if (finished) return;
  finished = true;
  const version = Bun.spawnSync([args.piBin, "--version"]).stdout.toString().trim();
  writeFileSync(
    join(args.stateDir, "supervisor-summary.json"),
    JSON.stringify(
      {
        seqMinted: seq,
        acked,
        gateRequests: gateSeq,
        toolGates: session.toolGates,
        protocolErrors: session.protocolErrors.length,
        piPid: piPid(),
        piVersion: version,
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

void session.request({ id: "spike-boot", type: "get_state" }).then(async () => {
  console.log(`[supervisor] boot ok pi_pid=${piPid()}`);
  if (args.prompt !== undefined) {
    await session.request({ id: "prompt-1", type: "prompt", message: args.prompt });
    console.log("[supervisor] prompt sent id=prompt-1");
  }
});

void transport.exited.then((code: number) => {
  console.log(`[supervisor] pi exited code=${code}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[supervisor] ${signal} received; closing pi stdin`);
    server.close();
    session.close();
    setTimeout(() => process.exit(0), 250);
  });
}
