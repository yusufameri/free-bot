#!/usr/bin/env bun
/**
 * Host control plane for the MVP smoke dry run (U0.11). It is the composition point:
 *
 *  - the one seq log and the U0.7 tunnel protocol on `/tunnel` (frames with a seq, ack/nack,
 *    resume by `last_seen_seq`), persisted to frames.jsonl so a SIGKILL and restart bring back
 *    the same log;
 *  - U0.8's grant policy as the single gate for every tool call, with the ledger persisted to
 *    grants.jsonl;
 *  - the host->Pi gate-dialog path the landed tunnel lacks (spikes/forge-test-a follow-up 1):
 *    `gate_request` / `gate_response` travel on the same /tunnel socket as frames;
 *  - the U0.10 page served from here, over a dense display stream persisted to display.jsonl.
 *
 * Spike-local policy: a call the classifier marks destructive needs the page's answer (allow
 * mints a real grant, deny is a fail-closed denial); any other call is auto-granted and still
 * consumed through the real policy. Every decision lands in decisions.jsonl with its code.
 *
 * STUB DISCLOSURE: every model decision in this run is the keyless scripted stub served by
 * spikes/forge-test-a/stub-model.ts. No provider, no BYOK key, no live-model traffic; Gate G1
 * parks the keyed run.
 *
 * Deliberately incomplete: no auth (one agent, one page, localhost-only).
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
import { createGrantPolicy, GrantStore, loadGrantStore, saveGrantStore } from "@freebot/review";
import { commandOf, DisplayLog, initialMapperState, isDestructive, mapPiFrame } from "./display.ts";
import type { DisplayFrame } from "./envelope.ts";

const GOVERNED = ["bash", "write"] as const;
const GRANT_TTL_MS = 10 * 60_000;
const PAGE_TOPIC = "page";
const APPROVABLE = new Set(["no_grant", "grant_mismatch"]);

interface Args {
  port: number;
  framesPath: string;
  displayPath: string;
  decisionsPath: string;
  storePath: string;
  gateTimeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    port: 0,
    framesPath: "",
    displayPath: "",
    decisionsPath: "",
    storePath: "",
    gateTimeoutMs: 60_000,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined) break;
    switch (flag) {
      case "--port":
        args.port = Number(value);
        break;
      case "--frames":
        args.framesPath = value;
        break;
      case "--display":
        args.displayPath = value;
        break;
      case "--decisions":
        args.decisionsPath = value;
        break;
      case "--store":
        args.storePath = value;
        break;
      case "--gate-timeout-ms":
        args.gateTimeoutMs = Number(value);
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (args.port <= 0) throw new Error("--port is required");
  if (args.framesPath === "") throw new Error("--frames is required");
  if (args.displayPath === "") throw new Error("--display is required");
  if (args.decisionsPath === "") throw new Error("--decisions is required");
  if (args.storePath === "") throw new Error("--store is required");
  return args;
}

const args = parseArgs(Bun.argv.slice(2));
mkdirSync(dirname(args.framesPath), { recursive: true });

const store: GrantStore = existsSync(args.storePath)
  ? await loadGrantStore(args.storePath)
  : new GrantStore();
const gate = createGrantPolicy(store, { tools: GOVERNED });

const piLog = new SeqLog<PiInboundFrame>();
if (existsSync(args.framesPath)) {
  for (const line of readFileSync(args.framesPath, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = JSON.parse(line) as SeqFrame<PiInboundFrame>;
    const outcome = piLog.append(entry.seq, entry.frame);
    if (outcome !== "appended") throw new Error(`frames file does not reload cleanly: ${outcome}`);
  }
}

const displayLog = new DisplayLog(args.displayPath);
const mapper = initialMapperState();
// Rebuild the live mapper's facts from the durable logs: turn count and the toolCallId ->
// command map come back by re-running the pure mapping over the reloaded pi frames (output
// discarded; display.jsonl is authoritative for what the page saw); denials come from
// decisions.jsonl.
for (const entry of piLog.since(0)) mapPiFrame(entry.frame, mapper);

interface DecisionLine {
  at: number;
  requestId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  allow: boolean;
  code: string;
  reason: string;
  via: string;
  grantId: string | null;
}

const decisions: DecisionLine[] = [];
if (existsSync(args.decisionsPath)) {
  for (const line of readFileSync(args.decisionsPath, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as DecisionLine;
    decisions.push(parsed);
    if (!parsed.allow) mapper.denied.add(parsed.toolCallId);
  }
}

function decisionCode(decision: ToolGateDecision): string {
  if (decision.allow) return "allow";
  return decision.reason.match(/^([a-z_]+):/)?.[1] ?? "denied";
}

function recordDecision(line: DecisionLine): void {
  decisions.push(line);
  appendFileSync(args.decisionsPath, `${JSON.stringify(line)}\n`);
  console.log(
    `[composer] decision id=${line.requestId} tool=${line.toolName} call=${line.toolCallId} code=${line.code} via=${line.via}${line.reason === "" ? "" : ` reason=${line.reason}`}`,
  );
}

function emitDisplay(frame: Omit<DisplayFrame, "seq">): void {
  const full = displayLog.emit(frame);
  server.publish(PAGE_TOPIC, JSON.stringify(full));
}

function ingestPiFrame(frame: PiInboundFrame): void {
  if (frame.type === "agent_settled") {
    emitDisplay({ type: "stream_end", payload: {} });
    return;
  }
  const mapped = mapPiFrame(frame, mapper);
  if (mapped !== null) emitDisplay(mapped);
}

const pendingAnswers = new Map<string, (decision: "allow" | "deny") => void>();
const answered = new Map<string, ToolGateDecision>();

/** Wait for the page's answer. No answer inside the timeout resolves null (fail closed). */
function pageAnswer(approvalId: string, timeoutMs: number): Promise<"allow" | "deny" | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAnswers.delete(approvalId);
      resolve(null);
    }, timeoutMs);
    pendingAnswers.set(approvalId, (decision) => {
      clearTimeout(timer);
      pendingAnswers.delete(approvalId);
      resolve(decision);
    });
  });
}

