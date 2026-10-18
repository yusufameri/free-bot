# The connector seam (U8.1)

A connector is a model-facing tool that acts on a person's own account. MCP is the wire, one
adapter sits behind a vendor-neutral interface, and no vendor type appears above it. What a caller
sees is a `Connector`: describe the tools, call one, ask whether it answers, and name which
credential it uses — and nothing about how any of that is wired.

## The interface, and where the vendor boundary is enforced

`packages/connectors/src/connector.ts` is the whole seam:

| surface | what it is |
| --- | --- |
| `Connector` | `id`, `ref: TokenRef`, `describe()`, `authenticate()`, `call(tool, args)`, `health()` |
| `TokenRef` | a branded string that *names* a credential and cannot carry one |
| `CredentialSource` | `ref` plus `headers()`, read at call time, handed to exactly one request |
| `namespacedToolName(id, tool)` | `<connector id>__<the connector's own tool name>`, the model-facing name |
| `offeredTools(connector)` | the connector's own discovery, mapped to namespaced offerings |

The boundary is a failing test rather than a convention. `boundary.test.ts` reads this package's own
non-test source, collects every module specifier, and fails on any bare specifier outside a
`VENDOR_FACING` allowlist — empty today, which is the strongest form of the rule: nothing in the
shipped package has a dependency to leak. U8.3 adds `composio.ts` to that list and a Composio type
cannot climb above it unnoticed. The same file proves acceptance 4: a stub adapter that shares no
code with the MCP adapter satisfies `Connector` and is driven through the same consumer
(`offeredTools`), which is what "U8.3 can add Composio without touching the seam" has to mean in a
test.

## The wire

`mcp-client.ts` is the JSON-RPC 2.0 streamable-HTTP transport (revision 2025-06-18), written here
rather than imported, so the seam's import graph is a fact and the wire is the specification's rather
than one SDK's. Every message is one POST with `Accept: application/json, text/event-stream`; the
answer is a JSON body or an SSE stream carrying the same payload; an `Mcp-Session-Id` from
`initialize` is repeated on later requests. `fetch` is injectable (`FetchLike`), which is how the
tests drive it without sockets, and how U8.3 points it at a proxy. Errors this module builds name no
header value.

