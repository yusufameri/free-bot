/**
 * Taxonomy behavior: the deny codes and the grant lifecycle come from packages/review verbatim
 * rather than from a copy that can drift, and a real gate decision becomes a valid v1 payload.
 */

import { describe, expect, test } from "bun:test";
import {
  canonicalActionHash,
  createGrantPolicy,
  GrantStore,
  DENY_CODES as REVIEW_DENY_CODES,
} from "@freebot/review";
import {
  actionHashSchema,
  DENY_CODES,
  GRANT_STATES,
  grantLifecyclePayload,
  grantStateSchema,
  toolCallDecisionPayload,
} from "./index.ts";

const HASH = `v1:sha256:${"b".repeat(64)}`;

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

  test("a real gate denial splits into a code the schema accepts and its detail", async () => {
    const gate = createGrantPolicy(new GrantStore(), { tools: ["bash"] });
    const decision = await gate({
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "echo hi" },
    });
    expect(decision.allow).toBe(false);
    const reason = decision.allow ? "" : decision.reason;
    const [code, ...rest] = reason.split(": ");
    expect(code).toBe("no_grant");
    expect(code).toBe(DENY_CODES[1]);
    const payload = toolCallDecisionPayload.parse({
      toolCallId: "call_1",
      allow: false,
      code,
      detail: rest.join(": "),
    });
    expect(payload).toEqual({
      toolCallId: "call_1",
      allow: false,
      code: "no_grant",
      detail: `no grant for action ${canonicalActionHash("bash", { command: "echo hi" })}`,
    });
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