async function handleGateRequest(
  requestId: string,
  call: ToolCallContext,
): Promise<ToolGateDecision> {
  const cached = answered.get(requestId);
  if (cached !== undefined) return cached;

  const handler = async (toolCall: ToolCallContext): Promise<ToolGateDecision> => {
    let via = "policy";
    let grantId: string | null = null;
    let decision: ToolGateDecision;
    if (!isDestructive(toolCall.toolName, toolCall.args)) {
      const issued = store.issue({
        toolName: toolCall.toolName,
        args: toolCall.args,
        ttlMs: GRANT_TTL_MS,
      });
      grantId = issued.id;
      via = "policy_auto_grant";
      decision = await gate(toolCall);
    } else {
      decision = await gate(toolCall);
      if (!decision.allow && APPROVABLE.has(decisionCode(decision))) {
        const approvalId = requestId;
        emitDisplay({
          type: "approval_request",
          payload: {
            approvalId,
            toolCallId: toolCall.toolCallId,
            command:
              mapper.commands.get(toolCall.toolCallId) ??
              commandOf(toolCall.toolName, toolCall.args),
          },
        });
        const answer = await pageAnswer(approvalId, args.gateTimeoutMs);
        if (answer === "allow") {
          const issued = store.issue({
            toolName: toolCall.toolName,
            args: toolCall.args,
            ttlMs: GRANT_TTL_MS,
          });
          grantId = issued.id;
          via = "page_allow_once";
          decision = await gate(toolCall);
        } else {
          decision = {
            allow: false,
            reason:
              answer === null
                ? `approval_timeout: no page answer within ${args.gateTimeoutMs}ms`
                : "user_denied: the page denied the approval card",
          };
          via = "page_deny";
        }
        emitDisplay({
          type: "approval_resolved",
          payload: { approvalId, decision: decision.allow ? "allow" : "deny" },
        });
      }
    }
    if (!decision.allow) mapper.denied.add(toolCall.toolCallId);
    recordDecision({
      at: Date.now(),
      requestId,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      args: toolCall.args,
      allow: decision.allow,
      code: decisionCode(decision),
      reason: decision.allow ? "" : decision.reason,
      via,
      grantId,
    });
    try {
      await saveGrantStore(store, args.storePath);
    } catch (error) {
      console.log(`[composer] store persist failed: ${messageOf(error)}`);
    }
    return decision;
  };

  const decision = await decideToolCall(handler, call);
  answered.set(requestId, decision);
  return decision;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function auditOf(): Record<string, unknown> {
  return {
    pi: piLog.audit(),
    display: displayLog.audit(),
    grants: store.grants(),
    decisions: decisions.map((line) => ({
      requestId: line.requestId,
      toolCallId: line.toolCallId,
      toolName: line.toolName,
      code: line.code,
      via: line.via,
      grantId: line.grantId,
    })),
    pendingApprovals: [...pendingAnswers.keys()],
  };
}

interface SocketData {
  role: "agent" | "page";
  resume: number;
}

const pageHtml = readFileSync(new URL("./page.html", import.meta.url).pathname, "utf8");
const build = await Bun.build({
  entrypoints: [new URL("./app.ts", import.meta.url).pathname],
  target: "browser",
  format: "esm",
});
if (!build.success) throw new Error(`page bundle failed:\n${build.logs.join("\n")}`);
const bundle = build.outputs[0];
if (bundle === undefined) throw new Error("page bundle produced no output");
const bundleJs = await bundle.text();

const server = Bun.serve<SocketData, Record<string, never>>({
  hostname: "127.0.0.1",
  port: args.port,
  async fetch(request, srv) {
    const url = new URL(request.url);
    if (url.pathname === "/tunnel" || url.pathname === "/events") {
      const requested = Number(url.searchParams.get("last_seen_seq") ?? "0");
      const data: SocketData = {
        role: url.pathname === "/tunnel" ? "agent" : "page",
        resume: Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0,
      };
      if (srv.upgrade(request, { data })) return undefined;
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    if (url.pathname === "/audit") return Response.json(auditOf());
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(pageHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/bundle.js") {
      return new Response(bundleJs, {
        headers: { "content-type": "application/javascript; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      if (ws.data.role === "agent") {
        console.log(
          `[composer] agent attached last_seen_seq=${ws.data.resume} log_last_seq=${piLog.lastSeq}`,
        );
        send(ws, { kind: "ack", seq: piLog.lastSeq });
        return;
      }
      console.log(
        `[composer] page attached last_seen_seq=${ws.data.resume} display_last_seq=${displayLog.lastSeq}`,
      );
      for (const frame of displayLog.since(ws.data.resume)) send(ws, frame);
      ws.subscribe(PAGE_TOPIC);
    },
    message(ws, message) {
      const text = typeof message === "string" ? message : message.toString("utf8");
      if (ws.data.role === "agent") {
        void onAgentMessage(ws, text);
        return;
      }
      const parsed = JSON.parse(text) as {
        type?: string;
        decision?: string;
        approvalId?: string;
      };
      if (parsed.type === "answer" && typeof parsed.approvalId === "string") {
        if (parsed.decision !== "allow" && parsed.decision !== "deny") return;
        console.log(
          `[composer] page answer approvalId=${parsed.approvalId} decision=${parsed.decision}`,
        );
        pendingAnswers.get(parsed.approvalId)?.(parsed.decision);
      }
    },
    close(ws) {
      if (ws.data.role === "agent") {
        console.log(`[composer] agent detached log_last_seq=${piLog.lastSeq}`);
      }
    },
  },
});

function send(
  ws: Bun.ServerWebSocket<SocketData>,
  message:
    | TunnelControlMessage
    | StreamMessage<PiInboundFrame>
    | DisplayFrame
    | Record<string, unknown>,
): void {
  ws.send(JSON.stringify(message));
}

function refuse(ws: Bun.ServerWebSocket<SocketData>, message: string): void {
  piLog.reject();
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
    const requestId = typeof envelope.requestId === "string" ? envelope.requestId : "";
    const call = envelope.call as ToolCallContext | undefined;
    const valid =
      requestId !== "" &&
      call !== undefined &&
      typeof call.toolCallId === "string" &&
      typeof call.toolName === "string";
    if (!valid) {
      console.log(`[composer] malformed gate request refused`);
      if (requestId !== "") {
        send(ws, {
          kind: "gate_response",
          requestId,
          decision: {
            allow: false,
            reason: "malformed_gate_request: the dialog carried no valid call",
          },
        });
      } else {
        refuse(ws, "malformed gate request");
      }
      return;
    }
    const decision = await handleGateRequest(requestId, call);
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
  const frame = envelope.frame as PiInboundFrame;
  const outcome = piLog.append(seq, frame);
  switch (outcome) {
    case "appended":
      appendFileSync(args.framesPath, `${JSON.stringify({ seq, frame })}\n`);
      ingestPiFrame(frame);
      send(ws, { kind: "ack", seq });
      return;
    case "duplicate":
      send(ws, { kind: "ack", seq: piLog.lastSeq });
      return;
    case "gap":
      send(ws, { kind: "nack", lastSeq: piLog.lastSeq });
      return;
    case "rejected":
      send(ws, { kind: "error", message: `not a seq: ${JSON.stringify(seq)}` });
      return;
  }
}

writeFileSync(`${args.decisionsPath}.ready`, `${Date.now()}\n`);
console.log(`[composer] listening port=${server.port}`);
console.log(
  `[composer] pi frames loaded n=${piLog.count} last_seq=${piLog.lastSeq}; display n=${displayLog.count} last_seq=${displayLog.lastSeq}; grants=${store.grants().length}`,
);
