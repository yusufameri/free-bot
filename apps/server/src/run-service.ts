/**
 * The run service: the loop, wired to real ports, and the one run authority in `apps/server`.
 *
 * One `SeqLog` per service instance is the record for every run it starts. Every reader reads that
 * one buffer: `stream()` replays it from a watermark and then follows it live, and the same buffer
 * is what `startTunnelServer({log})` can serve. Nothing here buffers events a second time.
 *
 * The service owns the run's state through `RunStore` and nothing else: `start` creates the record
 * before it launches the loop, so a cancel or a read that arrives in the same tick as `start` sees
 * the run the caller just asked for. The action is the loop's; this file only supplies ports.
 *
 * The model is real when the vault holds a key. `mode` defaults to `auto`, which asks the vault and
 * falls back to the replay transcript on a keyless machine, so the launcher's page gets the model
 * and a keyless machine still runs. The entrypoints the evidence drivers read state `replay`, so a
 * golden run never bills a provider and never varies (order 9). The choice and its reasons are in
 * `docs/RUNNING.md`.
 */

import { type ProviderPort, RunStore, runRunLoop, type SandboxPort, SeqLog } from "@freebot/core";
import type { EventMessage } from "@freebot/protocol";
import { GrantStore } from "@freebot/review";
import { DockerAdapter } from "@freebot/sandbox";
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
  type PendingApprovals,
  RUN_UNIT,
  runToolDefinitions,
} from "./run-ports.ts";
import { readVault, type VaultEntry } from "./vault.ts";

const RUN_IDLE_TTL_MS = 300_000;

/**
 * Suffixes this launch's sandbox names. The run id is `run-<n>` per process, and the sandbox is
 * named from it, so a container a hard-killed launch left behind would collide with the next
 * launch's `run-1` and its run would fail as `sandbox_unavailable`. The user-visible run id stays
 * readable; only the container name carries this tag.
 */
const LAUNCH_TAG = Math.random().toString(36).slice(2, 10);

export interface RunServiceOptions {
  /** Inject a provider, for a test. A factory takes the run's prompt, which is the model's user
   * message, so a keyed provider is built per run. */
  readonly provider?: (prompt: string) => ProviderPort | Promise<ProviderPort>;
  /** Inject a sandbox, so a test drives the endpoints without Docker. A factory gets one port per
   * run, which keeps two concurrent runs off each other's container. */
  readonly sandbox?: SandboxPort | (() => SandboxPort);
  /** Journal path for the run store. Omitted means an in-memory store. */
  readonly file?: string;
  readonly transcript?: string;
  /** How the factory picks the model. `auto` follows the vault, `replay` records, `live` demands a
   * key. Defaults to `auto`. */
  readonly mode?: ProviderMode;
  /** Read the vault, injectable so a test drives the keyed path with no key on the machine. */
  readonly readVaultEntry?: (path?: string) => VaultEntry | null;
  /** Where one line per real turn goes. Defaults to stderr, so a driver can read the run's turns. */
  readonly note?: (line: string) => void;
  readonly now?: () => number;
}

export interface RunService {
  readonly log: SeqLog<EventMessage>;
  readonly store: RunStore;
  readonly grants: GrantStore;
  readonly approvals: PendingApprovals;
  /** Begin a run. Returns before the loop does anything; progress arrives in the log. */
  start(prompt: string): { runId: string };
  cancel(runId: string): boolean;
  answer(approvalId: string, decision: "allow" | "deny"): boolean;
  events(lastSeq: number, limit?: number): { messages: EventMessage[]; lastSeq: number };
  /** The log's messages after `lastSeq`, in seq order, then live until `signal` aborts. */
  stream(lastSeq: number, signal: AbortSignal | undefined): AsyncGenerator<EventMessage>;
  /** Readers currently waiting for an append. Zero once every socket has gone away. */
  readonly subscribers: number;
  /** Resolves once every run this service started has settled. */
  idle(): Promise<void>;
}

