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
 * The connector surface's four arms are the second group that does not reach the run path: list,
 * connect, test and remove read and write the person's own two files through one registry, and the
 * row they answer with names the credential's reference rather than its value.
 *
 * A Bot and a thread are named, never inferred. `start_run` refuses a Bot or a thread this server
 * does not hold, by name, so a caller that sends a stale id is told which one is gone instead of
 * getting a run in some other conversation.
 */

import { type RunStatus as CoreRunStatus, isTerminal } from "@freebot/core";
import type { ApiContext, ConnectorRow } from "@freebot/protocol";
import {
  apiContract,
  BOT_ERRORS,
  CONNECTOR_ERRORS,
  WORKSPACE_READ_ERRORS,
} from "@freebot/protocol";
import { implement, ORPCError } from "@orpc/server";
import { type ConnectorRecord, ConnectorRegistry, UnknownConnectorError } from "./connectors.ts";
import { createProviderSetup, type ProviderSetup } from "./provider-setup.ts";
import { type RunService, UnknownRecordError } from "./run-service.ts";
import { WorkspaceReadError } from "./workspace-files.ts";

const api = implement(apiContract).$context<ApiContext>();

/** One Bot record as the contract reports it, in one place so every arm agrees. */
function botDto(
  bot: {
    id: string;
    name: string;
    role: string;
    purpose: string;
    createdAt: number;
    pinned: boolean;
    section: string;
    hidden: boolean;
    group: boolean;
    members: string[];
  },
  threadCount: number,
) {
  return {
    botId: bot.id,
    name: bot.name,
    role: bot.role,
    purpose: bot.purpose,
    createdAt: bot.createdAt,
    threadCount,
    pinned: bot.pinned,
    section: bot.section,
    hidden: bot.hidden,
    group: bot.group,
    members: bot.members,
  };
}

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

/**
 * The connector surface. All four arms read and write the registry the launcher built over the
 * person's own two files, and none of them can answer with a credential: a row carries the
 * credential's reference and the only place a header value exists is the vault file.
 *
 * `list_connectors` probes every connector once and a failed probe is a row in the `unreachable`
 * state, because a surface that lists connectors has to show the broken one. `connect_connector` and
 * `test_connector` answer the same row shape, so the surface renders one thing everywhere.
 */
function connectorRow(row: ConnectorRecord): ConnectorRow {
  return {
    id: row.id,
    label: row.label,
    url: row.url,
    ref: row.ref,
    state: row.state,
    detail: row.detail,
    tools: [...row.tools],
    testedAt: row.testedAt,
  };
}

export function createApiRouter(
  service: RunService,
  providers: ProviderSetup = createProviderSetup(),
  connectors: ConnectorRegistry = ConnectorRegistry.open(),
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
      bots: service.listBots().map(({ bot, threadCount }) => botDto(bot, threadCount)),
    })),

    create_bot: api.create_bot.handler(({ input }) => botDto(service.createBot(input.name), 0)),

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
      return botDto(bot, service.registry.threads(bot.id).length);
    }),

    /**
     * The sidebar's own write: pin, hide, section and a group's members are fields on the record, so
     * a partial patch reads the current values and writes all of them back. A record this server does
     * not hold is refused by name, the same way `update_bot` refuses one.
     */
    arrange_bot: api.arrange_bot.handler(({ input }) => {
      const current = service.registry.bot(input.botId);
      if (current === undefined) {
        throw new ORPCError("bot_not_found", {
          message: BOT_ERRORS.bot_not_found.message,
          status: BOT_ERRORS.bot_not_found.status,
        });
      }
      const bot = service.registry.arrangeBot({
        id: current.id,
        pinned: input.pinned ?? current.pinned,
        section: input.section ?? current.section,
        hidden: input.hidden ?? current.hidden,
        group: input.group ?? current.group,
        members: input.members ?? current.members,
      });
      return botDto(bot, service.registry.threads(bot.id).length);
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
     * The connector surface's four arms. See `connectorRow` for why the row is the same shape
     * everywhere: connect, test and list answer one thing, so a surface renders one thing.
     */
    list_connectors: api.list_connectors.handler(async () => ({
      connectors: (await connectors.list()).map(connectorRow),
    })),

    connect_connector: api.connect_connector.handler(async ({ input }) =>
      connectorRow(await connectors.connect(input)),
    ),

    test_connector: api.test_connector.handler(async ({ input }) => {
      try {
        return connectorRow(await connectors.test(input.id));
      } catch (error) {
        refuse(error);
      }
    }),

    /**
     * Removing one this install does not hold is a `removed: false` answer rather than a refusal, so
     * a surface can send the same removal twice and the end state is the same either way.
     */
    remove_connector: api.remove_connector.handler(({ input }) => connectors.remove(input.id)),
  };
}
