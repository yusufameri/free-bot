# FreeBot

FreeBot is an agent, a persistent sandbox computer, multi-surface chat, and first-class guardrails, matching the shape of Grok Bot while swapping its two lock-in points for open, pluggable interfaces. Any OpenAI-compatible `/v1/chat/completions` endpoint can drive it, and one `SandboxProvider` interface runs the computer on Docker locally or on E2B or boat.dev remotely. The Pi harness runs inside the sandbox where its tools live, and the control plane stays optional: local single-user mode works with no backend at all.

## Layout

```
packages/
  protocol/      shared TS types: events, Pi RPC records, oRPC contract, API DTOs, Connector
  core/          control-plane logic (bots, threads, approvals, routines, runs)
  sandbox/       SandboxProvider interface plus docker/e2b/boat adapters
  pi-bridge/     spawn `pi --mode rpc`, JSONL framing, event mapping, tunnel, replay mode
  providers/     BYOK OpenAI-compatible client plus Pi tool-call smoke test
  connectors/    Connector interface plus mcp / composio / raw-http adapters
  review/        review-model policy engine plus allow/block rules
  ui/            shared React components and hooks
  verify/        verification harness: one script per feature, artifacts, e2e drivers
apps/
  server/        Hono control plane
  web/           Next.js (T4)
  desktop/       Electron shell around ui/ (T6)
  mobile/        Expo app (T6)
  sandbox-agent/ in-VM daemon (T3)
docs/            verification index; self-host, BYOK, and connector guides
```

## Quickstart

```sh
bun install
bun run verify
```

`bun run verify` runs `bun run typecheck`, all tests, the workspace-shape checks in `packages/verify/features/scaffold.sh`, then boots `apps/server` on an ephemeral port and curls `/healthz`. It writes its proof to `packages/verify/artifacts/scaffold/<git-short-sha>/assert.txt` and prints `PASS scaffold` as its last line.

Other commands: `bun run lint`, `bun run typecheck`, `bun test`.

## Status

Scaffold only: layout, CI, lint/typecheck, the verify harness, and a health-checked server. Everything past that is unbuilt. What is verified so far, with script commands and artifact paths, is in [docs/VERIFICATION.md](docs/VERIFICATION.md).
