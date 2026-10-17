/**
 * Grant records and the canonical action hash.
 *
 * A grant is consent to perform exactly one action: one tool called with one set of arguments.
 * The action hash binds that consent to the action, so an approval for `bash echo hi` can never
 * authorize `bash rm -rf /` (plan finding 17, TOCTOU on approvals). The gate refuses to dispatch
 * without a matching grant (plan finding 11, approvals are a control-plane invariant).
 *
 * The canonical form is a recursive, key-sorted JSON tree with array order preserved. The digest
 * is SHA-256 over the canonical JSON of `{ tool, args }`, prefixed `v1:sha256:`. Anything the
 * canonicalizer cannot rewrite faithfully is refused, never coerced: a refusal makes the gate
 * deny, which is the fail-closed direction. The full normalization table lives in
 * docs/review-grants.md.
 */

/** The subset of JSON that a grant argument tree may contain. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Thrown when a value cannot be rewritten as canonical JSON without changing its meaning. */
export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

/** Thrown when a persisted grant record does not match the v1 record schema. */
export class GrantRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantRecordError";
  }
}

/** Every field of the v1 record schema. Parsing rejects anything outside this set. */
export const GRANT_RECORD_FIELDS = [
  "id",
  "seq",
  "issuedAt",
  "expiresAt",
  "actionHash",
  "toolName",
  "normalizedArgs",
  "consumedBy",
  "tombstoned",
] as const;

/** One grant, as stored and as derived for authorization. */
export interface GrantRecord {
  /** Grant identity. Unique across the ledger; consume and tombstone versions repeat it. */
  id: string;
  /** Ledger sequence assigned at issue time. Rewind tombstones grants with seq > rewind point. */
  seq: number;
  /** Epoch milliseconds. */
  issuedAt: number;
  /** Epoch milliseconds. The grant is valid while now < expiresAt. */
  expiresAt: number;
  /** Canonical action hash of (toolName, normalizedArgs). */
  actionHash: string;
  toolName: string;
  /** The canonical form of the granted arguments: recursively key-sorted, array order kept. */
  normalizedArgs: JsonValue;
  /** toolCallId of the call that consumed this grant, or null while unconsumed. */
  consumedBy: string | null;
  /** Tombstone reason (for example `rewind:12`), or null while live. */
  tombstoned: string | null;
}

const ACTION_HASH_PATTERN = /^v1:sha256:[0-9a-f]{64}$/;

/** The digest scheme. Any change to the normalization rules must bump this prefix. */
export const ACTION_HASH_PREFIX = "v1:sha256:";

function objectLabel(value: object): string {
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name === undefined || name.length === 0 ? "object" : name;
}

function canonicalize(value: unknown, path: string): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`${path}: refuses ${String(value)} (not a finite number)`);
      }
      if (Object.is(value, -0)) {
        throw new CanonicalizationError(`${path}: refuses -0 (JSON stringifies it as 0)`);
      }
      return value;
    case "object":
      break;
    default:
      throw new CanonicalizationError(`${path}: refuses ${typeof value} (not a JSON value)`);
  }
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      items.push(canonicalize(value[index] as unknown, `${path}[${index}]`));
    }
    return items;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalizationError(`${path}: refuses non-plain object (${objectLabel(value)})`);
  }
  const source = value as Record<string, unknown>;
  const sorted: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(source).sort()) {
    sorted[key] = canonicalize(source[key] as unknown, `${path}.${key}`);
  }
  return sorted;
}

/**
 * Rewrite a value as canonical JSON. Object keys sort ascending by UTF-16 code unit at every
 * level; array order is kept. Throws CanonicalizationError for anything not faithfully
 * representable. The result is a fresh tree with a null prototype, safe to sort keys named
 * `__proto__`.
 */
export function canonicalizeJson(value: unknown): JsonValue {
  return canonicalize(value, "$");
}

/** The canonical JSON text of a value. This text, not the value, is what gets hashed. */
export function canonicalJsonText(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

/**
 * The canonical action hash of one tool call: `v1:sha256:` plus the SHA-256 of the canonical JSON
 * of `{ args, tool }`. Arguments are normalized with canonicalizeJson first.
 */
export function canonicalActionHash(toolName: string, args: unknown): string {
  if (toolName.length === 0) {
    throw new CanonicalizationError("$: refuses an empty tool name");
  }
  const payload = canonicalJsonText({ args, tool: toolName });
  const digest = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
  return `${ACTION_HASH_PREFIX}${digest}`;
}

/**
 * Recompute a record's action hash from its own toolName and normalizedArgs. A record whose
 * stored actionHash differs from this is forged: it claims consent to one action while carrying
 * the content of another. The gate denies it.
 */
export function recomputeActionHash(
  record: Pick<GrantRecord, "toolName" | "normalizedArgs">,
): string {
  return canonicalActionHash(record.toolName, record.normalizedArgs);
}

function optionalName(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string" && value.length > 0) return value;
  throw new GrantRecordError(`${field} must be a non-empty string or null`);
}

/** Parse one persisted record. Shape-check only: hash consistency is the gate's concern. */
export function parseGrantRecord(value: unknown): GrantRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GrantRecordError("grant record must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(GRANT_RECORD_FIELDS as readonly string[]).includes(key)) {
      throw new GrantRecordError(`grant record carries unknown field ${key}`);
    }
  }
  const id = record.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new GrantRecordError("id must be a non-empty string");
  }
  const seq = record.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
    throw new GrantRecordError("seq must be a positive integer");
  }
  const issuedAt = record.issuedAt;
  if (typeof issuedAt !== "number" || !Number.isFinite(issuedAt)) {
    throw new GrantRecordError("issuedAt must be a finite epoch-milliseconds number");
  }
  const expiresAt = record.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw new GrantRecordError("expiresAt must be a finite number greater than issuedAt");
  }
  const actionHash = record.actionHash;
  if (typeof actionHash !== "string" || !ACTION_HASH_PATTERN.test(actionHash)) {
    throw new GrantRecordError(`actionHash must match ${ACTION_HASH_PREFIX}<64 lowercase hex>`);
  }
  const toolName = record.toolName;
  if (typeof toolName !== "string" || toolName.length === 0) {
    throw new GrantRecordError("toolName must be a non-empty string");
  }
  let normalizedArgs: JsonValue;
  try {
    normalizedArgs = canonicalizeJson(record.normalizedArgs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GrantRecordError(`normalizedArgs: ${message}`);
  }
  return {
    id,
    seq,
    issuedAt,
    expiresAt,
    actionHash,
    toolName,
    normalizedArgs,
    consumedBy: optionalName(record.consumedBy, "consumedBy"),
    tombstoned: optionalName(record.tombstoned, "tombstoned"),
  };
}
