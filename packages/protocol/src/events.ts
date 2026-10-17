/**
 * The v1 event taxonomy: one kind per fact the control plane can put in the stream.
 *
 * `EVENT_PAYLOADS` is the registry. Each kind maps to the payload schema that travels under
 * `envelope.payload`; `envelope.ts` composes the run-scoped envelope around these payloads and
 * `dto.ts` reuses them where a request carries an event-shaped value. Facts live in exactly one
 * place: the envelope owns `seq`, `ts`, and `runId`, so no payload restates them.
 *
 * Field names where the U0.10 web-stream spike already proved a shape are kept verbatim
 * (`toolCallId`, `toolName`, `command`, `destructive`, `output`, `durationMs`, `text`, `turn`,
 * `approvalId`, `decision`). `docs/protocol.md` carries the spike-to-v1 mapping table.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives shared across payloads
// ---------------------------------------------------------------------------

/** Canonical action hash minted by packages/review (grants.ts). Binds consent to one action. */
export const ACTION_HASH_PATTERN = /^v1:sha256:[0-9a-f]{64}$/;

export const actionHashSchema = z.string().regex(ACTION_HASH_PATTERN);

/**
 * The nine denial codes, verbatim from packages/review `DENY_CODES`. A gate that denies always
 * names exactly one; `events.test.ts` fails if this list and the authority ever diverge.
 */
export const DENY_CODES = [
  "unknown_tool",
  "no_grant",
  "grant_mismatch",
  "grant_expired",
  "grant_consumed",
  "grant_tombstoned",
  "grant_forged",
  "malformed_action",
  "grant_store_error",
] as const;

export const denyCodeSchema = z.enum(DENY_CODES);

export type DenyCode = z.infer<typeof denyCodeSchema>;

/** The four grant states packages/review's ledger can report. */
export const GRANT_STATES = ["issued", "consumed", "expired", "rewound"] as const;

export const grantStateSchema = z.enum(GRANT_STATES);

export type GrantState = z.infer<typeof grantStateSchema>;

/** A grant's identity and the action it authorizes, without its lifecycle state. */
export const grantRefSchema = z.object({
  /** GrantRecord.id. */
  grantId: z.string().min(1),
  /** GrantRecord.actionHash, recomputable from toolName plus normalizedArgs. */
  actionHash: actionHashSchema,
  /** Epoch milliseconds; the grant authorizes while now < expiresAt. */
  expiresAt: z.number().int().positive(),
});

export type GrantRef = z.infer<typeof grantRefSchema>;

// ---------------------------------------------------------------------------
// Run and turn boundaries
// ---------------------------------------------------------------------------

/** One user-requested run begins. `prompt` makes a replayed log self-describing. */
export const runStartedPayload = z.object({
  prompt: z.string(),
});

/** The run completed; Pi settled without failure and without a cancel. */
export const runFinishedPayload = z.object({});

/** The run ended without completing. `reason` is free text until the error taxonomy lands. */
export const runFailedPayload = z.object({
  reason: z.string().min(1),
});

/** One model turn starts inside the run, counted 1..n the way the spike counted turns. */
export const turnStartedPayload = z.object({
  turn: z.number().int().positive(),
});

export const turnEndedPayload = z.object({
  turn: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Assistant text
// ---------------------------------------------------------------------------

/** One assistant text delta. Empty deltas are legal; the display concatenates the parts. */
export const messageTextDeltaPayload = z.object({
  text: z.string(),
});

// ---------------------------------------------------------------------------
// Tool calls: requested, decided, resulted
// ---------------------------------------------------------------------------

/** The sandbox reports a call about to run. `destructive` marks a call the gate governs. */
export const toolCallRequestedPayload = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  /** `toolName` plus its JSON args, exactly the spike's rendering. */
  command: z.string(),
  destructive: z.boolean(),
});

/**
 * The gate's verdict on a call, before anything runs. Denials carry the reason code and detail
 * as separate fields so a consumer never splits the gate's display string, while the code stays
 * verbatim from packages/review.
 */
export const toolCallDecisionPayload = z.discriminatedUnion("allow", [
  z.object({
    toolCallId: z.string().min(1),
    allow: z.literal(true),
  }),
  z.object({
    toolCallId: z.string().min(1),
    allow: z.literal(false),
    code: denyCodeSchema,
    detail: z.string(),
  }),
]);

/**
 * What the call did. A denied call never ran: `denied` is true, `output` is the denial text,
 * and `durationMs` is null because Pi reports a duration only when the tool executed.
 */
