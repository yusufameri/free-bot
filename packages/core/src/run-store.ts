/**
 * The run store: one record per run, one writer, an append-only command journal.
 *
 * Every mutation is a command that gets journaled, and every command is idempotent, so two things
 * follow. A store that reopens a journal left behind by a crash replays to the same records, and a
 * command that arrives twice (a resent `start_run`, a replayed `cancel_run`, an agent's resend of a
 * held approval request) applies once. A terminal run is settled: every later lifecycle operation
 * is a no-op, so cancelling a finished run is not an error and never rewrites history, while a
 * `seq` or `usage` frame still lands on a settled record so late arrival is not lost.
 *
 * Commands apply in memory first and reach the disk second. The disk write is the next process's
 * crash-safety net, not this one's: if it fails, the caller gets the error rather than a success the
 * journal never saw. A journal whose last line has no newline is a torn write and is dropped on
 * reload, because the process that wrote it never reported it applied; a malformed line anywhere
 * else is corruption and throws.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  FAILURE_TAXONOMY,
  failureFor,
  type RunFailure,
  type RunFailureCode,
  RunTaxonomyError,
} from "./run-errors.ts";
import {
  assertTransition,
  isTerminal,
  type RunOperation,
  type RunStatus,
  RunTransitionError,
} from "./run-status.ts";
import { addUsage, emptyUsage, type UsageEvent, type UsageTotals } from "./run-usage.ts";

/** What the control plane parked: the card it renders and the deadline it enforces. */
export interface ParkedApproval {
  approvalId: string;
  toolCallId: string;
  command: string;
  /** The canonical action hash the answer binds to, so a re-rendered card cannot approve other args. */
  actionHash: string;
  expiresAt: number;
  requestedAt: number;
}

export interface RunRecord {
  id: string;
  threadId: string;
  botId: string;
  status: RunStatus;
  /** The prompt the run was started with; kept so a record is self-describing without the log. */
  prompt: string;
  /** The highest log seq this run has ingested; a rejoin replays from exactly here. */
  lastSeenSeq: number;
  /** 1 at start, plus one per resume after a loss. */
  attempt: number;
  approval: ParkedApproval | null;
  usage: UsageTotals;
  /** The current blocking or terminal reason. Cleared by `resume`. */
  error: RunFailure | null;
  createdAt: number;
  updatedAt: number;
}

export type RunCommand =
  | { op: "start"; id: string; threadId: string; botId: string; prompt: string; at: number }
  | { op: "begin"; id: string; at: number }
  | {
      op: "park";
      id: string;
      approvalId: string;
      toolCallId: string;
      command: string;
      actionHash: string;
      expiresAt: number;
      at: number;
    }
  | { op: "resolve"; id: string; approvalId: string; at: number }
  | { op: "pause"; id: string; code: RunFailureCode | null; detail: string | null; at: number }
  | { op: "resume"; id: string; at: number }
  | { op: "seq"; id: string; seq: number; at: number }
  | { op: "usage"; id: string; event: UsageEvent; at: number }
  | { op: "finish"; id: string; at: number }
  | { op: "fail"; id: string; code: RunFailureCode; detail: string | null; at: number };

export const RUN_COMMAND_OPS = [
  "start",
  "begin",
  "park",
  "resolve",
  "pause",
  "resume",
  "seq",
  "usage",
  "finish",
  "fail",
] as const;

export interface RunLoadReport {
  /** Lines the journal held and replay accepted as commands. */
  commands: number;
  /** Commands the lifecycle refused while replaying; empty is the invariant. */
  refused: Array<{ line: number; reason: string }>;
  /** Usage events whose id this store had already applied; replay never counts one twice. */
  duplicateUsage: string[];
  /** The last line had no newline, so it was never reported applied and was dropped. */
  tornTrailingLine: boolean;
}

export interface RunStoreOptions {
  /** Journal path. Omitted means an in-memory store that persists nothing. */
  file?: string;
  /** Injected clock; every command carries the time it was issued. */
  now?: () => number;
}

