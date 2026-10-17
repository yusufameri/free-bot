import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GrantRecord } from "./grants.ts";
import {
  GrantStore,
  GrantStoreError,
  grantStoreFromJsonl,
  grantStoreToJsonl,
  loadGrantStore,
  saveGrantStore,
} from "./store.ts";

const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const ECHO_HI = { command: "echo hi" };

function entry(store: GrantStore, index: number): GrantRecord {
  const record = store.log()[index];
  if (record === undefined) throw new Error(`no log entry at ${index}`);
  return record;
}

function issued(store: GrantStore, args: unknown = ECHO_HI): GrantRecord {
  return store.issue({ toolName: "bash", args, ttlMs: 60_000, now: T0 });
}

describe("issue", () => {
  test("appends the full v1 record shape", () => {
    const store = new GrantStore();
    const grant = issued(store);
    expect(grant).toMatchObject({
      id: "grant-1",
      seq: 1,
      issuedAt: T0,
      expiresAt: T0 + 60_000,
      toolName: "bash",
      consumedBy: null,
      tombstoned: null,
    });
    expect(grant.actionHash).toBe(
      "v1:sha256:0b07de4a30385177b5d5b2de52ca057887ecb38d536e7d2094df21deb5f80d63",
    );
    expect(store.grants()).toHaveLength(1);
  });

  test("assigns ascending seq and refuses a duplicate id (issue-once)", () => {
    const store = new GrantStore();
    issued(store);
    const second = issued(store, { command: "echo bye" });
    expect(second.seq).toBe(2);
    expect(second.id).toBe("grant-2");
    expect(() => store.issue({ toolName: "bash", args: ECHO_HI, ttlMs: 1, id: "grant-1" })).toThrow(
      "grant grant-1 already exists",
    );
  });

  test("refuses an empty tool name and a non-positive ttl", () => {
    const store = new GrantStore();
    expect(() => store.issue({ toolName: "", args: {}, ttlMs: 1 })).toThrow(
      "toolName must be non-empty",
    );
    expect(() => store.issue({ toolName: "bash", args: {}, ttlMs: 0 })).toThrow(
      "ttlMs must be a positive number",
    );
  });

  test("refuses args that are not canonical JSON", () => {
    const store = new GrantStore();
    expect(() => store.issue({ toolName: "bash", args: { a: undefined }, ttlMs: 1 })).toThrow(
      "$.a: refuses undefined",
    );
  });
});

describe("append-only log", () => {
  test("consume appends a version and leaves the issue version untouched", () => {
    const store = new GrantStore();
    issued(store);
    const consumed = store.consume("grant-1", "call_1", T0);
    expect(consumed.consumedBy).toBe("call_1");
    expect(store.log()).toHaveLength(2);
    expect(entry(store, 0).consumedBy).toBeNull();
    expect(Object.isFrozen(entry(store, 0))).toBe(true);
    expect(entry(store, 1).consumedBy).toBe("call_1");
  });

  test("replay derives the same state from the log", () => {
    const store = new GrantStore();
    issued(store);
    issued(store, { command: "echo bye" });
    store.consume("grant-1", "call_1", T0);
    const replayed = new GrantStore(store.log());
    expect(JSON.stringify(replayed.grants())).toBe(JSON.stringify(store.grants()));
    expect(replayed.log()).toHaveLength(3);
  });

  test("grants() returns current versions only, ascending by seq", () => {
    const store = new GrantStore();
    issued(store);
    issued(store, { command: "echo bye" });
    store.consume("grant-1", "call_1", T0);
    expect(store.grants().map((grant) => grant.id)).toEqual(["grant-1", "grant-2"]);
    expect(store.grants()[0]?.consumedBy).toBe("call_1");
  });
});

describe("consume", () => {
  test("refuses a second consume of the same grant", () => {
    const store = new GrantStore();
    issued(store);
    store.consume("grant-1", "call_1", T0);
    let failure: unknown;
    try {
      store.consume("grant-1", "call_2", T0);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GrantStoreError);
    expect((failure as GrantStoreError).code).toBe("already_consumed");
  });

  test("refuses an unknown grant", () => {
    const store = new GrantStore();
    let failure: unknown;
    try {
      store.consume("grant-404", "call_1", T0);
    } catch (error) {
      failure = error;
    }
    expect((failure as GrantStoreError).code).toBe("unknown_grant");
  });

  test("refuses an expired grant at the boundary instant", () => {
    const store = new GrantStore();
    store.issue({ toolName: "bash", args: ECHO_HI, ttlMs: 1000, now: T0 });
    expect(store.consume("grant-1", "call_1", T0 + 999).consumedBy).toBe("call_1");

    issued(store, { command: "echo bye" });
    let failure: unknown;
    try {
      store.consume("grant-2", "call_2", T0 + 1000 + 60_000);
    } catch (error) {
      failure = error;
    }
    expect((failure as GrantStoreError).code).toBe("expired");
  });
});