`mcp-connector.ts` is the one adapter: `describe` is `tools/list` (discovery is the server's, so a
tool the person's server gained appears at the next run), `call` is `tools/call` with text blocks
joined and non-text blocks named by type, `authenticate` is a handshake that answers with the
`TokenRef` and never the token, and `health` is a probe that reports a state instead of throwing.
`mcp-server.ts` is the other half of the same wire — a real server, used by the package's tests and
by the evidence harness to build the fixture connector on top of — with an optional request gate
that refuses with 401, which is how "the credential is required rather than merely sent" is
provable.

## The credential's path

A connector's address and its credential are the person's own, so both live in one file under the
freebot home — `connectors.json`, beside the vault, never in the repo and never in the environment:

```json
{ "connectors": [ { "id": "emulate-github", "url": "http://127.0.0.1:1234/mcp",
                    "headers": { "authorization": "Bearer ..." } } ] }
```

`apps/server/src/connectors.ts` is the app's reader: `parseConnectors` checks the file's shape at the
boundary, so a typo is a boot failure by name and an absent file is the ordinary no-connectors
machine. `ConnectorRegistry` turns entries into `McpConnector`s whose `headers()` closure is the only
holder of the value. The launcher prints which file it read and which id sits at which address, and
never a header; the person's own file is the only place the value is written down. Two routes answer
rows without it: `list_connectors` (id, url, `connector:emulate-github` as the reference, tools and a
health probe) and `test_connector` (the probe a person runs when adding one), with a connector the
install does not hold refused as `404 connector_not_found`.

Gate 4 holds by construction: the credential reaches one request header inside the seam and there is
no code path from it into the sandbox spec, the run's environment, or the log. The evidence driver
asks a container of the pinned image, in its own words, whether it can act on the service (401) and
whether it holds either credential (neither env, nor init's env, nor the Bot's workspace).

## The run's tool arm

`apps/server/src/run-ports.ts` holds one table, `RunTool[]`, and the table is the only place a tool
is declared. `bash` is `kind: "sandbox"` and keeps its argv. Each connector's tools join it as
`kind: "connector"` arms, discovered when the run starts, always `destructive: true` — a connector
tool acts on the person's account, so the gate is asked before it runs, exactly as for `bash`. The
same table produces the definition list the model is offered, the runner `RunToolExecutor` dispatches
on, and the names the run's own gate governs, so a tool can never be offered without a runner or run
without being governed; `createReviewGate` is built per run from the run's table for that reason. A
connector that cannot be described right now contributes no arms and one note line, rather than
failing a run the other tools could have finished. `RunToolExecutor` answers in the loop's one
outcome shape for both kinds, so the loop never learns which kind it dispatched, and the landed
`bash` arm and its tests are untouched.

## The evidence

`bun packages/verify/scripts/connectors.ts` writes
`packages/verify/artifacts/connectors/<short-sha>/assert.txt`. The service is
`vercel-labs/emulate`'s GitHub emulator, chosen because the issues API has exactly the shape a
connector tool needs (create and list, a status code that says who may write) and because `emulate`
ships it rather than requiring a hand-rolled stub. `packages/verify/src/emulator.ts` starts it on
`0.0.0.0` on an OS-picked port, seeded with a repository and a token this run minted; every
assertion about its state is a read of the service over its own REST surface. Three facts were
established by the driver's own probes rather than assumed, and they bound what the evidence may
claim:

- a write with no `authorization` header is refused `401 Requires authentication`;
- a write carrying *any* bearer value is accepted — the fixture checks presence, not identity, so
  the evidence claims credential *custody*, not credential *verification* (that half is proven at
  the fixture MCP server's exact-match gate instead);
- `reset()` empties the store and re-runs the seed, so a second run in the same process has to work
  again from empty and issue numbering restarts at 1.

The connector's far side is `packages/verify/src/github-mcp.ts`: the package's own MCP server with
two tools (`create_issue`, `list_issues`) whose handlers call the emulated service, and a bearer gate
comparing the connector's per-run token exactly. Two credentials stay separate throughout: the
connector's (the MCP server's bearer, held in the driver's mode-600 `connectors.json` under its own
temp home) and the service's (the emulator's token, held only by the fixture's closures).

The driver spawns `bun run up` three times over one temp home and bots root, the way a person runs
it, and drives each run over the page's own WebSocket. The model is the replay provider pinned to a
turn the driver renders from the committed template `packages/verify/fixtures/connector-turn.jsonl`,
keyless and replaying, because gate G1 parks the keyed path. Run 1 creates an issue through the
connector; the assertions read the issue back from the service itself. Then `reset()` empties it, the
launcher is restarted, and run 2 — a distinct title, so a distinct action hash — parks at the gate
again on its own fresh ledger and creates exactly one issue again, numbered from the reset. A
by-hand container of the pinned image proves the boundary (refused 401, carries neither credential),
and a third launch replays the landed `rpc-handshake.jsonl` to prove the bash arm still runs beside
the connector arm and touches no service state. Every secret is added to the artifact writer's
refusal list, and the last checks scan the worktree for all three.

## What remains

- **U8.2 owns sign-in.** The vault-backed `CredentialSource`, the account, and the OAuth flow
  replace the `connectors.json` file this unit reads; the registry's row shape is already the shape
  that flow needs.
- **U8.3 owns the second vendor.** `composio.ts` joins `packages/connectors`' `VENDOR_FACING` list
  and nothing above the seam changes; gate 8's delete test is what keeps that true.
- **Not in this unit:** streaming tool results, per-connector permission policy beyond the run's own
  gate, connector discovery outside a run's start (the route probe is the on-demand one), and any
  write path from a route to the file.
- The emulated service is a fixture and is named as one everywhere it appears in the artifact; no
  real third-party service, account, or key is involved anywhere in the evidence path.