export interface StartRunInput {
  /** Caller-minted and the idempotency key: the same id twice is the same run, never a second one. */
  id: string;
  threadId: string;
  botId: string;
  prompt: string;
}

export interface ParkInput {
  approvalId: string;
  toolCallId: string;
  command: string;
  actionHash: string;
  expiresAt: number;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const inner of Object.values(value)) deepFreeze(inner);
  return Object.freeze(value);
}

function view(record: RunRecord): RunRecord {
  return deepFreeze(structuredClone(record));
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTokenCounts(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    typeof value.input === "number" &&
    typeof value.output === "number" &&
    typeof value.cacheRead === "number" &&
    typeof value.cacheWrite === "number"
  );
}

/** The disk boundary: a journal line must be a complete command before it is applied. */
export function isRunCommand(value: unknown): value is RunCommand {
  if (!isRecordValue(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (typeof value.at !== "number" || !Number.isSafeInteger(value.at)) return false;
  switch (value.op) {
    case "start":
      return (
        typeof value.threadId === "string" &&
        typeof value.botId === "string" &&
        typeof value.prompt === "string"
      );
    case "begin":
    case "resume":
    case "finish":
      return true;
    case "park":
      return (
        typeof value.approvalId === "string" &&
        typeof value.toolCallId === "string" &&
        typeof value.command === "string" &&
        typeof value.actionHash === "string" &&
        typeof value.expiresAt === "number"
      );
    case "resolve":
      return typeof value.approvalId === "string";
    case "pause":
      return (
        (value.code === null || typeof value.code === "string") &&
        (value.detail === null || typeof value.detail === "string")
      );
    case "seq":
      return typeof value.seq === "number" && Number.isSafeInteger(value.seq);
    case "usage":
      return (
        isRecordValue(value.event) &&
        typeof value.event.usageId === "string" &&
        typeof value.event.provider === "string" &&
        typeof value.event.model === "string" &&
        isTokenCounts(value.event.tokens) &&
        typeof value.event.costNanoUsd === "number"
      );
    case "fail":
      return (
        typeof value.code === "string" &&
        (value.detail === null || typeof value.detail === "string")
      );
    default:
      return false;
  }
}

export class RunStore {
  readonly #runs = new Map<string, RunRecord>();
  readonly #usageIds = new Map<string, Set<string>>();
  readonly #events = new Map<string, UsageEvent[]>();
  readonly #duplicateUsage: string[] = [];
  readonly #file: string | undefined;
  readonly #now: () => number;
  #fd: number | null = null;
  #loadReport: RunLoadReport;

  constructor(options: RunStoreOptions = {}) {
    this.#file = options.file;
    this.#now = options.now ?? (() => Date.now());
    this.#loadReport = this.#readAndReplay();
  }

  get loadReport(): RunLoadReport {
    return this.#loadReport;
  }

  /** Idempotent per run id: a second start of the same id returns the same record, unchanged. */
  start(input: StartRunInput): { record: RunRecord; created: boolean } {
    const existing = this.#runs.get(input.id);
    if (existing !== undefined) return { record: view(existing), created: false };
    const command: RunCommand = {
      op: "start",
      id: input.id,
      threadId: input.threadId,
      botId: input.botId,
      prompt: input.prompt,
      at: this.#now(),
    };
    return { record: this.#commit(command), created: true };
  }

  begin(id: string): RunRecord {
    const current = this.#requireEntry(id);
    if (current.status === "running") return view(current);
    if (current.status !== "queued")
      throw new RunTransitionError(current.status, "running", "begin");
    return this.#commit({ op: "begin", id, at: this.#now() });
  }

  /** Park at a governed call. A resend of the same approval id is the same park, not a second one. */
  park(id: string, input: ParkInput): RunRecord {
    const current = this.#requireEntry(id);
    if (current.approval !== null && current.approval.approvalId === input.approvalId) {
      return view(current);
    }
    return this.#commit({
      op: "park",
      id,
      approvalId: input.approvalId,
      toolCallId: input.toolCallId,
      command: input.command,
      actionHash: input.actionHash,
      expiresAt: input.expiresAt,
      at: this.#now(),
    });
  }

  /**
   * The user answered the parked call. Both allow and deny return the run to `running`: a denial is
   * the tool's refusal text, not an ending, and the decision itself lives in the grant ledger and
   * the approval stream. A stale or already-resolved approval id is a no-op.
   */
  resolveApproval(id: string, approvalId: string): RunRecord {
    const current = this.#requireEntry(id);
    if (current.approval === null || current.approval.approvalId !== approvalId)
      return view(current);
    return this.#commit({ op: "resolve", id, approvalId, at: this.#now() });
  }

  /**
   * Park the run without ending it. `code` names a taxonomy entry that settles at `paused` (losing
   * the sandbox mid-run is the one today); omitting it is a user pause, which records no reason.
   */
  pause(id: string, input: { code?: RunFailureCode; detail?: string | null } = {}): RunRecord {
    const current = this.#requireEntry(id);
    if (current.status === "paused") return view(current);
    return this.#commit({
      op: "pause",
      id,
      code: input.code ?? null,
      detail: input.detail ?? null,
      at: this.#now(),
    });
  }

  /** The agent rejoined, or the user resumed. Attempts increment; the reason clears. */
  resume(id: string): RunRecord {
    const current = this.#requireEntry(id);
    if (current.status === "running") return view(current);
    return this.#commit({ op: "resume", id, at: this.#now() });
  }

  /** Move the run's durable position forward. A replayed or late frame never moves it back. */
  noteSeq(id: string, seq: number): RunRecord {
    if (!Number.isSafeInteger(seq) || seq < 1) {
      throw new Error(`not a log seq: ${seq}`);
    }
    const current = this.#requireEntry(id);
    if (seq <= current.lastSeenSeq) return view(current);
    return this.#commit({ op: "seq", id, seq, at: this.#now() });
  }

  /** Add one call's usage. A `usageId` this run already counted is refused, not added. */
  recordUsage(id: string, event: UsageEvent): { record: RunRecord; applied: boolean } {
    const current = this.#requireEntry(id);
    if (this.#usageIds.get(id)?.has(event.usageId) === true) {
      this.#duplicateUsage.push(event.usageId);
      return { record: view(current), applied: false };
    }
    return { record: this.#commit({ op: "usage", id, event, at: this.#now() }), applied: true };
  }

  finish(id: string): RunRecord {
    const current = this.#requireEntry(id);
    if (isTerminal(current.status)) return view(current);
    return this.#commit({ op: "finish", id, at: this.#now() });
  }

  /** Settle the run at the status its taxonomy entry names. A settled run is never rewritten. */
  fail(id: string, code: RunFailureCode, detail: string | null = null): RunRecord {
    const current = this.#requireEntry(id);
    if (isTerminal(current.status)) return view(current);
    if (FAILURE_TAXONOMY[code].status === "paused") throw new RunTaxonomyError(code, "fail");
    return this.#commit({ op: "fail", id, code, detail, at: this.#now() });
  }

  /** Idempotent: cancelling a run that already ended is a no-op, never an error. */
  cancel(id: string): RunRecord {
    return this.fail(id, "cancelled", null);
  }

  get(id: string): RunRecord | undefined {
    const record = this.#runs.get(id);
    return record === undefined ? undefined : view(record);
  }

  list(): RunRecord[] {
    return [...this.#runs.values()]
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .map((record) => view(record));
  }

  usageEvents(id: string): UsageEvent[] {
    this.#requireEntry(id);
    return structuredClone(this.#events.get(id) ?? []);
  }

  /** The whole store as one deterministic string: the convergence comparison. */
  serializeAll(): string {
    const runs = [...this.#runs.keys()].sort().map((id) => this.#runs.get(id));
    const usageIds: Record<string, string[]> = {};
    for (const id of [...this.#usageIds.keys()].sort()) {
      usageIds[id] = [...(this.#usageIds.get(id) ?? [])].sort();
    }
    return JSON.stringify({ runs, usageIds }, null, 2);
  }

  /**
   * Read the journal again from scratch and report whether the state came back the same. An
   * in-memory store has no journal to read, so it reports its current state as converged.
   */
  reload(): { report: RunLoadReport; converged: boolean } {
    if (this.#file === undefined) {
      return {
        report: { commands: 0, refused: [], duplicateUsage: [], tornTrailingLine: false },
        converged: true,
      };
    }
    const before = this.serializeAll();
    const report = this.#readAndReplay();
    return { report, converged: before === this.serializeAll() };
  }

  /** Release the journal handle. A process that dies here leaves exactly the commands it applied. */
  close(): void {
    if (this.#fd !== null) {
      closeSync(this.#fd);
      this.#fd = null;
    }
  }

  #requireEntry(id: string): RunRecord {
    const record = this.#runs.get(id);
    if (record === undefined) throw new Error(`unknown run: ${id}`);
    return record;
  }

  #commit(command: RunCommand): RunRecord {
    this.#apply(command);
    this.#append(command);
    return view(this.#requireEntry(command.id));
  }

  #move(
    id: string,
    to: RunStatus,
    via: RunOperation,
    at: number,
    mutate?: (record: RunRecord) => void,
  ): void {
    const record = this.#requireEntry(id);
    assertTransition(record.status, to, via);
    record.status = to;
    record.updatedAt = at;
    mutate?.(record);
  }

  #apply(command: RunCommand): void {
    switch (command.op) {
      case "start": {
        if (this.#runs.has(command.id)) return;
        this.#runs.set(command.id, {
          id: command.id,
          threadId: command.threadId,
          botId: command.botId,
          status: "queued",
          prompt: command.prompt,
          lastSeenSeq: 0,
          attempt: 1,
          approval: null,
          usage: emptyUsage(),
          error: null,
          createdAt: command.at,
          updatedAt: command.at,
        });
        return;
      }
      case "begin": {
        const record = this.#requireEntry(command.id);
        if (record.status === "running") return;
        if (record.status !== "queued")
          throw new RunTransitionError(record.status, "running", "begin");
        this.#move(command.id, "running", "begin", command.at);
        return;
      }
      case "park": {
        const record = this.#requireEntry(command.id);
        if (record.approval?.approvalId === command.approvalId) return;
        this.#move(command.id, "awaiting_approval", "park", command.at, (moved) => {
          moved.approval = {
            approvalId: command.approvalId,
            toolCallId: command.toolCallId,
            command: command.command,
            actionHash: command.actionHash,
            expiresAt: command.expiresAt,
            requestedAt: command.at,
          };
        });
        return;
      }
      case "resolve": {
        const record = this.#requireEntry(command.id);
        if (record.approval === null || record.approval.approvalId !== command.approvalId) return;
        this.#move(command.id, "running", "resolve", command.at, (moved) => {
          moved.approval = null;
        });
        return;
      }
      case "pause": {
        const record = this.#requireEntry(command.id);
        if (record.status === "paused") return;
        if (command.code !== null && FAILURE_TAXONOMY[command.code].status !== "paused") {
          throw new RunTaxonomyError(command.code, "pause");
        }
        this.#move(command.id, "paused", "pause", command.at, (moved) => {
          moved.error =
            command.code === null ? null : failureFor(command.code, command.detail, command.at);
        });
        return;
      }
      case "resume": {
        const record = this.#requireEntry(command.id);
        if (record.status === "running") return;
        if (record.status !== "paused")
          throw new RunTransitionError(record.status, "running", "resume");
        this.#move(command.id, "running", "resume", command.at, (moved) => {
          moved.attempt += 1;
          moved.approval = null;
          moved.error = null;
        });
        return;
      }
      case "seq": {
        const record = this.#requireEntry(command.id);
        if (command.seq <= record.lastSeenSeq) return;
        record.lastSeenSeq = command.seq;
        record.updatedAt = command.at;
        return;
      }
      case "usage": {
        const seen = this.#usageIds.get(command.id) ?? new Set<string>();
        if (seen.has(command.event.usageId)) {
          this.#duplicateUsage.push(command.event.usageId);
          return;
        }
        seen.add(command.event.usageId);
        this.#usageIds.set(command.id, seen);
        const record = this.#requireEntry(command.id);
        record.usage = addUsage(record.usage, command.event);
        record.updatedAt = command.at;
        const events = this.#events.get(command.id) ?? [];
        events.push(command.event);
        this.#events.set(command.id, events);
        return;
      }
      case "finish": {
        const record = this.#requireEntry(command.id);
        if (isTerminal(record.status)) return;
        this.#move(command.id, "done", "finish", command.at, (moved) => {
          moved.error = null;
        });
        return;
      }
      case "fail": {
        const record = this.#requireEntry(command.id);
        if (isTerminal(record.status)) return;
        const entry = FAILURE_TAXONOMY[command.code];
        if (entry.status === "paused") throw new RunTaxonomyError(command.code, "fail");
        this.#move(command.id, entry.status, "fail", command.at, (moved) => {
          moved.error = failureFor(command.code, command.detail, command.at);
          moved.approval = null;
        });
        return;
      }
    }
  }

  #append(command: RunCommand): void {
    if (this.#file === undefined) return;
    if (this.#fd === null) {
      mkdirSync(dirname(this.#file), { recursive: true });
      this.#fd = openSync(this.#file, "a");
    }
    writeSync(this.#fd, `${JSON.stringify(command)}\n`);
    fsyncSync(this.#fd);
  }

  #readAndReplay(): RunLoadReport {
    const loaded = this.#readLines();
    this.#reset();
    const refused: Array<{ line: number; reason: string }> = [];
    let commands = 0;
    for (const [index, line] of loaded.lines.entries()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`run journal line ${index + 1} is not JSON`);
      }
      if (!isRunCommand(parsed)) {
        throw new Error(`run journal line ${index + 1} is not a run command`);
      }
      commands += 1;
      try {
        this.#apply(parsed);
      } catch (error) {
        refused.push({
          line: index + 1,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      commands,
      refused,
      duplicateUsage: [...this.#duplicateUsage],
      tornTrailingLine: loaded.tornTrailingLine,
    };
  }

  /**
   * Read the journal. A file whose last line has no newline ends in a write the process never
   * reported applied, so the tail is dropped and the file repaired in place: left there, it would
   * turn into a malformed line in the middle of the journal as soon as the next command is
   * appended, and poison every later restart.
   */
  #readLines(): { lines: string[]; tornTrailingLine: boolean } {
    if (this.#file === undefined) return { lines: [], tornTrailingLine: false };
    let text: string;
    try {
      text = readFileSync(this.#file, "utf8");
    } catch (error) {
      if (isEnoent(error)) return { lines: [], tornTrailingLine: false };
      throw error;
    }
    if (text.length === 0) return { lines: [], tornTrailingLine: false };
    if (!text.endsWith("\n")) {
      const complete = text.slice(0, text.lastIndexOf("\n") + 1);
      writeFileSync(this.#file, complete);
      return {
        lines: complete.split("\n").filter((line) => line.trim().length > 0),
        tornTrailingLine: true,
      };
    }
    return {
      lines: text.split("\n").filter((line) => line.trim().length > 0),
      tornTrailingLine: false,
    };
  }

  #reset(): void {
    this.#runs.clear();
    this.#usageIds.clear();
    this.#events.clear();
    this.#duplicateUsage.length = 0;
  }
}
