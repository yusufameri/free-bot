# Forge test A (U0.9): a gated call cannot write inside the VM without a grant

Status: PASS. 91/91 checks at commit `a46071ce2b0108ad5d1d650a3a55ba4225520ced` (branch
`u0.9-forge-test-a`). Rerunnable command: `bun spikes/forge-test-a/run.ts`; artifact:
`packages/verify/artifacts/forge-test-a/a46071c/` (`assert.txt`, `seq-audit.txt`, `matrix.json`,
`decisions.jsonl`, `transcript.jsonl`, `gateway-summary.json`).

## Claim

A Pi tool call that the control plane did not authorize with one matching, unexpired, unconsumed,
untombstoned grant produces no side effect inside the VM. The gate's return value is never the
evidence: every row ends with a literal read of a canary path by `docker exec`, and the set of side
effects found inside the container equals the set of host allows, nothing else.

## Shape

The spike is the composed real path, not a mock. Pi 1.3.0 runs in the pinned sandbox image, its
only gate answer path is the landed U0.3 extension, and the grant ledger is U0.8's `GrantStore`
behind U0.8's policy. The VM relays; the host decides.

```
container (freebot-forge-a:a46071c)                  host
┌──────────────────────────────────────┐   TCP relay  ┌────────────────────────────────────────┐
│ gateway (spikes/forge-test-a)        │─┐ (SIGKILLed)│ composer (spikes/forge-test-a)         │
│   spawnPiTransport + PiSession       │ │  ┌────────►│   /tunnel  frames + gate dialogs       │
│   mints the one seq at Pi's stdout   │ │  │   WS    │   SeqLog (U0.7 protocol)               │
│   gate = relayGate, deadline = deny  │ │  │         │   GrantStore + createGrantPolicy       │
│   Outbox, resends gate requests on   │ │  │         │     (tools: bash, write)               │
│   rejoin; never decides              │◄┘  │         │   /audit /events /control              │
│ pi 1.3.0 + tool-gate.ts extension    │      │         │   frames.jsonl + grants.jsonl on disk  │
└──────────────────────────────────────┘      │         └────────────────────────────────────────┘
```

- The gate seam is the landed one: Pi's `tool_call` handler (`packages/pi-bridge/extension/tool-gate.ts`)
  asks over an `input` dialog, and `PiSession` here resolves that dialog by asking the composer over
  the tunnel. No decision is made in the VM, and the VM cannot mint consent: it has no ledger.
- The composer owns the one `SeqLog` and the one ledger, and persists both to JSONL outside every
  container mount, so the SIGKILL in row i is followed by a composer that reloads the same log and
  the same grants.
- `spikes/forge-test-a/Dockerfile` starts `FROM` the unmodified `packages/sandbox/image/Dockerfile`
  build (U0.6) and adds bun plus an empty `/var/freebot-canary`. The sandbox image itself was not
  touched.

Why the spike composes its own gateway instead of reusing `apps/sandbox-agent`: the landed agent
leg carries no host→Pi payload path. `apps/sandbox-agent/src/{supervisor,agent,link}.ts` forward
Pi frames up and `apps/server/src/tunnel.ts` ingests them; nothing carries a host message back down
to a Pi dialog, so a gate question cannot reach a host policy today. The gateway here reuses the
landed pieces that fit (`spawnPiTransport`, `PiSession`, `Outbox` from `@freebot/sandbox-agent`)
and adds the missing direction over the same tunnel protocol. That gap is the main follow-up.

## The matrix

Twelve calls, three of them allowed, each with the literal decision code and the literal in-VM
canary read (`/var/freebot-canary/<row>.txt`, `ABSENT` is the shell fallback for a missing file):

| Row | Setup | Expected | Observed decision | Canary read in the VM |
| --- | --- | --- | --- | --- |
| a | no grant for bash | deny `no_grant` | `no_grant: no grant for action v1:sha256:979ed0df…` | `ABSENT` |
| b | grant for bash with different args | deny `grant_mismatch` | `grant_mismatch: args differ from grant grant-1 for tool bash` | `ABSENT` |
| c | grant issued with a 1 s ttl an hour in the past | deny `grant_expired` | `grant_expired: grant grant-2 expired at 2026-10-17T07:41:21.441Z` | `ABSENT` |
| d | matching grant, then the identical call again | allow, then deny `grant_consumed` | `allow`, then `grant_consumed: grant grant-3 consumed by call_d_1` | present exactly once (`1792222940893040884`), unchanged by the second call |
| e | grant, then `rewind seq:0` tombstones it | deny `grant_tombstoned` | `grant_tombstoned: grant grant-4 tombstoned by rewind:0` | `ABSENT` |
| f | grant forged by appending tampered `normalizedArgs` and reloading | deny `grant_forged` | `grant_forged: grant grant-5 hash does not match its content` | `ABSENT` |
| g | grant for `spike_unknown`, a tool the policy does not govern | deny `unknown_tool` | `unknown_tool: spike_unknown is not a governed tool` | `ABSENT` |
| h | matching bash grant, then the identical call again | allow, then deny `grant_consumed` | `allow`, then `grant_consumed: grant grant-7 consumed by call_h_1` | present exactly once, unchanged by the second call |
| hw | matching `write` grant (the native file surface) | allow | `allow` | content literal `allowed-write` |
| j | the composer's policy itself throws | deny, fail-closed | `gate handler threw: simulated policy explosion (host producer threw)` | `ABSENT` |
| i | control plane unreachable mid-gated-call | no side effect; resolution after rejoin | `grant_mismatch: args differ from grant grant-7 for tool bash` | `ABSENT` while parked, while unreachable, and after rejoin |

