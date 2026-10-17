# Protocol v1 (U1.1): one envelope, one seq, zod as the single source of truth

`packages/protocol` is the shared contract for Phase 1. It defines what travels; it does not
enforce ordering. `packages/core`'s `SeqLog` owns ingest, refusal, dedupe, and the audit, and no
shape here weakens those rules (plan 2.7, plan 5.2). Every Phase 1 consumer imports this package.

## Shape

```
src/envelope.ts   version tag, seq/ts/runId fields, the message union, parse and serialize
src/events.ts     the taxonomy: EVENT_PAYLOADS registry (12 run-scoped kinds) + STREAM_PAYLOADS
src/dto.ts        the oRPC contract: 7 operations, strict inputs, /workspace-pinned paths
src/index.ts      public surface
fixtures/         the literal U0.10 display traffic and the rejection table
scripts/          fixture generator, spike->v1 adapter, replay demo, rejection runner, verify runner
```

zod schemas are the single source of truth. Every exported type is a `z.infer` of a schema;
`EventPayloads` is a mapped type over the `EVENT_PAYLOADS` registry, so a new kind cannot exist
without its payload schema. zod 4.6.7 is the only new external dependency (plan 444 sanctions
zod). `@freebot/core` and `@freebot/review` are workspace devDependencies used by tests and
scripts only; the contract itself imports zod alone.

## Envelope rules

Every log-ordered message is one object:

| Field | Rule |
| --- | --- |
| `v` | `1`, a zod literal. A breaking change to any shape bumps it. |
| `seq` | Integer ≥ 1. The message's own place in the one log. Never reused. `0` is a reader's cursor, never a message. |
| `ts` | Epoch milliseconds, minted by the origin together with the seq. |
| `runId` | Present on every run-scoped kind, absent on stream markers. `= "run-1"` never appears; it is minted by `start_run`. |
| `type` | The kind. The spike already used `type`; the discriminant keeps that name so the proven renderer keeps working. |
| `payload` | Always present, `{}` when the kind has nothing to say. |

Stream markers (`stream.hello`, `stream.resumed`, `stream.gap`) are the deliberate exception. A
marker addresses log positions instead of owning one, so it carries `v`, `type`, and `payload`,
and no `seq`. Giving a marker a fabricated seq is how a second counter starts; an empty log (a
page loaded before the first run) is the case that proves it, since there is no positive seq to
give.

## The message table

Twelve run-scoped kinds carry the log. Payload fields are exact; `seq`, `ts`, `runId` come from
the envelope.

| Kind | Payload | Carries |
| --- | --- | --- |
| `run.started` | `{prompt}` | The run boundary. A replayed log is self-describing. |
| `run.finished` | `{}` | Pi settled without failure and without a cancel. |
| `run.failed` | `{reason}` | The run ended without completing. Free text until the error taxonomy lands. |
| `turn.started` / `turn.ended` | `{turn}` | One model turn inside the run, counted 1..n. |
| `message.text.delta` | `{text}` | One assistant text delta; empty deltas are legal. |
| `tool_call.requested` | `{toolCallId, toolName, command, destructive}` | A call about to run, `command` = name + JSON args. |
| `tool_call.decision` | `{toolCallId, allow: true}` or `{toolCallId, allow: false, code, detail}` | The gate's verdict before anything runs. `code` is one of the nine, verbatim. |
| `tool_call.result` | `{toolCallId, ok, denied, output, durationMs}` | What the call did. A denied call never ran: `durationMs` is null. |
| `approval.requested` | `{approvalId, toolCallId, command, actionHash, expiresAt}` | A governed call parked for consent. `actionHash` binds it to the exact call; `expiresAt` is the deadline to answer. |
| `approval.resolved` | `{approvalId, decision: "allow", grant}` or `{approvalId, decision: "deny"}` | The answer. An allow carries the issued grant; a deny mints nothing. |
| `grant.lifecycle` | a union on `state`: `issued` / `consumed` / `expired` / `rewound` | The ledger transitions, each with exactly its own fields (`consumedBy`, `reason`). |

Three stream markers, never logged:

| Marker | Payload | Means |
| --- | --- | --- |
| `stream.hello` | `{firstSeq, lastSeq}` | The log's range at connect, the SeqLog audit fields of the same names. |
| `stream.resumed` | `{fromSeq, toSeq}` | A reader rejoined from `fromSeq`; the log runs to `toSeq`. |
| `stream.gap` | `{expected, got}` | A reader refused `got` because `expected` was missing, the SeqLog gapEvent verbatim. |

## One seq across transports

The seq is minted once, by the origin that reads the source of truth: the sandbox supervisor,
Pi's single reader, exactly as `packages/core/src/tunnel.ts` states and as U0.7's kill/rejoin and
U0.9's forged-call spikes proved (239 frames, zero gaps, zero duplicates across a SIGKILLed
composer). The control plane appends frames in exactly that order and never renumbers. Both
transports then **read** the one log:

| Message class | Transport | Direction |
| --- | --- | --- |
| `start_run`, `cancel_run`, `approve`, `deny`, `list_files`, `read_file` | oRPC request/response | client → control plane |
| `get_events(lastSeq)` | oRPC request/response | client → control plane, reads the same log |
| every run-scoped event, live | WebSocket push (`packages/core` `StreamMessage`) | control plane → client |
| `stream.hello` / `stream.resumed` | WebSocket, at connect and at replay | control plane → client |
| `stream.gap` | same socket, in the direction of the refusal | reader → sender |

The single counter survives because nothing but the supervisor mints and both transports read the
same log; a client that uses both keeps one `lastSeq` and may interleave them freely. The replay
path is identical on both: name `last_seen_seq` (`lastSeq` in `get_events`, `?last_seen_seq=` on
the socket) and receive exactly the messages after it, dense, from the same log.

