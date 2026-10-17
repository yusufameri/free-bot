import { describe, expect, test } from "bun:test";
import type { ToolGate, ToolGateDecision } from "@freebot/pi-bridge";
import type { GrantRecord } from "./grants.ts";
import { createGrantPolicy } from "./policy.ts";
import { GrantStore, grantStoreFromJsonl, grantStoreToJsonl } from "./store.ts";

const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const ECHO_HI = { command: "echo hi" };
const ECHO_HI_HASH = "v1:sha256:0b07de4a30385177b5d5b2de52ca057887ecb38d536e7d2094df21deb5f80d63";

function clock(start = T0) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

async function decide(
  gate: ToolGate,
  toolName: string,
  args: unknown,
  toolCallId = "call_1",
): Promise<ToolGateDecision> {
  return await gate({ toolCallId, toolName, args });
}

function codeOf(decision: ToolGateDecision): string {
  if (decision.allow) return "allow";
  return decision.reason.slice(0, decision.reason.indexOf(":"));
}

describe("allow-once semantics", () => {
  test("allows the granted action once and consumes its grant", async () => {
    const store = new GrantStore();
    const time = clock();
    const gate = createGrantPolicy(store, { now: time.now });
    store.issue({ toolName: "bash", args: ECHO_HI, ttlMs: 60_000, now: T0 });

    expect(await decide(gate, "bash", ECHO_HI)).toEqual({ allow: true });
    expect(store.grants()[0]?.consumedBy).toBe("call_1");
    expect(await decide(gate, "bash", ECHO_HI, "call_2")).toEqual({
      allow: false,
      reason: "grant_consumed: grant grant-1 consumed by call_1",
    });
  });

  test("two grants for one action allow twice, in seq order", async () => {
    const store = new GrantStore();
    const gate = createGrantPolicy(store, { now: () => T0 });
    store.issue({ toolName: "bash", args: ECHO_HI, ttlMs: 60_000, now: T0 });
    store.issue({ toolName: "bash", args: ECHO_HI, ttlMs: 60_000, now: T0 });

    expect(await decide(gate, "bash", ECHO_HI, "call_1")).toEqual({ allow: true });
    expect(await decide(gate, "bash", ECHO_HI, "call_2")).toEqual({ allow: true });
    expect(store.grants().map((grant) => grant.consumedBy)).toEqual(["call_1", "call_2"]);
    expect(codeOf(await decide(gate, "bash", ECHO_HI, "call_3"))).toBe("grant_consumed");
  });

  test("key-order variants of the granted args still match", async () => {
    const store = new GrantStore();
    const gate = createGrantPolicy(store, { now: () => T0 });
    store.issue({
      toolName: "bash",
      args: { command: "cp a b", flags: { force: true } },
      ttlMs: 60_000,
      now: T0,
    });
    expect(await decide(gate, "bash", { flags: { force: true }, command: "cp a b" })).toEqual({
      allow: true,
    });
  });

  test("is legal to assign the policy to the pi-bridge ToolGate contract", () => {
    const gate: ToolGate = createGrantPolicy(new GrantStore());
    expect(typeof gate).toBe("function");
  });
});

