/**
 * The documented U0.10 spike -> v1 mapping, as code.
 *
 * The spike's display envelope and the v1 taxonomy are different things on purpose (see the
 * mapping table in docs/protocol.md). This module is the adapter used by the compatibility test
 * and the replay demo, and it is the only place that knows both vocabularies; the contract in
 * `src/` does not mention the spike at all. Phase 1.5 retires it with the spike.
 *
 * Two things the mapping adds that the spike had no frame for: `run.started` opens the session,
 * and the stub-only `stream_end` terminal marker becomes the run boundary `run.finished`.
 * `tool_call.decision` is never synthesized here: the spike had no decision event, and inventing
 * one would make the compatibility claim weaker rather than stronger.
 */

import { canonicalActionHash } from "@freebot/review";
import type { DisplayFrame } from "../../../spikes/web-stream/envelope.ts";
import type { EventMessage } from "../src/index.ts";

export interface SpikeMapOptions {
  runId: string;
  /** The prompt the session ran; the spike's envelope carried none. */
  prompt: string;
  /** Clock for messages; the spike's frames carry no time. */
  startTs: number;
  /** Milliseconds added per emitted message, so a replay has a monotone clock. */
  stepMs: number;
  /** How long a parked approval waits for an answer. */
  answerWindowMs: number;
  /** How long the grant minted by an allow stays valid. */
  grantWindowMs: number;
  /** The canonical hash of the gated call, from `spikeActionHash`. */
  actionHash: string;
  /** The answer to fill into the spike's pending placeholder, if the caller wants it resolved. */
  answer?: "allow" | "deny";
}

export interface SpikeMapping {
  /** Every v1 message the session maps to, dense in seq from 1. */
  messages: EventMessage[];
  /** Pending `approval_resolved` placeholders: the pending state is `approval.requested` alone. */
  pendingCount: number;
}

/**
 * Map one recorded session. Seq is minted here, densely, in emission order: the spike's own
 * numbering is its own, and a dropped frame must not leave a hole in the v1 log.
 */
export function mapSpikeSession(
  frames: readonly DisplayFrame[],
  options: SpikeMapOptions,
): SpikeMapping {
  const messages: EventMessage[] = [];
  let pendingCount = 0;
  let seq = 0;
  let ts = options.startTs;

  const emit = (
    build: (fields: { seq: number; ts: number; runId: string }) => EventMessage,
  ): void => {
    seq += 1;
    messages.push(build({ seq, ts, runId: options.runId }));
    ts += options.stepMs;
  };

  emit(({ seq: s, ts: t, runId }) => ({
    v: 1,
    seq: s,
    ts: t,
    runId,
    type: "run.started",
    payload: { prompt: options.prompt },
  }));

  for (const frame of frames) {
    switch (frame.type) {
      case "turn_start":
        emit(({ seq: s, ts: t, runId }) => ({
          v: 1,
          seq: s,
          ts: t,
          runId,
          type: "turn.started",
          payload: { turn: frame.payload.turn },
        }));
        break;
      case "turn_end":
        emit(({ seq: s, ts: t, runId }) => ({
          v: 1,
          seq: s,
          ts: t,
          runId,
          type: "turn.ended",
          payload: { turn: frame.payload.turn },
        }));
        break;
      case "message_delta":
        emit(({ seq: s, ts: t, runId }) => ({
          v: 1,
          seq: s,
          ts: t,
          runId,
          type: "message.text.delta",
          payload: { text: frame.payload.text },
        }));
        break;
      case "tool_call":
        emit(({ seq: s, ts: t, runId }) => ({
          v: 1,
          seq: s,
          ts: t,
          runId,
          type: "tool_call.requested",
          payload: {
            toolCallId: frame.payload.toolCallId,
            toolName: frame.payload.toolName,
            command: frame.payload.command,
            destructive: frame.payload.destructive,
          },
        }));
        break;
      case "tool_result":
        emit(({ seq: s, ts: t, runId }) => ({
          v: 1,
          seq: s,
          ts: t,
          runId,
          type: "tool_call.result",
          payload: {
            toolCallId: frame.payload.toolCallId,
            ok: frame.payload.ok,
            denied: frame.payload.denied,
            output: frame.payload.output,
            durationMs: frame.payload.durationMs,
          },
        }));
        break;
      case "approval_request":
        emit(({ seq: s, ts: t, runId }) => ({
          v: 1,
          seq: s,
          ts: t,
          runId,
          type: "approval.requested",
          payload: {
            approvalId: frame.payload.approvalId,
            toolCallId: frame.payload.toolCallId,
            command: frame.payload.command,
            actionHash: options.actionHash,
            expiresAt: t + options.answerWindowMs,
          },
        }));
        break;
      case "approval_resolved": {
        const decision = options.answer ?? frame.payload.decision;
        if (decision === null) {
          pendingCount += 1;
          break;
        }
        emit(({ seq: s, ts: t, runId }) => ({
          v: 1,
          seq: s,
          ts: t,
          runId,
          type: "approval.resolved",
          payload:
            decision === "allow"
              ? {
                  approvalId: frame.payload.approvalId,
                  decision: "allow",
                  grant: {
                    grantId: `grant-${frame.payload.approvalId}`,
                    actionHash: options.actionHash,
                    expiresAt: t + options.grantWindowMs,
                    state: "issued",
                  },
                }
              : { approvalId: frame.payload.approvalId, decision: "deny" },
        }));
        break;
      }
      case "stream_end":
        emit(({ seq: s, ts: t, runId }) => ({
          v: 1,
          seq: s,
          ts: t,
          runId,
          type: "run.finished",
          payload: {},
        }));
        break;
      default: {
        // Every DisplayType has a case; a new spike frame type fails compilation here instead of
        // being silently unmapped.
        const unmapped: never = frame;
        throw new Error(`unmapped spike frame: ${JSON.stringify(unmapped)}`);
      }
    }
  }

  return { messages, pendingCount };
}

/**
 * The action hash of the spike's gated call, derived from the recorded command the way a real
 * gate would: `name + JSON(args)` is exactly how the spike rendered `command`.
 */
export function spikeActionHash(command: string, toolName: string): string {
  const json = command.slice(toolName.length).trim();
  return canonicalActionHash(toolName, JSON.parse(json) as unknown);
}
