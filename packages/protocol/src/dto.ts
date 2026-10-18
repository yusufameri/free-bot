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

/** The longest role a Bot can carry. The row beside the name shows it in one line. */
export const BOT_ROLE_MAX = 60;

/** The longest purpose a Bot can carry. It is one line, and it becomes the Bot's own instruction. */
export const BOT_PURPOSE_MAX = 280;

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
 *
 * `role` and `purpose` are the two fields a first-run screen asks for after the name: the short
 * label, and the one line saying what the Bot is for. Both may be empty, because a Bot can exist
 * before either question has been answered, and a record written before the two fields existed
 * reads back with both empty.
 */
export const botSchema = z.object({
  botId: botIdSchema,
  name: z.string().min(1),
  role: z.string(),
  purpose: z.string(),
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

/**
 * Give a Bot the two fields a first-run screen asks for after its name. Both are sent together,
 * because they are one answer to one question, and both are allowed to be empty: a person may leave
 * the label out, and a Bot whose purpose is not yet known is still a Bot.
 */
export const updateBotInput = z.strictObject({
  botId: botIdSchema,
  role: z.string().max(BOT_ROLE_MAX),
  purpose: z.string().max(BOT_PURPOSE_MAX),
});

export const updateBotOutput = botSchema;

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
// The provider connection: UX.md page 1, "Welcome, then connect a provider"
// ---------------------------------------------------------------------------

/**
 * The three things the page takes. The key is written to the vault and stored nowhere else, so this
 * input exists for the one call that saves it and no output ever carries it back.
 *
 * A newline in any field is refused at this boundary rather than at the writer: the vault is one
 * `KEY=value` per line, so a value that spans lines would rewrite the file's shape.
 */
/** The vault is one `KEY=value` per line, so a value that spans lines would rewrite the file. */
export function isOneLine(value: string): boolean {
  return !/[\r\n]/.test(value);
}

export const PROVIDER_BASE_URL_MAX = 2048;
export const PROVIDER_MODEL_MAX = 200;
export const PROVIDER_KEY_MAX = 4096;

/** An endpoint has to be one an HTTP client can dial: a provider's base URL, a connector's MCP URL. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export const providerConfigInput = z.strictObject({
  baseUrl: z
    .string()
    .min(1)
    .max(PROVIDER_BASE_URL_MAX)
    .refine(isOneLine, "the base URL must be one line")
    .refine(isHttpUrl, "the base URL must be an http or https URL"),
  model: z.string().min(1).max(PROVIDER_MODEL_MAX).refine(isOneLine, "the model must be one line"),
  key: z.string().min(1).max(PROVIDER_KEY_MAX).refine(isOneLine, "the key must be one line"),
});

export type ProviderConfigInput = z.infer<typeof providerConfigInput>;

/**
 * How capable the connection was when it was last tested. `capable` is a native tool call in the
 * test's reply, `limited` is a reply without one, and `untested` covers both a connection nobody has
 * tested and one whose test the provider refused.
 */
export const PROVIDER_STATUSES = ["untested", "capable", "limited"] as const;

export const providerStatusSchema = z.enum(PROVIDER_STATUSES);

export type ProviderStatus = z.infer<typeof providerStatusSchema>;

/**
 * The flags the test's own turn produced, derived from what was observed and never from the model's
 * name. A `null` field means that path was not exercised, which is not the same as a refusal.
 */
export const providerFlagsSchema = z.object({
  toolCalling: z.enum(["strong", "weak", "none"]),
  streaming: z.boolean().nullable(),
  structuredOutput: z.boolean().nullable(),
  contextWindow: z.number().int().positive().nullable(),
  notes: z.array(z.string()),
});

export type ProviderFlags = z.infer<typeof providerFlagsSchema>;

/** What the provider said when it refused the test. The status code is the point of the message. */
export const providerRefusalSchema = z.object({
  /** The HTTP status, or null when the test failed before the provider answered. */
  status: z.number().int().positive().nullable(),
  message: z.string(),
});

export type ProviderRefusal = z.infer<typeof providerRefusalSchema>;

/**
 * The connection as a surface reads it: the endpoint, the model, and what the last test found. There
 * is no key field, and there is no shape here a key could be smuggled into.
 */
export const providerConnectionSchema = z.object({
  baseUrl: z.string(),
  model: z.string(),
  status: providerStatusSchema,
  /** When the last test ran, or null when the connection has never been tested. */
  testedAt: tsSchema.nullable(),
  flags: providerFlagsSchema.nullable(),
  refusal: providerRefusalSchema.nullable(),
  /** The model's own reply from the test turn, or null when the test produced none. */
  answer: z.string().nullable(),
});

export type ProviderConnection = z.infer<typeof providerConnectionSchema>;

/** What a caller may know about the vault file, which is its path, its presence, and its mode. */
export const providerVaultSchema = z.object({
  path: z.string(),
  present: z.boolean(),
  mode: z.string().nullable(),
});

export type ProviderVault = z.infer<typeof providerVaultSchema>;

/**
 * Page 1's whole state. `connection: null` is the keyless machine, which is the page's empty state;
 * a connection carries the endpoint and the flags and never the key.
 */
export const providerStateSchema = z.object({
  vault: providerVaultSchema,
  connection: providerConnectionSchema.nullable(),
});

export type ProviderState = z.infer<typeof providerStateSchema>;

/** Read page 1's state. It names nothing: the install holds one active connection. */
export const getProviderInput = z.strictObject({});

export const getProviderOutput = providerStateSchema;

/**
 * Save a connection and test it. The save happens first and the test's outcome is the answer, so a
 * refused test still lands a connection the page can show as `untested`.
 */
export const connectProviderInput = providerConfigInput;

export const connectProviderOutput = providerConnectionSchema;

/**
 * The connectors this install holds. A row names the connector, what it is called, where it is,
 * which credential it uses (as a reference), what it offers, and the state the last probe left it
 * in. There is no header field and no token field here, so a route cannot answer with a credential
 * even by accident: the vault holds the headers and this shape has nowhere to put one.
 */
export const connectorToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
});