describe("rewind", () => {
  test("tombstones exactly the grants past the rewind point", () => {
    const store = new GrantStore();
    issued(store);
    issued(store, { command: "echo two" });
    issued(store, { command: "echo three" });
    const tombstoned = store.rewind(2, "rewind:2");
    expect(tombstoned.map((grant) => grant.id)).toEqual(["grant-3"]);
    expect(store.grants().map((grant) => [grant.id, grant.tombstoned])).toEqual([
      ["grant-1", null],
      ["grant-2", null],
      ["grant-3", "rewind:2"],
    ]);
  });

  test("is idempotent: a second rewind over the same point appends nothing", () => {
    const store = new GrantStore();
    issued(store);
    issued(store, { command: "echo two" });
    store.rewind(1, "rewind:1");
    const logLength = store.log().length;
    expect(store.rewind(1, "rewind:1")).toEqual([]);
    expect(store.log()).toHaveLength(logLength);
  });

  test("keeps consumption history and removes authority", () => {
    const store = new GrantStore();
    issued(store);
    store.consume("grant-1", "call_1", T0);
    const [tombstoned] = store.rewind(0, "rewind:0");
    expect(tombstoned?.consumedBy).toBe("call_1");
    expect(tombstoned?.tombstoned).toBe("rewind:0");
    let failure: unknown;
    try {
      store.consume("grant-1", "call_2", T0);
    } catch (error) {
      failure = error;
    }
    expect((failure as GrantStoreError).code).toBe("tombstoned");
  });

  test("refuses a negative rewind point", () => {
    const store = new GrantStore();
    expect(() => store.rewind(-1, "rewind:-1")).toThrow("rewindSeq must be a non-negative integer");
  });
});

describe("jsonl persistence", () => {
  test("round-trips the full append history through text", () => {
    const store = new GrantStore();
    issued(store);
    issued(store, { command: "echo bye" });
    store.consume("grant-1", "call_1", T0);
    store.rewind(1, "rewind:1");

    const text = grantStoreToJsonl(store);
    const reloaded = grantStoreFromJsonl(text);
    expect(grantStoreToJsonl(reloaded)).toBe(text);
    expect(JSON.stringify(reloaded.grants())).toBe(JSON.stringify(store.grants()));
    expect(reloaded.log()).toHaveLength(store.log().length);
  });

  test("keeps append order line by line", () => {
    const store = new GrantStore();
    issued(store);
    store.consume("grant-1", "call_1", T0);
    const lines = grantStoreToJsonl(store).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]?.endsWith('"tombstoned":null}')).toBe(true);
    expect(lines[1]).toContain('"consumedBy":"call_1"');
  });

  test("fails closed on a malformed line, naming it", () => {
    const valid = JSON.stringify({
      id: "grant-1",
      seq: 1,
      issuedAt: T0,
      expiresAt: T0 + 1000,
      actionHash: "v1:sha256:0b07de4a30385177b5d5b2de52ca057887ecb38d536e7d2094df21deb5f80d63",
      toolName: "bash",
      normalizedArgs: ECHO_HI,
      consumedBy: null,
      tombstoned: null,
    });
    expect(() => grantStoreFromJsonl("not json\n")).toThrow("line 1 is not JSON");
    expect(() => grantStoreFromJsonl(`${valid}\n{"id":"grant-2"}\n`)).toThrow(
      "line 2: seq must be a positive integer",
    );
  });

  test("loads back from a file with identical state", async () => {
    const store = new GrantStore();
    issued(store);
    store.consume("grant-1", "call_1", T0);
    const path = join(tmpdir(), `freebot-review-grants-${crypto.randomUUID()}.jsonl`);
    try {
      await saveGrantStore(store, path);
      const reloaded = await loadGrantStore(path);
      expect(grantStoreToJsonl(reloaded)).toBe(grantStoreToJsonl(store));
    } finally {
      await rm(path, { force: true });
    }
  });
});
