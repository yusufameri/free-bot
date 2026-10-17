#!/usr/bin/env bun
/**
 * The in-sandbox supervisor. It owns Pi (through pi-bridge's spawnPiTransport), mints the single
 * monotonic seq at the only place frames are read, keeps them in a replay buffer, and serves the
 * loopback link any tunnel agent can attach to.
 *
 * Pi's lifetime is the supervisor's lifetime: an agent can die and be replaced without Pi
 * restarting, and the replacement replays from the supervisor's watermark instead of guessing.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { SeqLog } from "@freebot/core";
import { type PiInboundFrame, spawnPiTransport } from "@freebot/pi-bridge";
import { type AgentToSupervisor, encodeLine, type SupervisorToAgent, splitLines } from "./link.ts";

interface Args {
  stateDir: string;
  piBin: string;
  listenPort: number;
  provider: string;
  model: string;
  stubBaseUrl?: string;
  prompt?: string;
  extensions: string[];
}

function parseArgs(argv: string[]): Args {
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  const args: Args = {
    stateDir: "",
    piBin: join(repoRoot, "node_modules/.bin/pi"),
    listenPort: 0,
    provider: "stub",
    model: "stub-1",
    extensions: [],
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
      case "--ext":
        args.extensions.push(value);
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
let booted = false;

const server = createServer((peer) => {
  peers.add(peer);
  buffers.set(peer, "");
  const attached: SupervisorToAgent = { kind: "attached", acked, lastSeq: log.lastSeq };
  peer.write(encodeLine(attached));
  const replay = log.since(acked);
  for (const entry of replay) {
    peer.write(encodeLine({ kind: "frame", seq: entry.seq, frame: entry.frame }));
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

  if (frame.type === "response" && frame.id === "spike-boot" && !booted) {
    booted = true;
    console.log(`[supervisor] boot ok pi_pid=${readPid(pidFile)}`);
    if (args.prompt !== undefined) {
      transport.write({ id: "prompt-1", type: "prompt", message: args.prompt });
      console.log("[supervisor] prompt sent id=prompt-1");
    }
  }
  if (frame.type === "agent_settled") {
    console.log(`[supervisor] pi settled seq=${seq}`);
  }
});

transport.write({ id: "spike-boot", type: "get_state" });

function readPid(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "pending";
  }
}

void transport.exited.then((code: number) => {
  console.log(`[supervisor] pi exited code=${code}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[supervisor] ${signal} received; closing pi stdin`);
    server.close();
    transport.close();
    setTimeout(() => process.exit(0), 250);
  });
}
