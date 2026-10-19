/**
 * The bot store: Bots and threads as records, one writer, an append-only command journal.
 *
 * The app has three nouns, and this store owns the two that outlive a run. A Bot is a named agent
 * with its own workspace directory, keyed by the Bot's id. A thread is one conversation with one
 * Bot, and it holds many runs: a second run in the same thread appends to the same conversation
 * rather than starting a new one. `RunStore` owns the third (`run`, which names the Bot and the
 * thread it belongs to), so the two stores share one discipline and not one record.
 *
 * A Bot carries a name, a role and a purpose. The name is required at creation; the other two are
 * asked for afterwards, which is why they have their own command rather than a longer `bot.create`:
 * a first-run screen asks for the name first and the purpose on the next pane, and a Bot that was
 * created before its purpose was known must be able to gain one. A journal written before the two
 * fields existed replays with both empty, so no install needs a migration step to keep its Bots.
 *
 * The discipline is `run-store.ts`'s, for the same reasons. Every mutation is a command that gets
 * journaled, and every command is idempotent by record id, so a store that reopens a journal left
 * behind by a crash replays to the same records and a command that arrives twice applies once. A
 * thread cannot be created for a Bot this store does not hold: a dangling thread would make the run
 * path's lookup fail somewhere later, where the reason is no longer visible.
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

/** A named agent. Its id is the key of its workspace directory, so it is a path segment. */
export interface BotRecord {
  id: string;
  name: string;
  /**
   * The short label beside the name, e.g. `Chief of staff`. Empty for a Bot that was never given
   * one, and for every Bot a journal from before this field replays to.
   */
  role: string;
  /**
   * The one line saying what the Bot is for. It is what the first-run screen's second pane asks
   * for, and it is the text a Bot's own system prompt is built from.
   */
  purpose: string;
  createdAt: number;
  updatedAt: number;
  /** A Pinned row sits above the sections. */
  pinned: boolean;
  /** The sidebar section this Bot belongs to. The empty string is the unassigned group. */
  section: string;
  /** Hidden Bots leave the main list and appear under the Hidden Bots disclosure. */
  hidden: boolean;
  /** A group chat: its members are other Bots, and its row reads as a room rather than an agent. */
  group: boolean;
  /** The Bots that take part in a group chat. Empty for every ordinary Bot. */
  members: string[];
}