export const toolCallResultPayload = z.object({
  toolCallId: z.string().min(1),
  ok: z.boolean(),
  denied: z.boolean(),
  output: z.string(),
  durationMs: z.number().int().nonnegative().nullable(),
});

// ---------------------------------------------------------------------------
// Approvals and the grant ledger
// ---------------------------------------------------------------------------

/**
 * A governed call is parked until the user answers. `actionHash` binds the request to the exact
 * call, so a later grant for different args cannot satisfy it; `expiresAt` is the deadline for
 * answering, after which the parked call is denied rather than run.
 */
export const approvalRequestedPayload = z.object({
  approvalId: z.string().min(1),
  toolCallId: z.string().min(1),
  command: z.string(),
  actionHash: actionHashSchema,
  expiresAt: z.number().int().positive(),
});

/** The user's answer, plus the grant an allow mints. A deny mints nothing. */
export const approvalResolvedPayload = z.discriminatedUnion("decision", [
  z.object({
    approvalId: z.string().min(1),
    decision: z.literal("allow"),
    grant: grantRefSchema.extend({ state: z.literal("issued") }),
  }),
  z.object({
    approvalId: z.string().min(1),
    decision: z.literal("deny"),
  }),
]);

/** The four lifecycle transitions, each carrying exactly the fields its state needs. */
export const grantLifecyclePayload = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("issued"),
    grantId: z.string().min(1),
    actionHash: actionHashSchema,
    expiresAt: z.number().int().positive(),
  }),
  z.object({
    state: z.literal("consumed"),
    grantId: z.string().min(1),
    actionHash: actionHashSchema,
    /** GrantRecord.consumedBy: the toolCallId the gate allowed. */
    consumedBy: z.string().min(1),
    at: z.number().int().positive(),
  }),
  z.object({
    state: z.literal("expired"),
    grantId: z.string().min(1),
    actionHash: actionHashSchema,
    at: z.number().int().positive(),
  }),
  z.object({
    state: z.literal("rewound"),
    grantId: z.string().min(1),
    actionHash: actionHashSchema,
    /** GrantRecord.tombstoned, for example `rewind:12`. */
    reason: z.string().min(1),
    at: z.number().int().positive(),
  }),
]);

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** Every run-scoped kind, keyed to the payload that travels under it. */
export const EVENT_PAYLOADS = {
  "run.started": runStartedPayload,
  "run.finished": runFinishedPayload,
  "run.failed": runFailedPayload,
  "turn.started": turnStartedPayload,
  "turn.ended": turnEndedPayload,
  "message.text.delta": messageTextDeltaPayload,
  "tool_call.requested": toolCallRequestedPayload,
  "tool_call.decision": toolCallDecisionPayload,
  "tool_call.result": toolCallResultPayload,
  "approval.requested": approvalRequestedPayload,
  "approval.resolved": approvalResolvedPayload,
  "grant.lifecycle": grantLifecyclePayload,
} as const;

export type EventType = keyof typeof EVENT_PAYLOADS;

export type EventPayloads = {
  [K in EventType]: z.infer<(typeof EVENT_PAYLOADS)[K]>;
};

export const EVENT_TYPES = Object.keys(EVENT_PAYLOADS) as EventType[];

/**
 * Stream markers address log positions instead of owning one, so they carry no seq and never
 * enter the log. See `envelope.ts` and docs/protocol.md.
 */
export const STREAM_PAYLOADS = {
  /** The log's range at connect, mirroring the SeqLog audit fields of the same names. */
  "stream.hello": z.object({
    firstSeq: z.number().int().positive().nullable(),
    lastSeq: z.number().int().nonnegative(),
  }),
  /** A reader rejoined from `fromSeq`; the log runs to `toSeq`. */
  "stream.resumed": z.object({
    fromSeq: z.number().int().nonnegative(),
    toSeq: z.number().int().nonnegative(),
  }),
  /** A reader refused `got` because `expected` was missing, the SeqLog gapEvent verbatim. */
  "stream.gap": z.object({
    expected: z.number().int().positive(),
    got: z.number().int().positive(),
  }),
} as const;

export type StreamType = keyof typeof STREAM_PAYLOADS;

export type StreamPayloads = {
  [K in StreamType]: z.infer<(typeof STREAM_PAYLOADS)[K]>;
};

export const STREAM_TYPES = Object.keys(STREAM_PAYLOADS) as StreamType[];
