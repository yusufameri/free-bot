/**
 * The loopback link between the in-VM supervisor and the tunnel agent, extended for this spike
 * (U0.11) with the host->Pi gate-dialog carriage that apps/sandbox-agent's landed link lacks.
 *
 * Copied-with-attribution from apps/sandbox-agent/src/link.ts (U0.7). The only additions are
 * `gate_request` (supervisor -> agent) and `gate_answer` (agent -> supervisor); every other
 * message and the JSONL split behavior are unchanged. The dialog is the U0.3 tool-gate seam: an
 * `input` dialog whose placeholder carries the call, answered with a serialized decision.
 */

import type { SeqFrame } from "@freebot/core";
import type { PiInboundFrame, ToolCallContext, ToolGateDecision } from "@freebot/pi-bridge";

/** Supervisor -> agent. */
export type SupervisorToAgent =
  | { kind: "attached"; acked: number; lastSeq: number }
  | { kind: "frame"; seq: number; frame: PiInboundFrame }
  | { kind: "gate_request"; requestId: string; call: ToolCallContext };

/** Agent -> supervisor. */
export type AgentToSupervisor =
  | { kind: "ack"; seq: number }
  | { kind: "gate_answer"; requestId: string; decision: ToolGateDecision };

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
