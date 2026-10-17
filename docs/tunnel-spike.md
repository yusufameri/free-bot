# Tunnel spike (U0.7): one seq, one log, across a hard kill

Status: PASS. 34/34 scenario checks green, both kill scenarios, at commit
`bf0a4e67b8351cb1db3d7f160f2042ddd7850ff9` (branch `u0.7-tunnel`). Rerunnable command:
`bun spikes/tunnel/kill-rejoin.ts`; artifact: `packages/verify/artifacts/tunnel/bf0a4e6/`
(`assert.txt`, `seq-audit.txt`, `transcript.jsonl`, per-scenario transcripts).

## Question

A live Pi in a sandbox must stream its frames to the control plane across a network that can die
mid-frame, and Pi must survive its tunnel dying. Is one monotonic sequence, minted once and stored
once, enough to guarantee the log never has a gap or a duplicate even when both the tunnel and the
forwarding process are SIGKILLed mid-stream?

## Shape

The spike is the minimal real path, not a mock: Pi 1.3.0 runs inside a Docker container, the
frames cross a real TCP relay and a real WebSocket, and `apps/server` serves them from the one log.

```
container (freebot-tunnel-spike image)              host
┌────────────────────────────────────┐   TCP relay  ┌───────────────────────────────┐
│ supervisor ── pi-bridge ── pi       │─┐ (SIGKILLed)│ apps/server                   │
│   mints seq, ring-replays          │ │  ┌────────►│   /tunnel  agent leg          │
│   loopback link (JSONL/TCP)        │ │  │  WS     │   /stream  client stream      │
│ agent ─────────────────────────────┘ │  │         │   /events  unary replay       │
│   forwards, replays unacked, ────────┴──┘         │   /audit   invariant report   │
│   reconnects naming last_seen_seq                 │   one SeqLog (packages/core)  │
└────────────────────────────────────┘              └───────────────────────────────┘
```

- `apps/sandbox-agent/src/supervisor.ts` is the only reader of Pi's stdout and the only place a seq
  is minted. It buffers every stamped frame and serves any agent that attaches, replaying from the
  server's acknowledged watermark.
- `apps/sandbox-agent/src/agent.ts` is disposable. It forwards frames over WS `/tunnel`, holds the
  unconfirmed window in an ordered outbox, and on reconnect names its acked watermark as
  `last_seen_seq`.
- `apps/server/src/tunnel.ts` owns the one `SeqLog` (from `packages/core`). Ingest is idempotent:
  a frame the log already holds is suppressed, a frame that skips ahead is refused with `nack` and
  the agent resends from `lastSeq + 1`. Clients on `/stream` and `/events` resume by
  `last_seen_seq` and get exactly the frames after it.
- `spikes/tunnel/tcp-relay.ts` is the tunnel under test, a byte-transparent TCP relay. SIGKILLing
  it drops the connection the way a middlebox dies: mid-frame, no close handshake. The container
  dials it through `host.docker.internal`; the repo is bind-mounted at `/work`, so the image is
  just node 24.22.0 plus the bun binary (Pi crashes under bun, so Pi runs under node).

## What the kill proves

The harness runs the same exchange twice: Pi boots, is prompted, and runs a three-call tool
sequence scripted by a keyless local stub model (`spikes/tunnel/stub-model.ts`, SSE, 15 ms per
delta) plus a real extension tool (`spikes/tunnel/echo-ext.ts`, 400 ms per call). Kill triggers:
(a) inside a paced text-delta burst right after the first `tool_execution_end`; (b) while the
second `spike_echo` call is in flight.

Scenario a, relay SIGKILLed mid-burst (`transcript-a.jsonl`):

```
frames logged: 124 (seq 1..124)     gaps: 0 []   duplicates: 0 []
kill point: last seq at kill 33; 91 frames arrived after the kill instant
rejoin: [agent] tunnel open last_seen_seq=33 reconnects=1
pi pid 25, starttime 373664 -> 373664 (unchanged); agent pid 47 stayed alive
4 truncated/malformed injections refused (rejected 0 -> 4) with lastSeq unchanged
```

Scenario b, tunnel agent SIGKILLed mid-tool-call (`transcript-b.jsonl`):

```
frames logged: 124 (seq 1..124)     gaps: 0 []   duplicates: 0 []
kill point: last seq at kill 77; 47 frames arrived after the kill instant
agent pid 46 -> 98 (fresh process); it reconnects and the server acks it to 77 on open
pi pid 25, starttime 374079 -> 374079 (same process across kill and reattach)
tool call call_spike_2, in flight at the kill, completed after reattach
```

In both runs the log holds exactly `1..124`, `firstSeq` 1, zero gaps, zero duplicates, zero
suppressions at ingest (the supervisor only replays past the acked watermark, so nothing needs
deduping), zero gap events, zero rejections. The observer's `/stream` copy of the sequence is also
gapless, and `GET /events?last_seen_seq=33` returns bytes-identical to the stream's tail, so the
unary endpoint and the stream read the same log.

## Limits

- Pi pid stability is proven for the agent dying (b) and the tunnel dying (a); the supervisor
  itself is not killed. Attaching to an already-running Pi is not supported by pi-bridge, so a
  supervisor restart is a Pi restart, by design.
- Seq epochs across a server restart are out of scope; `firstSeq` 1 is asserted, not a general
  contract yet.
- The stub model is keyless and scripted. The live keyed run parks on Gate 1 (no BYOK key).
- The container image is the spike-only recipe in `spikes/tunnel/Dockerfile`. U0.6 has since
  landed the real one at `packages/sandbox/image/Dockerfile`, which supersedes it when the tunnel
  is integrated for real. Network containment is U0.6's and U0.5's probe, not this spike's.
- No auth on `/tunnel`, one agent at a time by convention, not by check.