/** One conversation with one Bot. Runs append to it; it is not recreated per run. */
export interface ThreadRecord {
  id: string;
  botId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export type BotCommand =
  | { op: "bot.create"; id: string; name: string; at: number }
  | { op: "bot.update"; id: string; role: string; purpose: string; at: number }
  | {
      op: "bot.arrange";
      id: string;
      pinned: boolean;
      section: string;
      hidden: boolean;
      group: boolean;
      members: string[];
      at: number;
    }
  | { op: "thread.create"; id: string; botId: string; title: string; at: number };

export const BOT_COMMAND_OPS = [
  "bot.create",
  "bot.update",
  "bot.arrange",
  "thread.create",
] as const;

export interface BotLoadReport {
  /** Lines the journal held and replay accepted as commands. */
  commands: number;
  /** Commands replay refused; empty is the invariant. */
  refused: Array<{ line: number; reason: string }>;
  /** The last line had no newline, so it was never reported applied and was dropped. */
  tornTrailingLine: boolean;
}

export interface BotStoreOptions {
  /** Journal path. Omitted means an in-memory store that persists nothing. */
  file?: string;
  /** Injected clock; every command carries the time it was issued. */
  now?: () => number;
}

export interface CreateBotInput {
  /** Caller-minted and the idempotency key: the same id twice is the same Bot, never a second one. */
  id: string;
  name: string;
}

export interface UpdateBotInput {
  /** The Bot to add the two fields to. An id this store does not hold is refused. */
  id: string;
  /** The short label beside the name; the empty string is allowed and means "not given yet". */
  role: string;
  purpose: string;
}

export interface ArrangeBotInput {
  id: string;
  pinned: boolean;
  section: string;
  hidden: boolean;
  group: boolean;
  members: string[];
}

export interface CreateThreadInput {
  id: string;
  botId: string;
  title: string;
}

/**
 * The id the first Bot takes. It is the id the single-Bot app hard-coded, so a machine that already
 * ran it keeps the workspace directory that Bot's files are in.
 */
export const FIRST_BOT_ID = "bot-local";

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

function view<T>(record: T): T {
  return deepFreeze(structuredClone(record));
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The disk boundary: a journal line must be a complete command before it is applied. */
export function isBotCommand(value: unknown): value is BotCommand {
  if (!isRecordValue(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (typeof value.at !== "number" || !Number.isSafeInteger(value.at)) return false;
  switch (value.op) {
    case "bot.create":
      return typeof value.name === "string" && value.name.length > 0;
    case "bot.update":
      return typeof value.role === "string" && typeof value.purpose === "string";
    case "bot.arrange":
      return (
        typeof value.pinned === "boolean" &&
        typeof value.section === "string" &&
        typeof value.hidden === "boolean" &&
        typeof value.group === "boolean" &&
        Array.isArray(value.members) &&
        value.members.every((member) => typeof member === "string")
      );
    case "thread.create":
      return (
        typeof value.botId === "string" &&
        value.botId.length > 0 &&
        typeof value.title === "string" &&
        value.title.length > 0
      );
    default:
      return false;
  }
}

export class BotStore {
  readonly #bots = new Map<string, BotRecord>();
  readonly #threads = new Map<string, ThreadRecord>();
  readonly #file: string | undefined;
  readonly #now: () => number;
  #fd: number | null = null;
  #loadReport: BotLoadReport;

  constructor(options: BotStoreOptions = {}) {
    this.#file = options.file;
    this.#now = options.now ?? (() => Date.now());
    this.#loadReport = this.#readAndReplay();
  }

  get loadReport(): BotLoadReport {
    return this.#loadReport;
  }

  /** Idempotent per Bot id: a second create of the same id returns the same record, unchanged. */
  createBot(input: CreateBotInput): { record: BotRecord; created: boolean } {
    const existing = this.#bots.get(input.id);
    if (existing !== undefined) return { record: view(existing), created: false };
    const command: BotCommand = {
      op: "bot.create",
      id: input.id,
      name: input.name,
      at: this.#now(),
    };
    this.#commit(command);
    return { record: view(this.#requireBot(input.id)), created: true };
  }

  /**
   * Give a Bot the two fields a name is not: its role and its purpose. Applying the same values
   * twice lands on the same record, so a journal that replayed the command twice converges.
   */
  updateBot(input: UpdateBotInput): BotRecord {
    const command: BotCommand = {
      op: "bot.update",
      id: input.id,
      role: input.role,
      purpose: input.purpose,
      at: this.#now(),
    };
    this.#commit(command);
    return view(this.#requireBot(input.id));
  }

  /** Place a Bot in the sidebar. Applying the same placement twice converges on one record. */
  arrangeBot(input: ArrangeBotInput): BotRecord {
    const command: BotCommand = {
      op: "bot.arrange",
      id: input.id,
      pinned: input.pinned,
      section: input.section,
      hidden: input.hidden,
      group: input.group,
      members: input.members,
      at: this.#now(),
    };
    this.#commit(command);
    return view(this.#requireBot(input.id));
  }

  /** Idempotent per thread id, and refused for a Bot this store does not hold. */
  createThread(input: CreateThreadInput): { record: ThreadRecord; created: boolean } {
    const existing = this.#threads.get(input.id);
    if (existing !== undefined) return { record: view(existing), created: false };
    if (!this.#bots.has(input.botId)) throw new Error(`unknown bot: ${input.botId}`);
    const command: BotCommand = {
      op: "thread.create",
      id: input.id,
      botId: input.botId,
      title: input.title,
      at: this.#now(),
    };
    this.#commit(command);
    return { record: view(this.#requireThread(input.id)), created: true };
  }

  /**
   * The id for the next Bot this store creates: the single-Bot app's id while there is no Bot yet,
   * then `bot-<n>`. The name is not part of it, because the name is editable copy and the id is a
   * directory that files already live in.
   */
  nextBotId(): string {
    return this.#bots.size === 0 ? FIRST_BOT_ID : `bot-${this.#bots.size + 1}`;
  }

  /** The id for the next thread this store creates. Thread ids are unique across every Bot. */
  nextThreadId(): string {
    return `thread-${this.#threads.size + 1}`;
  }

  bot(id: string): BotRecord | undefined {
    const record = this.#bots.get(id);
    return record === undefined ? undefined : view(record);
  }

  /** Every Bot, in creation order. The command journal's order is the tiebreak when two share a tick. */
  bots(): BotRecord[] {
    return [...this.#bots.values()]
      .map((record, index) => ({ record, index }))
      .sort((a, b) => a.record.createdAt - b.record.createdAt || a.index - b.index)
      .map((entry) => view(entry.record));
  }

  thread(id: string): ThreadRecord | undefined {
    const record = this.#threads.get(id);
    return record === undefined ? undefined : view(record);
  }

  /** Every thread of one Bot, in creation order, with the journal's order as the tiebreak. */
  threads(botId: string): ThreadRecord[] {
    return [...this.#threads.values()]
      .map((record, index) => ({ record, index }))
      .filter((entry) => entry.record.botId === botId)
      .sort((a, b) => a.record.createdAt - b.record.createdAt || a.index - b.index)
      .map((entry) => view(entry.record));
  }

  /** The whole store as one deterministic string: the convergence comparison. */
  serializeAll(): string {
    const bots = [...this.#bots.keys()].sort().map((id) => this.#bots.get(id));
    const threads = [...this.#threads.keys()].sort().map((id) => this.#threads.get(id));
    return JSON.stringify({ bots, threads }, null, 2);
  }

  /**
   * Read the journal again from scratch and report whether the state came back the same. An
   * in-memory store has no journal to read, so it reports its current state as converged.
   */
  reload(): { report: BotLoadReport; converged: boolean } {
    if (this.#file === undefined) {
      return {
        report: { commands: 0, refused: [], tornTrailingLine: false },
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

  #commit(command: BotCommand): void {
    this.#apply(command);
    this.#append(command);
  }

  #requireBot(id: string): BotRecord {
    const record = this.#bots.get(id);
    if (record === undefined) throw new Error(`unknown bot: ${id}`);
    return record;
  }

  #requireThread(id: string): ThreadRecord {
    const record = this.#threads.get(id);
    if (record === undefined) throw new Error(`unknown thread: ${id}`);
    return record;
  }

  #apply(command: BotCommand): void {
    switch (command.op) {
      case "bot.create": {
        if (this.#bots.has(command.id)) return;
        this.#bots.set(command.id, {
          id: command.id,
          name: command.name,
          role: "",
          purpose: "",
          createdAt: command.at,
          updatedAt: command.at,
          pinned: false,
          section: "Work",
          hidden: false,
          group: false,
          members: [],
        });
        return;
      }
      case "bot.update": {
        const bot = this.#requireBot(command.id);
        bot.role = command.role;
        bot.purpose = command.purpose;
        bot.updatedAt = command.at;
        return;
      }
      case "bot.arrange": {
        const bot = this.#requireBot(command.id);
        bot.pinned = command.pinned;
        bot.section = command.section;
        bot.hidden = command.hidden;
        bot.group = command.group;
        bot.members = [...command.members];
        bot.updatedAt = command.at;
        return;
      }
      case "thread.create": {
        if (this.#threads.has(command.id)) return;
        if (!this.#bots.has(command.botId)) throw new Error(`unknown bot: ${command.botId}`);
        this.#threads.set(command.id, {
          id: command.id,
          botId: command.botId,
          title: command.title,
          createdAt: command.at,
          updatedAt: command.at,
        });
        return;
      }
    }
  }

  #append(command: BotCommand): void {
    if (this.#file === undefined) return;
    if (this.#fd === null) {
      mkdirSync(dirname(this.#file), { recursive: true });
      this.#fd = openSync(this.#file, "a");
    }
    writeSync(this.#fd, `${JSON.stringify(command)}\n`);
    fsyncSync(this.#fd);
  }

  #readAndReplay(): BotLoadReport {
    const loaded = this.#readLines();
    this.#bots.clear();
    this.#threads.clear();
    const refused: Array<{ line: number; reason: string }> = [];
    let commands = 0;
    for (const [index, line] of loaded.lines.entries()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`bot journal line ${index + 1} is not JSON`);
      }
      if (!isBotCommand(parsed)) {
        throw new Error(`bot journal line ${index + 1} is not a bot command`);
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
    return { commands, refused, tornTrailingLine: loaded.tornTrailingLine };
  }

  /**
   * Read the journal. A file whose last line has no newline ends in a write the process never
   * reported applied, so the tail is dropped and the file repaired in place: left there, it would
   * turn into a malformed line as soon as the next command is appended and poison every restart.
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
}
