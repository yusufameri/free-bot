/**
 * The control-plane API as an oRPC contract, built with `@orpc/contract` 1.15.7.
 *
 * This is the slice a server can implement and a client can call today: three unary run procedures
 * (`start_run`, `cancel_run`, `get_run`), one subscription (`subscribe_events`) that yields the
 * named thread's log in seq order, the two records a run belongs to (`list_bots`, `create_bot`,
 * `list_threads`, `create_thread`), and the workspace's two reads (`list_files`, `read_file`).
 * `dto.ts` stays the source of truth for the shapes it already owns; this file wires those schemas
 * into oRPC and adds only the shapes oRPC needs that did not exist.
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
import {
  cancelRunInput,
  cancelRunOutput,
  createBotInput,
  createBotOutput,
  createThreadInput,
  createThreadOutput,
  listBotsInput,
  listBotsOutput,
  listFilesInput,
  listFilesOutput,
  listThreadsInput,
  listThreadsOutput,
  readFileInput,
  readFileOutput,
  startRunInput,
  startRunOutput,
  threadIdSchema,
  type WorkspaceReadRefusal,
} from "./dto.ts";
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
 *
 * The subscription names the thread it is watching, because a log belongs to a thread: one log per
 * thread is what makes a conversation's seq space its own, and what lets the page show one
 * conversation at a time. Each thread's seq starts at 1, so a cursor is only meaningful with it.
 */
export const subscribeEventsInput = z.strictObject({
  threadId: threadIdSchema,
  lastSeq: cursorSeqSchema,
});

export type SubscribeEventsInput = z.infer<typeof subscribeEventsInput>;

// ---------------------------------------------------------------------------
// Workspace files
// ---------------------------------------------------------------------------

/**
 * The two refusals the Bot and thread arms raise, each with the status the wire answers with. A
 * caller that names a Bot or a thread the server does not hold is told which one, by name, rather
 * than getting an empty list back that reads as "this Bot has no threads".
 */
export const BOT_ERRORS = {
  bot_not_found: { status: 404, message: "no such Bot" },
  thread_not_found: { status: 404, message: "no such thread" },
} as const;

export type BotRefusal = keyof typeof BOT_ERRORS;

/**
 * The named refusals a `list_files` or `read_file` call can end in, each with the status the wire
 * answers with. The code IS the refusal name, so a surface branches on `error.code` rather than
 * matching a sentence. These are error codes oRPC does not know, so they are declared here; the
 * router also reads this table for the status an error it raises carries, because a code oRPC does
 * not know would otherwise answer 500 and read as a server fault instead of a refused path.
 */
export const WORKSPACE_READ_ERRORS = {
  absolute_path: { status: 400, message: "path is absolute; every path is relative to /workspace" },
  parent_traversal: { status: 400, message: "path contains a .. segment" },
  symlink_escape: { status: 403, message: "the path resolves outside /workspace" },
  path_not_found: { status: 404, message: "no such path under /workspace" },
  not_a_directory: { status: 400, message: "the path is not a directory" },
  not_a_file: { status: 400, message: "the path is not a file" },
  binary_file: { status: 415, message: "the file is not UTF-8 text" },
} as const satisfies Record<WorkspaceReadRefusal, { status: number; message: string }>;

/**
 * List one directory of a Bot's workspace, or read one file from it. Both read the named Bot's own
 * directory on the host, which is the path its container sees as `/workspace`, so what comes back is
 * what that Bot's computer wrote rather than a copy taken at some other time. The Bot is named on
 * every call: the workspace is per Bot, so a read without one would be a read of a Bot nobody named.
 */
export const listFilesProcedure = oc
  .input(listFilesInput)
  .output(listFilesOutput)
  .errors({ ...WORKSPACE_READ_ERRORS, ...BOT_ERRORS });

export const readFileProcedure = oc
  .input(readFileInput)
  .output(readFileOutput)
  .errors({ ...WORKSPACE_READ_ERRORS, ...BOT_ERRORS });

const listBotsProcedure = oc.input(listBotsInput).output(listBotsOutput).errors(BOT_ERRORS);

const createBotProcedure = oc.input(createBotInput).output(createBotOutput).errors(BOT_ERRORS);

const listThreadsProcedure = oc
  .input(listThreadsInput)
  .output(listThreadsOutput)
  .errors(BOT_ERRORS);

const createThreadProcedure = oc
  .input(createThreadInput)
  .output(createThreadOutput)
  .errors(BOT_ERRORS);

const startRunProcedure = oc.input(startRunInput).output(startRunOutput).errors(BOT_ERRORS);

const subscribeEventsProcedure = oc
  .input(subscribeEventsInput)
  .output(eventIterator(eventMessageSchema))
  .errors(BOT_ERRORS);

const getRunProcedure = oc.input(getRunInput).output(getRunOutput).errors(BOT_ERRORS);

export type ListFilesOutput = z.infer<typeof listFilesOutput>;
export type ReadFileOutput = z.infer<typeof readFileOutput>;

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/**
 * The contract router. Keys are the oRPC procedure names, which are also their paths.
 *
 * A Bot is a record, a thread is a record, and a run belongs to both: `list_bots` and `list_threads`
 * are how a surface learns the two ids a run needs, and `create_bot` and `create_thread` are how it
 * makes them. No arm infers a Bot or a thread from context, because the two ids are what the run
 * path is keyed by.
 *
 * The operations `dto.ts` declares beyond these (`get_events`, `approve`, `deny`) stay out until
 * each has a handler; a contract arm with no implementation would type a call the server cannot
 * answer.
 */
export const apiContract = {
  start_run: startRunProcedure,
  cancel_run: oc.input(cancelRunInput).output(cancelRunOutput),
  get_run: getRunProcedure,
  subscribe_events: subscribeEventsProcedure,
  list_bots: listBotsProcedure,
  create_bot: createBotProcedure,
  list_threads: listThreadsProcedure,
  create_thread: createThreadProcedure,
  list_files: listFilesProcedure,
  read_file: readFileProcedure,
};

export type ApiContract = typeof apiContract;

/** Every procedure name, for a caller that needs to enumerate them. */
export const API_PROCEDURES = [
  "start_run",
  "cancel_run",
  "get_run",
  "subscribe_events",
  "list_bots",
  "create_bot",
  "list_threads",
  "create_thread",
  "list_files",
  "read_file",
] as const;

export type ApiProcedure = (typeof API_PROCEDURES)[number];
