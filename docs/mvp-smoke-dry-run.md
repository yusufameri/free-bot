# MVP smoke dry run (U0.11): the whole Phase 0 pipeline, keyless, one command

Status: PASS. 60/60 harness checks at commit `7ce8f5e`, run by `bun spikes/mvp-smoke/run.ts`.
Artifacts: `packages/verify/artifacts/mvp-smoke/7ce8f5e/` (assert.txt, decision-table.txt,
seq-audit.txt, frames/, logs.txt, and the three JSONL log copies the run reads back; the grant
ledger's final state is in seq-audit.txt). The run needs Docker and Chrome; it needs no provider key
and no BYOK secret.

STUB DISCLOSURE: the decision source in this run is the keyless scripted stub
`spikes/forge-test-a/stub-model.ts`. No provider, no BYOK key, no live-model traffic. Gate G1
parks the keyed run (U0.12), which replaces only the decision source. Every other component here
is the real one: pi 1.3.0 in the pinned sandbox image, the landed tool-gate extension, the U0.8
grant ledger and policy, the U0.7 tunnel protocol, and the U0.10 page.

## Question

Does the pipeline compose end to end with no model key: one host control plane carrying a real
pi turn through the tunnel, every tool call gated by the real grant policy, the stream rendered
in the U0.10 page and answered by clicking, and a mid-task SIGKILL of the relay and the composer
surviving on one gapless, duplicate-free seq log?

## Shape

```
host                                              container (pinned sandbox image)
  Chrome 155, headless, CDP-driven                  supervisor   owns pi, mints the one seq,
  composer     seq log, display log, grants,                      carries the gate dialog
               decisions, page server               pi 1.3.0     bash + write, tool-gate ext
  relay        byte-transparent TCP hop             agent        tunnel client, outbox replay
  stub model   scripted plans, HTTP /v1 (keyless)

Chrome --ws /events-- composer --ws /tunnel-- relay --tcp-- agent --loopback-- supervisor --stdio-- pi
                                                                                        |
                                                              pi --HTTP /v1--> stub model server
```

The container dials `host.docker.internal`; the page never talks to the container. The composer is
the composition point and the only decision maker.

Provenance, nothing outside this directory modified:

| Reused by import | Copied with attribution, extended |
| --- | --- |
| `spikes/forge-test-a/stub-model.ts` (the decision source), `spikes/tunnel/tcp-relay.ts` (the relay), `@freebot/sandbox-agent`'s `Outbox` | U0.10's `app.ts`, `envelope.ts`, `reducer.ts`, `page.html` (renderer, unchanged); U0.7's `supervisor.ts`, `agent.ts`, `link.ts` (extended with the gate dialog) |

| File | Role |
| --- | --- |
| `run.ts` | the harness: preflight, images, processes, the CDP driver, every assertion, the artifact |
| `composer.ts` | host control plane: `/tunnel`, `/events`, `/`, `/bundle.js`, `/audit`, gate policy, logs |
| `display.ts` | pi frame to display frame mapping, the dense display log, the spike classifier |
| `display.test.ts` | 6 tests over the mapping and the display log, literal expectations |
| `supervisor.ts` | in-VM: spawns pi under `PiSession`, mints the seq at the only read point, serves the link |
| `agent.ts` | in-VM: tunnel client, outbox, resends held `gate_request`s on every reopen |
| `link.ts` | the supervisor-agent loopback protocol, extended with `gate_request` / `gate_answer` |
| `Dockerfile` | the derived image: the pinned base plus bun, for the in-VM supervisor and agent |
| `tsconfig.json` | the spike's own typecheck target (`bun x tsc -p spikes/mvp-smoke/tsconfig.json`) |

## The gate dialog path (U0.9 follow-up 1, closed here)

U0.9 had to run its own in-VM gateway because the landed link could not carry the host's answer to
pi. Here the dialog rides the same socket as the frames:

```
pi (tool-gate ext) --input dialog--> supervisor --gate_request--> agent --gate_request--> composer
composer (grant policy) --gate_response--> agent --gate_answer--> supervisor --extension_ui_response--> pi stdin
```

The extension is the landed `packages/pi-bridge/extension/tool-gate.ts`, unmodified. The composer's
`answered` map caches the decision per `requestId`, so an agent rejoin that resends a held request
gets the same answer instead of a second approval card.

## What runs, in order

1. Preflight: docker, the pi binary, Chrome, the spike typecheck. The pinned base image is built
   from `packages/sandbox/image/Dockerfile` and asserted by its node digest label; the derived
   image adds bun and nothing else.
2. The page comes up first and is asserted idle: connected, zero frames, no resume banner.
3. The container starts; `pi --version` is read in it (`1.3.0`). The supervisor starts pi under the
   tool-gate extension, points it at the stub's `/v1`, and writes its port and pid to `/scratch/state`.
4. Five plans and a stop are queued in the stub (`echo one`, the gated `rm`, `sleep 3 && echo two`,
   the repeated `rm`, the second `rm`), then the agent starts and the tunnel opens.
5. Step 1 passes the real policy: the composer mints a grant, consumes it through `createGrantPolicy`,
   and the card shows `done` with output `one`.
6. Step 2 is destructive. The gate denies with `no_grant`; the composer emits the approval card; the
   page's `Allow once` mints `grant-2` and the re-run gate allows with `via=page_allow_once`; the
   harness reads `/scratch/task/doomed.txt` in the VM and finds it gone.
7. Step 3 is in flight (`sleep 3`). The harness SIGKILLs the relay and the composer, restarts both on
   the same ports, and waits for the page's banner.
8. The task continues: step 3 finishes on the same logs, the repeated `rm` is denied from the ledger
   with `grant_consumed` and no card is offered, and the second `rm` is refused by the page (`Deny`).
9. The run asserts the end state, writes the artifact, and prints one `RESULT` line.

## Decisions

One decision per call, from the artifact's `decision-table.txt`:

| Call | Command | Code | Via | Grant |
| --- | --- | --- | --- | --- |
| `call_step_1` | `echo one` | `allow` | `policy_auto_grant` | `grant-1`, consumed by `call_step_1` |
| `call_step_2` | `rm -f /scratch/task/doomed.txt` | `allow` | `page_allow_once` | `grant-2`, consumed by `call_step_2` |
| `call_step_3` | `sleep 3 && echo two` | `allow` | `policy_auto_grant` | `grant-3`, consumed by `call_step_3` |
| `call_step_4` | `rm -f /scratch/task/doomed.txt` (repeat) | `grant_consumed` | `policy` | none, denied without a card |
| `call_step_5` | `rm -f /scratch/task/doomed2.txt` | `user_denied` | `page_deny` | none |

The spike-local classifier is one rule: a bash command that names `rm` needs a human. The real
classifier is the Phase 5 policy engine; this run needs exactly one destructive step. A harmless
call is auto-granted by issuing a real grant and immediately consuming it through the real policy,
so even the ungated path exercises the ledger. A destructive call is offered to the page only when
the gate denies with an approvable code (`no_grant`, `grant_mismatch`); ledger denials stay
fail-closed with no card.

## Kill and rejoin

The harness SIGKILLs the relay and the composer. Both, because the page's resume banner is the
page's own socket dying and reopening; killing the relay alone would leave the page open and prove
nothing about the durable logs. Both restart on the same ports; the composer reloads
`frames.jsonl`, `display.jsonl`, and `grants.jsonl`, rebuilds the mapper's turn count and command
map by re-running the pure mapping over the reloaded frames, and loads the denial set from
`decisions.jsonl`.

At the kill: the pi log stands at seq 58, the last frame being step 3's `tool_execution_start` (the
`sleep 3` is in flight, the stream is quiet by construction), and the display log stands at seq 18.
The agent rejoins (`last_seen_seq=58 reconnects=1`), the page resumes from its last display seq and
shows `resumed from seq 18`, and the run ends with zero gaps and zero duplicates in both logs, with
all 106 minted pi seqs present in the durable log and 38 display frames rendered.

