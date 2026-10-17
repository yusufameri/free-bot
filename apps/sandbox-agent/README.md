# @freebot/sandbox-agent

in-VM daemon that supervises Pi, Xvfb, Chromium, and MCP clients (plan 2.7, phase T3). Owned by T3.

The T3 framework shell has not landed yet. What exists today is the U0.7 tunnel spike: the
minimal real path from a containerized Pi to `apps/server` over one sequenced log. The spike
runs from this repo bind-mounted into a container (see `spikes/tunnel/Dockerfile`); nothing here
assumes that mount.

```
src/supervisor.ts  owns Pi via pi-bridge, mints the one monotonic seq, buffers frames, serves a loopback link
src/agent.ts       attaches to the link, forwards frames over the WS tunnel, replays unacked frames, reconnects
src/link.ts        JSONL protocol between the two (attached / frame / ack)
src/outbox.ts      ordered outbox: acked watermark, since(), replay of the unconfirmed window
src/index.ts       re-exports
```

The supervisor is the only reader of Pi's stdout and the only place seqs are minted; the agent is
disposable. Kill the agent and a replacement attaches, replays from the supervisor's watermark,
and the log on the server still holds exactly one sequence with no gaps or duplicates. The
invariant and its proof: `docs/tunnel-spike.md`, harness `spikes/tunnel/kill-rejoin.ts`.

Run (inside a container with the repo at `/work`, host control plane reachable):

```
bun apps/sandbox-agent/src/supervisor.ts --state-dir /scratch/state --pi-bin /work/node_modules/.bin/pi \
  --stub-base-url http://host.docker.internal:<port>/v1 --prompt "..." --ext /work/spikes/tunnel/echo-ext.ts
bun apps/sandbox-agent/src/agent.ts --server ws://host.docker.internal:<port>/tunnel \
  --supervisor-port-file /scratch/state/supervisor.port --pid-file /scratch/state/agent.pid
```

Pi runs under node (`node_modules/.bin/pi` shebang); the supervisor and agent run under bun. Pi
1.3.0 crashes under bun 1.2.5 (`webidl.util.markAsUncloneable`), so the container image ships both
runtimes. Attaching to an already-running Pi process is not supported by pi-bridge; the supervisor
is the attach point.