describe("fail-closed denials", () => {
  test("unknown tool: outside the governed list, even with a grant", async () => {
    const store = new GrantStore();
    const gate = createGrantPolicy(store, { tools: ["bash"], now: () => T0 });
    store.issue({
      toolName: "web_fetch",
      args: { url: "https://example.com" },
      ttlMs: 60_000,
      now: T0,
    });
    expect(await decide(gate, "web_fetch", { url: "https://example.com" })).toEqual({
      allow: false,
      reason: "unknown_tool: web_fetch is not a governed tool",
    });
  });

  test("no grant: the tool has never been granted", async () => {
    const store = new GrantStore();
    const gate = createGrantPolicy(store, { now: () => T0 });
    expect(await decide(gate, "bash", ECHO_HI)).toEqual({
      allow: false,
      reason: `no_grant: no grant for action ${ECHO_HI_HASH}`,
    });
  });

  test("grant mismatch: a grant for the tool exists, none for these args", async () => {
    const store = new GrantStore();
    const gate = createGrantPolicy(store, { now: () => T0 });
    store.issue({ toolName: "bash", args: ECHO_HI, ttlMs: 60_000, now: T0 });
    expect(await decide(gate, "bash", { command: "echo bye" })).toEqual({
      allow: false,
      reason: "grant_mismatch: args differ from grant grant-1 for tool bash",
    });
  });

  test("expired: valid strictly before expiresAt, denied at it", async () => {
    const store = new GrantStore();
    const time = clock();
    const gate = createGrantPolicy(store, { now: time.now });
    store.issue({ toolName: "bash", args: ECHO_HI, ttlMs: 1000, now: T0 });

    time.advance(999);
    expect(await decide(gate, "bash", ECHO_HI, "call_1")).toEqual({ allow: true });

    store.issue({ toolName: "bash", args: ECHO_HI, ttlMs: 1, now: T0 + 999 });
    time.advance(1);
    const expiredAt = new Date(T0 + 1000).toISOString();
    expect(await decide(gate, "bash", ECHO_HI, "call_2")).toEqual({
      allow: false,
      reason: `grant_expired: grant grant-2 expired at ${expiredAt}`,
    });
  });

  test("tombstoned: a rewind past the grant removes its authority", async () => {
    const store = new GrantStore();
    const gate = createGrantPolicy(store, { now: () => T0 });
    store.issue({ toolName: "bash", args: { command: "echo one" }, ttlMs: 60_000, now: T0 });
    store.issue({ toolName: "bash", args: ECHO_HI, ttlMs: 60_000, now: T0 });
    store.rewind(1, "rewind:1");

    expect(await decide(gate, "bash", ECHO_HI)).toEqual({
      allow: false,
      reason: "grant_tombstoned: grant grant-2 tombstoned by rewind:1",
    });
    expect(await decide(gate, "bash", { command: "echo one" })).toEqual({ allow: true });
  });

  test("forged: a record whose hash disagrees with its content never authorizes", async () => {
    const forged = JSON.stringify({
      id: "grant-9",
      seq: 9,
      issuedAt: T0,
      expiresAt: T0 + 60_000,
      actionHash: ECHO_HI_HASH,
      toolName: "bash",
      normalizedArgs: { command: "rm -rf /" },
      consumedBy: null,
      tombstoned: null,
    });
    const store = grantStoreFromJsonl(`${forged}\n`);
    const gate = createGrantPolicy(store, { now: () => T0 });
    expect(await decide(gate, "bash", ECHO_HI)).toEqual({
      allow: false,
      reason: "grant_forged: grant grant-9 hash does not match its content",
    });
    expect(codeOf(await decide(gate, "bash", { command: "rm -rf /" }))).toBe("grant_mismatch");
  });

  test("malformed action: args that are not canonical JSON", async () => {
    const store = new GrantStore();
    const gate = createGrantPolicy(store, { now: () => T0 });
    expect(await decide(gate, "bash", { command: undefined })).toEqual({
      allow: false,
      reason: "malformed_action: $.args.command: refuses undefined (not a JSON value)",
    });
  });

  test("store failure denies instead of propagating", async () => {
    class BrokenStore extends GrantStore {
      override consume(): GrantRecord {
        throw new Error("disk on fire");
      }
    }
    const store = new BrokenStore();
    const gate = createGrantPolicy(store, { now: () => T0 });
    store.issue({ toolName: "bash", args: ECHO_HI, ttlMs: 60_000, now: T0 });
    expect(await decide(gate, "bash", ECHO_HI)).toEqual({
      allow: false,
      reason: "grant_store_error: disk on fire",
    });
  });

  test("the six fail-closed flows carry six distinct codes", async () => {
    const codes = new Set<string>();

    const unknown = new GrantStore();
    codes.add(
      codeOf(
        await decide(createGrantPolicy(unknown, { tools: ["bash"] }), "web_fetch", {
          url: "https://example.com",
        }),
      ),
    );

    const bare = new GrantStore();
    codes.add(codeOf(await decide(createGrantPolicy(bare, { now: () => T0 }), "bash", ECHO_HI)));

    const mismatched = new GrantStore();
    mismatched.issue({ toolName: "bash", args: ECHO_HI, ttlMs: 60_000, now: T0 });
    codes.add(
      codeOf(
        await decide(createGrantPolicy(mismatched, { now: () => T0 }), "bash", {
          command: "echo bye",
        }),
      ),
    );

    const expired = new GrantStore();
    expired.issue({ toolName: "bash", args: ECHO_HI, ttlMs: 1, now: T0 });
    codes.add(
      codeOf(await decide(createGrantPolicy(expired, { now: () => T0 + 1 }), "bash", ECHO_HI)),
    );

    const tombstoned = new GrantStore();
    tombstoned.issue({ toolName: "bash", args: ECHO_HI, ttlMs: 60_000, now: T0 });
    tombstoned.rewind(0, "rewind:0");
    codes.add(
      codeOf(await decide(createGrantPolicy(tombstoned, { now: () => T0 }), "bash", ECHO_HI)),
    );

    const consumed = new GrantStore();
    consumed.issue({ toolName: "bash", args: ECHO_HI, ttlMs: 60_000, now: T0 });
    const consumedGate = createGrantPolicy(consumed, { now: () => T0 });
    await decide(consumedGate, "bash", ECHO_HI, "call_1");
    codes.add(codeOf(await decide(consumedGate, "bash", ECHO_HI, "call_2")));

    expect([...codes].sort()).toEqual([
      "grant_consumed",
      "grant_expired",
      "grant_mismatch",
      "grant_tombstoned",
      "no_grant",
      "unknown_tool",
    ]);
  });
});

describe("shared store", () => {
  test("two policy instances over one store cannot double-spend a grant", async () => {
    const store = new GrantStore();
    store.issue({ toolName: "bash", args: ECHO_HI, ttlMs: 60_000, now: T0 });
    const gateA = createGrantPolicy(store, { now: () => T0 });
    const gateB = createGrantPolicy(store, { now: () => T0 });
    const call = { toolCallId: "call_1", toolName: "bash", args: ECHO_HI };

    const [a, b] = await Promise.all([gateA(call), gateB({ ...call, toolCallId: "call_2" })]);
    expect(a).toEqual({ allow: true });
    expect(b).toEqual({
      allow: false,
      reason: "grant_consumed: grant grant-1 consumed by call_1",
    });
    expect(store.grants()[0]?.consumedBy).toBe("call_1");
  });

  test("a reloaded store keeps enforcing consumption", async () => {
    const store = new GrantStore();
    store.issue({ toolName: "bash", args: ECHO_HI, ttlMs: 60_000, now: T0 });
    await decide(createGrantPolicy(store, { now: () => T0 }), "bash", ECHO_HI, "call_1");

    const reloaded = grantStoreFromJsonl(grantStoreToJsonl(store));
    expect(
      await decide(createGrantPolicy(reloaded, { now: () => T0 }), "bash", ECHO_HI, "call_2"),
    ).toEqual({ allow: false, reason: "grant_consumed: grant grant-1 consumed by call_1" });
  });
});