## Evidence

`bun spikes/mvp-smoke/run.ts` is the one command. It drives real Chrome over CDP and asserts DOM
facts against literal values: the card command strings, `one\n` and `two\n` as card output, the
button labels `["Allow once","Deny"]`, the decision texts `allowed once` and `denied`, the banner
text, the five card statuses, the two approval decisions, and the dense rendered seqs. The freezes
are real: while the first approval is pending the page's `lastSeq` is asserted unchanged across
700 ms, and no decision line exists for the pending call.

Side effects are read in the VM, not from the gate's return value: `doomed.txt` is `ABSENT` after
the allowed removal, `doomed-again` (re-created before the repeat) is still there after the
`grant_consumed` denial, and `doomed2.txt` is intact after the page's refusal.

The seq audits run on both logs and on a fresh re-read of the JSONL: gaps `[]`, duplicates `[]`,
rejected `0`, suppressed at ingest `[]`.

The seven committed frames, all byte-distinct:

| Frame | Bytes | What it shows |
| --- | --- | --- |
| `01-idle` | 16828 | connected, no frames, no banner |
| `02-streaming` | 30100 | turn 1 text, step-1 card done with output `one` |
| `03-approval-pending` | 48839 | `rm` card AWAITING APPROVAL, `Allow once` / `Deny`, frozen at display seq 11 |
| `04-post-approval` | 63359 | `allowed once`, step-2 card done with no output, the file gone in the VM |
| `05-kill-rejoin-resumed` | 66360 | `resumed from seq 18`, step-3 card RUNNING after the SIGKILL |
| `06-denied` | 110688 | the second approval resolved as denied |
| `07-done` | 110797 | six turns, last seq 38, duplicates ignored 0, `stream complete` |

