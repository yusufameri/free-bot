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
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderPort, SandboxPort } from "@freebot/core";
import { ProviderTurnError } from "@freebot/core";
import type { SandboxSpec } from "@freebot/sandbox";
import {
  createRunService,
  threadJournalPath,
  threadTranscriptPath,
  UnknownRecordError,
} from "./run-service.ts";

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

describe("a stop while the run is parked", () => {
  test("cancel wakes the parked approval and settles the run at cancelled at once", async () => {
    const provider: ProviderPort = {
      async next(input) {
        if (input.turn === 1) {
          return {
            text: [],
            toolCalls: [
              {
                toolCallId: "call_1",
                toolName: "bash",
                args: { command: "echo one" },
                destructive: true,
              },
            ],
          };
        }
        return { text: [], toolCalls: [] };
      },
    };
    const service = createRunService({
      botsRoot: botsRoot(),
      sandbox: noSandbox,
      provider: () => provider,
    });
    const bot = service.createBot("Local Bot");
    const thread = service.createThread(bot.id);
    const { runId } = service.start({ prompt: "one", botId: bot.id, threadId: thread.id });

    const deadline = Date.now() + 2_000;
    while (service.run(runId)?.record.status !== "awaiting_approval") {
      if (Date.now() > deadline) throw new Error("the run never parked");
      await Bun.sleep(5);
    }
    expect(service.approvals.pending()).toHaveLength(1);
    expect(service.cancel(runId)).toBe(true);

    await Promise.race([
      service.idle(),
      Bun.sleep(2_000).then(() => {
        throw new Error("the stop did not wake the parked approval");
      }),
    ]);
    expect(service.run(runId)?.record.status).toBe("cancelled");
    expect(service.approvals.pending()).toEqual([]);
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

  test("a second run whose setup throws settles instead of staying queued", async () => {
    const root = botsRoot();
    const first = createRunService({
      botsRoot: root,
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });
    const bot = first.createBot("Local Bot");
    const thread = first.createThread(bot.id);
    first.start({ prompt: "one", botId: bot.id, threadId: thread.id });
    await first.idle();
    first.close();

    const reopened = createRunService({
      botsRoot: root,
      sandbox: noSandbox,
      provider: () => {
        throw new Error("the model could not be built");
      },
    });
    const started = reopened.start({ prompt: "two", botId: bot.id, threadId: thread.id });
    expect(started.runId).toBe("run-2");
    expect(reopened.run(started.runId)?.record.status).toBe("queued");

    await reopened.idle();

    expect(reopened.run(started.runId)?.record).toMatchObject({
      status: "failed",
      error: { code: "internal_invariant", detail: "the model could not be built" },
    });
    const frames = reopened
      .events(thread.id, 0)
      .messages.filter((frame) => frame.runId === started.runId);
    expect(frames.map((frame) => [frame.type, frame.payload])).toEqual([
      ["run.failed", { reason: "the model could not be built" }],
      ["run.status", { runId: "run-2", status: "failed" }],
    ]);
    reopened.close();
  });

  test("a setup error that names a parked code settles instead of throwing", async () => {
    const service = createRunService({
      botsRoot: botsRoot(),
      sandbox: noSandbox,
      provider: () => {
        throw new ProviderTurnError("sandbox_lost_mid_run", "the sandbox is gone");
      },
    });
    const bot = service.createBot("Local Bot");
    const thread = service.createThread(bot.id);
    const { runId } = service.start({ prompt: "one", botId: bot.id, threadId: thread.id });

    await service.idle();

    expect(service.run(runId)?.record).toMatchObject({
      status: "failed",
      error: { code: "internal_invariant", detail: "the sandbox is gone" },
    });
    expect(
      service.events(thread.id, 0).messages.filter((frame) => frame.runId === runId),
    ).toHaveLength(2);
    service.close();
  });

  test("a boot finishes a setup settlement that never reached the record", async () => {
    const root = botsRoot();
    const first = createRunService({
      botsRoot: root,
      sandbox: noSandbox,
      provider: () => {
        throw new Error("the model could not be built");
      },
    });
    const bot = first.createBot("Local Bot");
    const thread = first.createThread(bot.id);
    const { runId } = first.start({ prompt: "one", botId: bot.id, threadId: thread.id });
    await first.idle();
    first.close();

    // The crash this covers: both ending frames were written, the record never was, and the status
    // frame was lost too. The next boot finishes the ending from the frame that survived.
    const journal = threadJournalPath(root, bot.id, thread.id);
    const commands = readFileSync(journal, "utf8")
      .split("\n")
      .filter((line) => line !== "" && (JSON.parse(line) as { op: string }).op !== "fail");
    writeFileSync(journal, `${commands.join("\n")}\n`);
    const transcript = threadTranscriptPath(root, bot.id, thread.id);
    const records = readFileSync(transcript, "utf8")
      .split("\n")
      .filter((line) => {
        if (line === "") return false;
        const record = JSON.parse(line) as {
          frame: { type: string; payload: { status?: string } };
        };
        return !(record.frame.type === "run.status" && record.frame.payload.status === "failed");
      });
    writeFileSync(transcript, `${records.join("\n")}\n`);

    const reopened = createRunService({
      botsRoot: root,
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });

    expect(reopened.run(runId)?.record).toMatchObject({
      status: "failed",
      error: { code: "internal_invariant", detail: "the model could not be built" },
    });
    expect(
      reopened.events(thread.id, 0).messages.filter((frame) => frame.type === "run.failed"),
    ).toHaveLength(1);
    expect(reopened.events(thread.id, 0).messages.at(-1)?.payload).toEqual({
      runId,
      status: "failed",
    });
    reopened.close();
  });
});

/**
 * A thread's conversation across a restart: what the page replays, and what the boot pass does with
 * a run the last process left in flight. The files themselves are `packages/core`'s subject
 * (`transcript-store.test.ts`); what these assert is the wiring, at the paths the docs name.
 */
describe("a thread's conversation across a restart", () => {
  test("the frames come back, and the next run continues the same seq space", async () => {
    const root = botsRoot();
    const first = createRunService({
      botsRoot: root,
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });
    const bot = first.createBot("Local Bot");
    const thread = first.createThread(bot.id);
    first.start({ prompt: "remember me", botId: bot.id, threadId: thread.id });
    await first.idle();
    const before = first.events(thread.id, 0).messages;
    first.close();

    const transcript = threadTranscriptPath(root, bot.id, thread.id);
    expect(transcript).toBe(join(root, bot.id, "threads", thread.id, "transcript.jsonl"));
    const written = readFileSync(transcript, "utf8")
      .split("\n")
      .filter((line) => line !== "");
    expect(written).toHaveLength(before.length);
    expect(JSON.parse(written[0] as string)).toEqual({ seq: 1, frame: before[0] });

    const reopened = createRunService({
      botsRoot: root,
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });
    const after = reopened.events(thread.id, 0).messages;
    expect(after).toEqual(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((frame, index) => frame.seq === index + 1)).toBe(true);
    expect(reopened.audit(thread.id)).toMatchObject({
      firstSeq: 1,
      lastSeq: before.length,
      count: before.length,
      gaps: [],
      duplicates: [],
    });
    // The cursor means the same thing on either side of the restart: a client that had read the
    // whole conversation is owed nothing, and one that reads it again gets the same frames.
    expect(reopened.events(thread.id, before.length).messages).toEqual([]);

    const second = reopened.start({ prompt: "and again", botId: bot.id, threadId: thread.id });
    await reopened.idle();
    expect(reopened.run(second.runId)?.record.status).toBe("done");
    const continued = reopened.events(thread.id, 0).messages;
    expect(continued.slice(before.length).map((frame) => frame.seq)).toEqual(
      before.map((_frame, index) => before.length + index + 1),
    );
    expect(continued[before.length]?.payload).toEqual({ prompt: "and again" });
    reopened.close();
  });

  test("a run the last process left in flight is settled where the page can see it", async () => {
    const root = botsRoot();
    const stuck: ProviderPort = { next: () => new Promise(() => {}) };
    const first = createRunService({
      botsRoot: root,
      sandbox: noSandbox,
      provider: () => stuck,
    });
    const bot = first.createBot("Local Bot");
    const thread = first.createThread(bot.id);
    const { runId } = first.start({ prompt: "hold the line", botId: bot.id, threadId: thread.id });
    const deadline = Date.now() + 2_000;
    while (first.run(runId)?.record.status !== "running") {
      if (Date.now() > deadline) throw new Error("the run never reached its provider");
      await Bun.sleep(5);
    }
    const inflight = first.events(thread.id, 0).messages.length;
    first.close();

    const reopened = createRunService({
      botsRoot: root,
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });
    expect(reopened.run(runId)?.record.status).toBe("failed");
    expect(reopened.run(runId)?.record.error).toEqual({
      code: "server_restart",
      detail: null,
      at: expect.any(Number),
    });
    const frames = reopened.events(thread.id, 0).messages;
    expect(frames.slice(inflight).map((frame) => [frame.type, frame.seq])).toEqual([
      ["run.failed", inflight + 1],
      ["run.status", inflight + 2],
    ]);
    expect(frames[inflight]?.payload).toEqual({
      reason: "FreeBot stopped while this run was in flight.",
    });

    // The ending is in the transcript, so a second restart settles nothing a second time.
    reopened.close();
    const third = createRunService({
      botsRoot: root,
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });
    expect(third.run(runId)?.record.status).toBe("failed");
    expect(
      third.events(thread.id, 0).messages.filter((frame) => frame.type === "run.failed"),
    ).toHaveLength(1);
    expect(third.audit(thread.id)).toMatchObject({ gaps: [], duplicates: [] });
    third.close();
  });

  test("a boot finishes an ending the last process got half way through", async () => {
    const root = botsRoot();
    const stuck: ProviderPort = { next: () => new Promise(() => {}) };
    const first = createRunService({
      botsRoot: root,
      sandbox: noSandbox,
      provider: () => stuck,
    });
    const bot = first.createBot("Local Bot");
    const thread = first.createThread(bot.id);
    const { runId } = first.start({ prompt: "hold the line", botId: bot.id, threadId: thread.id });
    const deadline = Date.now() + 2_000;
    while (first.run(runId)?.record.status !== "running") {
      if (Date.now() > deadline) throw new Error("the run never reached its provider");
      await Bun.sleep(5);
    }
    const inflight = first.events(thread.id, 0).messages.length;
    first.close();

    // The crash this covers: the process wrote the first ending frame and died before the second, so
    // the record is still the running one it was and the transcript ends one frame short.
    const transcript = threadTranscriptPath(root, bot.id, thread.id);
    const held = readFileSync(transcript, "utf8")
      .split("\n")
      .filter((line) => line !== "");
    const last = JSON.parse(held[held.length - 1] as string) as { frame: Record<string, unknown> };
    const endingFrame = {
      ...last.frame,
      seq: inflight + 1,
      type: "run.failed",
      payload: { reason: "FreeBot stopped while this run was in flight." },
    };
    writeFileSync(
      transcript,
      `${held.join("\n")}\n${JSON.stringify({ seq: inflight + 1, frame: endingFrame })}\n`,
    );

    const second = createRunService({
      botsRoot: root,
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });
    expect(second.run(runId)?.record.status).toBe("failed");
    // The frame the crash never wrote is the only one this boot adds: the ending it did write is
    // kept rather than written a second time.
    expect(
      second
        .events(thread.id, 0)
        .messages.slice(inflight)
        .map((frame) => frame.type),
    ).toEqual(["run.failed", "run.status"]);
    expect(
      second.events(thread.id, 0).messages.filter((f) => f.type === "run.failed"),
    ).toHaveLength(1);
    expect(second.audit(thread.id)).toMatchObject({ gaps: [], duplicates: [] });
    second.close();

    // A record the taxonomy already failed at this code goes through the same repair, because the
    // transcript can still be short of the frame that record was failed for.
    const withoutStatus = readFileSync(transcript, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .filter((line) => {
        const record = JSON.parse(line) as {
          frame: { type: string; payload: { status?: string } };
        };
        return !(record.frame.type === "run.status" && record.frame.payload.status === "failed");
      });
    writeFileSync(transcript, `${withoutStatus.join("\n")}\n`);

    const third = createRunService({
      botsRoot: root,
      sandbox: noSandbox,
      provider: () => immediateProvider,
    });
    expect(third.events(thread.id, 0).messages.slice(inflight)).toEqual([
      endingFrame,
      expect.objectContaining({ type: "run.status", payload: { runId, status: "failed" } }),
    ]);
    expect(third.audit(thread.id)).toMatchObject({ gaps: [], duplicates: [] });
    third.close();
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
