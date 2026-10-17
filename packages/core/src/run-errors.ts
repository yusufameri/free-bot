/**
 * The failure taxonomy: every way a run stops short, in one closed union.
 *
 * Each code carries the sentence that explains it to a maintainer, the status the run converges to,
 * the landed wire kind that carries it (or null, for a wire gap), and the one line the shell shows.
 * The binding lives here rather than at each call site so a new code cannot land with a status and
 * no copy, or with a copy and no status.
 *
 * Six codes settle at `failed`, one parks the run at `paused` instead (the sandbox can be rejoined,
 * so losing it mid-run is not an ending), and one settles at `cancelled`.
 */

import type { RunEventKind } from "./run-events.ts";
import type { RunStatus } from "./run-status.ts";

export const RUN_FAILURE_CODES = [
  "provider_auth",
  "provider_rate_limit",
  "provider_malformed_tool_call",
  "sandbox_unavailable",
  "sandbox_lost_mid_run",
  "approval_timeout",
  "cancelled",
  "internal_invariant",
] as const;

export type RunFailureCode = (typeof RUN_FAILURE_CODES)[number];

export interface FailureEntry {
  /** One sentence: what causes this, for whoever reads the run's forensics. */
  means: string;
  /** The status the run converges to. */
  status: RunStatus;
  /** The landed kind that carries it, or null when the vocabulary is silent. */
  event: RunEventKind | null;
  /** The one line the shell shows. */
  copy: string;
}

export const FAILURE_TAXONOMY = {
  provider_auth: {
    means: "The provider rejected the key, or the account cannot reach the model.",
    status: "failed",
    event: "run.failed",
    copy: "The model provider rejected your API key.",
  },
  provider_rate_limit: {
    means: "The provider answered 429 and the run's retries were exhausted.",
    status: "failed",
    event: "run.failed",
    copy: "The model provider is rate-limiting you. Try again in a few minutes.",
  },
  provider_malformed_tool_call: {
    means:
      "The model's tool call did not match the tool schema and the structured-output fallback could not recover it.",
    status: "failed",
    event: "run.failed",
    copy: "That model sent a tool call FreeBot cannot run. Try a different model.",
  },
  sandbox_unavailable: {
    means:
      "No sandbox could be started: the daemon is down, the pinned image is missing, or the provider refused.",
    status: "failed",
    event: "run.failed",
    copy: "FreeBot could not start the sandbox. Run freebot doctor.",
  },
  sandbox_lost_mid_run: {
    means:
      "The sandbox died while the run was in flight. The run is parked, not failed, until the agent rejoins with its last seen seq.",
    status: "paused",
    event: null,
    copy: "The sandbox was lost. FreeBot is reconnecting; the run continues where it stopped.",
  },
  approval_timeout: {
    means:
      "A parked call reached its deadline with no answer, so the control plane denied it and failed the run.",
    status: "failed",
    event: "run.failed",
    copy: "The approval request timed out.",
  },
  cancelled: {
    means: "The user cancelled the run.",
    status: "cancelled",
    event: null,
    copy: "Cancelled.",
  },
  internal_invariant: {
    means:
      "The control plane broke one of its own invariants, for example by asking for an illegal lifecycle transition.",
    status: "failed",
    event: "run.failed",
    copy: "FreeBot hit an internal error and stopped this run.",
  },
} as const satisfies Record<RunFailureCode, FailureEntry>;

export interface RunFailure {
  code: RunFailureCode;
  /** This instance's own message: a provider string, a seq, a line of detail. Never the UI copy. */
  detail: string | null;
  at: number;
}

export class RunTaxonomyError extends Error {
  readonly code: RunFailureCode;
  readonly attempted: "pause" | "fail";

  constructor(code: RunFailureCode, attempted: "pause" | "fail") {
    super(
      `${attempted}(${code}): the taxonomy settles this code at status ${failureEntry(code).status}`,
    );
    this.name = "RunTaxonomyError";
    this.code = code;
    this.attempted = attempted;
  }
}

export function failureEntry(code: RunFailureCode): FailureEntry {
  return FAILURE_TAXONOMY[code];
}

export function failureFor(code: RunFailureCode, detail: string | null, at: number): RunFailure {
  return { code, detail, at };
}

/** The codes that park a run rather than ending it. */
export function isParkingCode(code: RunFailureCode): boolean {
  return failureEntry(code).status === "paused";
}
