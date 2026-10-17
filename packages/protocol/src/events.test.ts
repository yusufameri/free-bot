/**
 * Taxonomy behavior: the deny codes and the grant lifecycle come from packages/review verbatim
 * rather than from a copy that can drift, and every decision the real gate can return (the allow
 * path and all nine denials) becomes a valid v1 payload.
 */

import { describe, expect, test } from "bun:test";
import {
  canonicalActionHash,
  createGrantPolicy,
  type GrantRecord,
  GrantStore,
  DENY_CODES as REVIEW_DENY_CODES,
} from "@freebot/review";
import {
  actionHashSchema,
  DENY_CODES,
  type DenyCode,
  GRANT_STATES,
  grantLifecyclePayload,
  grantStateSchema,
  toolCallDecisionPayload,
} from "./index.ts";

const HASH = `v1:sha256:${"b".repeat(64)}`;
const CALL = "call_1";
const AT = 1_000;
const TTL = 60_000;
const ECHO = { command: "echo hi" };
const ECHO_HASH = canonicalActionHash("bash", ECHO);

/** What the gate returns, without importing the pi-bridge type it is declared with. */
type Decision = ReturnType<ReturnType<typeof createGrantPolicy>>;

/** One gate over one store, governing `bash` alone, with the clock pinned where it matters. */
const gate =
  (store: GrantStore, now: () => number = Date.now) =>
  (args: unknown, toolName = "bash"): Decision =>
    createGrantPolicy(store, { tools: ["bash"], now })({ toolCallId: CALL, toolName, args });

/** A store that fails the way a dead ledger would; the gate must deny rather than throw. */
class BrokenStore extends GrantStore {
  override byActionHash(): GrantRecord[] {
    throw new Error("ledger unavailable");
  }
}

/**
 * Every path the gate can deny through, one seeded store each, in `DENY_CODES` order. `detail` is
 * the explanation the consumer recovers by splitting the combined reason on ": ", asserted as a
 * literal below; the table is checked against the registry so a new code cannot go unexercised.
 */
const DENIALS: Array<{ code: DenyCode; detail: string; decide: () => Decision }> = [
  {
    code: "unknown_tool",
    detail: "read_file is not a governed tool",
    decide: () => gate(new GrantStore())({ path: "/workspace/notes.md" }, "read_file"),
  },
  {
    code: "no_grant",
    detail: `no grant for action ${ECHO_HASH}`,
    decide: () => gate(new GrantStore())(ECHO),
  },
  {
    code: "grant_mismatch",
    detail: "args differ from grant grant-1 for tool bash",
    decide: () => {
      const store = new GrantStore();
      store.issue({ toolName: "bash", args: ECHO, ttlMs: TTL, id: "grant-1", now: AT });
      return gate(store)({ command: "rm -rf /" });
    },
  },
  {
    code: "grant_expired",
    detail: "grant grant-1 expired at 1970-01-01T00:01:01.000Z",
    decide: () => {
      const store = new GrantStore();
      store.issue({ toolName: "bash", args: ECHO, ttlMs: TTL, id: "grant-1", now: AT });
      return gate(store, () => AT + TTL)(ECHO);
    },
  },
  {
    code: "grant_consumed",
    detail: "grant grant-1 consumed by call_9",
    decide: () => {
      const store = new GrantStore();
      store.issue({ toolName: "bash", args: ECHO, ttlMs: TTL, id: "grant-1", now: AT });
      store.consume("grant-1", "call_9", AT + 1);
      return gate(store, () => AT + 2)(ECHO);
    },
  },
  {
    code: "grant_tombstoned",
    detail: "grant grant-1 tombstoned by rewind:12",
    decide: () => {
      const store = new GrantStore();
      store.issue({ toolName: "bash", args: ECHO, ttlMs: TTL, id: "grant-1", now: AT });
      store.rewind(0, "rewind:12");
      return gate(store, () => AT + 2)(ECHO);
    },
  },
  {
    code: "grant_forged",
    detail: "grant grant-1 hash does not match its content",
    decide: () => {
      // A tampered ledger: the stored hash is the call's, the stored args are another call's.
      const forged: GrantRecord = {
        id: "grant-1",
        seq: 1,
        issuedAt: AT,
        expiresAt: AT + TTL,
        actionHash: ECHO_HASH,
        toolName: "bash",
        normalizedArgs: { command: "rm -rf /" },
        consumedBy: null,
        tombstoned: null,
      };
      return gate(new GrantStore([forged]), () => AT + 2)(ECHO);
    },
  },
  {
    code: "malformed_action",
    detail: "$.args.at: refuses Infinity (not a finite number)",
    decide: () => gate(new GrantStore())({ command: "echo hi", at: Number.POSITIVE_INFINITY }),
  },
  {
    code: "grant_store_error",
    detail: "ledger unavailable",
    decide: () => gate(new BrokenStore())(ECHO),
  },
];

