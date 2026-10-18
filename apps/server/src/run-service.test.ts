/**
 * The run service's own contract: the three records a run sits inside, and the properties the
 * surface tests over oRPC and the transports cannot show.
 *
 * What is left here is what those two cannot express: that a Bot, a thread and a run all exist
 * before the loop's first await, that two runs in one thread share one seq space, that two Bots have
 * two workspace directories, and that a second process over the same bots root brings every record
 * and every run back.
 *
 * Every service below is built with a sandbox that starts nothing, so no test here needs Docker: the
 * runs still execute, and what they execute in is not what any of these assertions are about.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderPort, SandboxPort } from "@freebot/core";
import type { SandboxSpec } from "@freebot/sandbox";
import { createRunService, UnknownRecordError } from "./run-service.ts";

/** One turn of text and no call, so a run finishes in the few frames it can. */
/** Creates nothing and runs nothing, so a test that starts a run needs no container. */
const noSandbox: SandboxPort = {
  async create() {},
  async execute() {
    throw new Error("this test starts no tool call");
  },
  async destroy() {},
};

const immediateProvider: ProviderPort = {
  async next() {
    return { text: ["ok"], toolCalls: [] };
  },
};

/** A bots root of this test's own, so nothing here reads or writes a Bot a person has run. */
function botsRoot(): string {
  return mkdtempSync(join(tmpdir(), "freebot-run-service-"));
}

describe("a Bot, a thread, and a run inside them", () => {
  test("two runs in one thread share one seq space and both finish", async () => {
    const service = createRunService({
      botsRoot: botsRoot(),
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });
    const bot = service.createBot("Local Bot");
    const thread = service.createThread(bot.id);

    const first = service.start({ prompt: "one", botId: bot.id, threadId: thread.id });
    const second = service.start({ prompt: "two", botId: bot.id, threadId: thread.id });
    await service.idle();

    expect(service.run(first.runId)?.record.status).toBe("done");
    expect(service.run(second.runId)?.record.status).toBe("done");

    const frames = service.events(thread.id, 0).messages;
    expect(frames.every((frame, index) => frame.seq === index + 1)).toBe(true);
    expect([...new Set(frames.map((frame) => frame.runId))].sort()).toEqual([
      first.runId,
      second.runId,
    ]);
    expect(service.audit(thread.id)).toMatchObject({
      firstSeq: 1,
      count: frames.length,
      gaps: [],
      duplicates: [],
      rejected: 0,
    });
    // The thread is the conversation: both runs are in it, in the order they were asked for.
    const held = service.listThreads(bot.id)[0];
    expect(held?.runs.map((record) => record.prompt)).toEqual(["one", "two"]);
  });

  test("both records exist before the loop's first await, and the run names them", async () => {
    const service = createRunService({
      botsRoot: botsRoot(),
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });
    const bot = service.createBot("Local Bot");
    const thread = service.createThread(bot.id);

    const started = service.start({ prompt: "one", botId: bot.id, threadId: thread.id });

    // Read in the same tick, before any await: the record is already there to be addressed.
    expect(service.run(started.runId)).toMatchObject({
      botId: bot.id,
      threadId: thread.id,
      record: { prompt: "one", status: "queued" },
    });
    await service.idle();
  });

  test("two subscribers both see every frame, in seq order", async () => {
    const service = createRunService({
      botsRoot: botsRoot(),
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });
    const bot = service.createBot("Local Bot");
    const thread = service.createThread(bot.id);
    const controller = new AbortController();
    const seen: number[][] = [[], []];
    const pumps = seen.map(async (list) => {
      for await (const message of service.stream(thread.id, 0, controller.signal)) {
        list.push(message.seq);
      }
    });

    const { runId } = service.start({ prompt: "one", botId: bot.id, threadId: thread.id });
    await service.idle();

    const deadline = Date.now() + 2_000;
    while (
      Date.now() < deadline &&
      !seen.every((list) => list.length === service.audit(thread.id).lastSeq)
    ) {
      await Bun.sleep(10);
    }
    controller.abort();
    await Promise.all(pumps);

    expect(service.run(runId)?.record.status).toBe("done");
    expect(seen[0]?.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]?.every((seq, index) => seq === index + 1)).toBe(true);
  });

  test("one thread's frames are not another thread's, and each log starts at its own seq 1", async () => {
    const service = createRunService({
      botsRoot: botsRoot(),
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });
    const bot = service.createBot("Local Bot");
    const first = service.createThread(bot.id);
    const second = service.createThread(bot.id);

    service.start({ prompt: "in the first", botId: bot.id, threadId: first.id });
    await service.idle();

    expect(service.events(first.id, 0).messages[0]?.payload).toEqual({ prompt: "in the first" });
    expect(service.events(second.id, 0).messages).toEqual([]);
  });

  test("a Bot or a thread this server does not hold is refused by name", async () => {
    const service = createRunService({
      botsRoot: botsRoot(),
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });
    const bot = service.createBot("Local Bot");
    const thread = service.createThread(bot.id);
    const other = service.createBot("Other");

    expect(() => service.start({ prompt: "x", botId: "bot-nowhere", threadId: thread.id })).toThrow(
      "no such Bot: bot-nowhere",
    );
    expect(() => service.start({ prompt: "x", botId: bot.id, threadId: "thread-9" })).toThrow(
      UnknownRecordError,
    );
    expect(() => service.start({ prompt: "x", botId: bot.id, threadId: "thread-9" })).toThrow(
      "no such thread: thread-9",
    );
    // A thread belongs to one Bot: naming it under another is a lookup that failed, not a move.
    expect(() => service.start({ prompt: "x", botId: other.id, threadId: thread.id })).toThrow(
      "no such thread: thread-1",
    );
    expect(() => service.listThreads("bot-nowhere")).toThrow("no such Bot: bot-nowhere");
    expect(() => service.createThread("bot-nowhere")).toThrow("no such Bot: bot-nowhere");
    expect(service.listBots().map(({ bot: record }) => record.name)).toEqual([
      "Local Bot",
      "Other",
    ]);
  });
});

