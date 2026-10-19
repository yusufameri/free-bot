# The connector seam, and the credential that stays the person's (U8.1, U8.2)

A connector is a model-facing tool that acts on a person's own account. MCP is the wire, one
adapter sits behind a vendor-neutral interface, and no vendor type appears above it. What a caller
sees is a `Connector`: describe the tools, call one, ask whether it answers, and name which
credential it uses — and nothing about how any of that is wired.

U8.1 built the seam. U8.2 made the credential the person's own: it moved out of the file the
configured connector was written in and into a vault at mode 600, the four arms a surface needs
connect, test, list and remove, and no answer carries a value.

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
`VENDOR_FACING` allowlist. The list holds one entry, `composio.ts`, and the strongest form of the rule
still holds underneath it: nothing in the shipped package has a dependency to leak, so the allowance
is about the vendor's *name* rather than about an import. The same file holds the name to the same
rule, failing if any file outside the list carries it and if `connector.ts`, the one module every
caller above the seam imports, carries it anywhere. A Composio type therefore cannot climb above the
adapter unnoticed. The same file proves acceptance 4: a stub adapter that shares no code with the MCP
adapter satisfies `Connector` and is driven through the same consumer (`offeredTools`), which is what
"U8.3 can add Composio without touching the seam" has to mean in a test.

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

## The second vendor, and the MCP endpoint path

`composio.ts` is the second adapter, and it is the only module in the package allowed to name the
vendor. It does not speak a second wire: it mints a Composio session and then hands the endpoint the
session answered with to `McpConnector`, so everything above the seam and the whole transport below it
are the ones that were already there.

The endpoint path is the vendor's own, taken from its reference rather than invented here:

