#!/usr/bin/env bun
/**
 * Host-side composer for forge test A. It is the control plane in this spike: it owns the one
 * sequence log, the grant ledger, and the decision for every tool call. The in-VM gateway is an
 * untrusted reporter that may only ask; every answer here comes from U0.8's grant policy over a
 * real store, and every failure to answer is Pi's own fail-closed denial.
 *
 * It speaks the U0.7 tunnel protocol on `/tunnel` (frames with a seq, ack/nack, resume by
 * `last_seen_seq`) and carries the gate dialog on the same socket as `gate_request` /
 * `gate_response`. Frames and the ledger persist to JSONL outside every container mount, so a
 * SIGKILL and restart bring back the same log and the same ledger.
 *
 * `/control` is the harness-only lever (issue, rewind, forge, hold-next, state). It requires a
 * token minted by the harness; the token lives only in host memory and argv, never in a mount.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type SeqFrame,
  SeqLog,
  type StreamMessage,
  type TunnelControlMessage,
} from "@freebot/core";
import {
  decideToolCall,
  type PiInboundFrame,
  type ToolCallContext,
  type ToolGateDecision,
} from "@freebot/pi-bridge";
import {
  canonicalizeJson,
  createGrantPolicy,
  type GrantRecord,
  GrantStore,
  loadGrantStore,
  recomputeActionHash,
  saveGrantStore,
} from "@freebot/review";

const GOVERNED = ["bash", "write"] as const;
const CLIENT_TOPIC = "stream";

interface Args {
  portFile: string;
  storePath: string;
  framesPath: string;
  decisionsPath: string;
  controlToken: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    portFile: "",
    storePath: "",
    framesPath: "",
    decisionsPath: "",
    controlToken: "",
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined) break;
    switch (flag) {
      case "--port-file":
        args.portFile = value;
        break;
      case "--store":
        args.storePath = value;
        break;
      case "--frames":
        args.framesPath = value;
        break;
      case "--decisions":
        args.decisionsPath = value;
        break;
      case "--control-token":
        args.controlToken = value;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  for (const [name, value] of Object.entries(args)) {
    if (value === "")
      throw new Error(`--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  return args;
}

const args = parseArgs(Bun.argv.slice(2));
mkdirSync(dirname(args.portFile), { recursive: true });

let store: GrantStore = existsSync(args.storePath)
  ? await loadGrantStore(args.storePath)
  : new GrantStore();
let gate = createGrantPolicy(store, { tools: GOVERNED });

const log = new SeqLog<PiInboundFrame>();
if (existsSync(args.framesPath)) {
  for (const line of readFileSync(args.framesPath, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = JSON.parse(line) as SeqFrame<PiInboundFrame>;
    const outcome = log.append(entry.seq, entry.frame);
    if (outcome !== "appended") throw new Error(`frames file does not reload cleanly: ${outcome}`);
  }
}

const answered = new Map<string, ToolGateDecision>();
let held: { requestId: string; call: ToolCallContext } | null = null;
let holdArmed = false;
let throwArmed = false;

function decisionCode(decision: ToolGateDecision): string {
  if (decision.allow) return "allow";
  return decision.reason.match(/^([a-z_]+):/)?.[1] ?? "denied";
}

/** Persist the ledger, then hand back the decision. A persisted unmount is not worth a lie. */
async function decide(id: string, call: ToolCallContext): Promise<ToolGateDecision> {
  let target = gate;
  if (throwArmed) {
    throwArmed = false;
    target = (): never => {
      throw new Error("simulated policy explosion (host producer threw)");
    };
  }
  const decision = await decideToolCall(target, call);
  const code = decisionCode(decision);
  appendFileSync(
    args.decisionsPath,
    `${JSON.stringify({
      at: Date.now(),
      requestId: id,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      args: call.args,
      allow: decision.allow,
      code,
      reason: decision.allow ? "" : decision.reason,
    })}\n`,
  );
  try {
    await saveGrantStore(store, args.storePath);
  } catch (error) {
    console.log(`[composer] store persist failed: ${messageOf(error)}`);
  }
  console.log(
    `[composer] decision id=${id} tool=${call.toolName} code=${code}${decision.allow ? "" : ` reason=${decision.reason}`}`,
  );
  return decision;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stateOf(): Record<string, unknown> {
  const lines = existsSync(args.decisionsPath)
    ? readFileSync(args.decisionsPath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
    : [];
  const parsed = lines.map((line) => JSON.parse(line) as { allow: boolean });
  return {
    grants: store.grants(),
    decisions: parsed.length,
    allows: parsed.filter((entry) => entry.allow).length,
    held: held?.requestId ?? null,
    answered: answered.size,
  };
}

async function control(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const op = body.op;
  if (op === "issue") {
    const issued = store.issue({
      toolName: String(body.toolName),
      args: body.args,
      ttlMs: Number(body.ttlMs),
      ...(typeof body.now === "number" ? { now: body.now } : {}),
    });
    await saveGrantStore(store, args.storePath);
    return { grantId: issued.id, seq: issued.seq, actionHash: issued.actionHash };
  }
  if (op === "rewind") {
    const affected = store.rewind(Number(body.seq), String(body.reason));
    await saveGrantStore(store, args.storePath);
    return { tombstoned: affected.map((grant) => grant.id) };
  }
  if (op === "forge") {
    const current = store.current(String(body.grantId));
    if (current === undefined) return { ok: false, error: `no grant ${String(body.grantId)}` };
    const tampered: GrantRecord = {
      ...current,
      normalizedArgs: canonicalizeJson(body.args),
    };
    appendFileSync(args.storePath, `${JSON.stringify(tampered)}\n`);
    store = await loadGrantStore(args.storePath);
    gate = createGrantPolicy(store, { tools: GOVERNED });
    return {
      ok: true,
      grantId: tampered.id,
      storedHash: tampered.actionHash,
      recomputedHash: recomputeActionHash(tampered),
    };
  }
  if (op === "hold-next") {
    holdArmed = true;
    return { armed: true };
  }
  if (op === "throw-next") {
    throwArmed = true;
    return { armed: true };
  }
  if (op === "state") return stateOf();
  return { error: `unknown op ${String(op)}` };
}

interface SocketData {
  role: "agent" | "client";
  resume: number;
}

const server = Bun.serve<SocketData, Record<string, never>>({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, srv) {
    const url = new URL(request.url);
    if (url.pathname === "/tunnel" || url.pathname === "/stream") {
      const requested = Number(url.searchParams.get("last_seen_seq") ?? "0");
      const data: SocketData = {
        role: url.pathname === "/tunnel" ? "agent" : "client",
        resume: Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0,
      };
      if (srv.upgrade(request, { data })) return undefined;
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    if (url.pathname === "/audit") return Response.json(log.audit());
    if (url.pathname === "/events") {
      const requested = Number(url.searchParams.get("last_seen_seq") ?? "0");
      const lastSeenSeq = Number.isFinite(requested) ? requested : 0;
      return Response.json({
        last_seq: log.lastSeq,
        count: log.count,
        frames: log.since(lastSeenSeq),
      });
    }
    if (url.pathname === "/control" && request.method === "POST") {
      if (request.headers.get("x-forge-control") !== args.controlToken) {
        return new Response("forbidden", { status: 403 });
      }
      const body = (await request.json()) as Record<string, unknown>;
      console.log(`[composer] control op=${String(body.op)}`);
      const result = await control(body);
      return Response.json(result);
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const resume = ws.data.resume;
      if (ws.data.role === "agent") {
        console.log(
          `[composer] agent attached last_seen_seq=${resume} log_last_seq=${log.lastSeq}`,
        );
        send(ws, { kind: "ack", seq: log.lastSeq });
        return;
      }
      send(ws, { kind: "hello", lastSeq: log.lastSeq });
      for (const entry of log.since(resume)) {
        send(ws, { kind: "frame", seq: entry.seq, frame: entry.frame });
      }
      ws.subscribe(CLIENT_TOPIC);
    },
    message(ws, message) {
      const text = typeof message === "string" ? message : message.toString("utf8");
      if (ws.data.role === "agent") void onAgentMessage(ws, text);
    },
    close(ws) {
      if (ws.data.role === "agent") {
        console.log(`[composer] agent detached log_last_seq=${log.lastSeq}`);
      }
    },
  },
});

function send(
  ws: Bun.ServerWebSocket<SocketData>,
  message: TunnelControlMessage | StreamMessage<PiInboundFrame> | Record<string, unknown>,
): void {
  ws.send(JSON.stringify(message));
}

function refuse(ws: Bun.ServerWebSocket<SocketData>, message: string): void {
  log.reject();
  send(ws, { kind: "error", message });
}

async function onAgentMessage(ws: Bun.ServerWebSocket<SocketData>, text: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    refuse(ws, "malformed JSON");
    return;
  }
  if (typeof parsed !== "object" || parsed === null || !("kind" in parsed)) {
    refuse(ws, "not an envelope");
    return;
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.kind === "gate_request") {
    const requestId = String(envelope.requestId);
    const call = envelope.call as ToolCallContext;
    if (holdArmed) {
      holdArmed = false;
      held = { requestId, call };
      console.log(`[composer] held id=${requestId} tool=${call.toolName}`);
      return;
    }
    const cached = answered.get(requestId);
    if (cached !== undefined) {
      send(ws, { kind: "gate_response", requestId, decision: cached });
      return;
    }
    console.log(`[composer] gate_request id=${requestId} tool=${call.toolName}`);
    const decision = await decide(requestId, call);
    answered.set(requestId, decision);
    send(ws, { kind: "gate_response", requestId, decision });
    return;
  }
  if (envelope.kind !== "frame") {
    refuse(ws, "not a frame envelope");
    return;
  }
  if (typeof envelope.seq !== "number" || !("frame" in envelope)) {
    refuse(ws, "envelope carries no seq or frame");
    return;
  }
  const seq = envelope.seq;
  const outcome = log.append(seq, envelope.frame as PiInboundFrame);
  switch (outcome) {
    case "appended":
      appendFileSync(args.framesPath, `${JSON.stringify({ seq, frame: envelope.frame })}\n`);
      server.publish(CLIENT_TOPIC, JSON.stringify({ kind: "frame", seq, frame: envelope.frame }));
      send(ws, { kind: "ack", seq });
      return;
    case "duplicate":
      send(ws, { kind: "ack", seq: log.lastSeq });
      return;
    case "gap":
      send(ws, { kind: "nack", lastSeq: log.lastSeq });
      return;
    case "rejected":
      send(ws, { kind: "error", message: `not a seq: ${JSON.stringify(seq)}` });
      return;
  }
}

const port = server.port ?? 0;
writeFileSync(args.portFile, `${port}\n`);
console.log(`[composer] listening port=${port}`);
console.log(
  `[composer] frames loaded n=${log.count} last_seq=${log.lastSeq} store grants=${store.grants().length}`,
);
