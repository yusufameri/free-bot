# @freebot/web

The chat surface (plan 2.5/2.7, Phase 1 T4). One thread rendering the v1 event stream: streaming
assistant text, tool-call cards, and allow-once/deny approval cards.

Status: live-ui-verified. `docs/web-shell.md` has the design, the eight key states, the evidence
and the deliberate gaps.

## Commands

```
bun run --cwd apps/web typecheck   # both tsconfigs: the browser surface and the node-side harness
bun run --cwd apps/web fixtures    # regenerate apps/web/fixtures/*.jsonl from the protocol adapter
bun run --cwd apps/web dev         # watch a replay at http://127.0.0.1:<port>/?auto=allow
bun run --cwd apps/web capture     # the CDP evidence run: frames + assert.txt under packages/verify
```

## Layout

| Path | Owns |
| --- | --- |
| `host/index.html` | The page shell and the `data-*` contract the evidence harness asserts on. |
| `host/main.ts` | The socket, the reconnect, and handing every message to the shared model. |
| `fixtures/*.jsonl` | The committed replay sessions: `allow` and `deny`, dense in `seq` from 1. |
| `scripts/fixture.ts` | Regenerating the fixtures from `packages/protocol`'s spike adapter, with `--check`. |
| `scripts/server.ts` | The replay server: page, bundle, `/events`, holds, kills, answers. |
| `scripts/capture.ts` | The CDP driver: eight key states, DOM facts, PNGs, the distinctness guard. |

`tsconfig.json` covers the browser surface (`host/`, `packages/ui/browser/`) with the DOM lib;
`tsconfig.node.json` covers the node-side scripts without it, because pulling the DOM lib into the
program that reaches `packages/review` through the protocol's spike adapter breaks `pi-bridge`.
The root `bun run typecheck` sees only `*.ts` under `apps/*/src`, so both are run here.

Nothing in this app calls a model, holds a key, or reaches beyond localhost.
