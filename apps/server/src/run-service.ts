/**
 * The run service: the loop, wired to real ports, and the one run authority in `apps/server`.
 *
 * The service is organized around the three nouns, and each one owns its own state:
 *
 * - A Bot is a record (`BotStore`) and a host directory, `botsRoot/<botId>/workspace`, which every
 *   run of that Bot mounts at `/workspace`. Two Bots cannot see each other's files, because the
 *   mount is this Bot's directory and nothing else.
 * - A thread is a record, one conversation with one Bot, and it owns three things on disk: its run
 *   journal, `botsRoot/<botId>/threads/<threadId>/runs.jsonl`, its transcript,
 *   `botsRoot/<botId>/threads/<threadId>/transcript.jsonl`, and its log, which is that transcript.
 *   One log per thread is what makes a conversation's seq space its own, so the page can show one
 *   thread's frames and only that thread's; one transcript per thread is what makes those frames
 *   outlive the process, so the conversation a person was reading is the one they come back to.
 * - A run belongs to both. `start` names the Bot and the thread, refuses either if it is not there,
 *   and creates the run's record before it launches the loop, so a cancel or a read that arrives in
 *   the same tick as `start` sees the run the caller just asked for.
 *
 * Every thread the registry holds is opened at boot, so a restart brings back every Bot, every
 * thread and every run the last process had, and `list_bots` / `list_threads` answer from the same
 * records the run path reads. A run the last process left in flight is settled at boot: the record
 * says `failed`, and the transcript carries the two frames that say why (see `settleAbandoned`). The
 * files that hold this are described in `docs/bots-and-threads.md` and `docs/transcript.md`.
 *
 * The model is real when the vault holds a key. `mode` defaults to `auto`, which asks the vault and
 * falls back to the replay transcript on a keyless machine, so the launcher's page gets the model
 * and a keyless machine still runs. The entrypoints the evidence drivers read state `replay`, so a
 * golden run never bills a provider and never varies (order 9). The choice and its reasons are in
 * `docs/RUNNING.md`.
 */

import { join } from "node:path";
import type { Connector } from "@freebot/connectors";
import {
  type BotRecord,
  BotStore,
  failureEntry,
  isTerminal,
  type ProviderPort,
  type RunRecord,
  RunStore,
  runRunLoop,
  type SandboxPort,
  type SeqLog,
  type ThreadRecord,
  type TokenPrices,
  TranscriptStore,
} from "@freebot/core";
import {
  type BotRefusal,
  type EventMessage,
  eventMessageSchema,
  type ListFilesOutput,
  type ReadFileOutput,
} from "@freebot/protocol";
import { GrantStore } from "@freebot/review";
import { DockerAdapter } from "@freebot/sandbox";
import { envWorkspace } from "./cli/args.ts";
import {
  chooseProvider,
  createProviderPort,
  DEFAULT_TRANSCRIPT,
  type ProviderMode,
} from "./provider.ts";
import {
  createLogPort,
  createPendingApprovals,
  createReviewGate,
  DockerRunSandbox,
  destructiveTool,
  governedTools,
  type PendingApprovals,
  RUN_UNIT,
  RUN_WORKSPACE,
  type RunTool,
  RunToolExecutor,
  runToolDefinitions,
  runToolsFor,
} from "./run-ports.ts";
import { freebotHome, readVault, type VaultEntry } from "./vault.ts";
import {
  botWorkspacePath,
  createWorkspaceReader,
  type WorkspaceReader,
} from "./workspace-files.ts";

const RUN_IDLE_TTL_MS = 300_000;

/**
 * Suffixes this launch's sandbox names. The run id is `run-<n>` per process, and the sandbox is
 * named from it, so a container a hard-killed launch left behind would collide with the next
 * launch's `run-1` and its run would fail as `sandbox_unavailable`. The user-visible run id stays
 * readable; only the container name carries this tag.
 */