describe("deny codes", () => {
  test("the nine codes match packages/review in value and order", () => {
    expect(DENY_CODES).toEqual([
      "unknown_tool",
      "no_grant",
      "grant_mismatch",
      "grant_expired",
      "grant_consumed",
      "grant_tombstoned",
      "grant_forged",
      "malformed_action",
      "grant_store_error",
    ]);
    expect(DENY_CODES.join(",")).toBe(Object.values(REVIEW_DENY_CODES).join(","));
  });

  test("the seeded stores cover every code the gate can name, in registry order", () => {
    expect(DENIALS.map((entry) => entry.code)).toEqual([...DENY_CODES]);
  });

  for (const { code, detail, decide } of DENIALS) {
    test(`a real gate denial on ${code} splits into the code and its detail`, async () => {
      const decision = await decide();
      expect(decision.allow).toBe(false);
      const reason = decision.allow ? "" : decision.reason;
      const [parsedCode, ...rest] = reason.split(": ");
      const payload = toolCallDecisionPayload.parse({
        toolCallId: CALL,
        allow: false,
        code: parsedCode,
        detail: rest.join(": "),
      });
      expect({ reason, payload }).toEqual({
        reason: `${code}: ${detail}`,
        payload: { toolCallId: CALL, allow: false, code, detail },
      });
    });
  }

  test("a denial with no detail is refused: a denied call always names why", () => {
    expect(
      toolCallDecisionPayload.safeParse({
        toolCallId: CALL,
        allow: false,
        code: "no_grant",
        detail: "",
      }).success,
    ).toBe(false);
  });

  test("a real gate allow becomes a valid v1 decision with no ad-hoc fields", async () => {
    const store = new GrantStore();
    const gate = createGrantPolicy(store, { tools: ["bash"] });
    const issued = store.issue({ toolName: "bash", args: { command: "echo hi" }, ttlMs: 60_000 });
    expect(issued.actionHash).toBe(canonicalActionHash("bash", { command: "echo hi" }));
    expect(actionHashSchema.safeParse(issued.actionHash).success).toBe(true);
    const decision = await gate({
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "echo hi" },
    });
    expect(decision.allow).toBe(true);
    expect(toolCallDecisionPayload.parse({ toolCallId: "call_1", allow: true })).toEqual({
      toolCallId: "call_1",
      allow: true,
    });
  });
});

describe("grant lifecycle", () => {
  test("the four states are exactly issued, consumed, expired, rewound", () => {
    expect(GRANT_STATES).toEqual(["issued", "consumed", "expired", "rewound"]);
    expect(grantStateSchema.options).toEqual([...GRANT_STATES]);
  });

  test("each state carries exactly its own fields", () => {
    expect(
      grantLifecyclePayload.parse({
        state: "issued",
        grantId: "g1",
        actionHash: HASH,
        expiresAt: 2,
      }),
    ).toEqual({ state: "issued", grantId: "g1", actionHash: HASH, expiresAt: 2 });
    expect(
      grantLifecyclePayload.parse({
        state: "consumed",
        grantId: "g1",
        actionHash: HASH,
        consumedBy: "call_1",
        at: 2,
      }),
    ).toEqual({ state: "consumed", grantId: "g1", actionHash: HASH, consumedBy: "call_1", at: 2 });
    expect(
      grantLifecyclePayload.parse({ state: "expired", grantId: "g1", actionHash: HASH, at: 2 }),
    ).toEqual({
      state: "expired",
      grantId: "g1",
      actionHash: HASH,
      at: 2,
    });
    expect(
      grantLifecyclePayload.parse({
        state: "rewound",
        grantId: "g1",
        actionHash: HASH,
        reason: "rewind:12",
        at: 2,
      }),
    ).toEqual({ state: "rewound", grantId: "g1", actionHash: HASH, reason: "rewind:12", at: 2 });
  });

  test("another state's fields are stripped, so a state cannot leak into the wrong shape", () => {
    expect(
      grantLifecyclePayload.parse({
        state: "expired",
        grantId: "g1",
        actionHash: HASH,
        at: 2,
        consumedBy: "call_1",
        reason: "rewind:12",
      }),
    ).toEqual({ state: "expired", grantId: "g1", actionHash: HASH, at: 2 });
  });
});
