/**
 * The Phase 1 oRPC contract, as zod shapes. `@orpc/contract` is not installed yet, so these are
 * plain object schemas; wiring them through oRPC's contract builder is a follow-up that changes
 * no shape here.
 *
 * Inputs are strict: an unknown key in a command is a caller bug and refuses. Outputs reuse the
 * envelope's event schema rather than restating it. Every path is pinned under `/workspace`;
 * there is no absolute path and no `..` segment in the contract at all.
 *
 * Auth is not in the protocol. The localhost token and the Origin/Host allowlist sit in the Hono
 * layer per plan 2.7; the DTOs carry no caller identity.
 */

import { z } from "zod";
import { cursorSeqSchema, eventMessageSchema, runIdSchema, tsSchema } from "./envelope.ts";
import { runStatusValueSchema } from "./events.ts";

/** The one filesystem root the API addresses. */
export const WORKSPACE_ROOT = "/workspace";

/**
 * A Bot id or a thread id. Both are path segments in the operator's own filesystem: a Bot's
 * workspace directory and a thread's run journal are named by their id, so the contract refuses an
 * id that is not one segment, before any handler turns it into a path.
 */
const idSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "an id is lower-case letters, digits and dashes");

/** The id of one Bot. It keys the Bot's workspace directory. */
export const botIdSchema = idSchema;

/** The id of one thread. It keys the thread's run journal. */
export const threadIdSchema = idSchema;

/** The longest name a Bot can carry. The sidebar renders it in one row. */
export const BOT_NAME_MAX = 60;

/** The longest title a thread can carry. The thread list renders it in one row. */
export const THREAD_TITLE_MAX = 120;

/** A path relative to `WORKSPACE_ROOT`: no leading slash, no `..` segment, not empty. */
export const workspacePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) => !path.startsWith("/") && !path.split("/").includes(".."),
    "path must be relative to /workspace without .. segments",
  );

/** Upper bound on one `get_events` page, so one read cannot pull an unbounded log. */
export const GET_EVENTS_MAX_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Runs: the async model
// ---------------------------------------------------------------------------

/**
 * Begin a run. The prompt becomes `run.started.payload.prompt`, so a replayed log is
 * self-describing. The response returns before the run does anything: the run's progress arrives
 * as events, and `run.finished` / `run.failed` end it.
 *
 * A run names the Bot it belongs to and the thread it appends to, and both records exist before
 * this call returns: the service refuses a Bot or thread it does not hold rather than minting one
 * behind the caller's back. Two runs in one thread are two runs of one conversation.
 */
export const startRunInput = z.strictObject({
  prompt: z.string().min(1),
  botId: botIdSchema,
  threadId: threadIdSchema,
});

export const startRunOutput = z.object({
  runId: runIdSchema,
});

/**
 * Ask the run to stop. Cancellation is cooperative: the request is delivered, the sandbox
 * supervisor stops feeding Pi, and the run ends with `run.finished` or `run.failed` on the
 * stream. A second cancel for the same run is not an error the client must handle.
 */
export const cancelRunInput = z.strictObject({
  runId: runIdSchema,
});

export const cancelRunOutput = z.object({
  runId: runIdSchema,
});

/**
 * Read the log after a watermark. `lastSeq: 0` asks from the beginning; the response is dense,
 * every message in the answer has `seq > lastSeq`, and `lastSeq` names the log's head at read
 * time. The same counter serves the WebSocket, so a client may interleave both.
 */
export const getEventsInput = z.strictObject({
  lastSeq: cursorSeqSchema,
  limit: z.number().int().positive().max(GET_EVENTS_MAX_LIMIT).optional(),
});

export const getEventsOutput = z.object({
  messages: z.array(eventMessageSchema),
  lastSeq: cursorSeqSchema,
});

// ---------------------------------------------------------------------------
// Approvals: allow once or deny
// ---------------------------------------------------------------------------

/** Allow once: the gate issues a grant bound to the request's action hash and consumes it. */
export const approveInput = z.strictObject({
  approvalId: z.string().min(1),
});

export const approveOutput = z.object({
  approvalId: z.string().min(1),
  decision: z.literal("allow"),
});

/** Deny: no grant is issued, the parked call is failed with a denial result. */
export const denyInput = z.strictObject({
  approvalId: z.string().min(1),
});

export const denyOutput = z.object({
  approvalId: z.string().min(1),
  decision: z.literal("deny"),
});

// ---------------------------------------------------------------------------
// Bots and threads: the two records a run belongs to
// ---------------------------------------------------------------------------

/**
 * One Bot as the contract reports it. `threadCount` is what the sidebar shows beside the name, and
 * it is computed from the thread records rather than stored, so the two can never disagree.
 */
export const botSchema = z.object({
  botId: botIdSchema,
  name: z.string().min(1),
  createdAt: tsSchema,
  threadCount: z.number().int().nonnegative(),
});

export type Bot = z.infer<typeof botSchema>;

/**
 * One run as the thread's history reports it: what the conversation was asked, and where it got to.
 * The status is the seven-value model the stream already carries in `run.status` payloads.
 */
