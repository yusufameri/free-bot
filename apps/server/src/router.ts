/**
 * The contract's implementation: eleven handlers over one `RunService`, plus page 1's two arms.
 *
 * The router is built from `apiContract`, so a handler that returns the wrong shape is a compile
 * error and oRPC still validates the input and output on the wire at runtime. `$context` types the
 * per-call context the socket layer injects (the abort signal), and nothing else reads it.
 *
 * `update_bot` is the one arm that reaches `RunService`'s registry rather than one of its methods:
 * a Bot's role and purpose are fields on the record, and the registry is the record's own owner, so
 * routing the write through the run service would add a pass-through and nothing else.
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
import {
  apiContract,
  BOT_ERRORS,
  CONNECTOR_ERRORS,
  WORKSPACE_READ_ERRORS,
} from "@freebot/protocol";
import { implement, ORPCError } from "@orpc/server";
import { ConnectorRegistry, UnknownConnectorError } from "./connectors.ts";
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
  if (error instanceof UnknownConnectorError) {
    throw new ORPCError("connector_not_found", {
      message: error.message,
      status: CONNECTOR_ERRORS.connector_not_found.status,
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
  connectors: ConnectorRegistry = ConnectorRegistry.fromEntries([]),
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
        role: bot.role,
        purpose: bot.purpose,
        createdAt: bot.createdAt,
        threadCount,
      })),
    })),

    create_bot: api.create_bot.handler(({ input }) => {
      const bot = service.createBot(input.name);
      return {
        botId: bot.id,
        name: bot.name,
        role: bot.role,
        purpose: bot.purpose,
        createdAt: bot.createdAt,
        threadCount: 0,
      };
    }),

    /**
     * The Bot record's own arm, read straight off the registry this service exposes: a Bot's role
     * and purpose are facts about the record, and no run path is involved in writing them.
     */
    update_bot: api.update_bot.handler(({ input }) => {
      if (service.registry.bot(input.botId) === undefined) {
        throw new ORPCError("bot_not_found", {
          message: BOT_ERRORS.bot_not_found.message,
          status: BOT_ERRORS.bot_not_found.status,
        });
      }
      const bot = service.registry.updateBot({
        id: input.botId,
        role: input.role,
        purpose: input.purpose,
      });
      return {
        botId: bot.id,
        name: bot.name,
        role: bot.role,
        purpose: bot.purpose,
        createdAt: bot.createdAt,
        threadCount: service.registry.threads(bot.id).length,
      };
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

    /**
     * The connector surface. Both arms read the registry the launcher built from the person's own
     * file, and neither can answer with a credential: a row carries the credential's reference.
     * The arrays are copied here because the contract's shape is mutable and the seam's is not.
     */
    list_connectors: api.list_connectors.handler(async () => ({
      connectors: (await connectors.list()).map((row) => ({
        id: row.id,
        url: row.url,
        ref: row.ref,
        tools: [...row.tools],
        health: row.health,
      })),
    })),

    test_connector: api.test_connector.handler(async ({ input }) => {
      try {
        const tested = await connectors.test(input.id);
        return { ...tested, tools: [...tested.tools] };
      } catch (error) {
        refuse(error);
      }
    }),
  };
}
