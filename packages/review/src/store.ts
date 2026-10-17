/**
 * The append-only grant ledger and its JSONL persistence.
 *
 * The log holds every version of every grant in append order; records are frozen, never mutated.
 * Current state is derived by replaying the log: the last version per grant id wins. Consuming
 * and tombstoning append a new version rather than editing the record, so the history of what
 * was authorized, when, and by which call stays intact.
 *
 * Consumption is the atomic unit of this store: the check and the append happen in one
 * synchronous step, so two gates sharing a store can never both consume the same grant
 * (issue-once, consume-once). No awaited operation sits between check and append.
 */

import {
  canonicalActionHash,
  canonicalizeJson,
  type GrantRecord,
  parseGrantRecord,
} from "./grants.ts";

export type GrantStoreErrorCode =
  | "invalid_input"
  | "duplicate_grant_id"
  | "unknown_grant"
  | "already_consumed"
  | "tombstoned"
  | "expired"
  | "malformed_log";

/** Thrown by direct store use. The gate maps every one of these to a denial. */
export class GrantStoreError extends Error {
  readonly code: GrantStoreErrorCode;

  constructor(code: GrantStoreErrorCode, message: string) {
    super(message);
    this.name = "GrantStoreError";
    this.code = code;
  }
}

export interface IssueGrantInput {
  toolName: string;
  /** Raw arguments; normalized with canonicalizeJson before hashing and storing. */
  args: unknown;
  /** Time to live in milliseconds. Must be positive. */
  ttlMs: number;
  /** Override the generated `grant-<seq>` id. Duplicate ids are refused. */
  id?: string;
  /** Epoch milliseconds; defaults to Date.now(). Tests pin it. */
  now?: number;
}

export class GrantStore {
  readonly #entries: GrantRecord[] = [];
  readonly #state = new Map<string, GrantRecord>();
  #nextSeq = 1;

  constructor(entries: readonly GrantRecord[] = []) {
    for (const entry of entries) {
      this.#append(entry);
    }
  }

  #fold(entry: GrantRecord): void {
    this.#state.set(entry.id, Object.freeze(entry));
    if (entry.seq >= this.#nextSeq) {
      this.#nextSeq = entry.seq + 1;
    }
  }

  #append(record: GrantRecord): GrantRecord {
    this.#entries.push(record);
    this.#fold(record);
    return this.#state.get(record.id) as GrantRecord;
  }

  /**
   * Append an issue version. The action hash is computed here from (toolName, args), so every
   * store-issued grant is self-consistent by construction.
   */
  issue(input: IssueGrantInput): GrantRecord {
    if (input.toolName.length === 0) {
      throw new GrantStoreError("invalid_input", "toolName must be non-empty");
    }
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new GrantStoreError("invalid_input", "ttlMs must be a positive number");
    }
    const now = input.now ?? Date.now();
    if (!Number.isFinite(now)) {
      throw new GrantStoreError("invalid_input", "now must be a finite epoch-milliseconds number");
    }
    const seq = this.#nextSeq;
    const id = input.id ?? `grant-${seq}`;
    if (this.#state.has(id)) {
      throw new GrantStoreError("duplicate_grant_id", `grant ${id} already exists`);
    }
    const normalizedArgs = canonicalizeJson(input.args);
    return this.#append({
      id,
      seq,
      issuedAt: now,
      expiresAt: now + input.ttlMs,
      actionHash: canonicalActionHash(input.toolName, normalizedArgs),
      toolName: input.toolName,
      normalizedArgs,
      consumedBy: null,
      tombstoned: null,
    });
  }

  /**
   * Append a consume version. Rejects any grant that cannot authorize right now: unknown,
   * already consumed, tombstoned, or expired at `now`.
   */
  consume(grantId: string, consumedBy: string, now = Date.now()): GrantRecord {
    if (consumedBy.length === 0) {
      throw new GrantStoreError("invalid_input", "consumedBy must be non-empty");
    }
    const current = this.#state.get(grantId);
    if (current === undefined) {
      throw new GrantStoreError("unknown_grant", `no grant ${grantId}`);
    }
    if (current.tombstoned !== null) {
      throw new GrantStoreError(
        "tombstoned",
        `grant ${grantId} tombstoned by ${current.tombstoned}`,
      );
    }
    if (current.consumedBy !== null) {
      throw new GrantStoreError(
        "already_consumed",
        `grant ${grantId} already consumed by ${current.consumedBy}`,
      );
    }
    if (current.expiresAt <= now) {
      throw new GrantStoreError(
        "expired",
        `grant ${grantId} expired at ${new Date(current.expiresAt).toISOString()}`,
      );
    }
    return this.#append({ ...current, consumedBy });
  }

  /**
   * Rewind the ledger to a point: every grant with seq greater than `rewindSeq` that is not yet
   * tombstoned gets a tombstone version with `reason`. Idempotent: a second rewind over the same
   * point appends nothing. Consumption state stays as it was; rewind only removes authority.
   */
  rewind(rewindSeq: number, reason: string): GrantRecord[] {
    if (!Number.isInteger(rewindSeq) || rewindSeq < 0) {
      throw new GrantStoreError("invalid_input", "rewindSeq must be a non-negative integer");
    }
    if (reason.length === 0) {
      throw new GrantStoreError("invalid_input", "reason must be non-empty");
    }
    const affected = [...this.#state.values()]
      .filter((grant) => grant.seq > rewindSeq && grant.tombstoned === null)
      .sort((left, right) => left.seq - right.seq);
    return affected.map((grant) => this.#append({ ...grant, tombstoned: reason }));
  }

  current(grantId: string): GrantRecord | undefined {
    return this.#state.get(grantId);
  }

  /** Current versions for one action hash, ascending by seq. */
  byActionHash(actionHash: string): GrantRecord[] {
    return this.#by((grant) => grant.actionHash === actionHash);
  }

  /** Current versions for one tool, ascending by seq. */
  byTool(toolName: string): GrantRecord[] {
    return this.#by((grant) => grant.toolName === toolName);
  }

  /** The derived state: one current version per grant id, ascending by seq. */
  grants(): readonly GrantRecord[] {
    return this.#by(() => true);
  }

  /** The raw append-only log: every version ever appended, in append order. */
  log(): readonly GrantRecord[] {
    return [...this.#entries];
  }

  #by(predicate: (grant: GrantRecord) => boolean): GrantRecord[] {
    return [...this.#state.values()].filter(predicate).sort((left, right) => left.seq - right.seq);
  }
}

/** Serialize a store as one JSON record per line, in append order. */
export function grantStoreToJsonl(store: GrantStore): string {
  const lines = store.log().map((entry) => JSON.stringify(entry));
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * Rebuild a store from JSONL text. Every line must parse as a v1 record; the first malformed
 * line fails the load with its line number, so a corrupt ledger never silently drops records.
 */
export function grantStoreFromJsonl(text: string): GrantStore {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const entries = lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new GrantStoreError("malformed_log", `line ${index + 1} is not JSON`);
    }
    try {
      return parseGrantRecord(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GrantStoreError("malformed_log", `line ${index + 1}: ${message}`);
    }
  });
  return new GrantStore(entries);
}

export async function saveGrantStore(store: GrantStore, path: string): Promise<void> {
  await Bun.write(path, grantStoreToJsonl(store));
}

export async function loadGrantStore(path: string): Promise<GrantStore> {
  return grantStoreFromJsonl(await Bun.file(path).text());
}