const LAUNCH_TAG = Math.random().toString(36).slice(2, 10);

/** The Bot registry's file name inside the bots root. */
export const REGISTRY_FILE = "index.jsonl";

/** The default title a thread carries until a person renames it. */
export const NEW_THREAD_TITLE = "New conversation";

/** One thread's run journal, the file a restart brings that thread's run records back from. */
export function threadJournalPath(root: string, botId: string, threadId: string): string {
  return join(root, botId, "threads", threadId, "runs.jsonl");
}

/** One thread's transcript, the file a restart brings that thread's conversation back from. */
export function threadTranscriptPath(root: string, botId: string, threadId: string): string {
  return join(root, botId, "threads", threadId, "transcript.jsonl");
}

/**
 * A caller named a Bot or a thread this server does not hold. The refusal name is what the wire
 * reports, so a surface can branch on it instead of matching a sentence.
 */
export class UnknownRecordError extends Error {
  readonly refusal: BotRefusal;
  /** The id the caller named. */
  readonly id: string;

  constructor(refusal: BotRefusal, id: string) {
    super(`${refusal === "bot_not_found" ? "no such Bot" : "no such thread"}: ${id}`);
    this.name = "UnknownRecordError";
    this.refusal = refusal;
    this.id = id;
  }
}

export interface RunServiceOptions {
  /** Inject a provider, for a test. A factory takes the run's prompt, which is the model's user
   * message, so a keyed provider is built per run. */
  readonly provider?: (prompt: string) => ProviderPort | Promise<ProviderPort>;
  /** Inject a sandbox, so a test drives the endpoints without Docker. A factory gets one port per
   * run, which keeps two concurrent runs off each other's container. */
  readonly sandbox?: SandboxPort | (() => SandboxPort);
  /** The directory that holds the Bot registry and one workspace per Bot. Defaults to the bots
   * directory under the freebot home, which is where the single-Bot app already kept its own. */
  readonly botsRoot?: string;
  readonly transcript?: string;
  /**
   * The connectors this server's runs may call. Each contributes one governed tool arm per tool its
   * server offers, so the run's table is built once per run, when the run starts. A supplier rather
   * than a list, so a connector connected while this server is up is offered to the next run; the
   * credential is read from the vault at call time either way. Empty by default: a machine nobody
   * has connected anything on runs exactly as it did before.
   */
  readonly connectors?: () => readonly Connector[];
  /** How the factory picks the model. `auto` follows the vault, `replay` records, `live` demands a
   * key. Defaults to `auto`. */
  readonly mode?: ProviderMode;
  /** Read the vault, injectable so a test drives the keyed path with no key on the machine. */
  readonly readVaultEntry?: (path?: string) => VaultEntry | null;
  /**
   * The per-run spend ceiling in integer nano-USD. The loop consults it before each provider turn
   * against the run's settled usage. Omitted means a run is uncapped.
   */
  readonly spendCapNanoUsd?: number;
  /**
   * What a token costs on the configured model, so the keyed adapter can turn the provider's token
   * usage into the nano-USD the cap compares. Omitted means the adapter reports no cost and the cap
   * has nothing to measure; the operator path configures both together.
   */
  readonly prices?: TokenPrices;
  /** Where one line per real turn goes. Defaults to stderr, so a driver can read the run's turns. */
  readonly note?: (line: string) => void;
  readonly now?: () => number;
}

/** One Bot and the count the sidebar renders beside its name. */
export interface BotSummary {
  readonly bot: BotRecord;
  readonly threadCount: number;
}

/** One thread and its conversation: the runs that append to it, oldest first. */
export interface ThreadSummary {
  readonly thread: ThreadRecord;
  readonly runs: RunRecord[];
}

export interface StartRunInput {
  readonly prompt: string;
  readonly botId: string;
  readonly threadId: string;
}