Row commands use `date +%s%N` so two calls that carry the same args still write different bytes;
"exactly one write" is therefore checkable by comparing the canary content before and after, not
just its existence. The final `ls -1 /var/freebot-canary` inside the container is
`["d.txt", "h.txt", "hw.txt"]`: ten denials produced no file at all, including the two rows whose
call was a byte-identical repeat of an allowed call.

Two native surfaces go through the same single intercept: `bash` (shell commands) and `write`
(file writes). `spike_unknown` is an extension tool the policy does not govern, and the governed
check wins before any grant lookup.

### Row i: the control plane dies mid-gated-call

1. `hold-next`, then the stub scripts the call; the composer holds the gate request and answers
   nothing (`held="gate-13"`). The call is unresolved and the canary is `ABSENT`.
2. The harness SIGKILLs the relay and the composer. The canary is still `ABSENT`, the call is still
   unresolved, and the durable frame log does not move (`frames on disk 226 -> 226`).
3. The composer restarts with the same frames file, the same ledger, and a fresh control token; the
   relay listens on the same port. The gateway reconnects with `last_seen_seq=226` and resends the
   in-flight gate request (`replayed 0 unconfirmed frames and 1 gate requests`).
4. Exactly one decision line exists for the call, written after the rejoin: the call resolves under
   the same policy with the canary still `ABSENT`.

The resolution code is `grant_mismatch`, not `no_grant`: by then the ledger holds bash grants
(`grant-7` is row h's, consumed) that do not match this call's args, and U0.8 classifies "grants
exist for the tool, none for this action" as `grant_mismatch`. The row's claim is that a call parked
across a control-plane death still resolves under the same policy and still cannot write; row a
covers the `no_grant` wording.

## Seq audit across the kill

`seq-audit.txt` records one monotonic sequence and one durable log across the composer restart:
239 frames, `seq 1..239`, gaps `[]`, duplicates `[]`, nothing suppressed at ingest, zero gap events,
zero rejected payloads, and the observer's `/stream` copy also gapless. The gateway's mint and the
host log agree exactly (`minted 239, logged 239`); the gateway's acknowledged watermark at exit was
237, which trails by the frames still in flight when Pi settled — it is a delivery watermark, not
the log.

## Fail-closed when the handler itself fails

U0.3's rule is that a throwing gate handler yields a denial, not an allow. The harness cites the
landed fixture rather than duplicating it — `bun test packages/pi-bridge/src/gate.test.ts -t "throwing handler"`
runs green inside the run — and row j exercises it on the composed path: a `throw-next` control op
makes the composer's policy throw, and the call is denied with the thrown text verbatim
(`gate handler threw: simulated policy explosion (host producer threw)`), Pi reports an error
result, and the canary stays `ABSENT`. The harness reads that decision's code as `denied` because
the reason carries no `<code>:` prefix; the reason is the literal evidence.

## Pins and disclosure

- Pi in the container reports `1.3.0`. The base image is `packages/sandbox/image/Dockerfile` built
  unmodified at this commit; its pinned node digest label is
  `sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5`. Image IDs are
  per-build: the artifact records the ones this run produced.
- Model decisions come from a keyless scripted stub (`spikes/forge-test-a/stub-model.ts`) served on
  the host. No BYOK key, no live provider, no network egress beyond that stub. Nothing in this
  artifact is live-model traffic, and Gate G1 still parks the keyed smoke.
- The harness preflights the docker engine, `node_modules`, and `spikes/forge-test-a`'s own
  typecheck, so a missing prerequisite fails before any container starts.

## Limits

- The browser surface is out of scope by design (Phase 2). No browser tool is exercised here. The
  claim covers the single gate every tool call already passes through, but a browser call is not
  evidence in this artifact.
- The gateway is a spike composition of the landed parts, not `apps/sandbox-agent`. It mirrors the
  supervisor's seq minting and the agent's outbox, and it adds the host→Pi dialog path the landed
  link does not have.
- The gateway's own deadline path (`gate unreachable: no decision within --gate-deadline-ms`) is
  implemented but not exercised: row i kills the composer and brings it back, so the call resolves
  after rejoin rather than timing out. That path needs its own row.
- Ledger durability is JSONL append plus reload; the SIGKILL-and-reload case is exercised for
  correctness, not for fsync-level crash consistency.
- The stub is scripted: this proves the plumbing and the policy, not model judgment. One Pi process,
  one container, one agent at a time, like the tunnel spike.
- The scenario is timeboxed evidence at 91 checks in one command; it is not a differential fuzzer.
  A hostile Pi that lies about its frames is out of scope for this test (the host decides anyway,
  and the log is host-owned).

## Follow-ups

1. Carry a gate dialog down the landed tunnel (host→Pi payload path), so the in-VM side can be the
   shipped supervisor+agent and the composer here can be replaced by `apps/server`.
2. A row for the gate-deadline expiry: a host that never answers must produce the same `ABSENT`.
3. A browser-surface row when Phase 2 lands, through the same intercept.
