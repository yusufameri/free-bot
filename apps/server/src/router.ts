/**
 * The contract's implementation: ten handlers over one `RunService`, plus page 1's two arms.
 *
 * The router is built from `apiContract`, so a handler that returns the wrong shape is a compile
 * error and oRPC still validates the input and output on the wire at runtime. `$context` types the
 * per-call context the socket layer injects (the abort signal), and nothing else reads it.
 *
 * `get_provider` and `connect_provider` are the two arms that do not reach the run path. The second
 * one writes the vault and answers with what its test found, so its input is the only place in the
 * contract a key appears: nothing here returns it, and the record it saves has no field for it.
 *
 * Every handler reaches the same authority the loop runs behind, so a run started here executes
 * rather than printing a record of itself. `get_run` projects `packages/core`'s seven run statuses
 * onto the contract's three arms, because the wire's `get_run` is a coarse read: see
 * `PROTOCOL_STATUS`. The two workspace reads reach the same `RunService` and therefore the same
 * directory the named Bot's runs mount, so the page reads that Bot's computer rather than a second
 * copy of it.
 *
 * A Bot and a thread are named, never inferred. `start_run` refuses a Bot or a thread this server
 * does not hold, by name, so a caller that sends a stale id is told which one is gone instead of
 * getting a run in some other conversation.
 */

import { type RunStatus as CoreRunStatus, isTerminal } from "@freebot/core";
import type { ApiContext } from "@freebot/protocol";
import { apiContract, BOT_ERRORS, WORKSPACE_READ_ERRORS } from "@freebot/protocol";
import { implement, ORPCError } from "@orpc/server";
import { createProviderSetup, type ProviderSetup } from "./provider-setup.ts";
import { type RunService, UnknownRecordError } from "./run-service.ts";
import { WorkspaceReadError } from "./workspace-files.ts";

const api = implement(apiContract).$context<ApiContext>();

/**
 * A refusal raised as the wire's own error. The refusal's name IS the code, so a surface branches on
 * `error.code`, and its status comes from the one table the contract declares it with. A code oRPC
 * does not know answers 500 unless its status is set here, which would make a refused path or a
 * missing Bot read as a server fault.
 */
function refuse(error: unknown): never {
  if (error instanceof WorkspaceReadError) {
    throw new ORPCError(error.refusal, {
      message: error.message,
      status: WORKSPACE_READ_ERRORS[error.refusal].status,
    });
  }
  if (error instanceof UnknownRecordError) {
    throw new ORPCError(error.refusal, {
      message: error.message,
      status: BOT_ERRORS[error.refusal].status,
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

export function createApiRouter(
  service: RunService,
  providers: ProviderSetup = createProviderSetup(),
) {
  return {
    start_run: api.start_run.handler(({ input }) => {
      try {
        return { runId: service.start(input).runId };
      } catch (error) {
        refuse(error);
      }
    }),

    cancel_run: api.cancel_run.handler(({ input }) => {
      if (!service.cancel(input.runId)) {
        throw new ORPCError("NOT_FOUND", { message: `no such run: ${input.runId}` });
      }
      return { runId: input.runId };
    }),

    get_run: api.get_run.handler(({ input }) => {
      const found = service.run(input.runId);
      if (found === undefined) {
        throw new ORPCError("NOT_FOUND", { message: `no such run: ${input.runId}` });
      }
      return {
        runId: found.record.id,
        status: PROTOCOL_STATUS[found.record.status],
        prompt: found.record.prompt,
        startedAt: found.record.createdAt,
        endedAt: isTerminal(found.record.status) ? found.record.updatedAt : null,
        lastSeq: service.audit(found.threadId).lastSeq,
      };
    }),

    subscribe_events: api.subscribe_events.handler(({ input, context }) =>
      service.stream(input.threadId, input.lastSeq, context.signal),
    ),

    list_bots: api.list_bots.handler(() => ({
      bots: service.listBots().map(({ bot, threadCount }) => ({
        botId: bot.id,
        name: bot.name,
        createdAt: bot.createdAt,
        threadCount,
      })),
    })),

    create_bot: api.create_bot.handler(({ input }) => {
      const bot = service.createBot(input.name);
      return { botId: bot.id, name: bot.name, createdAt: bot.createdAt, threadCount: 0 };
    }),

    list_threads: api.list_threads.handler(({ input }) => {
      try {
        return {
          threads: service.listThreads(input.botId).map(({ thread, runs }) => ({
            threadId: thread.id,
            botId: thread.botId,
            title: thread.title,
            createdAt: thread.createdAt,
            runs: runs.map((record) => ({
              runId: record.id,
              prompt: record.prompt,
              status: record.status,
              startedAt: record.createdAt,
            })),
          })),
        };
      } catch (error) {
        refuse(error);
      }
    }),

    create_thread: api.create_thread.handler(({ input }) => {
      try {
        const thread = service.createThread(input.botId, input.title);
        return {
          threadId: thread.id,
          botId: thread.botId,
          title: thread.title,
          createdAt: thread.createdAt,
          runs: [],
        };
      } catch (error) {
        refuse(error);
      }
    }),

    list_files: api.list_files.handler(async ({ input }) => {
      try {
        return await service.listFiles(input.botId, input.path);
      } catch (error) {
        refuse(error);
      }
    }),

    read_file: api.read_file.handler(async ({ input }) => {
      try {
        return await service.readFile(input.botId, input.path);
      } catch (error) {
        refuse(error);
      }
    }),

    get_provider: api.get_provider.handler(() => providers.describe()),

    connect_provider: api.connect_provider.handler(
      async ({ input }) => await providers.connect(input),
    ),
  };
}
