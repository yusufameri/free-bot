# The run loop (U1.7)

A run executes here. U1.4 landed the run model (`packages/core`'s seven statuses, the record, the
seq-ordered log) and proved the lifecycle against frames; this unit makes the lifecycle produce
those frames. `start_run` drives a real sandbox, a provider turn produces a tool call, the gate
intercepts it, an approval parks and resolves, the result feeds the next turn, and the run finishes.

The loop's model is the factory's choice, not a fixed replay. `apps/server/src/provider.ts` builds a
real `KeyedProvider` when the vault holds a key and a replay provider when it does not, so a keyed
machine calls a real model. This unit's evidence run pins the replay provider on purpose so its
assertions hold a fixed turn (order 9). Nothing else is a stand-in.

## Shape

```
packages/core/src/run-loop.ts        the loop: one pure function over injected ports
packages/core/src/run-loop.test.ts   16 tests over the transitions, fake ports, real gate and log
apps/server/src/run-ports.ts         the landed packages adapted into those ports
apps/server/src/replay-provider.ts   the model's turns, read from a committed Pi transcript
apps/server/src/run-service.ts       the run endpoints, over one SeqLog
apps/server/src/run-loop-live.ts     the evidence run: a real container, the replay provider
apps/server/src/run-service.test.ts  the endpoints driven with a fake sandbox
```

## The steps

1. **Start and begin.** `store.start` creates the record, `run.started` carries the prompt,
   `store.begin` moves it to running, and `run.status` says so. The record exists and is running
   before anything external happens, so a crashed run is visible rather than invisible.
2. **Create the sandbox** from the run's spec, from the pinned image. A sandbox that will not start
   fails the run at `sandbox_unavailable` before its first turn, which is the reason `queued` has a
   `failed` transition at all.
3. **One provider turn.** `turn.started`, then the assistant text it streamed as
   `message.text.delta` frames, then each tool call it asked for.
4. **The gate intercepts each call.** `tool_call.requested`, then the gate's verdict as
   `tool_call.decision`. An allow runs the call in the sandbox and records `tool_call.result`. A
   denial the control plane can ask about (`no_grant`, `grant_mismatch`) parks the run. Any other
   denial is fail-closed: no card, and the call never runs. A ledger denial must never become a
   prompt for a human, or the gate stops being a gate.
5. **A parked call resolves.** `store.park` records the approval on the run, `approval.requested`
   carries the card, and `run.status` says `awaiting_approval`. Then the human answers:
   - **allow once**: `approval.resolved` with the issued grant, then a second gate ask consumes it,
     which is the allow-once move, and the call runs.
   - **deny**: `approval.resolved` with no grant, and the second ask reports `user_denied` from the
     refusal the answer recorded.
   Either way the decision in the log is the gate's, never one the loop invented, and either way the
   run returns to running.
6. **The results feed the next turn.** The outcomes of one turn are the `results` of the next. A
   turn with no tool calls ends the run: `run.finished` and `run.status` `done`.
7. **The sandbox is destroyed on every path**, a `create` that threw included, so a run never leaks
   a container.

Two bounding rules stand beside the steps. A provider that never settles trips the turn ceiling and
fails the run at `internal_invariant`. A sandbox lost mid-call pauses the run at
`sandbox_lost_mid_run` instead of failing it, per the taxonomy, and leaves the call unresolved
because the rejoin replays from the record's position.

## The ports

The loop owns no I/O. Six ports carry everything it needs, and each is implemented by an adapter
over a landed package, so the same code runs under `bun test` and against Docker.

| Port | Methods | Live adapter |
| --- | --- | --- |
| `ProviderPort` | `next(TurnInput): Promise<ProviderTurn>` | `ReplayProvider` over the committed transcript; Pi in the sandbox once G1 clears |
| `SandboxPort` | `create(spec)`, `execute(call)`, `destroy()` | `DockerRunSandbox` over `packages/sandbox`'s `DockerAdapter` |
| `GatePort` | `decide(call): Promise<GateVerdict>` | `packages/review`'s `createGrantPolicy` over a real ledger |
| `ApprovalPort` | `await(ApprovalRequest): Promise<ApprovalAnswer>` | `createPendingApprovals`, resolved by the approve and deny routes |
| `RunStore` | the landed seven named operations | `packages/core`'s own store, not adapted |
| `LogPort` | `append(type, payload): number` | `createLogPort` over the `SeqLog` the reader pages |

`RunStore` is the state authority and the `SeqLog` is the record, so the loop never keeps a status
of its own and never mints a seq. The gate is the only thing that allows a call.

`ProviderTurnError` is how a provider adapter names a taxonomy code: the adapter knows the provider
client's typed errors, the loop only knows `RunFailureCode`. A failure the adapter did not name
settles at `internal_invariant`.

## The two new wire frames

`run.status` is the one kind the twelve-kind vocabulary was missing. It answers "where is this run"
without making a reader merge five kinds, and it is the only thing that can say `paused` or
`cancelled`, which previously existed in the record and nowhere on the wire.

```json
{"v":1,"seq":6,"ts":1792238400009,"runId":"run-u1.7","type":"run.status",
 "payload":{"runId":"run-u1.7","status":"awaiting_approval"}}
```

`runId` repeats the envelope's field on purpose. The envelope stays the single source for `seq`,
`ts`, and the run a message belongs to; this copy lets a consumer that holds a bare payload address
its run.