describe("the Bot's workspace", () => {
  test("every run mounts this Bot's own directory at /workspace", async () => {
    const specs: SandboxSpec[] = [];
    const service = createRunService({
      botsRoot: botsRoot(),
      sandbox: {
        async create(spec) {
          specs.push(spec);
        },
        async execute() {
          throw new Error("this test starts no tool call");
        },
        async destroy() {},
      },
      provider: () => immediateProvider,
    });
    const bot = service.createBot("Local Bot");
    const thread = service.createThread(bot.id);

    service.start({ prompt: "one", botId: bot.id, threadId: thread.id });
    await service.idle();

    expect(specs.map((spec) => spec.mounts)).toEqual([
      [{ host: service.workspaceFor(bot.id), container: "/workspace" }],
    ]);
  });

  test("a file in one Bot's workspace is not in another Bot's", async () => {
    const root = botsRoot();
    const service = createRunService({
      botsRoot: root,
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });
    const first = service.createBot("First");
    const second = service.createBot("Second");

    writeFileSync(join(service.workspaceFor(first.id), "note.txt"), "mine\n");

    // The reader reports the real path, which is the same directory under another name on macOS.
    expect(service.workspaceFor(first.id)).toBe(realpathSync(join(root, first.id, "workspace")));
    expect(service.workspaceFor(second.id)).toBe(realpathSync(join(root, second.id, "workspace")));
    expect((await service.readFile(first.id, "note.txt")).text).toBe("mine\n");
    expect((await service.listFiles(second.id, ".")).entries).toEqual([]);
    expect(
      await service.readFile(second.id, "note.txt").catch((error: Error) => error.message),
    ).toBe("path_not_found: note.txt");
  });

  test("a workspace read for a Bot this server does not hold creates nothing and is refused", async () => {
    const root = botsRoot();
    const service = createRunService({
      botsRoot: root,
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });

    expect(await service.listFiles("bot-nowhere", ".").catch((error: Error) => error.message)).toBe(
      "no such Bot: bot-nowhere",
    );
    expect(await Bun.file(join(root, "bot-nowhere")).exists()).toBe(false);
  });
});

