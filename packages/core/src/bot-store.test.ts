/**
 * The bot store's own contract, at the level a restart exercises: what one command per record
 * means, and what a journal that reopens has to come back as.
 *
 * The store is the only thing that survives a server restart for Bots and threads, so every
 * assertion here reads a record after a real second instance has replayed the real file.
 */

import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore, type BotStoreOptions, isBotCommand } from "./bot-store.ts";

function journal(name = "registry.jsonl"): string {
  return join(mkdtempSync(join(tmpdir(), "freebot-bot-store-")), name);
}

/** A store with a clock the test drives, so every timestamp in an assertion is a literal. */
function storeAt(clock: { at: number }, options: BotStoreOptions = {}): BotStore {
  return new BotStore({ ...options, now: () => clock.at });
}

function refusal(attempt: () => unknown): Error {
  try {
    attempt();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the store to refuse this");
}

describe("bots and threads as records", () => {
  test("a created Bot carries its name and the time it was made", () => {
    const clock = { at: 1_000 };
    const store = storeAt(clock);

    const made = store.createBot({ id: "bot-local", name: "Local Bot" });

    expect(made.created).toBe(true);
    expect(made.record).toEqual({
      id: "bot-local",
      name: "Local Bot",
      role: "",
      purpose: "",
      createdAt: 1_000,
      updatedAt: 1_000,
      pinned: false,
      section: "Work",
      hidden: false,
      group: false,
      members: [],
    });
    expect(store.bots()).toEqual([made.record]);
  });

  test("a Bot gains the role and the purpose a later command gives it", () => {
    const clock = { at: 1_000 };
    const store = storeAt(clock);
    store.createBot({ id: "bot-local", name: "Atlas" });

    clock.at = 2_000;
    const described = store.updateBot({
      id: "bot-local",
      role: "Chief of staff",
      purpose: "Release pipeline, changelog, dependency sweeps",
    });

    expect(described).toEqual({
      id: "bot-local",
      name: "Atlas",
      role: "Chief of staff",
      purpose: "Release pipeline, changelog, dependency sweeps",
      createdAt: 1_000,
      updatedAt: 2_000,
      pinned: false,
      section: "Work",
      hidden: false,
      group: false,
      members: [],
    });
    const again = store.updateBot({
      id: "bot-local",
      role: "Chief of staff",
      purpose: "Release pipeline, changelog, dependency sweeps",
    });
    expect(again).toEqual(described);
  });

  test("an update for a Bot this store does not hold is refused by name", () => {
    const store = storeAt({ at: 1_000 });
    const empty = refusal(() => store.updateBot({ id: "bot-9", role: "x", purpose: "y" }));

    expect(empty.message).toBe("unknown bot: bot-9");
    expect(store.bots()).toHaveLength(0);
  });

  test("a second create of the same id is the same Bot, never a second one or a rewrite", () => {
    const clock = { at: 1_000 };
    const store = storeAt(clock);
    const first = store.createBot({ id: "bot-local", name: "Local Bot" });

    clock.at = 2_000;
    const again = store.createBot({ id: "bot-local", name: "Renamed By Accident" });

    expect(again.created).toBe(false);
    expect(again.record).toEqual(first.record);
    expect(store.bots()).toHaveLength(1);
    expect(store.bots()[0]?.name).toBe("Local Bot");
  });

  test("a thread belongs to one Bot and names the conversation", () => {
    const clock = { at: 1_000 };
    const store = storeAt(clock);
    store.createBot({ id: "bot-local", name: "Local Bot" });

    const made = store.createThread({ id: "thread-1", botId: "bot-local", title: "First" });

    expect(made.created).toBe(true);
    expect(made.record).toEqual({
      id: "thread-1",
      botId: "bot-local",
      title: "First",
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(store.threads("bot-local")).toEqual([made.record]);
    expect(store.thread("thread-1")).toEqual(made.record);
  });

  test("a thread for a Bot this store does not hold is refused by name", () => {
    const store = storeAt({ at: 1_000 });

    const error = refusal(() =>
      store.createThread({ id: "thread-1", botId: "bot-nowhere", title: "Orphan" }),
    );

    expect(error.message).toBe("unknown bot: bot-nowhere");
    expect(store.thread("thread-1")).toBeUndefined();
  });

  test("every thread of one Bot is listed, in creation order, and another Bot's are not", () => {
    const clock = { at: 1_000 };
    const store = storeAt(clock);
    store.createBot({ id: "bot-1", name: "One" });
    store.createBot({ id: "bot-2", name: "Two" });
    store.createThread({ id: "thread-1", botId: "bot-1", title: "First" });
    clock.at = 2_000;
    store.createThread({ id: "thread-2", botId: "bot-2", title: "Other" });
    clock.at = 3_000;
    store.createThread({ id: "thread-3", botId: "bot-1", title: "Second" });

    expect(store.threads("bot-1").map((thread) => thread.id)).toEqual(["thread-1", "thread-3"]);
    expect(store.threads("bot-2").map((thread) => thread.id)).toEqual(["thread-2"]);
    expect(store.bots().map((bot) => bot.id)).toEqual(["bot-1", "bot-2"]);
  });

  test("the minting rule names the first Bot the way the single-Bot app did", () => {
    const store = storeAt({ at: 1_000 });
    expect(store.nextBotId()).toBe("bot-local");
    expect(store.nextThreadId()).toBe("thread-1");

    store.createBot({ id: store.nextBotId(), name: "Local Bot" });
    store.createThread({ id: store.nextThreadId(), botId: "bot-local", title: "First" });

    expect(store.nextBotId()).toBe("bot-2");
    expect(store.nextThreadId()).toBe("thread-2");
  });
});

describe("the journal", () => {
  test("one line per applied command, and none for the no-ops", () => {
    const clock = { at: 1_000 };
    const file = journal();
    const store = storeAt(clock, { file });
    store.createBot({ id: "bot-local", name: "Local Bot" });
    store.createThread({ id: "thread-1", botId: "bot-local", title: "First" });
    store.createBot({ id: "bot-local", name: "Local Bot" });

    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown);

    expect(lines).toEqual([
      { op: "bot.create", id: "bot-local", name: "Local Bot", at: 1_000 },
      { op: "thread.create", id: "thread-1", botId: "bot-local", title: "First", at: 1_000 },
    ]);
    expect(lines.every((line) => isBotCommand(line))).toBe(true);
  });

  test("a store that reopens the journal converges to the same records", () => {
    const clock = { at: 1_000 };
    const file = journal();
    const first = storeAt(clock, { file });
    first.createBot({ id: "bot-local", name: "Local Bot" });
    first.createBot({ id: "bot-2", name: "Second" });
    first.createThread({ id: "thread-1", botId: "bot-local", title: "First" });
    first.createThread({ id: "thread-2", botId: "bot-2", title: "Other" });
    first.close();

    const reopened = storeAt(clock, { file });

    expect(reopened.serializeAll()).toBe(first.serializeAll());
    expect(reopened.loadReport).toEqual({ commands: 4, refused: [], tornTrailingLine: false });
    expect(reopened.bots().map((bot) => bot.name)).toEqual(["Local Bot", "Second"]);
    expect(reopened.threads("bot-local").map((thread) => thread.id)).toEqual(["thread-1"]);
    expect(reopened.reload().converged).toBe(true);
  });

  test("a torn trailing line is dropped, the journal repaired, and the state converges", () => {
    const clock = { at: 1_000 };
    const file = journal();
    const store = storeAt(clock, { file });
    store.createBot({ id: "bot-local", name: "Local Bot" });
    store.close();
    appendFileSync(file, '{"op":"thread.create","id":"thread-1","botId":"bot-lo');

    const reopened = storeAt(clock, { file });

    expect(reopened.loadReport).toEqual({ commands: 1, refused: [], tornTrailingLine: true });
    expect(reopened.threads("bot-local")).toEqual([]);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    expect(reopened.reload().converged).toBe(true);
  });

  test("a malformed thread line before the end is corruption, and says which line", () => {
    const file = journal();
    writeFileSync(file, '{"op":"bot.create","id":"bot-local","name":"Local Bot","at":1}\n');
    appendFileSync(file, '{"op":"thread.create","id":"thread-1","botId":"bot-local"}\n');

    const error = refusal(() => storeAt({ at: 1_000 }, { file }));

    expect(error.message).toBe("bot journal line 2 is not a bot command");
  });

  test("a line that is not JSON is corruption too", () => {
    const file = journal();
    writeFileSync(file, "{ not json\n");

    const error = refusal(() => storeAt({ at: 1_000 }, { file }));

    expect(error.message).toBe("bot journal line 1 is not JSON");
  });

  test("a thread command for an absent Bot is recorded as refused, not fatal", () => {
    const file = journal();
    writeFileSync(
      file,
      [
        '{"op":"bot.create","id":"bot-local","name":"Local Bot","at":1}',
        '{"op":"thread.create","id":"thread-1","botId":"bot-gone","title":"Orphan","at":2}',
        '{"op":"thread.create","id":"thread-2","botId":"bot-local","title":"First","at":3}',
        "",
      ].join("\n"),
    );

    const store = storeAt({ at: 1_000 }, { file });

    expect(store.loadReport.commands).toBe(3);
    expect(store.loadReport.refused).toEqual([{ line: 2, reason: "unknown bot: bot-gone" }]);
    expect(store.threads("bot-local").map((thread) => thread.id)).toEqual(["thread-2"]);
  });

  test("a Bot's two fields are one more line, and the journal replays them", () => {
    const clock = { at: 1_000 };
    const file = journal();
    const store = storeAt(clock, { file });
    store.createBot({ id: "bot-local", name: "Atlas" });
    clock.at = 2_000;
    store.updateBot({ id: "bot-local", role: "Chief of staff", purpose: "Release pipeline" });
    store.close();

    const lines = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown);
    const reopened = storeAt(clock, { file });

    expect(lines).toEqual([
      { op: "bot.create", id: "bot-local", name: "Atlas", at: 1_000 },
      {
        op: "bot.update",
        id: "bot-local",
        role: "Chief of staff",
        purpose: "Release pipeline",
        at: 2_000,
      },
    ]);
    expect(reopened.bot("bot-local")?.purpose).toBe("Release pipeline");
    expect(reopened.serializeAll()).toBe(store.serializeAll());
    expect(reopened.reload().converged).toBe(true);
  });

  test("a journal written before the two fields existed replays with both empty", () => {
    const file = journal();
    writeFileSync(
      file,
      [
        '{"op":"bot.create","id":"bot-local","name":"Local Bot","at":1}',
        '{"op":"thread.create","id":"thread-1","botId":"bot-local","title":"First","at":2}',
        "",
      ].join("\n"),
    );

    const store = storeAt({ at: 1_000 }, { file });

    expect(store.bot("bot-local")).toEqual({
      id: "bot-local",
      name: "Local Bot",
      role: "",
      purpose: "",
      createdAt: 1,
      updatedAt: 1,
      pinned: false,
      section: "Work",
      hidden: false,
      group: false,
      members: [],
    });
    expect(store.loadReport).toEqual({ commands: 2, refused: [], tornTrailingLine: false });
  });

  test("an update for an absent Bot is recorded as refused, not fatal", () => {
    const file = journal();
    writeFileSync(
      file,
      [
        '{"op":"bot.update","id":"bot-gone","role":"Owner","purpose":"Everything","at":1}',
        '{"op":"bot.create","id":"bot-local","name":"Local Bot","at":2}',
        "",
      ].join("\n"),
    );

    const store = storeAt({ at: 1_000 }, { file });

    expect(store.loadReport.commands).toBe(2);
    expect(store.loadReport.refused).toEqual([{ line: 1, reason: "unknown bot: bot-gone" }]);
    expect(store.bots()).toHaveLength(1);
  });

  test("a store with no journal persists nothing and reloads to the same state", () => {
    const store = storeAt({ at: 1_000 });
    store.createBot({ id: "bot-local", name: "Local Bot" });

    expect(store.reload()).toEqual({
      report: { commands: 0, refused: [], tornTrailingLine: false },
      converged: true,
    });
    expect(store.bots()).toHaveLength(1);
  });
});