`user_denied` is the tenth deny code. A resolved human denial was indistinguishable from a missing
grant: both arrived as `no_grant`, so a surface could not say "you denied this" and a consumer could
not tell an answered refusal from a question nobody asked.

```json
{"v":1,"seq":18,"ts":1792238400027,"runId":"run-u1.7","type":"tool_call.decision",
 "payload":{"toolCallId":"u17-call-2","allow":false,"code":"user_denied",
            "detail":"the user denied action v1:sha256:3b532bd5..."}}
```

The gate produces it, not the loop: `createGrantPolicy` takes one new input, a set of refused action
hashes, and a refused action denies `user_denied` unless a live grant authorizes it. That last clause
is what makes a later allow override an earlier no.

## The endpoints

`apps/server` had healthz and the tunnel, and no oRPC (`@orpc/contract` is not installed). The run
endpoints are Hono routes validated with the landed DTO schemas:

| Route | Operation |
| --- | --- |
| `POST /runs` | `start_run`: 202 with the run id, before the run does anything |
| `POST /runs/:runId/cancel` | `cancel_run`: cooperative; the loop cancels between calls |
| `GET /runs/events?last_seq=&limit=` | `get_events`: pages the one log by watermark |
| `POST /approvals/:approvalId/allow` | `approve` |
| `POST /approvals/:approvalId/deny` | `deny` |

One `SeqLog` serves every run the service starts, and every reader reads that one buffer.
`startTunnelServer` gained an optional `log`, so the control plane's stream can serve the same buffer
instead of a second one; that injection is what "reuse the landed stream" means here, and the
stream's v1 adoption is the follow-up `docs/protocol.md` already names.

Driving a run to completion over these routes is proven with a fake sandbox in
`run-service.test.ts`, not against Docker, so the endpoint claim is unit-test-verified.

### Overlap with the landed control plane, and what to do about it

U1.3 landed after this unit's brief was written and carries its own run surface: `control-plane.ts`
mints `run.started` and a cancel with its own run table over its own `SeqLog`, and `router.ts`
implements `start_run`, `cancel_run`, `get_run` and `subscribe_events` behind the auth gate. That was
the placeholder this unit was expected to replace, and for one unit's duration both surfaces were
present.

U2.1 performed the resolution: `control-plane.ts` and the Hono `runRoutes` are deleted, the oRPC
router drives `RunService` directly, and the page's own stream is a second transport over the same
log. The Hono table under "The endpoints" below is historical. `docs/one-run-path.md` is the current
record.

## What the evidence run proves

`bun apps/server/src/run-loop-live.ts` writes
`packages/verify/artifacts/run-loop/<short-sha>/assert.txt`. It boots a container from the pinned
image (asserting the recorded layer set), runs the loop with the replay provider, allows the first
call once and denies the second, and prints the status trail, the decision table, the seq audit, both
new frames as they sit in the log, and the container proof.

| Real | Replayed |
| --- | --- |
| the container, from the pinned image | the model's turns, from the committed Pi transcript |
| the loop, the gate and the grant ledger | the human's two answers, scripted by the run |
| the approved call's execution, inside the container | the transcript's own closing text |
| the run store and the seq-ordered log | |

Two things about that table are worth stating plainly. The recorded turn holds one governed (`bash`)
call, so the second call, the one the human refuses, is scripted by the evidence run: the refusal
path needs a second governed call and the recording has none. And the closing assistant text is the
recording's own wording for the recording's result, not a reaction to the container's output; the
`tool_call.result` frame beside it is the container's real stdout.

The cleanup proof is label-scoped per order 22: the run's own container is gone after the run, the
unit's `sweep()` finds nothing left to remove, and a decoy container carrying a different unit label
survives until the run removes it itself.

## What remains

- **The keyed model.** This unit's evidence run pins the replay provider; a run under `bun run up`
  uses the vault's keyed model, selected by the factory in `apps/server/src/provider.ts` and asserted
  by `packages/verify/scripts/keyed-run.ts` (U2.4). The loop does not change between the two.
- **The scheduler.** Idle-kill and auto-stop still belong to it. The loop destroys its own sandbox at
  the end of a run and carries `idleTtlMs` on the spec, but nothing stops an idle sandbox between
  runs, and nothing resumes a run parked at `sandbox_lost_mid_run`. The rejoin contract exists (the
  record's `lastSeenSeq`, the log's `since`), and the scheduler is what calls it.
- **Spend caps are not wired.** `checkSpendCap` exists and is tested, and the loop does not consult it:
  no `usage_event` is recorded either, because the replay provider reports no usage. This PR wires
  neither, and a keyed provider is what makes the check meaningful.
- **The gate's allow carries no grant id**, so `tool_call.decision` cannot name the grant it consumed.
  `docs/protocol.md` already carries this follow-up.
- **`packages/ui` renders no grant lifecycle or turn marker for a live run.** The `run.status` arm
  this unit noted as missing was added in U2.1: the page now renders the run's own transitions, so a
  parked run does not look frozen. `grant.lifecycle` frames are emitted by no landed producer, so the
  page's arm for them renders nothing yet.
- **oRPC.** The routes are the DTO shapes over HTTP; the `@orpc/contract` wiring is the mechanical
  pass `docs/protocol.md` names.
