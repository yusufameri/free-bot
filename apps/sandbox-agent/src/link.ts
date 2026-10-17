/**
 * The loopback link between the supervisor (which owns Pi and mints seqs) and the tunnel agent
 * (which forwards them to the control plane). JSONL over TCP inside the sandbox.
 *
 * The supervisor is the source of truth for both ends of the link: `attached` tells a fresh or
 * rejoining agent where the server's durable watermark is, and the frames after it follow
 * immediately, so a replaced agent can never renumber or skip a frame.
 */

import type { SeqFrame } from "@freebot/core";
import type { PiInboundFrame } from "@freebot/pi-bridge";

/** Supervisor -> agent. */
export type SupervisorToAgent =
  | { kind: "attached"; acked: number; lastSeq: number }
  | { kind: "frame"; seq: number; frame: PiInboundFrame };

/** Agent -> supervisor. */
export type AgentToSupervisor = { kind: "ack"; seq: number };

export function encodeLine(message: SupervisorToAgent | AgentToSupervisor): string {
  return `${JSON.stringify(message)}\n`;
}

/** One JSONL line per call; a trailing partial line stays in the buffer for the next chunk. */
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  let rest = buffer + chunk;
  const lines: string[] = [];
  let newline = rest.indexOf("\n");
  while (newline !== -1) {
    const line = rest.slice(0, newline);
    rest = rest.slice(newline + 1);
    if (line.trim().length > 0) lines.push(line);
    newline = rest.indexOf("\n");
  }
  return { lines, rest };
}

export type LinkFrame = SeqFrame<PiInboundFrame>;
