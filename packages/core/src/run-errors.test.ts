import { describe, expect, test } from "bun:test";
import { EVENT_PAYLOADS } from "../../protocol/src/events.ts";
import {
  failureEntry,
  failureFor,
  isParkingCode,
  RUN_FAILURE_CODES,
  type RunFailureCode,
  RunTaxonomyError,
} from "./run-errors.ts";
import { isTerminal, type RunStatus } from "./run-status.ts";

/** The taxonomy as a table of its own, so the registry is checked against this and not itself. */
const EXPECTED: Array<{
  code: RunFailureCode;
  status: RunStatus;
  event: "run.failed" | null;
  copy: string;
}> = [
  {
    code: "provider_auth",
    status: "failed",
    event: "run.failed",
    copy: "The model provider rejected your API key.",
  },
  {
    code: "provider_rate_limit",
    status: "failed",
    event: "run.failed",
    copy: "The model provider is rate-limiting you. Try again in a few minutes.",
  },
  {
    code: "provider_malformed_tool_call",
    status: "failed",
    event: "run.failed",
    copy: "That model sent a tool call FreeBot cannot run. Try a different model.",
  },
  {
    code: "sandbox_unavailable",
    status: "failed",
    event: "run.failed",
    copy: "FreeBot could not start the sandbox. Run freebot doctor.",
  },
  {
    code: "sandbox_lost_mid_run",
    status: "paused",
    event: null,
    copy: "The sandbox was lost. FreeBot is reconnecting; the run continues where it stopped.",
  },
  {
    code: "approval_timeout",
    status: "failed",
    event: "run.failed",
    copy: "The approval request timed out.",
  },
  { code: "cancelled", status: "cancelled", event: null, copy: "Cancelled." },
  {
    code: "internal_invariant",
    status: "failed",
    event: "run.failed",
    copy: "FreeBot hit an internal error and stopped this run.",
  },
];

describe("the failure taxonomy", () => {
  test("eight codes, each with the status and copy it converges to", () => {
    expect(RUN_FAILURE_CODES.length).toBe(8);

    for (const expected of EXPECTED) {
      const entry = failureEntry(expected.code);
      expect({
        code: expected.code,
        status: entry.status,
        event: entry.event,
        copy: entry.copy,
      }).toEqual(expected);
      expect(entry.means.endsWith(".")).toBe(true);
      expect(entry.means.length).toBeGreaterThan(20);
      expect(isTerminal(entry.status) || entry.status === "paused").toBe(true);
    }

    expect(EXPECTED.map((entry) => entry.code)).toEqual([...RUN_FAILURE_CODES]);
  });

  test("one code parks the run, the rest settle it", () => {
    expect(RUN_FAILURE_CODES.filter(isParkingCode)).toEqual(["sandbox_lost_mid_run"]);
  });

  test("a code carried as run.failed is a valid payload under the landed schema", () => {
    for (const expected of EXPECTED) {
      if (expected.event !== "run.failed") continue;
      const parsed = EVENT_PAYLOADS["run.failed"].safeParse({ reason: expected.code });
      expect(parsed.success).toBe(true);
    }
  });

  test("a refusal says which code and which operation, and names the settled status", () => {
    const onFail = (() => {
      try {
        throw new RunTaxonomyError("sandbox_lost_mid_run", "fail");
      } catch (error) {
        return error as Error;
      }
    })();

    expect(onFail.message).toBe(
      "fail(sandbox_lost_mid_run): the taxonomy settles this code at status paused",
    );
    expect(new RunTaxonomyError("provider_auth", "pause").message).toBe(
      "pause(provider_auth): the taxonomy settles this code at status failed",
    );
  });

  test("an instance's failure carries its own detail, not the copy", () => {
    expect(failureFor("provider_auth", "401 invalid_api_key", 1_700)).toEqual({
      code: "provider_auth",
      detail: "401 invalid_api_key",
      at: 1_700,
    });
  });
});
