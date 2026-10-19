# Stopping a run, and the spend cap the loop consults

U10.3 closes the two MVP predicate lines that were partial: a run started from the page can be
stopped from the page, and the per-run spend cap `packages/core` computes is consulted by the run
loop rather than only by an evidence script.

## The stop

The composer carries two controls: `Start run` and `Stop run`. The stop is present always and
disabled unless a run is in flight. Its DOM state is the whole contract a driver reads: the label,
`disabled`, `data-in-flight`, `data-run-id`, and `data-stopping`.

Clicking it calls the contract's own `cancel_run` over oRPC, the route `apps/server/src/router.ts`
already implements. The fixture peer, which has no route client, sends `{type: "cancel", runId}` on
the page's socket instead; `apps/server/src/api-server.ts` lands that on the same
`RunService.cancel`.

`RunService.cancel` has two jobs. It sets the run's cancelled flag, which the loop checks before the
sandbox, between turns and between calls. If the run is parked at the gate, it also wakes the
pending approval (`PendingApprovals.cancelRun`), because a promise that waits on a human is not a
point the loop's next check reaches. The loop checks its cancelled flag after the wait resolves and
settles through the taxonomy's `cancelled` entry before reading whatever woke it. That is why a stop
while the card is waiting records no allow and no denial.

The terminal state is `cancelled`, carried by `run.status` and nothing else: the loop does not emit
`run.finished` or `run.failed` for a stop. The page keeps every frame that arrived before the stop,
disables the waiting approval's buttons and marks the card `run stopped`, disables the stop control
again, and re-enables the composer. The loop's `finally` destroys the run's sandbox on this path as
on every other, so the stop leaves no container behind.

A provider call already in flight is not aborted mid-call: the loop stops at its next check, which is
the boundary after that call returns. The sandbox and the container are removed when the run settles.

## The spend cap

The loop now reads settled usage. A provider turn may carry `usage` (`provider`, `model`, `tokens`,
`costNanoUsd`); the loop records it on the run as `runId:turn-N` through `RunStore.recordUsage`, so a
replay cannot count one call twice. Before each provider turn it calls
`checkSpendCap(run.usage, request.spendCapNanoUsd)`.

A total over the cap settles the run at the taxonomy's `spend_cap` entry, which is `failed` with a
`run.failed` frame whose reason names the spend, the cap and the overage. The next provider call is
not made. A total exactly equal to the cap is still within it (`checkSpendCap` compares `>`), and an
under-cap run is unaffected. A run started without `spendCapNanoUsd` is uncapped: the ceiling is the
configured one, not a hard-coded number.

The keyed adapter prices a turn when it is given the four token prices; without them it reports no
usage cost rather than a zero that would make a cap look enforced. The keyed wire reports prompt and
completion tokens only, so the two cache counts are zero.

`bun run up` configures both together:

```bash
# The per-run ceiling; the launch defaults to 5.00 USD when this is unset.
FREEBOT_SPEND_CAP_USD=0.50

# All four or none: a partial set is refused at boot, not defaulted.
FREEBOT_PRICE_INPUT_PER_MTOK=3.00
FREEBOT_PRICE_OUTPUT_PER_MTOK=15.00
FREEBOT_PRICE_CACHE_READ_PER_MTOK=0.30
FREEBOT_PRICE_CACHE_WRITE_PER_MTOK=3.75
```

The launcher prints the cap at boot:

```
freebot up: spend cap 5.00 USD per run; no token prices configured, so a keyed run reports no cost
```

The cap measures provider calls. A connector call's own vendor billing is outside the run's token
cost and outside this ceiling.

## Evidence

- `bun packages/verify/scripts/cancel-run.ts` — `live-ui-verified`: a really launched
  `bun run up --no-open --replay`, a run started from the page, a stop clicked while the recorded
  call is parked, the `cancelled` terminal marker, the retained prompt and tool card, and the
  label-scoped container census back to its baseline beside a surviving decoy. Three committed
  frames: `01-no-run`, `02-in-flight`, `03-cancelled`.
- `bun packages/verify/scripts/spend-cap.ts` — the landed loop over a provider that reports settled
  usage: an over-cap run is refused its next provider turn with `spend_cap`, an under-cap run is
  unaffected, spending exactly the cap still allows the next turn, and an uncapped run with the same
  spend finishes.