export interface RunService {
  /** The Bot registry: every Bot and thread record this server holds. */
  readonly registry: BotStore;
  /** The directory holding one workspace per Bot. */
  readonly workspacesRoot: string;
  readonly grants: GrantStore;
  readonly approvals: PendingApprovals;
  /** Every Bot, in creation order, with its thread count. */
  listBots(): BotSummary[];
  /** Create a Bot. The id is minted here, because it keys the Bot's workspace directory. */
  createBot(name: string): BotRecord;
  /** Every thread of one Bot, in creation order, each with its conversation. Refused by name when
   * the Bot is not one this server holds. */
  listThreads(botId: string): ThreadSummary[];
  createThread(botId: string, title?: string): ThreadRecord;
  /** The run's record and the two records it belongs to, or undefined for a run it never held. */
  run(runId: string): { record: RunRecord; botId: string; threadId: string } | undefined;
  /** The host directory a Bot's runs mount at `/workspace`. */
  workspaceFor(botId: string): string;
  /** Begin a run in a Bot's thread. Returns before the loop does anything; progress is in the log. */
  start(input: StartRunInput): { runId: string };
  cancel(runId: string): boolean;
  answer(approvalId: string, decision: "allow" | "deny"): boolean;
  /** One thread's messages after `lastSeq`, up to `limit`. */
  events(
    threadId: string,
    lastSeq: number,
    limit?: number,
  ): { messages: EventMessage[]; lastSeq: number };
  /** One thread's log audit, which is what its `stream.hello` reports. */
  audit(threadId: string): ReturnType<SeqLog<EventMessage>["audit"]>;
  /** One thread's messages after `lastSeq`, in seq order, then live until `signal` aborts. */
  stream(
    threadId: string,
    lastSeq: number,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<EventMessage>;
  /** One directory of a Bot's workspace, refused by name when it is not one. */
  listFiles(botId: string, path: string): Promise<ListFilesOutput>;
  /** One UTF-8 file of a Bot's workspace, refused by name when it is not one. */
  readFile(botId: string, path: string): Promise<ReadFileOutput>;
  /** Readers currently waiting for an append, across every thread. Zero once every socket is gone. */
  readonly subscribers: number;
  /** Resolves once every run this service started has settled. */
  idle(): Promise<void>;
  /** Release every journal this service holds open. */
  close(): void;
}

/** One thread's own state: its record, its run journal, its log, and the readers waiting on it. */
interface ThreadRuntime {
  readonly thread: ThreadRecord;
  readonly store: RunStore;
  /** The thread's frames: the log the stream serves from, and the file they survive in. */
  readonly log: TranscriptStore<EventMessage>;
  readonly waiters: Set<() => void>;
}

export function createRunService(options: RunServiceOptions = {}): RunService {
  const workspacesRoot = resolveBotsRoot(options.botsRoot);
  const now = options.now ?? Date.now;
  const registry = new BotStore({ file: join(workspacesRoot, REGISTRY_FILE), now });
  const grants = new GrantStore();
  const refusals = new Set<string>();
  const approvals = createPendingApprovals();
  const cancelled = new Set<string>();
  const inflight: Array<Promise<unknown>> = [];
  const transcript = options.transcript ?? DEFAULT_TRANSCRIPT;
  const connectors = options.connectors ?? (() => []);
  const vaultEntry = options.readVaultEntry ?? readVault;
  const runtimes = new Map<string, ThreadRuntime>();
  const readers = new Map<string, WorkspaceReader>();
  /** The run's thread, so a run id alone reaches the record and the log it belongs to. */
  const runThreads = new Map<string, string>();
  /** Run ids count across every thread and continue from the runs a previous process recorded. */
  let runSerial = 0;

  /** The run's record and the two records it belongs to, or undefined for a run it never held. */
  function runOf(
    runId: string,
  ): { record: RunRecord; botId: string; threadId: string } | undefined {
    const threadId = runThreads.get(runId);
    if (threadId === undefined) return undefined;
    const runtime = runtimes.get(threadId);
    if (runtime === undefined) return undefined;
    const record = runtime.store.get(runId);
    if (record === undefined) return undefined;
    return { record, botId: runtime.thread.botId, threadId };
  }

  function requireBot(botId: string): BotRecord {
    const bot = registry.bot(botId);
    if (bot === undefined) throw new UnknownRecordError("bot_not_found", botId);
    return bot;
  }

  /**
   * The thread's runtime, opened from its record. Every thread the registry holds has one by the
   * time this returns: they are opened at boot and by `createThread`, so a run can never find a
   * thread without the record that owns it.
   */
  function runtimeFor(threadId: string): ThreadRuntime {
    const runtime = runtimes.get(threadId);
    if (runtime === undefined) throw new UnknownRecordError("thread_not_found", threadId);
    return runtime;
  }

  /**
   * Settle a run the process holding it did not outlive.
   *
   * The record survives a restart; the loop driving it does not. Left alone it stays `running` and
   * the page replays a conversation that will never gain another frame, so the boot pass ends it at
   * the code the taxonomy already declares for this (`server_restart`) rather than inventing a
   * reason here.
   *
   * Both ending frames are appended before the record is failed, because the transcript is what the
   * page reads: a crash between the two writes then leaves a conversation that already ends, and the
   * next boot sees the frame, keeps it, and fails the record instead of appending a second ending.
   * Each frame is asked for separately, since a crash can land between them, and a run the taxonomy
   * has already failed at this code is repaired too, for the same reason.
   *
   * A `paused` run is left alone. The taxonomy parks a run that can be rejoined, so its status is a
   * wait rather than an ending, and a restart is not evidence that the wait ended. `queued`,
   * `running` and `awaiting_approval` all mean a loop is (or just was) driving this run.
   */
  function settleAbandoned(runtime: ThreadRuntime, record: RunRecord): void {
    const restartFailure = record.error?.code === "server_restart";
    if (record.status === "paused" || (isTerminal(record.status) && !restartFailure)) return;
    const ending = failureEntry("server_restart");
    const frames = runtime.log.since(0).filter((entry) => entry.frame.runId === record.id);
    const hasFailFrame = frames.some((entry) => entry.frame.type === "run.failed");
    const hasFailedStatus = frames.some(
      (entry) => entry.frame.type === "run.status" && entry.frame.payload.status === "failed",
    );
    const logPort = createLogPort({
      log: runtime.log,
      runId: record.id,
      noteSeq: (seq) => void runtime.store.noteSeq(record.id, seq),
      now,
    });
    if (!hasFailFrame) logPort.append("run.failed", { reason: ending.copy });
    if (!hasFailedStatus) logPort.append("run.status", { runId: record.id, status: "failed" });
    runtime.store.fail(record.id, "server_restart", null);
  }

  function openRuntime(thread: ThreadRecord): ThreadRuntime {
    const store = new RunStore({
      file: threadJournalPath(workspacesRoot, thread.botId, thread.id),
      now,
    });
    const runtime: ThreadRuntime = {
      thread,
      store,
      log: new TranscriptStore<EventMessage>({
        file: threadTranscriptPath(workspacesRoot, thread.botId, thread.id),
        isFrame: (value): value is EventMessage => eventMessageSchema.safeParse(value).success,
      }),
      waiters: new Set(),
    };
    runtimes.set(thread.id, runtime);
    const runs = store.list();
    for (const record of runs) runThreads.set(record.id, thread.id);
    runSerial = Math.max(runSerial, runs.length);
    for (const record of runs) settleAbandoned(runtime, record);
    return runtime;
  }

  for (const bot of registry.bots()) {
    for (const thread of registry.threads(bot.id)) openRuntime(thread);
  }

  /** The reader over one Bot's workspace directory, created on first use. */
  function readerFor(botId: string): WorkspaceReader {
    requireBot(botId);
    const existing = readers.get(botId);
    if (existing !== undefined) return existing;
    const created = createWorkspaceReader(botWorkspacePath(workspacesRoot, botId));
    readers.set(botId, created);
    return created;
  }

  /**
   * This run's provider, from the factory's choice. The prompt is the model's user message, and the
   * run's own tool table decides which calls the gate governs.
   */
  async function providerFor(prompt: string, tools: readonly RunTool[]): Promise<ProviderPort> {
    if (options.provider !== undefined) return await options.provider(prompt);
    const choice = chooseProvider({
      mode: options.mode ?? "auto",
      vault: vaultEntry(),
      transcript,
    });
    return await createProviderPort(choice, {
      prompt,
      destructive: (name) => destructiveTool(name, tools),
      tools: governedTools(tools),
      ...(options.prices === undefined ? {} : { prices: options.prices }),
      ...(options.note === undefined ? {} : { note: options.note }),
    });
  }

  /** Resolves on the next append in this thread, or as soon as `signal` aborts. */
  function nextAppend(
    runtime: ThreadRuntime,
    signal: AbortSignal | undefined,
  ): { promise: Promise<void>; drop: () => void } {
    let wake!: () => void;
    const promise = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const stop = () => {
      drop();
      wake();
    };
    const drop = () => {
      runtime.waiters.delete(stop);
      signal?.removeEventListener("abort", stop);
    };
    runtime.waiters.add(stop);
    signal?.addEventListener("abort", stop);
    return { promise, drop };
  }

  /**
   * The thread's messages after `lastSeq`, in seq order, then live.
   *
   * The waiter is registered *before* the log is read, not after. Read-then-wait loses a wake that
   * lands while the reader is between the read and the wait, and the reader then sleeps through
   * every frame the log holds. Register-then-read cannot: an append is either already visible to the
   * read, or it resolves the waiter the read already registered.
   */
  async function* stream(
    threadId: string,
    lastSeq: number,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<EventMessage> {
    const runtime = runtimeFor(threadId);
    let cursor = lastSeq;
    while (signal?.aborted !== true) {
      const wake = nextAppend(runtime, signal);
      try {
        for (const entry of runtime.log.since(cursor)) {
          cursor = entry.seq;
          yield entry.frame;
        }
        await wake.promise;
      } finally {
        wake.drop();
      }
    }
  }

  return {
    registry,
    workspacesRoot,
    grants,
    approvals,
    stream,

    listBots() {
      return registry.bots().map((bot) => ({
        bot,
        threadCount: registry.threads(bot.id).length,
      }));
    },

    createBot(name) {
      const id = registry.nextBotId();
      return registry.createBot({ id, name }).record;
    },

    listThreads(botId) {
      requireBot(botId);
      return registry.threads(botId).map((thread) => ({
        thread,
        runs: runtimeFor(thread.id).store.list(),
      }));
    },

    createThread(botId, title) {
      requireBot(botId);
      const id = registry.nextThreadId();
      const created = registry.createThread({ id, botId, title: title ?? NEW_THREAD_TITLE }).record;
      openRuntime(created);
      return created;
    },

    run: runOf,

    workspaceFor: (botId) => readerFor(botId).root,

    get subscribers() {
      let waiting = 0;
      for (const runtime of runtimes.values()) waiting += runtime.waiters.size;
      return waiting;
    },

    start(input) {
      const bot = requireBot(input.botId);
      const runtime = runtimeFor(input.threadId);
      if (runtime.thread.botId !== bot.id) {
        // A thread belongs to one Bot. Naming it under another Bot is a lookup that failed, not a
        // thread to move, and starting a run there would write into the wrong Bot's conversation.
        throw new UnknownRecordError("thread_not_found", input.threadId);
      }
      runSerial += 1;
      const runId = `run-${runSerial}`;
      runThreads.set(runId, runtime.thread.id);
      // The record exists before the loop's first await, so a cancel or a read in the same tick as
      // this call has a run to address. The loop's own `store.start` for this id is a no-op.
      runtime.store.start({
        id: runId,
        threadId: runtime.thread.id,
        botId: bot.id,
        prompt: input.prompt,
      });
      const logPort = createLogPort({
        log: runtime.log,
        runId,
        noteSeq: (seq) => void runtime.store.noteSeq(runId, seq),
        now,
        onAppend: () => {
          for (const wake of [...runtime.waiters]) wake();
        },
      });
      const injected = options.sandbox;
      const sandbox =
        typeof injected === "function"
          ? injected()
          : (injected ?? new DockerRunSandbox(new DockerAdapter({ unit: RUN_UNIT })));
      const run = (async () => {
        // The run's table, discovered when the run starts: the landed arms, plus one arm per tool
        // the run's connectors offer. A connector that cannot be reached right now contributes no
        // arms and says so on the note line, rather than failing a run that the other tools could
        // still finish.
        const tools = await runToolsFor(connectors(), options.note);
        const provider = await providerFor(input.prompt, tools);
        return await runRunLoop(
          {
            sandbox: new RunToolExecutor(sandbox, tools),
            provider,
            gate: createReviewGate(grants, refusals, { now, tools }),
            approvals,
            store: runtime.store,
            log: logPort,
            now,
            cancelled: () => cancelled.has(runId),
          },
          {
            runId,
            threadId: runtime.thread.id,
            botId: bot.id,
            prompt: input.prompt,
            sandbox: {
              name: `${runId}-${LAUNCH_TAG}`,
              idleTtlMs: RUN_IDLE_TTL_MS,
              // This Bot's workspace is the container's `/workspace`. A run's container is destroyed
              // when the run ends, so the files a run produced would go with it; the mount is what
              // makes them outlive the run, and it is what keeps one Bot's files out of another's.
              mounts: [{ host: readerFor(bot.id).root, container: RUN_WORKSPACE }],
            },
            tools: runToolDefinitions(tools),
            ...(options.spendCapNanoUsd === undefined
              ? {}
              : { spendCapNanoUsd: options.spendCapNanoUsd }),
          },
        );
      })();
      inflight.push(run);
      return { runId };
    },

    cancel(runId) {
      if (runOf(runId) === undefined) return false;
      cancelled.add(runId);
      // A run parked at the gate is waiting on a promise, not on the loop's next check: wake it so
      // the stop lands now. The loop reads its cancelled flag before the answer, so this wake
      // records no decision.
      approvals.cancelRun(runId);
      return true;
    },

    answer(approvalId, decision) {
      return approvals.answer({ approvalId, decision, grants, refusals });
    },

    events(threadId, lastSeq, limit) {
      const runtime = runtimeFor(threadId);
      const page = runtime.log.since(lastSeq);
      const bounded = limit === undefined ? page : page.slice(0, limit);
      return { messages: bounded.map((entry) => entry.frame), lastSeq: runtime.log.lastSeq };
    },

    audit(threadId) {
      return runtimeFor(threadId).log.audit();
    },

    listFiles: async (botId, path) => await readerFor(botId).list(path),
    readFile: async (botId, path) => await readerFor(botId).read(path),

    idle: async () => {
      await Promise.allSettled(inflight);
    },

    close: () => {
      for (const runtime of runtimes.values()) {
        runtime.store.close();
        runtime.log.close();
      }
      registry.close();
    },
  };
}

/**
 * The bots root a service runs over: the option, then `FREEBOT_WORKSPACE`, then the default under
 * the freebot home.
 *
 * The variable is the documented way to move the whole set, and `bun run up` already honors it by
 * passing the option through. A server started directly has to mean the same thing by it, or a
 * driver that points the variable at a scratch directory gets the machine's own Bots instead: that
 * is how a run id in one driver's assertion came to depend on what another driver had left behind.
 */
function resolveBotsRoot(option: string | undefined): string {
  return option ?? envWorkspace() ?? join(freebotHome(), "bots");
}
