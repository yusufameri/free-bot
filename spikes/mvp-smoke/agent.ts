#!/usr/bin/env bun
/**
 * The tunnel agent for the MVP smoke dry run (U0.11), copied-with-attribution from
 * apps/sandbox-agent/src/agent.ts (U0.7) and extended to carry the gate dialog both ways.
 *
 * Frames keep the landed behavior: buffered in an outbox, replayed from `last_seen_seq` on
 * rejoin, acked by the server. New here: `gate_request` messages from the supervisor are held
 * while the tunnel is down and resent on every reopen (the composer answers idempotently per
 * requestId), and the composer's `gate_response` is handed back to the supervisor as
 * `gate_answer`. The agent never decides anything.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import type { PiInboundFrame, ToolCallContext, ToolGateDecision } from "@freebot/pi-bridge";
import { Outbox } from "@freebot/sandbox-agent";
import { type AgentToSupervisor, encodeLine, type SupervisorToAgent, splitLines } from "./link.ts";

interface Args {
  server: string;
  supervisorHost: string;
  supervisorPortFile: string;
  pidFile?: string;
  reconnectDelayMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    server: "",
    supervisorHost: "127.0.0.1",
    supervisorPortFile: "",
    reconnectDelayMs: 250,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined) break;
    switch (flag) {
      case "--server":
        args.server = value;
        break;
      case "--supervisor-host":
        args.supervisorHost = value;
        break;
      case "--supervisor-port-file":
        args.supervisorPortFile = value;
        break;
      case "--pid-file":
        args.pidFile = value;
        break;
      case "--reconnect-delay-ms":
        args.reconnectDelayMs = Number(value);
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (args.server === "") throw new Error("--server is required");
  if (args.supervisorPortFile === "") throw new Error("--supervisor-port-file is required");
  return args;
}

const args = parseArgs(Bun.argv.slice(2));
if (args.pidFile !== undefined) writeFileSync(args.pidFile, `${process.pid}\n`);

const outbox = new Outbox<PiInboundFrame>();
const pendingDialogs = new Map<string, { requestId: string; call: ToolCallContext }>();
let tunnel: WebSocket | null = null;
let tunnelOpen = false;
let link: ReturnType<typeof connect> | null = null;
let linkBuffer = "";
let reconnects = 0;

function sendFrame(entry: { seq: number; frame: PiInboundFrame }): void {
  tunnel?.send(JSON.stringify({ kind: "frame", seq: entry.seq, frame: entry.frame }));
}

function sendGateRequest(entry: { requestId: string; call: ToolCallContext }): void {
  tunnel?.send(
    JSON.stringify({ kind: "gate_request", requestId: entry.requestId, call: entry.call }),
  );
}

function sendPending(): void {
  const pending = outbox.pending();
  for (const entry of pending) sendFrame(entry);
  for (const entry of pendingDialogs.values()) sendGateRequest(entry);
  if (pending.length > 0 || pendingDialogs.size > 0) {
    console.log(
      `[agent] replayed ${pending.length} unconfirmed frames from seq ${pending[0]?.seq ?? outbox.acked} and ${pendingDialogs.size} gate requests`,
    );
  }
}

function connectTunnel(): void {
  const ws = new WebSocket(`${args.server}?last_seen_seq=${outbox.acked}`);
  tunnel = ws;
  ws.addEventListener("open", () => {
    if (tunnel !== ws) return;
    tunnelOpen = true;
    console.log(`[agent] tunnel open last_seen_seq=${outbox.acked} reconnects=${reconnects}`);
    sendPending();
  });
  ws.addEventListener("message", (event) => {
    if (tunnel !== ws) return;
    const message = JSON.parse(String(event.data)) as {
      kind: string;
      seq?: number;
      lastSeq?: number;
      requestId?: string;
      decision?: ToolGateDecision;
      message?: string;
    };
    if (message.kind === "ack" && typeof message.seq === "number") {
      outbox.ack(message.seq);
      link?.write(encodeLine({ kind: "ack", seq: message.seq }));
      return;
    }
    if (message.kind === "nack" && typeof message.lastSeq === "number") {
      const resend = outbox.since(message.lastSeq);
      console.log(`[agent] nack lastSeq=${message.lastSeq}; resending ${resend.length} frames`);
      for (const entry of resend) sendFrame(entry);
      return;
    }
    if (message.kind === "gate_response" && typeof message.requestId === "string") {
      const answer: AgentToSupervisor = {
        kind: "gate_answer",
        requestId: message.requestId,
        decision: message.decision as ToolGateDecision,
      };
      pendingDialogs.delete(message.requestId);
      link?.write(encodeLine(answer));
      return;
    }
    if (message.kind === "error") {
      console.log(`[agent] server refused a message: ${String(message.message)}`);
    }
  });
  ws.addEventListener("close", () => {
    if (tunnel !== ws) return;
    tunnelOpen = false;
    tunnel = null;
    reconnects += 1;
    console.log(`[agent] tunnel closed; reconnecting in ${args.reconnectDelayMs}ms`);
    setTimeout(connectTunnel, args.reconnectDelayMs);
  });
  ws.addEventListener("error", () => {
    // `close` follows and owns the reconnect.
  });
}

async function readSupervisorPort(): Promise<number> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const port = Number(readFileSync(args.supervisorPortFile, "utf8").trim());
      if (Number.isSafeInteger(port) && port > 0) return port;
    } catch {
      // the supervisor has not written the port yet
    }
    await Bun.sleep(50);
  }
  throw new Error(`supervisor port file never appeared: ${args.supervisorPortFile}`);
}

const port = await readSupervisorPort();
connectTunnel();

link = connect({ host: args.supervisorHost, port }, () => {
  console.log(`[agent] supervisor link open`);
});
link.on("data", (chunk) => {
  const split = splitLines(linkBuffer, chunk.toString("utf8"));
  linkBuffer = split.rest;
  for (const line of split.lines) {
    const message = JSON.parse(line) as SupervisorToAgent;
    if (message.kind === "attached") {
      console.log(`[agent] attached acked=${message.acked} supervisor_last_seq=${message.lastSeq}`);
      continue;
    }
    if (message.kind === "gate_request") {
      pendingDialogs.set(message.requestId, { requestId: message.requestId, call: message.call });
      if (tunnelOpen) sendGateRequest(message);
      continue;
    }
    outbox.push({ seq: message.seq, frame: message.frame });
    if (tunnelOpen) sendFrame({ seq: message.seq, frame: message.frame });
  }
});
link.on("close", () => {
  console.log("[agent] supervisor link closed; exiting");
  process.exit(1);
});
link.on("error", (error) => {
  console.log(`[agent] supervisor link error: ${error.message}`);
});
