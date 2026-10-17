/**
 * The v1 envelope: one shape, one seq, minted once by the origin.
 *
 * Every log-ordered message is `{v, seq, ts, runId, type, payload}`. The origin that reads the
 * source of truth (the sandbox supervisor reading Pi, per packages/core `tunnel.ts`) stamps the
 * seq; every transport then *reads* the one log, so oRPC and WebSocket can never mint competing
 * counters. `seq` is the message's own place in that log, starts at 1, and is never reused.
 *
 * Stream markers (`stream.*`) are the exception that proves the rule: they address log positions
 * instead of owning one, so they carry `v` but no `seq`, and they never enter the log. Giving a
 * marker a fabricated seq is how a second counter starts.
 *
 * Unknown-key policy: strip. `z.object` drops keys the schema does not name, so a producer that
 * adds a field in v1.x cannot break a v1 reader, and a producer cannot smuggle extra keys into a
 * display layer. The version tag, not strictness, is the compatibility boundary; the DTO inputs
 * in `dto.ts` are strict because an unknown key in a command is a caller bug. See docs/protocol.md.
 */

import { z } from "zod";
import { EVENT_PAYLOADS, STREAM_PAYLOADS } from "./events.ts";

/** Stable wire version. Any breaking change to an envelope or payload shape bumps this literal. */
export const PROTOCOL_VERSION = 1;

export const versionSchema = z.literal(PROTOCOL_VERSION);

/** A message's own place in the one log. Starts at 1; 0 is a reader's cursor, never a message. */
export const messageSeqSchema = z.number().int().positive();

/** A reader's watermark: how far it has consumed. 0 means "nothing yet". */
export const cursorSeqSchema = z.number().int().nonnegative();

/** Epoch milliseconds, minted by the origin together with the seq. */
export const tsSchema = z.number().int().positive();

/** The run a message belongs to. The run id is minted by start_run. */
export const runIdSchema = z.string().min(1);

const envelopeFields = {
  v: versionSchema,
  seq: messageSeqSchema,
  ts: tsSchema,
};

const runScoped = <const K extends keyof typeof EVENT_PAYLOADS>(
  type: K,
  payload: (typeof EVENT_PAYLOADS)[K],
) =>
  z.object({
    ...envelopeFields,
    runId: runIdSchema,
    type: z.literal(type),
    payload,
  });

const streamScoped = <const K extends keyof typeof STREAM_PAYLOADS>(
  type: K,
  payload: (typeof STREAM_PAYLOADS)[K],
) =>
  z.object({
    v: versionSchema,
    type: z.literal(type),
    payload,
  });

// ---------------------------------------------------------------------------
// Run-scoped messages: one per kind in the taxonomy
// ---------------------------------------------------------------------------

export const runStartedMessage = runScoped("run.started", EVENT_PAYLOADS["run.started"]);
export const runFinishedMessage = runScoped("run.finished", EVENT_PAYLOADS["run.finished"]);
export const runFailedMessage = runScoped("run.failed", EVENT_PAYLOADS["run.failed"]);
export const runStatusMessage = runScoped("run.status", EVENT_PAYLOADS["run.status"]);
export const turnStartedMessage = runScoped("turn.started", EVENT_PAYLOADS["turn.started"]);
export const turnEndedMessage = runScoped("turn.ended", EVENT_PAYLOADS["turn.ended"]);
export const messageTextDeltaMessage = runScoped(
  "message.text.delta",
  EVENT_PAYLOADS["message.text.delta"],
);
export const toolCallRequestedMessage = runScoped(
  "tool_call.requested",
  EVENT_PAYLOADS["tool_call.requested"],
);
export const toolCallDecisionMessage = runScoped(
  "tool_call.decision",
  EVENT_PAYLOADS["tool_call.decision"],
);
export const toolCallResultMessage = runScoped(
  "tool_call.result",
  EVENT_PAYLOADS["tool_call.result"],
);
export const approvalRequestedMessage = runScoped(
  "approval.requested",
  EVENT_PAYLOADS["approval.requested"],
);
export const approvalResolvedMessage = runScoped(
  "approval.resolved",
  EVENT_PAYLOADS["approval.resolved"],
);
export const grantLifecycleMessage = runScoped(
  "grant.lifecycle",
  EVENT_PAYLOADS["grant.lifecycle"],
);

const eventMessages = [
  runStartedMessage,
  runFinishedMessage,
  runFailedMessage,
  runStatusMessage,
  turnStartedMessage,
  turnEndedMessage,
  messageTextDeltaMessage,
  toolCallRequestedMessage,
  toolCallDecisionMessage,
  toolCallResultMessage,
  approvalRequestedMessage,
  approvalResolvedMessage,
  grantLifecycleMessage,
] as const;

/** Every run-scoped message: the log's contents, dense in seq, one kind per entry. */
export const eventMessageSchema = z.discriminatedUnion("type", eventMessages);

export type EventMessage = z.infer<typeof eventMessageSchema>;

// ---------------------------------------------------------------------------
// Stream markers
// ---------------------------------------------------------------------------

export const streamHelloMessage = streamScoped("stream.hello", STREAM_PAYLOADS["stream.hello"]);
export const streamResumedMessage = streamScoped(
  "stream.resumed",
  STREAM_PAYLOADS["stream.resumed"],
);
export const streamGapMessage = streamScoped("stream.gap", STREAM_PAYLOADS["stream.gap"]);

/** Markers a stream reports about itself. Never logged, never seq-stamped. */
export const streamMessageSchema = z.discriminatedUnion("type", [
  streamHelloMessage,
  streamResumedMessage,
  streamGapMessage,
] as const);

export type StreamMessage = z.infer<typeof streamMessageSchema>;

// ---------------------------------------------------------------------------
// Parse and serialize
// ---------------------------------------------------------------------------

/** Everything a transport can put on the wire. */
export const messageSchema = z.discriminatedUnion("type", [
  ...eventMessages,
  streamHelloMessage,
  streamResumedMessage,
  streamGapMessage,
] as const);

export type Message = z.infer<typeof messageSchema>;

/** Parse one wire message. Throws ZodError on anything outside v1; strips unnamed keys. */
export function parseMessage(value: unknown): Message {
  return messageSchema.parse(value);
}

/** The non-throwing form, for boundaries that must refuse rather than crash. */
export function safeParseMessage(value: unknown): z.ZodSafeParseResult<Message> {
  return messageSchema.safeParse(value);
}

/**
 * Serialize one message. `seq` is the log's order, not the JSON's; a reader orders by seq, never
 * by arrival.
 */
export function serializeMessage(message: Message): string {
  return JSON.stringify(message);
}