| what | value |
| --- | --- |
| API base | `https://backend.composio.dev` (`COMPOSIO_API_BASE`; a person's own deployment passes theirs) |
| session route | `POST /api/v3.1/tool_router/session` (`COMPOSIO_SESSION_PATH`) |
| the key's header | `x-api-key` (`COMPOSIO_KEY_HEADER`) |
| request body | `{ user_id }`, plus `toolkits` when the connector was built with any |
| answer | `mcp: { type: "http", url }`, and `mcp.headers` when the session names any |

`describe`, `call`, `authenticate` and `health` are the same four the seam declares. One connector
object mints one session, so a describe, a call and a probe share an endpoint rather than spending a
key request each, and a refused session is not cached, because a service that was down for one probe
is not a connector that is dead for the launch.

Three rules this adapter enforces on answers it did not choose. A session that answers no `mcp`
object, a `type` other than `http`, no `url`, a `url` that is not one, or a protocol this seam cannot
carry is refused by name rather than guessed at, and every one of those refusals is a `ConnectorError`
naming the connector. So is a session the vendor refuses, whose message carries the status and the
service's own words and never the key.

**The key reaches the session route and nothing else.** That is the custody rule of Part 11 applied to
a vendor that hands back an endpoint: the project key mints sessions, it is not the endpoint's
credential, the endpoint may sit on the vendor's own host rather than on the API base, and a
session-minting key sent to a host the person never configured would be a leak with a redirect in
front of it. So the endpoint's requests carry `mcp.headers` when the session named any and nothing at
all when it did not. The driver asserts both halves: with a session that names headers, every request
the endpoint's gate sees carries the session token and none carries the project key; with a session
that names none, the endpoint's gate refuses the call 401, which is what the public schema's shape
(defaulting to no headers) actually implies.

Two things are declared rather than proven, because this project owns no Composio account (order 33):

- the public schema for the session answer lists `mcp.type` and `mcp.url` and no headers object, while
  the vendor's SDK exposes `session.mcp.headers`. A session without headers is therefore treated as
  ordinary rather than malformed, which is the shape the schema documents.
- no real session endpoint is ever reached. What the fixture asserts is the custody claim and the
  path, not the vendor's live behaviour. A person running this against their own account is the
  manual best-effort check Part 11.1 describes.

Gate 8's delete test is what keeps the adapter from becoming load-bearing, and it runs rather than
being described: the driver moves `composio.ts` and its own test aside, runs `bun run typecheck` and
`bun test`, asserts both exit 0 with a real pass count and no `composio.test.ts` in the run, and puts
the file back byte for byte. Its literal output is in the artifact.

## The credential's path

A connector's address and its label are not secrets, and its credential is. The two live in two files
under the freebot home, and the split is the point (order 33):

| file | holds | mode |
| --- | --- | --- |
| `connectors.json` | id, label, endpoint, the credential's `TokenRef`, the tools the last probe saw, the state it left, when it ran | 600 |
| `connectors.env` | one line per connector: `FREEBOT_CONNECTOR_<id>=<json of its header map>` | 600 |

`apps/server/src/connectors.ts` is the app's reader and writer of both.
`parseConnectorRecords` checks the record's shape at the boundary, so a typo is a boot failure by
name and an absent file is the ordinary no-connectors machine. A record that still carries a
`headers` field is refused with the vault's own path in the message, because that is the shape the
file had before this unit and it would otherwise load a connector nobody can authenticate.

The vault is written through `apps/server/src/vault.ts`, the same module the BYOK key uses:
`writeSecretFile` is the one writer, mode 600 on every write, one `NAME=value` per line.
`ConnectorRegistry` reads both files on every call rather than caching them, and the connector it
builds reads the vault inside `headers()` at call time. That last property is the whole of rotation:
a credential replaced in place reaches the next request with no rebuild, no restart and no second
connector object. Nothing reads a header value back out: the record has no field for one, and every
route's answer is a row from `connectorRowSchema`, which has none either.

Gate 4 holds by construction: the credential reaches one request header inside the seam, and there is
no code path from it into the sandbox spec, the run's environment, or the log. The evidence driver
asks a container of the pinned image, in its own words, whether it can act on the service (401) and
whether it holds either credential (neither env, nor init's env, nor the Bot's workspace).

## The routes, and the state a surface renders

Four arms, all over the app's own route surface, and one row shape for connect, test and list so a
surface renders one thing everywhere:

| arm | input | answer |
| --- | --- | --- |
| `list_connectors` | nothing | `{ connectors: ConnectorRow[] }`, each probed once |
| `connect_connector` | `{ id, label?, url, headers }` | the `ConnectorRow` its own probe left |
| `test_connector` | `{ id }` | the same row shape; an id nobody holds is `404 connector_not_found` |
| `remove_connector` | `{ id }` | `{ id, removed }`; `removed: false` for a connector nobody holds |

`headers` is the credential, and the connect input is the one place in the contract one appears. The
id is the key, so connecting an id that exists rotates its credential in place rather than adding a
second connector.

A connector's connection is one of three words rather than a boolean:

| state | when | why it is not `ok: false` |
| --- | --- | --- |
| `connected` | the probe reached the person's own service and it answered | |
| `unreachable` | the probe ran and did not get an answer this seam could use | |
| `untested` | the vault holds no credential for this record, so nothing was probed | a missing credential must not read as a broken service |

The probe is `authenticate()` then `describe()`: the sign-in through the seam, then the tool listing.
Connect saves the credential first and the record second, so a connection the person's service
refuses is still saved and shown as `unreachable` rather than as a save that never happened. That is
the honesty page 1's provider pane already had, in the vocabulary this surface needs.

Removal takes the credential out of the vault and the record out of the store, so a later call for it
is refused by name instead of finding a stale secret. A second removal answers `removed: false` and
changes nothing, which is what makes it safe to send twice.

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

The run path asks the registry for its connectors when a run starts rather than when the server
boots, so a connector connected while the launcher is up is offered to the next run. A record the
vault holds no credential for contributes no arms at all: a tool that could only ever be refused is
worse than a connector that is not offered, and the route's row is where that state belongs.

## The evidence

Two drivers, one per unit, and both run at the same head.

`bun packages/verify/scripts/connector-credentials.ts` (U8.2) writes
`packages/verify/artifacts/connector-credentials/<short-sha>/assert.txt`. One `bun run up` over a home
the driver made and no `--connectors` flag, so the launcher derives both files from that home; the
person's own service is a real MCP server the driver serves, whose tools act on the `emulate` GitHub
fixture bound on `0.0.0.0` and seeded per run. It signs in over the route surface, then runs the
three probes the provider key already had:

- **not returnable over the wire** — every response body read, searched literally for the credential;
- **not in the record file** — the whole file searched for the credential and for the header name;
- **not in any artifact** — `rg -l -F <the credential>` over the worktree, and the artifact's own
  lines. The artifact writer refuses to write a file carrying any credential it minted.

It then rotates the credential through the same route, with the service changed to accept the new
one, and asserts what the service received before and after, on the route's own probe and on a
connector object the app built before the rotation, inside one launch's lifetime. Removal is asserted
as an empty vault, an empty record, an empty list, and a `404 connector_not_found`; a record put back
by hand with no credential line reads `untested` rather than calling the service broken. No run is
started, so the driver creates no container and touches no Docker resource.

`bun packages/verify/scripts/connectors.ts` (U8.1) is the run-path evidence: three really launched
`bun run up` processes over one temp home and bots root, its own probes establishing that a write
with no `authorization` header is refused `401 Requires authentication` by the emulated service and
that `reset()` empties the store and re-runs the seed, then a replayed model turn that calls
`emulate-github__create_issue` through the seam, parks at the gate, is answered allow, and creates
exactly one issue the service itself reports. A by-hand container of the pinned image proves the
boundary (refused 401, carries neither credential), and the landed `bash` arm still runs beside the
connector arm. Its credential now lives in the vault rather than in the record, and its checks moved
with it: the record is asserted to hold no credential at all.

The emulator is `vercel-labs/emulate`'s GitHub service, started by `packages/verify/src/emulator.ts`
on `0.0.0.0` on an OS-picked port and seeded with a repository and a token that run minted. Its own
probes bound what the evidence may claim: a write with no `authorization` header is refused, and a
write carrying *any* bearer value is accepted, so the run-path driver claims credential *custody*
rather than credential *verification*. The exact-match half is proven at the fixture MCP server's own
bearer gate (`packages/verify/src/github-mcp.ts`), which compares its per-run token exactly.

The same driver also carries U8.3's second-vendor evidence and gate 8's contract test, and both are
inside the run count above. The emulated vendor is two services in the driver's own process, because
the vendor's API is two: a session route that refuses a request without its project key and answers
`mcp: { type: "http", url }` for one that carries it, and an MCP endpoint built from
`packages/connectors`' own server whose tools act on the account's store over HTTP. The adapter drives
it in the same process, over real sockets, through the module's own four operations, and the state
before, the call, the account's own report, the reset, and the call from empty again are asserted
against the vendor's own REST surface. The delete test then moves `composio.ts` and its test aside and
runs `bun run typecheck` and `bun test`, asserting exit 0, a real pass count, and no `composio.test.ts`
in the run, before restoring the file and checking its sha256 is the one it had.

## What remains

- **The OAuth browser flow is a later unit.** This unit's sign-in is the credential a person already
  has: the app takes it, saves it to the vault and probes with it. Everything a browser flow needs on
  top of that is a redirect, a callback and a token exchange that ends in the same `connect_connector`
  call.
- **U8.3 landed the second vendor.** `composio.ts` is on `packages/connectors`' `VENDOR_FACING` list,
  nothing above the seam changed, and gate 8's delete test is what keeps that true. What it does *not*
  yet have is a route: the app's registry still builds every connector it holds as an `McpConnector`
  from the record's `url`, so a Composio connector is reachable through the adapter by a caller that
  builds one and not yet through `connect_connector`. The record has no field naming an adapter kind,
  and adding one is a protocol change no unit owns yet, so it is named here rather than half-built. A
  person can point a connector at their own Composio MCP endpoint today, which is the shape the
  registry already holds.
- **U8.4 owns the "Connect apps" screen.** It renders the four arms and the three states above. It
  must never show a header value, and it does not have one to show: no route answers with one.
- **Not in this unit:** streaming tool results, per-connector permission policy beyond the run's own
  gate, connector discovery outside a run's start (the route probe is the on-demand one), and any
  write path from a route to the sandbox.
- The emulated service is a fixture and is named as one everywhere it appears in the artifacts; no
  real third-party service, account, or key is involved anywhere in the evidence path. That holds for
  the second vendor too, and it is stricter there: nothing in this repo has ever reached
  `backend.composio.dev`, so the vendor's live shape is documented from its reference and asserted
  against the fixture rather than observed.
