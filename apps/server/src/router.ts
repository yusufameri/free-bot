/**
 * The contract's implementation: six handlers over one `RunService`.
 *
 * The router is built from `apiContract`, so a handler that returns the wrong shape is a compile
 * error and oRPC still validates the input and output on the wire at runtime. `$context` types the
 * per-call context the socket layer injects (the abort signal), and nothing else reads it.
 *
 * Every handler reaches the same authority the loop runs behind, so a run started here executes
 * rather than printing a record of itself. `get_run` projects `packages/core`'s seven run statuses
 * onto the contract's three arms, because the wire's `get_run` is a coarse read: see `PROTOCOL_STATUS`.
 * The two workspace reads reach the same `RunService` and therefore the same directory the runs
 * mount, so the page reads the computer rather than a second copy of it.
 */

import { type RunStatus as CoreRunStatus, isTerminal } from "@freebot/core";
import type { ApiContext } from "@freebot/protocol";
import { apiContract, WORKSPACE_READ_ERRORS } from "@freebot/protocol";
import { implement, ORPCError } from "@orpc/server";
import type { RunService } from "./run-service.ts";
import { WorkspaceReadError } from "./workspace-files.ts";

const api = implement(apiContract).$context<ApiContext>();

/**
 * A workspace refusal raised as the wire's own error. The refusal's name IS the code, so a surface
 * branches on `error.code`, and its status comes from the one table the contract declares it with.
 * A code oRPC does not know answers 500 unless its status is set here, which would make a refused
 * path read as a server fault.
 */
function refuseRead(error: unknown): never {
  if (error instanceof WorkspaceReadError) {
    throw new ORPCError(error.refusal, {
      message: error.message,
      status: WORKSPACE_READ_ERRORS[error.refusal].status,
    });
  }
  throw error;
}

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

    list_files: api.list_files.handler(async ({ input }) => {
      try {
        return await service.listFiles(input.path);
      } catch (error) {
        refuseRead(error);
      }
    }),

    read_file: api.read_file.handler(async ({ input }) => {
      try {
        return await service.readFile(input.path);
      } catch (error) {
        refuseRead(error);
      }
    }),
  };
}