export type ConnectorToolRow = z.infer<typeof connectorToolSchema>;

/**
 * The three states one connector's connection can be in. They are the whole vocabulary a surface
 * branches on, and the third is why this is an enum rather than a boolean: a record the vault holds
 * no credential for has not been tried, and a missing credential must not read as a broken service.
 *
 * - `connected`: the probe reached the person's own service and it answered;
 * - `unreachable`: the probe ran and did not get an answer this seam could use;
 * - `untested`: no credential is in the vault for this record, so nothing was probed.
 */
export const CONNECTOR_STATES = ["connected", "unreachable", "untested"] as const;

export const connectorStateSchema = z.enum(CONNECTOR_STATES);

export type ConnectorState = z.infer<typeof connectorStateSchema>;

/** The longest label a connector row shows. It is one line beside the connector's address. */
export const CONNECTOR_LABEL_MAX = 60;

/** The longest endpoint a connector can name. Matches the provider base URL's bound. */
export const CONNECTOR_URL_MAX = 2048;

/** The most a connector's credential can be, counted over the JSON the vault stores it as. */
export const CONNECTOR_HEADERS_MAX = 8192;

/**
 * A connector's id. It namespaces every tool name the connector offers, so it is one slug and it is
 * also the key a second connect rotates rather than duplicates.
 */
export const connectorIdSchema = idSchema;

export const connectorRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** The connector's endpoint: the MCP URL its own server answers at. */
  url: z.string(),
  /** The credential's reference, which names it and cannot spend it. */
  ref: z.string(),
  state: connectorStateSchema,
  /** The last probe's own words: the service's line, or this app's reason there was no probe. */
  detail: z.string(),
  /** What the connector offered at the last probe, which is what a run would be offered. */
  tools: z.array(connectorToolSchema),
  /** When the last probe ran, or null when this connector has never been probed. */
  testedAt: tsSchema.nullable(),
});

export type ConnectorRow = z.infer<typeof connectorRowSchema>;

/** List the install's connectors. It names nothing: the install holds one set of them. */
export const listConnectorsInput = z.strictObject({});

