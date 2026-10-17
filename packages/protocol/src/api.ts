/**
 * The control-plane API as an oRPC contract, built with `@orpc/contract` 1.15.7.
 *
 * This is the slice a server can implement and a client can call today: three unary run procedures
 * (`start_run`, `cancel_run`, `get_run`) and one subscription (`subscribe_events`) that yields the
 * log's messages in seq order. `dto.ts` stays the source of truth for the shapes it already owns;
 * this file wires those schemas into oRPC and adds only the shapes oRPC needs that did not exist.
 *
 * Auth is not here either. The token gate and the Origin/Host allowlist live in the Hono/Bun layer
 * (apps/server), because they are transport facts, not API facts. Nothing in this contract carries
 * a caller identity.
 *
 * Client context and `api.ts` consumers: a client built from `apiContract` infers every input and
 * output from these schemas, so a shape change here is a compile error over there. That is the
 * point of the file.
 */

import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { cancelRunInput, cancelRunOutput, startRunInput, startRunOutput } from "./dto.ts";
import { cursorSeqSchema, eventMessageSchema, runIdSchema, tsSchema } from "./envelope.ts";

/**
 * What the server injects into every call's context. `signal` is the transport's abort signal where
 * one exists (the WebSocket leg supplies one per connection), so a subscription can stop waiting on
 * a log append the moment its socket goes away.
 */
export type ApiContext = {
  signal: AbortSignal | undefined;
};

// ---------------------------------------------------------------------------
// Runs: what the contract reports about a run
// ---------------------------------------------------------------------------

/**
 * A run's state as the contract reports it. The three arms mirror the log exactly: a run is
 * `running` after `run.started`, and becomes `finished` or `failed` at the terminal event. There is
 * no `cancelled` arm because the v1 taxonomy has no cancelled kind: a cancel ends the run as
 * `failed` with a reason. If packages/protocol's run model (a sibling unit) lands its own state
 * enum, this one should be replaced by an import of it rather than kept in parallel.
 */
export const RUN_STATUSES = ["running", "finished", "failed"] as const;

export const runStatusSchema = z.enum(RUN_STATUSES);

export type RunStatus = z.infer<typeof runStatusSchema>;

export const getRunInput = z.strictObject({
  runId: runIdSchema,
});

/**
 * One run at read time. `lastSeq` is the log's head when the run was read, which is the watermark a
 * display resumes from, so a caller can read a run and then subscribe without a gap.
 */
export const getRunOutput = z.object({
  runId: runIdSchema,
  status: runStatusSchema,
  prompt: z.string(),
  startedAt: tsSchema,
  endedAt: tsSchema.nullable(),
  lastSeq: cursorSeqSchema,
});

export type GetRunInput = z.infer<typeof getRunInput>;
export type GetRunOutput = z.infer<typeof getRunOutput>;

// ---------------------------------------------------------------------------
// The event stream
// ---------------------------------------------------------------------------

/**
 * Subscribe from a watermark. The stream yields exactly the log's messages with `seq > lastSeq`, in
 * seq order, replaying what the log already holds before it goes live. `0` means "from the
 * beginning". The same counter serves `get_events` over HTTP, so a client may interleave both.
 */
export const subscribeEventsInput = z.strictObject({
  lastSeq: cursorSeqSchema,
});

export type SubscribeEventsInput = z.infer<typeof subscribeEventsInput>;

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/**
 * The contract router. Keys are the oRPC procedure names, which are also their paths.
 *
 * The seven operations `dto.ts` already declares beyond these four (`get_events`, `approve`, `deny`,
 * `list_files`, `read_file`) stay out until each has a handler; a contract arm with no implementation
 * would type a call the server cannot answer.
 */
export const apiContract = {
  start_run: oc.input(startRunInput).output(startRunOutput),
  cancel_run: oc.input(cancelRunInput).output(cancelRunOutput),
  get_run: oc.input(getRunInput).output(getRunOutput),
  subscribe_events: oc.input(subscribeEventsInput).output(eventIterator(eventMessageSchema)),
};

export type ApiContract = typeof apiContract;

/** The four procedure names, for a caller that needs to enumerate them. */
export const API_PROCEDURES = ["start_run", "cancel_run", "get_run", "subscribe_events"] as const;

export type ApiProcedure = (typeof API_PROCEDURES)[number];
