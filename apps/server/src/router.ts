/**
 * The contract's implementation: four handlers over one `ControlPlane`.
 *
 * The router is built from `apiContract`, so a handler that returns the wrong shape is a compile
 * error and oRPC still validates the input and output on the wire at runtime. `$context` types the
 * per-call context the socket layer injects (the abort signal), and nothing else reads it.
 */

import type { ApiContext } from "@freebot/protocol";
import { apiContract } from "@freebot/protocol";
import { implement, ORPCError } from "@orpc/server";
import type { ControlPlane } from "./control-plane.ts";

const api = implement(apiContract).$context<ApiContext>();

export function createApiRouter(control: ControlPlane) {
  return {
    start_run: api.start_run.handler(({ input }) => ({
      runId: control.startRun(input.prompt).runId,
    })),

    cancel_run: api.cancel_run.handler(({ input }) => {
      if (control.cancelRun(input.runId) === undefined) {
        throw new ORPCError("NOT_FOUND", { message: `no such run: ${input.runId}` });
      }
      return { runId: input.runId };
    }),

    get_run: api.get_run.handler(({ input }) => {
      const run = control.getRun(input.runId);
      if (run === undefined) {
        throw new ORPCError("NOT_FOUND", { message: `no such run: ${input.runId}` });
      }
      return {
        runId: run.runId,
        status: run.status,
        prompt: run.prompt,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        lastSeq: control.log.lastSeq,
      };
    }),

    subscribe_events: api.subscribe_events.handler(({ input, context }) =>
      control.stream(input.lastSeq, context.signal),
    ),
  };
}
