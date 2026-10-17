/**
 * The grant policy: a pi-bridge ToolGate that allows a call only when it consumes a matching,
 * unexpired, unconsumed, untombstoned grant whose action hash equals the canonical hash of the
 * call. Every other path denies, and every denial names a distinct reason code.
 *
 * This is the control-plane invariant of plan finding 11: the gate lives here, not in the
 * sandbox. The in-VM agent is an untrusted reporter; a killed or forged agent cannot mint
 * consent, only the control plane can append grants. Plan finding 37: rewind tombstones grants
 * past the rewind point, so rewound history can never authorize a call again.
 *
 * Fail-closed rules, each asserted against literal values in policy.test.ts:
 *
 * | Path | Reason |
 * | --- | --- |
 * | tool outside the governed list | `unknown_tool: <name> is not a governed tool` |
 * | no grant exists for the tool | `no_grant: no grant for action <hash>` |
 * | grants exist for the tool, none for this action | `grant_mismatch: args differ from ...` |
 * | matching grant expired | `grant_expired: grant <id> expired at <iso>` |
 * | matching grant already consumed | `grant_consumed: grant <id> consumed by <call>` |
 * | matching grant tombstoned by rewind | `grant_tombstoned: grant <id> tombstoned by <reason>` |
 * | stored actionHash disagrees with its content | `grant_forged: grant <id> hash does not match its content` |
 * | args not canonicalizable | `malformed_action: <canonicalization error>` |
 * | any store failure | `grant_store_error: <message>` |
 */

import type { ToolCallContext, ToolGate, ToolGateDecision } from "@freebot/pi-bridge";
import { canonicalActionHash, type GrantRecord, recomputeActionHash } from "./grants.ts";
import type { GrantStore } from "./store.ts";

/** The distinct denial codes. A gate that denies always names one of these. */
export const DENY_CODES = {
  UNKNOWN_TOOL: "unknown_tool",
  NO_GRANT: "no_grant",
  GRANT_MISMATCH: "grant_mismatch",
  GRANT_EXPIRED: "grant_expired",
  GRANT_CONSUMED: "grant_consumed",
  GRANT_TOMBSTONED: "grant_tombstoned",
  GRANT_FORGED: "grant_forged",
  MALFORMED_ACTION: "malformed_action",
  GRANT_STORE_ERROR: "grant_store_error",
} as const;

export type DenyCode = (typeof DENY_CODES)[keyof typeof DENY_CODES];

export interface GrantPolicyOptions {
  /** The tools this gate governs. Omit to govern every tool name; others deny `unknown_tool`. */
  tools?: readonly string[];
  /** Clock override for tests. Defaults to Date.now. */
  now?: () => number;
}

function deny(code: DenyCode, detail: string): ToolGateDecision {
  return { allow: false, reason: `${code}: ${detail}` };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build a ToolGate over one store. Allows consume the matching grant atomically; denials name
 * their reason code. Never throws: internal failures deny.
 */
export function createGrantPolicy(store: GrantStore, options: GrantPolicyOptions = {}): ToolGate {
  const governed = options.tools === undefined ? undefined : new Set(options.tools);
  const now = options.now ?? Date.now;

  return (call: ToolCallContext): ToolGateDecision => {
    try {
      if (governed !== undefined && !governed.has(call.toolName)) {
        return deny(DENY_CODES.UNKNOWN_TOOL, `${call.toolName} is not a governed tool`);
      }
      let callHash: string;
      try {
        callHash = canonicalActionHash(call.toolName, call.args);
      } catch (error) {
        return deny(DENY_CODES.MALFORMED_ACTION, messageOf(error));
      }

      const candidates = store.byActionHash(callHash);
      for (const candidate of candidates) {
        if (recomputeActionHash(candidate) !== candidate.actionHash) {
          return deny(
            DENY_CODES.GRANT_FORGED,
            `grant ${candidate.id} hash does not match its content`,
          );
        }
      }

      const at = now();
      const authorizing = candidates.filter(
        (grant) => grant.tombstoned === null && grant.consumedBy === null && grant.expiresAt > at,
      );
      const chosen = authorizing[0];
      if (chosen !== undefined) {
        store.consume(chosen.id, call.toolCallId, at);
        return { allow: true };
      }

      const latest = candidates.at(-1);
      if (latest !== undefined) {
        return classifyDenial(latest);
      }

      const toolGrants = store.byTool(call.toolName);
      const toolLatest = toolGrants.at(-1);
      if (toolLatest !== undefined) {
        return deny(
          DENY_CODES.GRANT_MISMATCH,
          `args differ from grant ${toolLatest.id} for tool ${call.toolName}`,
        );
      }
      return deny(DENY_CODES.NO_GRANT, `no grant for action ${callHash}`);
    } catch (error) {
      return deny(DENY_CODES.GRANT_STORE_ERROR, messageOf(error));
    }
  };
}

/** The most recent matching grant exists but cannot authorize. Tombstone first, then consume. */
function classifyDenial(grant: GrantRecord): ToolGateDecision {
  if (grant.tombstoned !== null) {
    return deny(DENY_CODES.GRANT_TOMBSTONED, `grant ${grant.id} tombstoned by ${grant.tombstoned}`);
  }
  if (grant.consumedBy !== null) {
    return deny(DENY_CODES.GRANT_CONSUMED, `grant ${grant.id} consumed by ${grant.consumedBy}`);
  }
  return deny(
    DENY_CODES.GRANT_EXPIRED,
    `grant ${grant.id} expired at ${new Date(grant.expiresAt).toISOString()}`,
  );
}
