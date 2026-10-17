import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_PAYLOADS } from "@freebot/protocol";
import { type RunCommand, RunStore, type RunStoreOptions } from "./run-store.ts";
import { costNanoUsd, noTokens, type TokenPrices, type UsageEvent } from "./run-usage.ts";

const PRICES: TokenPrices = {
  inputPerMTok: "3.00",
  outputPerMTok: "15.00",
  cacheReadPerMTok: "0.30",
  cacheWritePerMTok: "3.75",
};

const HASH = `v1:sha256:${"c".repeat(64)}`;

function journal(name = "runs.jsonl"): string {
  return join(mkdtempSync(join(tmpdir(), "freebot-run-store-")), name);
}

/** A store with a clock the test drives, so every timestamp in an assertion is a literal. */
function storeAt(clock: { at: number }, options: RunStoreOptions = {}): RunStore {
  return new RunStore({ ...options, now: () => clock.at });
}

function usage(usageId: string, input: number): UsageEvent {
  const tokens = { ...noTokens(), input };
  return {
    usageId,
    provider: "openai",
    model: "gpt-4o",
    tokens,
    costNanoUsd: costNanoUsd(PRICES, tokens),
  };
}

function refusal(attempt: () => unknown): Error {
  try {
    attempt();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the store to refuse this");
}

function parkInput(approvalId = "approval-1"): Parameters<RunStore["park"]>[1] {
  return {
    approvalId,
    toolCallId: "call_step_2",
    command: "rm -f /scratch/task/doomed.txt",
    actionHash: HASH,
    expiresAt: 61_000,
  };
}

/** Start, begin, and return the store mid-run: the state most of these assertions begin from. */
function runningRun(clock: { at: number }, options: RunStoreOptions = {}): RunStore {
  const store = storeAt(clock, options);
  store.start({ id: "run-1", threadId: "thread-1", botId: "bot-1", prompt: "echo one" });
  store.begin("run-1");
  return store;
}

describe("the run record", () => {
  test("start parks the run at queued and begin moves it to running", () => {
    const clock = { at: 1_000 };
    const store = storeAt(clock);

    const started = store.start({
      id: "run-1",
      threadId: "thread-1",
      botId: "bot-1",
      prompt: "echo one",
    });

    expect(started.created).toBe(true);
    expect(started.record).toEqual({
      id: "run-1",
      threadId: "thread-1",
      botId: "bot-1",
      status: "queued",
      prompt: "echo one",
      lastSeenSeq: 0,
      attempt: 1,
      approval: null,
      usage: {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costNanoUsd: 0,
        byModel: {},
      },
      error: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    expect(store.begin("run-1").status).toBe("running");
    expect(store.get("run-1")?.status).toBe("running");
    expect(store.get("nope")).toBeUndefined();
    expect(store.list().map((record) => record.id)).toEqual(["run-1"]);
  });

  test("the parked record carries the card the shell renders", () => {
    const clock = { at: 1_000 };
    const store = runningRun(clock);

    const parked = store.park("run-1", parkInput());

    expect(parked.status).toBe("awaiting_approval");
    expect(parked.approval).toEqual({
      approvalId: "approval-1",
      toolCallId: "call_step_2",
      command: "rm -f /scratch/task/doomed.txt",
      actionHash: HASH,
      expiresAt: 61_000,
      requestedAt: 1_000,
    });
  });

  test("a parked record can build a valid approval.requested payload", () => {
    const clock = { at: 1_000 };
    const parked = runningRun(clock).park("run-1", parkInput()).approval;

    expect(parked).not.toBeNull();
    const { approvalId, toolCallId, command, actionHash, expiresAt } = parked ?? {
      approvalId: "",
      toolCallId: "",
      command: "",
      actionHash: "",
      expiresAt: 0,
    };
    const parsed = EVENT_PAYLOADS["approval.requested"].safeParse({
      approvalId,
      toolCallId,
      command,
      actionHash,
      expiresAt,
    });

    expect(parsed.success).toBe(true);
  });

  test("the smoke's lifecycle runs status by status, ending at done with attempt 2", () => {
    const clock = { at: 1_000 };
    const store = runningRun(clock);
    const seen: string[] = [store.get("run-1")?.status ?? ""];

    seen.push(store.park("run-1", parkInput()).status);
    seen.push(store.resolveApproval("run-1", "approval-1").status);
    store.noteSeq("run-1", 58);
    seen.push(store.pause("run-1", { code: "sandbox_lost_mid_run" }).status);
    seen.push(store.resume("run-1").status);
    seen.push(store.finish("run-1").status);

    expect(seen).toEqual(["running", "awaiting_approval", "running", "paused", "running", "done"]);
    expect(store.get("run-1")).toEqual({
      id: "run-1",
      threadId: "thread-1",
      botId: "bot-1",
      status: "done",
      prompt: "echo one",
      lastSeenSeq: 58,
      attempt: 2,
      approval: null,
      usage: {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costNanoUsd: 0,
        byModel: {},
      },
      error: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
  });

  test("a lost sandbox parks the run with its reason, and resuming clears it", () => {
    const clock = { at: 1_000 };
    const store = runningRun(clock);

    const paused = store.pause("run-1", { code: "sandbox_lost_mid_run" });

    expect(paused.status).toBe("paused");
    expect(paused.error).toEqual({ code: "sandbox_lost_mid_run", detail: null, at: 1_000 });
    expect(paused.attempt).toBe(1);
    expect(store.resume("run-1").error).toBeNull();
    expect(store.get("run-1")?.attempt).toBe(2);
  });

  test("a user pause records no reason", () => {
    const clock = { at: 1_000 };
    const store = runningRun(clock);

    expect(store.pause("run-1").error).toBeNull();
    expect(store.get("run-1")?.status).toBe("paused");
  });

  test("a failure settles the run at the status its taxonomy names, and cancel is one of them", () => {
    const clock = { at: 1_000 };
    const failed = runningRun(clock);
    const failure = failed.fail("run-1", "provider_auth", "401 invalid_api_key");

    expect(failure.status).toBe("failed");
    expect(failure.error).toEqual({
      code: "provider_auth",
      detail: "401 invalid_api_key",
      at: 1_000,
    });

    const cancelled = runningRun(clock);
    expect(cancelled.cancel("run-1").status).toBe("cancelled");
    expect(cancelled.get("run-1")?.error?.code).toBe("cancelled");
  });

  test("the first terminal status wins", () => {
    const clock = { at: 1_000 };
    const store = runningRun(clock);
    store.finish("run-1");

    expect(store.fail("run-1", "provider_auth").status).toBe("done");
    expect(store.cancel("run-1").status).toBe("done");
    expect(store.get("run-1")?.error).toBeNull();
  });

  test("usage is added per call and a repeated usage id is refused, not counted twice", () => {
    const clock = { at: 1_000 };
    const store = runningRun(clock);

    expect(store.recordUsage("run-1", usage("u1", 1_000))).toMatchObject({ applied: true });
    const repeated = store.recordUsage("run-1", usage("u1", 1_000));

    expect(repeated.applied).toBe(false);
    expect(repeated.record.usage.costNanoUsd).toBe(3_000_000);
    expect(repeated.record.usage.byModel["openai/gpt-4o"]?.calls).toBe(1);
    expect(store.usageEvents("run-1")).toEqual([usage("u1", 1_000)]);
    expect(repeated.record.updatedAt).toBe(1_000);
  });
});

describe("idempotent operations", () => {
  test("starting an existing run returns the same record and never rewrites it", () => {
    const clock = { at: 1_000 };
    const store = runningRun(clock);
    clock.at = 2_000;

    const again = store.start({
      id: "run-1",
      threadId: "thread-1",
      botId: "bot-1",
      prompt: "echo one",
    });

    expect(again.created).toBe(false);
    expect(again.record.status).toBe("running");
    expect(again.record.createdAt).toBe(1_000);
    expect(again.record.updatedAt).toBe(1_000);
  });

  test("cancelling twice, and cancelling a settled run, is a no-op rather than an error", () => {
    const clock = { at: 1_000 };
    const store = runningRun(clock);
    store.cancel("run-1");
    clock.at = 2_000;

    const second = store.cancel("run-1");

    expect(second.status).toBe("cancelled");
    expect(second.updatedAt).toBe(1_000);

    const finished = runningRun(clock);
    finished.finish("run-1");
    expect(finished.cancel("run-1").status).toBe("done");
  });

  test("a resent park and a stale approval answer are no-ops", () => {
    const clock = { at: 1_000 };
    const store = runningRun(clock);
    store.park("run-1", parkInput());
    clock.at = 2_000;

    expect(store.park("run-1", parkInput()).updatedAt).toBe(1_000);
    expect(store.resolveApproval("run-1", "approval-elsewhere").status).toBe("awaiting_approval");
    expect(store.get("run-1")?.approval?.approvalId).toBe("approval-1");
  });

  test("a repeated begin is a no-op", () => {
    const clock = { at: 1_000 };
    const store = runningRun(clock);
    clock.at = 2_000;

    expect(store.begin("run-1").updatedAt).toBe(1_000);
  });

  test("resolving the same approval twice is a no-op", () => {
    const clock = { at: 1_000 };
    const store = runningRun(clock);
    store.park("run-1", parkInput());
    store.resolveApproval("run-1", "approval-1");
    clock.at = 2_000;

    const again = store.resolveApproval("run-1", "approval-1");

    expect(again.status).toBe("running");
    expect(again.updatedAt).toBe(1_000);
  });

  test("the durable seq only moves forward, and only when it moves", () => {
    const clock = { at: 1_000 };
    const store = runningRun(clock);
    store.noteSeq("run-1", 58);
    clock.at = 2_000;

    expect(store.noteSeq("run-1", 58).updatedAt).toBe(1_000);
    expect(store.noteSeq("run-1", 12).lastSeenSeq).toBe(58);
    expect(store.noteSeq("run-1", 59).lastSeenSeq).toBe(59);
  });

  test("resuming a running run is a no-op, so a replayed rejoin cannot inflate the attempt count", () => {
    const clock = { at: 1_000 };
    const store = runningRun(clock);
    clock.at = 2_000;

    expect(store.resume("run-1").attempt).toBe(1);
    expect(store.get("run-1")?.updatedAt).toBe(1_000);
  });
});

describe("illegal moves", () => {
  test("parking a run that never began is refused by name", () => {
    const store = storeAt({ at: 1_000 });
    store.start({ id: "run-1", threadId: "thread-1", botId: "bot-1", prompt: "echo one" });

    expect(refusal(() => store.park("run-1", parkInput())).message).toBe(
      "park: queued -> awaiting_approval is not a legal run transition",
    );
  });

  test("a second, different approval cannot park an already parked run", () => {
    const store = runningRun({ at: 1_000 });
    store.park("run-1", parkInput());

    expect(refusal(() => store.park("run-1", parkInput("approval-2"))).message).toBe(
      "park: awaiting_approval -> awaiting_approval is not a legal run transition",
    );
  });

  test("resume only leaves paused, so it cannot clear a park nobody answered", () => {
    const store = runningRun({ at: 1_000 });
    store.park("run-1", parkInput());

    expect(refusal(() => store.resume("run-1")).message).toBe(
      "resume: awaiting_approval -> running is not a legal run transition",
    );
  });

  test("a parked run cannot begin again, so a replayed begin cannot clear a park", () => {
    const store = runningRun({ at: 1_000 });
    store.park("run-1", parkInput());

    expect(refusal(() => store.begin("run-1")).message).toBe(
      "begin: awaiting_approval -> running is not a legal run transition",
    );
    expect(store.get("run-1")?.approval?.approvalId).toBe("approval-1");
  });

  test("a run that never began fails without running: the sandbox that will not start", () => {
    const store = storeAt({ at: 1_000 });
    store.start({ id: "run-1", threadId: "thread-1", botId: "bot-1", prompt: "echo one" });

    const failed = store.fail("run-1", "sandbox_unavailable", "docker daemon unreachable");

    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({
      code: "sandbox_unavailable",
      detail: "docker daemon unreachable",
      at: 1_000,
    });
  });

  test("a paused run cannot finish without resuming", () => {
    const store = runningRun({ at: 1_000 });
    store.pause("run-1");

    expect(refusal(() => store.finish("run-1")).message).toBe(
      "finish: paused -> done is not a legal run transition",
    );
  });

  test("a code the taxonomy settles cannot be used to park, or a parking code to fail", () => {
    const store = runningRun({ at: 1_000 });

    expect(refusal(() => store.pause("run-1", { code: "provider_auth" })).message).toBe(
      "pause(provider_auth): the taxonomy settles this code at status failed",
    );
    expect(refusal(() => store.fail("run-1", "sandbox_lost_mid_run")).message).toBe(
      "fail(sandbox_lost_mid_run): the taxonomy settles this code at status paused",
    );
  });

  test("an unknown run and a non-seq are refused", () => {
    const store = storeAt({ at: 1_000 });

    expect(refusal(() => store.begin("run-9")).message).toBe("unknown run: run-9");
    expect(refusal(() => store.noteSeq("run-1", 0)).message).toBe("not a log seq: 0");
  });
});

describe("the journal", () => {
  test("one line per applied command, and none for the no-ops", () => {
    const file = journal();
    const store = runningRun({ at: 1_000 }, { file });
    store.park("run-1", parkInput());
    store.park("run-1", parkInput());
    store.resolveApproval("run-1", "approval-1");
    store.noteSeq("run-1", 58);
    store.noteSeq("run-1", 12);
    store.finish("run-1");
    store.cancel("run-1");

    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as RunCommand);

    expect(lines.map((command) => command.op)).toEqual([
      "start",
      "begin",
      "park",
      "resolve",
      "seq",
      "finish",
    ]);
    expect(store.get("run-1")?.status).toBe("done");
  });

  test("a store that reopens the journal converges to the same records", () => {
    const file = journal();
    const clock = { at: 1_000 };
    const store = runningRun(clock, { file });
    store.park("run-1", parkInput());
    store.recordUsage("run-1", usage("u1", 1_000));
    store.noteSeq("run-1", 58);
    const before = store.serializeAll();
    store.close();

    const reopened = new RunStore({ file, now: () => clock.at });

    expect(reopened.loadReport).toEqual({
      commands: 5,
      refused: [],
      duplicateUsage: [],
      tornTrailingLine: false,
    });
    expect(reopened.serializeAll()).toBe(before);
    expect(reopened.get("run-1")?.status).toBe("awaiting_approval");
    expect(reopened.get("run-1")?.lastSeenSeq).toBe(58);
    expect(reopened.reload()).toEqual({
      report: { commands: 5, refused: [], duplicateUsage: [], tornTrailingLine: false },
      converged: true,
    });
  });

  test("a torn trailing line is dropped, the journal repaired, and the state still converges", () => {
    const file = journal();
    const store = runningRun({ at: 1_000 }, { file });
    const before = store.serializeAll();
    store.close();
    appendFileSync(file, '{"op":"seq","id":"run-1","seq":58,"at":2');

    const reopened = new RunStore({ file, now: () => 2_000 });

    expect(reopened.loadReport.tornTrailingLine).toBe(true);
    expect(reopened.loadReport.commands).toBe(2);
    expect(reopened.serializeAll()).toBe(before);

    reopened.pause("run-1");
    const later = new RunStore({ file, now: () => 3_000 });

    expect(later.loadReport).toEqual({
      commands: 3,
      refused: [],
      duplicateUsage: [],
      tornTrailingLine: false,
    });
    expect(later.get("run-1")?.status).toBe("paused");
  });

  test("a malformed line before the end is corruption, and says which line", () => {
    const file = journal();
    writeFileSync(
      file,
      [
        JSON.stringify({ op: "start", id: "run-1", threadId: "t", botId: "b", prompt: "p", at: 1 }),
        JSON.stringify({ op: "teleport", id: "run-1", at: 2 }),
        JSON.stringify({ op: "begin", id: "run-1", at: 3 }),
        "",
      ].join("\n"),
    );

    expect(refusal(() => new RunStore({ file })).message).toBe(
      "run journal line 2 is not a run command",
    );
  });

  test("a line that is not JSON is corruption too", () => {
    const file = journal();
    writeFileSync(file, `not json\n`);

    expect(refusal(() => new RunStore({ file })).message).toBe("run journal line 1 is not JSON");
  });

  test("a replayed usage line counts once and is reported as refused", () => {
    const file = journal();
    const store = runningRun({ at: 1_000 }, { file });
    store.recordUsage("run-1", usage("u1", 1_000));
    const line = readFileSync(file, "utf8").trim().split("\n").at(-1) ?? "";
    store.close();
    appendFileSync(file, `${line}\n`);

    const reopened = new RunStore({ file, now: () => 1_000 });

    expect(reopened.loadReport.duplicateUsage).toEqual(["u1"]);
    expect(reopened.get("run-1")?.usage.costNanoUsd).toBe(3_000_000);
    expect(reopened.usageEvents("run-1")).toEqual([usage("u1", 1_000)]);
  });

  test("a command the lifecycle refuses in the journal is recorded, not fatal", () => {
    const file = journal();
    writeFileSync(
      file,
      [
        JSON.stringify({ op: "start", id: "run-1", threadId: "t", botId: "b", prompt: "p", at: 1 }),
        JSON.stringify({
          op: "park",
          id: "run-1",
          approvalId: "approval-1",
          toolCallId: "call-1",
          command: "rm",
          actionHash: HASH,
          expiresAt: 9,
          at: 2,
        }),
        "",
      ].join("\n"),
    );

    const store = new RunStore({ file });

    expect(store.loadReport.refused).toEqual([
      { line: 2, reason: "park: queued -> awaiting_approval is not a legal run transition" },
    ]);
    expect(store.get("run-1")?.status).toBe("queued");
  });

  test("a store with no journal persists nothing and reloads to the same state", () => {
    const store = runningRun({ at: 1_000 });
    const before = store.serializeAll();

    expect(store.loadReport.commands).toBe(0);
    expect(store.reload()).toEqual({
      report: { commands: 0, refused: [], duplicateUsage: [], tornTrailingLine: false },
      converged: true,
    });
    expect(store.serializeAll()).toBe(before);
  });
});
