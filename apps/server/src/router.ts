/**
 * The contract's implementation: four handlers over one `RunService`.
 *
 * The router is built from `apiContract`, so a handler that returns the wrong shape is a compile
 * error and oRPC still validates the input and output on the wire at runtime. `$context` types the
 * per-call context the socket layer injects (the abort signal), and nothing else reads it.
 *
 * Every handler reaches the same authority the loop runs behind, so a run started here executes
 * rather than printing a record of itself. `get_run` projects `packages/core`'s seven run statuses
 * onto the contract's three arms, because the wire's `get_run` is a coarse read: see `PROTOCOL_STATUS`.
 */

import { type RunStatus as CoreRunStatus, isTerminal } from "@freebot/core";
import type { ApiContext } from "@freebot/protocol";
import { apiContract } from "@freebot/protocol";
import { implement, ORPCError } from "@orpc/server";
import type { RunService } from "./run-service.ts";

const api = implement(apiContract).$context<ApiContext>();

/**
 * The contract's coarse status for each of `packages/core`'s seven. `Record` over the core union,
 * so a status the core model adds is a compile error here rather than a silent read of `running`.
 */
const PROTOCOL_STATUS: Record<CoreRunStatus, "running" | "finished" | "failed"> = {
  queued: "running",
  running: "running",
  awaiting_approval: "running",
  paused: "running",
  done: "finished",
  failed: "failed",
  cancelled: "failed",
};

export function createApiRouter(service: RunService) {
  return {
    start_run: api.start_run.handler(({ input }) => ({
      runId: service.start(input.prompt).runId,
    })),

    cancel_run: api.cancel_run.handler(({ input }) => {
      if (!service.cancel(input.runId)) {
        throw new ORPCError("NOT_FOUND", { message: `no such run: ${input.runId}` });
      }
      return { runId: input.runId };
    }),

    get_run: api.get_run.handler(({ input }) => {
      const record = service.store.get(input.runId);
      if (record === undefined) {
        throw new ORPCError("NOT_FOUND", { message: `no such run: ${input.runId}` });
      }
      return {
        runId: record.id,
        status: PROTOCOL_STATUS[record.status],
        prompt: record.prompt,
        startedAt: record.createdAt,
        endedAt: isTerminal(record.status) ? record.updatedAt : null,
        lastSeq: service.log.lastSeq,
      };
    }),

    subscribe_events: api.subscribe_events.handler(({ input, context }) =>
      service.stream(input.lastSeq, context.signal),
    ),
  };
}