export const listConnectorsOutput = z.object({ connectors: z.array(connectorRowSchema) });

/**
 * Connect a connector, or replace the credential of one this install already holds. The id is the
 * key, so connecting an id that exists rotates its credential in place rather than adding a second
 * connector, and the answer is the state its own service left the probe in.
 *
 * `headers` is the credential: this input is the one place in the contract one appears, and no
 * output carries one back. It is a header map rather than a token string because that is what a
 * person's own server asks for, and the vault is one `NAME=value` per line, so every value must be
 * one line.
 */
export const connectConnectorInput = z.strictObject({
  id: connectorIdSchema,
  label: z
    .string()
    .min(1)
    .max(CONNECTOR_LABEL_MAX)
    .refine(isOneLine, "the label must be one line")
    .optional(),
  url: z
    .string()
    .min(1)
    .max(CONNECTOR_URL_MAX)
    .refine(isOneLine, "the endpoint must be one line")
    .refine(isHttpUrl, "the endpoint must be an http or https URL"),
  headers: z
    .record(
      z.string().min(1).refine(isOneLine, "a header name must be one line"),
      z.string().min(1).refine(isOneLine, "a header value must be one line"),
    )
    .refine(
      (headers) => Object.keys(headers).length > 0,
      "a connector needs at least one header, or its service cannot tell who is calling",
    )
    .refine(
      (headers) => JSON.stringify(headers).length <= CONNECTOR_HEADERS_MAX,
      `a credential is at most ${CONNECTOR_HEADERS_MAX} characters of JSON`,
    ),
});

export type ConnectConnectorInput = z.infer<typeof connectConnectorInput>;

export const connectConnectorOutput = connectorRowSchema;

/**
 * Test one connector the way a person checks a connection: with its own credential, then report. A
 * refusal is a successful call whose answer says so, and its `state` is `unreachable` rather than an
 * error, because a surface listing connectors has to show the broken one.
 */
export const testConnectorInput = z.strictObject({ id: connectorIdSchema });

export const testConnectorOutput = connectorRowSchema;

/**
 * Remove a connector: its credential leaves the vault and its record leaves the store, so the next
 * call for it finds nothing rather than a stale secret. Removing one this install does not hold is
 * not an error: `removed` is false and the end state is the same, which is what makes a second
 * removal safe to send.
 */
export const removeConnectorInput = z.strictObject({ id: connectorIdSchema });

export const removeConnectorOutput = z.object({ id: z.string(), removed: z.boolean() });

// ---------------------------------------------------------------------------
// The operation registry
// ---------------------------------------------------------------------------

/** Every Phase 1 operation, keyed by its oRPC name. The follow-up wiring builds from this map. */
export const API_OPERATIONS = {
  start_run: { input: startRunInput, output: startRunOutput },
  cancel_run: { input: cancelRunInput, output: cancelRunOutput },
  list_bots: { input: listBotsInput, output: listBotsOutput },
  create_bot: { input: createBotInput, output: createBotOutput },
  update_bot: { input: updateBotInput, output: updateBotOutput },
  list_threads: { input: listThreadsInput, output: listThreadsOutput },
  create_thread: { input: createThreadInput, output: createThreadOutput },
  get_events: { input: getEventsInput, output: getEventsOutput },
  approve: { input: approveInput, output: approveOutput },
  deny: { input: denyInput, output: denyOutput },
  list_files: { input: listFilesInput, output: listFilesOutput },
  read_file: { input: readFileInput, output: readFileOutput },
  get_provider: { input: getProviderInput, output: getProviderOutput },
  connect_provider: { input: connectProviderInput, output: connectProviderOutput },
  list_connectors: { input: listConnectorsInput, output: listConnectorsOutput },
  connect_connector: { input: connectConnectorInput, output: connectConnectorOutput },
  test_connector: { input: testConnectorInput, output: testConnectorOutput },
  remove_connector: { input: removeConnectorInput, output: removeConnectorOutput },
} as const;

export type ApiOperation = keyof typeof API_OPERATIONS;

export const API_OPERATION_NAMES = Object.keys(API_OPERATIONS) as ApiOperation[];