The unit tests are `bun test spikes/mvp-smoke/display.test.ts` (6 pass). PNG bytes vary run to run
(antialiasing, timestamped filenames); the structure and the seqs do not. A video recording stays
deferred by standing order 12, as in U0.10.

## Limits

- The fixture stubs the model, not the pipeline. The keyed run (U0.12) is the first proof with a
  real decision source; G1 parks it.
- The destructive classifier is `/\brm\b/` in a bash command. Nothing here proves policy coverage,
  only that a gated call reaches the human and a ledger denial does not.
- The JSONL appends are `appendFileSync`, not fsync-atomic. A SIGKILL at the wrong instant could
  tear the last line of `frames.jsonl` or `display.jsonl`; both logs fail loudly at reload
  (`JSON.parse` or the `SeqLog` append outcome), so it would not fail silently. This run avoids the
  window structurally: the kill lands inside a 3-second tool call with no frames arriving, and the
  harness asserts the step-3 card is the last display frame before it fires.
- The display stream carries host-minted dense seqs (1..38), the U0.10 page contract unchanged; the
  audited pipeline log is `frames.jsonl` with pi's seqs (1..106). Which seq the page carries in the
  real pipeline is a contract decision this spike does not make.
- Approval frames are composer-emitted, because only the control plane knows whether the gate's
  denial is approvable; they are not derived from pi frames.
- One agent, one page, one container, localhost only, no auth, no TLS, hardcoded Chrome path.
  The relay and the composer share a host here; in production they are the tunnel's two ends.

## Follow-ups

1. U0.12: swap the stub for the keyed model. Nothing else in this composition should change.
2. Move the gate-dialog carriage out of the copied link: `gate_request` / `gate_answer` belong in
   `apps/sandbox-agent` and the tunnel's control messages, with a pinned `requestId` idempotency
   contract on the host side.
3. Replace the JSONL logs with an atomic-append format (fsync or length-prefixed) before anything
   concurrent writes them.
4. The Phase 5 policy engine replaces the `/\brm\b/` classifier; the composer's gate call site stays.
5. Decide whether the page keeps the dense display seq or carries pi's seq end to end.
