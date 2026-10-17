/**
 * The control-plane end of the tunnel: one event log, one seq, served over a WebSocket stream
 * (`/stream`), the agent leg (`/tunnel`), and a unary HTTP endpoint (`/events`).
 *
 * The log is the only place a seq becomes durable. Ingest is idempotent, so a reconnecting agent
 * may resend frames the log already holds (a lost ack leaves its window open) without ever
 * duplicating an entry; a gap is refused with `nack` so the agent resends from `lastSeq + 1`
 * rather than writing a hole.
 */

import {
  type SeqFrame,
  SeqLog,
  type StreamMessage,
  type TunnelControlMessage,
} from "@freebot/core";
import type { PiInboundFrame } from "@freebot/pi-bridge";
import { Hono } from "hono";
import { app } from "./app";

const CLIENT_TOPIC = "stream";

interface SocketData {
  role: "agent" | "client";
  /** The `last_seen_seq` this socket asked to resume from. */
  lastSeenSeq: number;
}

export interface TunnelServer {
  port: number;
  log: SeqLog<PiInboundFrame>;
  stop(): void;
}

function send(
  ws: Bun.ServerWebSocket<SocketData>,
  message: TunnelControlMessage | StreamMessage<PiInboundFrame>,
): void {
  ws.send(JSON.stringify(message));
}

function frameMessage(entry: SeqFrame<PiInboundFrame>): StreamMessage<PiInboundFrame> {
  return { kind: "frame", seq: entry.seq, frame: entry.frame };
}

export function startTunnelServer(options: { port?: number } = {}): TunnelServer {
  const log = new SeqLog<PiInboundFrame>();

  const http = new Hono();
  http.route("/", app);
  http.get("/events", (c) => {
    const requested = Number(c.req.query("last_seen_seq") ?? "0");
    const lastSeenSeq = Number.isFinite(requested) ? requested : 0;
    return c.json({
      last_seq: log.lastSeq,
      count: log.count,
      reply_is_exact: log.since(lastSeenSeq).length === Math.max(0, log.lastSeq - lastSeenSeq),
      frames: log.since(lastSeenSeq),
    });
  });
  http.get("/audit", (c) => c.json(log.audit()));

  const server = Bun.serve<SocketData, Record<string, never>>({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname !== "/tunnel" && url.pathname !== "/stream") return http.fetch(request);
      const requested = Number(url.searchParams.get("last_seen_seq") ?? "0");
      const lastSeenSeq = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
      const data: SocketData = {
        role: url.pathname === "/tunnel" ? "agent" : "client",
        lastSeenSeq,
      };
      if (srv.upgrade(request, { data })) return undefined;
      return new Response("expected a websocket upgrade", { status: 426 });
    },
    websocket: {
      open(ws) {
        if (ws.data.role === "agent") {
          console.log(
            `[tunnel] agent attached last_seen_seq=${ws.data.lastSeenSeq} log_last_seq=${log.lastSeq}`,
          );
          send(ws, { kind: "ack", seq: log.lastSeq });
          return;
        }
        console.log(
          `[stream] client attached last_seen_seq=${ws.data.lastSeenSeq} log_last_seq=${log.lastSeq}`,
        );
        send(ws, { kind: "hello", lastSeq: log.lastSeq });
        // Replay synchronously, then subscribe: nothing can slip between the two in one tick.
        for (const entry of log.since(ws.data.lastSeenSeq)) send(ws, frameMessage(entry));
        ws.subscribe(CLIENT_TOPIC);
      },
      message(ws, message) {
        if (ws.data.role !== "agent") return;
        onAgentMessage(ws, typeof message === "string" ? message : message.toString("utf8"));
      },
      close(ws) {
        if (ws.data.role === "agent") {
          console.log(`[tunnel] agent detached log_last_seq=${log.lastSeq}`);
        }
      },
    },
  });

  // Boundary parsing only: the frame's inner shape was validated by pi-bridge at the origin.
  function onAgentMessage(ws: Bun.ServerWebSocket<SocketData>, text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      refuse(ws, "malformed JSON");
      return;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("kind" in parsed) ||
      parsed.kind !== "frame"
    ) {
      refuse(ws, "not a frame envelope");
      return;
    }
    const envelope = parsed as { seq?: unknown; frame?: unknown };
    if (typeof envelope.seq !== "number" || !("frame" in envelope)) {
      refuse(ws, "envelope carries no seq or frame");
      return;
    }
    const seq = envelope.seq;
    const outcome = log.append(seq, envelope.frame as PiInboundFrame);
    switch (outcome) {
      case "appended":
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
        sendError(ws, `not a seq: ${JSON.stringify(seq)}`);
        return;
    }
  }

  function refuse(ws: Bun.ServerWebSocket<SocketData>, message: string): void {
    log.reject();
    sendError(ws, message);
  }

  function sendError(ws: Bun.ServerWebSocket<SocketData>, message: string): void {
    send(ws, { kind: "error", message });
  }

  return {
    port: server.port ?? 0,
    log,
    stop: () => server.stop(true),
  };
}