export const runSummarySchema = z.object({
  runId: runIdSchema,
  prompt: z.string(),
  status: runStatusValueSchema,
  startedAt: tsSchema,
});

export type RunSummary = z.infer<typeof runSummarySchema>;

/**
 * One thread and the conversation in it. A thread holds many runs and lasts: it is not recreated per
 * run, and its `runs` are the record that survives a restart. This is what the thread list renders,
 * and what the restart evidence reads back before and after the server stops.
 */
export const threadSchema = z.object({
  threadId: threadIdSchema,
  botId: botIdSchema,
  title: z.string().min(1),
  createdAt: tsSchema,
  runs: z.array(runSummarySchema),
});

export type Thread = z.infer<typeof threadSchema>;

/** Every Bot, in creation order. */
export const listBotsInput = z.strictObject({});

export const listBotsOutput = z.object({
  bots: z.array(botSchema),
});

/**
 * Create a Bot. The id is minted by the server, because the id is the key of the Bot's workspace
 * directory and two callers that both picked one would collide on the filesystem.
 */
export const createBotInput = z.strictObject({
  name: z.string().min(1).max(BOT_NAME_MAX),
});

export const createBotOutput = botSchema;

export const listThreadsInput = z.strictObject({
  botId: botIdSchema,
});

export const listThreadsOutput = z.object({
  threads: z.array(threadSchema),
});

/** Create a thread in a Bot. A title is optional; the thread list shows it when there is one. */
export const createThreadInput = z.strictObject({
  botId: botIdSchema,
  title: z.string().min(1).max(THREAD_TITLE_MAX).optional(),
});

export const createThreadOutput = threadSchema;

// ---------------------------------------------------------------------------
// /workspace files
// ---------------------------------------------------------------------------

export const fileKindSchema = z.enum(["file", "dir"]);

export const fileEntrySchema = z.object({
  /** Base name, for display. */
  name: z.string().min(1),
  /** Path relative to `WORKSPACE_ROOT`. */
  path: workspacePathSchema,
  kind: fileKindSchema,
  /** Bytes; 0 for a directory. */
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().int().nonnegative(),
});

export type FileEntry = z.infer<typeof fileEntrySchema>;

/** List one directory of a Bot's workspace. The default `"."` is the workspace root. */
export const listFilesInput = z.strictObject({
  botId: botIdSchema,
  path: workspacePathSchema.default("."),
});

export const listFilesOutput = z.object({
  path: workspacePathSchema,
  entries: z.array(fileEntrySchema),
});

/** Read one UTF-8 text file of a Bot's workspace. Binary content is refused, never mangled. */
export const readFileInput = z.strictObject({
  botId: botIdSchema,
  path: workspacePathSchema,
});

export const readFileOutput = z.object({
  path: workspacePathSchema,
  text: z.string(),
  /** Bytes on disk, before any read cap. */
  size: z.number().int().nonnegative(),
  /** True when the file exceeds the read cap and `text` holds a prefix. */
  truncated: z.boolean(),
});

/**
 * The named refusals a workspace read can end in. A read never returns partial bytes for a refusal:
 * the caller gets one of these names as the wire error's code, so a surface can branch on the
 * reason instead of matching an error string.
 *
 * `absolute_path` and `parent_traversal` are also refused by `workspacePathSchema` before a handler
 * runs; a reader that is called below the schema refuses them again under these names, because a
 * boundary that fires once is a boundary that can be bypassed.
 */
export const WORKSPACE_READ_REFUSALS = [
  "absolute_path",
  "parent_traversal",
  "symlink_escape",
  "path_not_found",
  "not_a_directory",
  "not_a_file",
  "binary_file",
] as const;

export const workspaceReadRefusalSchema = z.enum(WORKSPACE_READ_REFUSALS);

export type WorkspaceReadRefusal = z.infer<typeof workspaceReadRefusalSchema>;

/** The most bytes one `read_file` returns. A larger file comes back as a prefix with `truncated`. */
export const READ_FILE_MAX_BYTES = 262_144;

// ---------------------------------------------------------------------------
// The operation registry
// ---------------------------------------------------------------------------

/** Every Phase 1 operation, keyed by its oRPC name. The follow-up wiring builds from this map. */
export const API_OPERATIONS = {
  start_run: { input: startRunInput, output: startRunOutput },
  cancel_run: { input: cancelRunInput, output: cancelRunOutput },
  list_bots: { input: listBotsInput, output: listBotsOutput },
  create_bot: { input: createBotInput, output: createBotOutput },
  list_threads: { input: listThreadsInput, output: listThreadsOutput },
  create_thread: { input: createThreadInput, output: createThreadOutput },
  get_events: { input: getEventsInput, output: getEventsOutput },
  approve: { input: approveInput, output: approveOutput },
  deny: { input: denyInput, output: denyOutput },
  list_files: { input: listFilesInput, output: listFilesOutput },
  read_file: { input: readFileInput, output: readFileOutput },
} as const;

export type ApiOperation = keyof typeof API_OPERATIONS;

export const API_OPERATION_NAMES = Object.keys(API_OPERATIONS) as ApiOperation[];
