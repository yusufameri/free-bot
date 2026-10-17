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
import { cursorSeqSchema, eventMessageSchema, runIdSchema } from "./envelope.ts";

/** The one filesystem root the API addresses. */
export const WORKSPACE_ROOT = "/workspace";

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
 */
export const startRunInput = z.strictObject({
  prompt: z.string().min(1),
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

/** List one directory. The default `"."` is the workspace root. */
export const listFilesInput = z.strictObject({
  path: workspacePathSchema.default("."),
});

export const listFilesOutput = z.object({
  path: workspacePathSchema,
  entries: z.array(fileEntrySchema),
});

/** Read one UTF-8 text file. Binary content is refused, never mangled. */
export const readFileInput = z.strictObject({
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

// ---------------------------------------------------------------------------
// The operation registry
// ---------------------------------------------------------------------------

/** Every Phase 1 operation, keyed by its oRPC name. The follow-up wiring builds from this map. */
export const API_OPERATIONS = {
  start_run: { input: startRunInput, output: startRunOutput },
  cancel_run: { input: cancelRunInput, output: cancelRunOutput },
  get_events: { input: getEventsInput, output: getEventsOutput },
  approve: { input: approveInput, output: approveOutput },
  deny: { input: denyInput, output: denyOutput },
  list_files: { input: listFilesInput, output: listFilesOutput },
  read_file: { input: readFileInput, output: readFileOutput },
} as const;

export type ApiOperation = keyof typeof API_OPERATIONS;

export const API_OPERATION_NAMES = Object.keys(API_OPERATIONS) as ApiOperation[];