## Versioning and unknown keys

- **The tag is the compatibility boundary.** `v: 1` on every message. Additive fields stay in v1;
  a shape that changes meaning bumps the literal, and old readers refuse it loudly rather than
  misread it.
- **Wire messages strip unknown keys** (zod's default `z.object`). A v1.x producer that adds a
  field cannot break a v1 reader, and an untrusted in-VM producer cannot smuggle extra keys into
  the display layer or the log: the parsed value holds exactly the schema's fields. This is the
  middle path between the two options the brief named: `strict` would make every additive field a
  coordinated flag day, `passthrough` would let unnamed keys travel. Required-field typos still
  fail, because a missing required key is an error.
- **Command inputs are strict** (`z.strictObject`). An unknown key in `start_run` or `approve` is
  a caller bug, and the caller is same-machine, same-version code; refusing is fail-closed. Every
  operation in `API_OPERATIONS` has a test that proves its refusal.

Both halves of the policy are asserted against literal zod text in `src/envelope.test.ts`,
`src/dto.test.ts`, and the shared tables in `fixtures/rejections.json`.

## Spike to production: what changed and why

The U0.10 page (59/59 CDP checks) streams `{seq, type, payload}` with eight display types. v1
keeps the envelope field names and every payload field it proved, and changes four things:

| Spike | v1 | Why |
| --- | --- | --- |
| — (none) | `run.started`, `run.finished`, `run.failed`, `tool_call.decision`, `grant.lifecycle`, `stream.*` | The run model, the gate verdict, the ledger transitions, and the resume markers are Phase 1 facts the stub never had. |
| `turn_start` / `turn_end` | `turn.started` / `turn.ended` | Same payload, namespaced so every kind is `domain.thing`. The turn cards the spike renders and asserts (4 turns) keep working. |
| `message_delta`, `tool_call`, `tool_result`, `approval_request` | `message.text.delta`, `tool_call.requested`, `tool_call.result`, `approval.requested` | Renames only. Payload fields are byte-identical (`text`, `toolCallId`, `toolName`, `command`, `destructive`, `ok`, `denied`, `output`, `durationMs`, `approvalId`). |
| `approval_resolved {decision: null}` | no message | The spike sent a placeholder and filled in the answer later. In v1 the pending state is `approval.requested` alone; a resolved approval always carries a decision. |
| `stream_end` | `run.finished` | The stub's terminal marker; the run boundary is what actually ended. A long-lived socket has no end marker. |
| `seq` renumbered densely (1..84) | the seq the log mints, densely from 1 | Same intent, but the spike's numbering was the stub's; production mints at the origin. The adapter renumbers, so a dropped frame cannot leave a hole. |

The compatibility test (`src/spike-compat.test.ts`) reads the literal fixture
(`fixtures/spike-display-frames-a.jsonl`, 84 frames produced by the spike's own mapper over the
committed U0.7 transcript) and proves every frame maps, every mapped message parses and
round-trips under v1, and the spike's own field values survive byte for byte, including the gated
call's real canonical action hash (`v1:sha256:2adc5e17...`).

## Deliberately not in v1

- **Browser, VNC, and screen events** (Phase 2). The taxonomy has no `browser.*` or `screen.*`
  kind; Phase 2 adds them additively.
- **Multi-Bot events** (Phase 4). No `botId` in the envelope and no group-thread kinds: Phase 1 is
  one Bot. The spike proved one thread and one page, and single-Bot keeps the envelope honest.
- **Per-message ids.** `seq` is the identity in Phase 1; the browser keys its cards on it and
  `SeqLog` dedupes on it. A rewind that truncates the event log (the ledger already tombstones
  grants) is what would make seq alone insufficient, so the id lands with that feature.
- **Structured tool arguments.** `command` carries the name plus JSON args the way the spike
  rendered it. The canonical action hash, not the display, is the binding for the args; the ledger
  holds them.
- **Auth.** The protocol carries no caller identity. The localhost token and the Origin/Host
  allowlist sit in the Hono layer (plan 2.7).
- **A second schema vocabulary for transports.** oRPC and WS carry the same messages; the
  `@orpc/contract` wiring is a follow-up because oRPC is not installed yet (`API_OPERATIONS` is
  shaped for a mechanical wiring pass).
- **Event-log rewind.** `grant.lifecycle` can say `rewound`; the log itself has no truncation
  operation in Phase 1.

## Evidence

`bun packages/protocol/scripts/verify.ts` runs lint, both typechecks, the test suite, the fixture
freshness check, the rejection table, and the replay demo, then writes
`packages/verify/artifacts/protocol/<short-sha>/assert.txt` (with
`replay-audit.txt` beside it). Verdict: `unit-test-verified`. No UI here: nothing in this unit
renders, so no live-ui claim is made.

The replay demo is the load-bearing artifact. It maps the recorded session, round-trips every
message through `parseMessage`, ingests the result through `packages/core`'s real `SeqLog`, and
prints the audit: 85 frames logged, `gaps 0 []`, `duplicates 0 []`, one replayed frame suppressed
at ingest (`[30]`), one gap refused and healed by resend (`31<-32`), one frame refused by the
schema before ingest (`rejected 1`).

## Follow-ups

- Wire `API_OPERATIONS` through `@orpc/contract` once oRPC lands (shape-preserving).
- The gate's allow path returns `{allow: true}` and no grant id, so `tool_call.decision` cannot
  name the consumed grant; `packages/review` would need to return it.
- `run.failed {reason}` is free text until the Phase 1 error taxonomy names codes.
- Retire `scripts/spike-map.ts` and the spike fixture with the U0.10 spike in Phase 1.5.
- Decide the per-message id when the event log gains rewind.
