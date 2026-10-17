# The run model (U1.4)

A `run` is one agent execution in `packages/core`. Plan 2.8 puts it beside the thread rather than
inside it, because a run has its own lifecycle, its own cost, and its own forensics: a thread keeps
conversation, a run is the thing that can be queued, parked for consent, lost with its sandbox, and
resumed without losing either.

## Files

| File | What it owns |
| --- | --- |
| `run-status.ts` | The seven statuses, the transition registry, and the refusal error |
| `run-errors.ts` | The eight failure codes with their status, wire kind, and UI copy |
| `run-events.ts` | Which landed protocol kind each transition emits |
| `run-store.ts` | The record, the named operations, and the append-only journal |
| `run-usage.ts` | Integer nano-USD money and the per-run, per-model accumulator |

## The lifecycle

```
queued ──begin──▶ running ──park──▶ awaiting_approval ──resolve──▶ running
   │                 │  ▲                  │                            │
   │                 │  └──────resume──────┼──── pause ─▶ paused ───────┘
   │                 │                     │                 │
   └──fail───────────┴──finish──▶ done     └──fail──────────┴──fail──▶ failed
        │                                                              
        └──cancel────────────────────────────────────────────▶ cancelled
```

Fourteen pairs are legal; `transitionPairs()` lists them and `RUN_TRANSITIONS` is the only authority
on which. `RunStore` exposes one named operation per move and no status setter, so the illegal ones
have no call site. `queued` can fail without ever running, because a sandbox that will not start
fails a run before its first turn. The three terminal statuses are settled: every later lifecycle
operation is a no-op, so cancelling a finished run is not an error and never rewrites history, while
a `seq` or `usage` frame still lands on a settled record so late arrival is not lost.

`awaiting_approval` and `paused` both return to `running`, and both are waits rather than endings. A
denied approval returns the run to `running` too: the refusal is the tool's result, not the run's
outcome, and the decision itself lives in the grant ledger and in the approval stream.

## The store

One record per run, keyed by a caller-minted id, holding `{id, threadId, botId, status, prompt,
lastSeenSeq, attempt, approval, usage, error, createdAt, updatedAt}`. `attempt` is 1 at start and
grows by one per resume after a loss; `lastSeenSeq` only moves forward, so a replayed or late frame
cannot drag the rejoin point backwards.

Every mutation is a command and every command is appended to a JSONL journal before the caller is
answered. Commands are idempotent, which is what makes the journal cheap to recover:

- `start_run` on an existing id returns the same record and creates nothing.
- `cancel_run` on a terminal run is a no-op.
- a resent park (the agent replaying a held approval request after a rejoin) is the same park.
- a repeated `usage_event` id is refused rather than counted twice.
- a `seq` at or below the record's position changes nothing.

A journal whose last line has no newline ends in a write the process never reported applied. The
store drops that tail and repairs the file, because leaving it there would turn it into a malformed
line in the middle of the journal as soon as the next command landed and poison every later restart.
A malformed line anywhere else is corruption and throws with its line number.

## The failure taxonomy

| Code | Run | Wire kind | UI copy |
| --- | --- | --- | --- |
| `provider_auth` | failed | `run.failed` | The model provider rejected your API key. |
| `provider_rate_limit` | failed | `run.failed` | The model provider is rate-limiting you. Try again in a few minutes. |
| `provider_malformed_tool_call` | failed | `run.failed` | That model sent a tool call FreeBot cannot run. Try a different model. |
| `sandbox_unavailable` | failed | `run.failed` | FreeBot could not start the sandbox. Run freebot doctor. |
| `sandbox_lost_mid_run` | paused | none | The sandbox was lost. FreeBot is reconnecting; the run continues where it stopped. |
| `approval_timeout` | failed | `run.failed` | The approval request timed out. |
| `cancelled` | cancelled | none | Cancelled. |
| `internal_invariant` | failed | `run.failed` | FreeBot hit an internal error and stopped this run. |

A code carries its own sentence (`means`), the status the run converges to, the kind that carries it,
and the one line the shell shows, so a new code cannot land with half a mapping. Losing the sandbox
mid-run parks the run instead of ending it, because the smoke proved the rejoin path works.

Two rows have no wire kind. The landed twelve say nothing that means "this run is parked", "this run
is paused", "this run was cancelled", or "this run rejoined", and the only kind left is `run.failed`,
whose payload means the run ended without completing. The record is authoritative for those states.
One `run.status` kind closes the gap, and it is a follow-up because
`packages/protocol/src/envelope.test.ts` pins the kind list literally and belongs to
packages/protocol.

## Usage and spend

`UsageEvent` is plan 2.8's `usage_event`: one call's provider, model, tokens, and cost. Totals are a
fold over events, keyed `provider/model` with sorted keys so a snapshot is byte-stable. Money is an
integer count of nano-USD (`1 USD = 1_000_000_000`), parsed once from the decimal strings providers
publish and never a float afterwards; a price finer than one nano-USD per token is refused rather
than rounded.

`checkSpendCap(totals, capNanoUsd)` is the threshold compare a run loop consults. The run loop does
not exist yet, so the enforcement wiring is a follow-up; the compare itself is done and tested.

## `freebot doctor`

`bun apps/server/src/cli/doctor.ts` prints five literal PASS/FAIL lines: the bun version, the Docker
daemon, the pinned sandbox image and its base digest label, the run store, and the provider key's
presence (never its value). It lives in `apps/server` because that app owns the local control-plane
runtime and already imports `packages/core`; plan 2.7 has no CLI app, and one would be scaffolding
for five checks.

The two Docker probes retry once after 500 ms. Docker Desktop answers `docker info` and `docker image
inspect` with a non-zero exit while its daemon is still booting, and a mid-boot machine produced
`FAIL pinned image: freebot-sandbox:u0.6 not present` on a first run and the exact committed digest
seconds later. The retry cannot hide a genuinely absent image: both attempts fail the same way and
the check still prints `freebot-sandbox:u0.6 not present`.

The store check writes rather than stats: it starts, cancels, and reopens a `doctor-probe` run. Both
operations are idempotent, so a hundred doctor runs leave one settled record and append nothing after
the first three commands. The provider key check FAILs while gate G1 parks the keyed run, which is
the honest answer rather than a rubber stamp.

## Evidence

`bun packages/core/src/run-evidence.ts` drives the smoke's lifecycle frame by frame through the
landed `SeqLog`, kills the process that holds the journal mid-step, reopens with a torn last line,
rejoins on attempt 2 at the seq after the kill, and prints the transition rows, the idempotency
results, the convergence result, the taxonomy table, and the doctor's output to
`packages/verify/artifacts/core-run-model/<short-sha>/assert.txt`.