export function createRunService(options: RunServiceOptions = {}): RunService {
  const log = new SeqLog<EventMessage>();
  const store = new RunStore(options.file === undefined ? {} : { file: options.file });
  const grants = new GrantStore();
  const refusals = new Set<string>();
  const approvals = createPendingApprovals();
  const now = options.now ?? Date.now;
  const gate = createReviewGate(grants, refusals, { now });
  const cancelled = new Set<string>();
  const inflight: Array<Promise<unknown>> = [];
  const transcript = options.transcript ?? DEFAULT_TRANSCRIPT;
  const vaultEntry = options.readVaultEntry ?? readVault;

  /** One entry per reader waiting for an append; `stream()` adds and drops its own. */
  const waiters = new Set<() => void>();

  /** This run's provider, from the factory's choice. The prompt is the model's user message. */
  async function providerFor(prompt: string): Promise<ProviderPort> {
    if (options.provider !== undefined) return await options.provider(prompt);
    const choice = chooseProvider({
      mode: options.mode ?? "auto",
      vault: vaultEntry(),
      transcript,
    });
    return await createProviderPort(choice, {
      prompt,
      destructive: destructiveTool,
      ...(options.note === undefined ? {} : { note: options.note }),
    });
  }

  /** Resolves on the next append, or as soon as `signal` aborts. */
  function nextAppend(signal: AbortSignal | undefined): {
    promise: Promise<void>;
    drop: () => void;
  } {
    let wake!: () => void;
    const promise = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const stop = () => {
      drop();
      wake();
    };
    const drop = () => {
      waiters.delete(stop);
      signal?.removeEventListener("abort", stop);
    };
    waiters.add(stop);
    signal?.addEventListener("abort", stop);
    return { promise, drop };
  }

  /**
   * The log's messages after `lastSeq`, in seq order, then live.
   *
   * The waiter is registered *before* the log is read, not after. Read-then-wait loses a wake that
   * lands while the reader is between the read and the wait, and the reader then sleeps through
   * every frame the log holds. Register-then-read cannot: an append is either already visible to the
   * read, or it resolves the waiter the read already registered.
   */
  async function* stream(
    lastSeq: number,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<EventMessage> {
    let cursor = lastSeq;
    while (signal?.aborted !== true) {
      const wake = nextAppend(signal);
      try {
        for (const entry of log.since(cursor)) {
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
    log,
    store,
    grants,
    approvals,
    stream,

    get subscribers() {
      return waiters.size;
    },

    start(prompt) {
      const runId = `run-${store.list().length + 1}`;
      // The record exists before the loop's first await, so a cancel or a read in the same tick as
      // this call has a run to address. The loop's own `store.start` for this id is a no-op.
      store.start({
        id: runId,
        threadId: `thread-${runId}`,
        botId: "bot-local",
        prompt,
      });
      const logPort = createLogPort({
        log,
        runId,
        noteSeq: (seq) => void store.noteSeq(runId, seq),
        now,
        onAppend: () => {
          for (const wake of [...waiters]) wake();
        },
      });
      const injected = options.sandbox;
      const sandbox =
        typeof injected === "function"
          ? injected()
          : (injected ?? new DockerRunSandbox(new DockerAdapter({ unit: RUN_UNIT })));
      const run = (async () => {
        const provider = await providerFor(prompt);
        return await runRunLoop(
          {
            sandbox,
            provider,
            gate,
            approvals,
            store,
            log: logPort,
            now,
            cancelled: () => cancelled.has(runId),
          },
          {
            runId,
            threadId: `thread-${runId}`,
            botId: "bot-local",
            prompt,
            sandbox: { name: `${runId}-${LAUNCH_TAG}`, idleTtlMs: RUN_IDLE_TTL_MS },
            tools: runToolDefinitions(),
          },
        );
      })();
      inflight.push(run);
      return { runId };
    },

    cancel(runId) {
      if (store.get(runId) === undefined) return false;
      cancelled.add(runId);
      return true;
    },

    answer(approvalId, decision) {
      return approvals.answer({ approvalId, decision, grants, refusals });
    },

    events(lastSeq, limit) {
      const page = log.since(lastSeq);
      const bounded = limit === undefined ? page : page.slice(0, limit);
      return { messages: bounded.map((entry) => entry.frame), lastSeq: log.lastSeq };
    },

    idle: async () => {
      await Promise.allSettled(inflight);
    },
  };
}