describe("a second process over the same bots root", () => {
  test("brings back every Bot, every thread and every run", async () => {
    const root = botsRoot();
    const first = createRunService({
      botsRoot: root,
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });
    const bot = first.createBot("Local Bot");
    const other = first.createBot("Second");
    const thread = first.createThread(bot.id);
    first.createThread(other.id);
    const { runId } = first.start({ prompt: "remember me", botId: bot.id, threadId: thread.id });
    await first.idle();
    first.close();

    const reopened = createRunService({
      botsRoot: root,
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });

    expect(
      reopened.listBots().map(({ bot: record, threadCount }) => [record.name, threadCount]),
    ).toEqual([
      ["Local Bot", 1],
      ["Second", 1],
    ]);
    expect(
      reopened.listThreads(bot.id)[0]?.runs.map((record) => [record.id, record.prompt]),
    ).toEqual([[runId, "remember me"]]);
    expect(reopened.registry.loadReport).toEqual({
      commands: 4,
      refused: [],
      tornTrailingLine: false,
    });
    reopened.close();
  });

  test("run ids continue past the runs the last process recorded", async () => {
    const root = botsRoot();
    const first = createRunService({
      botsRoot: root,
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });
    const bot = first.createBot("Local Bot");
    const thread = first.createThread(bot.id);
    expect(first.start({ prompt: "one", botId: bot.id, threadId: thread.id }).runId).toBe("run-1");
    await first.idle();
    first.close();

    const reopened = createRunService({
      botsRoot: root,
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });
    expect(reopened.start({ prompt: "two", botId: bot.id, threadId: thread.id }).runId).toBe(
      "run-2",
    );
    await reopened.idle();
    expect(reopened.listThreads(bot.id)[0]?.runs.map((record) => record.id)).toEqual([
      "run-1",
      "run-2",
    ]);
    reopened.close();
  });
});

describe("the bots root a service runs over", () => {
  const saved = { workspace: process.env.FREEBOT_WORKSPACE, home: process.env.FREEBOT_HOME };

  function withEnv(env: { FREEBOT_WORKSPACE?: string; FREEBOT_HOME?: string }): () => void {
    if (env.FREEBOT_WORKSPACE === undefined) delete process.env.FREEBOT_WORKSPACE;
    else process.env.FREEBOT_WORKSPACE = env.FREEBOT_WORKSPACE;
    if (env.FREEBOT_HOME === undefined) delete process.env.FREEBOT_HOME;
    else process.env.FREEBOT_HOME = env.FREEBOT_HOME;
    return () => {
      if (saved.workspace === undefined) delete process.env.FREEBOT_WORKSPACE;
      else process.env.FREEBOT_WORKSPACE = saved.workspace;
      if (saved.home === undefined) delete process.env.FREEBOT_HOME;
      else process.env.FREEBOT_HOME = saved.home;
    };
  }

  test("FREEBOT_WORKSPACE moves the whole set, so a driver lands in its own directory", () => {
    const scratch = realpathSync(botsRoot());
    const restore = withEnv({ FREEBOT_WORKSPACE: scratch });
    try {
      const service = createRunService({ sandbox: noSandbox, provider: () => immediateProvider });
      expect(service.workspacesRoot).toBe(scratch);
      const bot = service.createBot("Local Bot");
      expect(existsSync(join(scratch, "index.jsonl"))).toBe(true);
      expect(bot.id).toBe("bot-local");
      service.close();
    } finally {
      restore();
    }
  });

  test("the option still wins over the variable, and an empty variable means the default", () => {
    const explicit = realpathSync(botsRoot());
    const restore = withEnv({ FREEBOT_WORKSPACE: realpathSync(botsRoot()) });
    try {
      expect(createRunService({ botsRoot: explicit, sandbox: noSandbox }).workspacesRoot).toBe(
        explicit,
      );
    } finally {
      restore();
    }

    const home = realpathSync(botsRoot());
    const restoreDefault = withEnv({ FREEBOT_WORKSPACE: "", FREEBOT_HOME: home });
    try {
      expect(createRunService({ sandbox: noSandbox }).workspacesRoot).toBe(join(home, "bots"));
    } finally {
      restoreDefault();
    }
  });
});
