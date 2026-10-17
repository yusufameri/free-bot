/**
 * The run endpoints: the loop, wired to real ports, behind HTTP.
 *
 * One `SeqLog` per service instance is the record for every run it starts, and every reader reads
 * that one buffer: `GET /runs/events` pages it by watermark, and `startTunnelServer({log})` can
 * serve the same buffer over the stream. Nothing here buffers events a second time.
 *
 * The provider defaults to the replay transcript, because gate G1 parks the keyed path: a run
 * started today replays the committed turn's call and waits for the human. A keyed provider is a
 * later unit's swap of one factory.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ProviderPort,
  ProviderTurnError,
  RunStore,
  runRunLoop,
  type SandboxPort,
  SeqLog,
} from "@freebot/core";
import {
  approveInput,
  cancelRunInput,
  denyInput,
  type EventMessage,
  getEventsInput,
  startRunInput,
} from "@freebot/protocol";
import { GrantStore } from "@freebot/review";
import { DockerAdapter } from "@freebot/sandbox";
import { Hono } from "hono";
import { ReplayProvider, readTranscript, turnForTool, turnsInBlock } from "./replay-provider.ts";
import {
  createLogPort,
  createPendingApprovals,
  createReviewGate,
  DockerRunSandbox,
  type PendingApprovals,
  RUN_UNIT,
  runToolDefinitions,
} from "./run-ports.ts";

const DEFAULT_TRANSCRIPT = join(
  fileURLToPath(new URL("../../../", import.meta.url)),
  "packages/pi-bridge/fixtures/rpc-handshake.jsonl",
);

const RUN_IDLE_TTL_MS = 300_000;

export interface RunServiceOptions {
  /** Inject a provider, for a test or for the keyed path once G1 clears. */
  readonly provider?: () => ProviderPort | Promise<ProviderPort>;
  /** Inject a sandbox, so a test drives the endpoints without Docker. */
  readonly sandbox?: SandboxPort;
  /** Journal path for the run store. Omitted means an in-memory store. */
  readonly file?: string;
  readonly transcript?: string;
  readonly now?: () => number;
}

export interface RunService {
  readonly log: SeqLog<EventMessage>;
  readonly store: RunStore;
  readonly grants: GrantStore;
  readonly approvals: PendingApprovals;
  /** Begin a run. Returns before the run does anything; progress arrives in the log. */
  start(prompt: string): { runId: string };
  cancel(runId: string): boolean;
  answer(approvalId: string, decision: "allow" | "deny"): boolean;
  events(lastSeq: number, limit?: number): { messages: EventMessage[]; lastSeq: number };
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

  async function providerFor(): Promise<ProviderPort> {
    if (options.provider !== undefined) return await options.provider();
    const turns = await readTranscript(transcript);
    const block = turnForTool(turns, "bash");
    if (block === undefined) {
      throw new ProviderTurnError(
        "provider_malformed_tool_call",
        `the replay transcript holds no bash call: ${transcript}`,
      );
    }
    return new ReplayProvider(turnsInBlock(block));
  }

  return {
    log,
    store,
    grants,
    approvals,

    start(prompt) {
      const runId = `run-${store.list().length + 1}`;
      const logPort = createLogPort({
        log,
        runId,
        noteSeq: (seq) => void store.noteSeq(runId, seq),
        now,
      });
      const sandbox =
        options.sandbox ?? new DockerRunSandbox(new DockerAdapter({ unit: RUN_UNIT }));
      const run = (async () => {
        const provider = await providerFor();
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
            sandbox: { name: runId, idleTtlMs: RUN_IDLE_TTL_MS },
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

/** The routes, validated at the boundary with the landed DTOs. */
export function runRoutes(service: RunService): Hono {
  const routes = new Hono();

  routes.post("/runs", async (c) => {
    const parsed = startRunInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid" }, 400);
    return c.json(service.start(parsed.data.prompt), 202);
  });

  routes.post("/runs/:runId/cancel", async (c) => {
    const parsed = cancelRunInput.safeParse({ runId: c.req.param("runId") });
    if (!parsed.success) return c.json({ error: "invalid run id" }, 400);
    return c.json({ runId: parsed.data.runId, cancelled: service.cancel(parsed.data.runId) });
  });

  routes.get("/runs/events", (c) => {
    const parsed = getEventsInput.safeParse({
      lastSeq: Number(c.req.query("last_seq") ?? "0"),
      ...(c.req.query("limit") === undefined ? {} : { limit: Number(c.req.query("limit")) }),
    });
    if (!parsed.success)
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid" }, 400);
    return c.json(service.events(parsed.data.lastSeq, parsed.data.limit));
  });

  for (const decision of ["allow", "deny"] as const) {
    routes.post(`/approvals/:approvalId/${decision}`, async (c) => {
      const schema = decision === "allow" ? approveInput : denyInput;
      const parsed = schema.safeParse({ approvalId: c.req.param("approvalId") });
      if (!parsed.success) return c.json({ error: "invalid approval id" }, 400);
      const answered = service.answer(parsed.data.approvalId, decision);
      return c.json(
        { approvalId: parsed.data.approvalId, decision, answered },
        answered ? 202 : 404,
      );
    });
  }

  return routes;
}
