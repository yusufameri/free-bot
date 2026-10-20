# Verification record: the narrative

The prose below sat beside the verification table before U10.1 moved the rows into
`docs/verification/` and made `docs/VERIFICATION.md` generated. It is kept verbatim, minus the
rows themselves. The row files and their artifacts are the authority; where this narrative and
a row disagree, the row wins.

One row per verified feature, per plan 9.3. Artifacts live under `packages/verify/artifacts/`, one
directory per feature and git short sha. The row records the commit the artifact was produced at.

Coverage so far is the scaffold unit, the pi-rpc and containment spikes, the pi-bridge client, and the
sandbox image pin. The scaffold row covers workspace shape, typecheck, the `apps/server` health test,
and a real HTTP probe of `GET /healthz` on an ephemeral port. The pi-rpc row covers a live `pi --mode
rpc` process driven over strict JSONL by `spikes/pi-rpc/drive.ts` against a keyless local stub model;
its verdict is `spike-verified` because no `bun test` suite covers it, only the driver's own 39
assertions, all green in the committed transcript. The pi-bridge row covers `packages/pi-bridge`: 28
replay-driven tests (frame parsing against the frozen transcript, session correlation and ordered
events, fail-closed gate paths), all green in `bun run verify`, plus the smoke's parked path. Its
live keyed smoke (one real gated tool call) is not part of this row's artifact, which holds the
replay path. The containment row
covers seven kernel-level egress probes inside a container netns (direct https, proxy egress, DNS
over UDP and TCP, raw TCP, UDP including the QUIC port, DoH, IP literals) produced by a rerunnable
script; its limits are stated in `docs/containment-spike.md`. The sandbox image row covers the pinned
image build, two in-image replays of the same scripted Pi turn with an asserted-equal event sequence,
and a zero-hit key-material scan; its limits and normalization are stated in
`docs/sandbox-image.md`. Rationale and citations for the pi-rpc spike live in `docs/pi-rpc-spike.md`,
and for the pi-bridge in `docs/pi-bridge.md`. The review-grants row covers `packages/review`: 57
tests over canonical action hashing, an append-only grant ledger with rewind tombstoning, and a
fail-closed gate whose denial codes are asserted distinct against literal values; rationale lives
in `docs/review-grants.md`. The tunnel row covers the U0.7 spike's 34 harness checks (relay SIGKILL
and agent SIGKILL over a real WebSocket, truncated-frame refusals, `/events` vs `/stream` byte
equality) plus the `SeqLog`/tunnel unit tests; the audit invariant, pid evidence, and limits are in
`docs/tunnel-spike.md`. The browser containment row covers headless Chromium inside the U0.4 netns
across seven arms (two proxied controls, adversarial public-URL and IP-literal navigations, an
in-page page of five DoH and IP-literal attempts, a forced-QUIC pair read from the udp/443 bucket,
and the resolver guard), with every arm's UDP attributed by counter-only port buckets and the
denials rendered into four screenshots; rationale and limits live in
`docs/browser-containment-spike.md`. The forge test A row covers U0.9's composed gate: the pinned
sandbox image plus U0.3's dialog intercept and U0.8's ledger behind one host composer, with eleven
scenario rows (no grant, mismatch, expired, consumed, tombstoned, forged, unknown tool, native bash
and file-write positive controls, a throwing handler, and a SIGKILLed control plane mid-gated-call)
each verified by a literal read of a canary path inside the container rather than by the gate's
return value; its shape, limits, and follow-ups are in `docs/forge-test-a.md`. The mvp smoke dry
run row covers the U0.11 composition of the whole Phase 0 pipeline under one command: the pinned
image plus the landed tool-gate extension, the U0.7 tunnel, the U0.8 ledger and policy, and the
U0.10 page, driven by the keyless stub model through one approval allow, one page denial, a ledger
`grant_consumed` repeat, and a mid-task SIGKILL of the relay and the composer with a page resume
from its last display seq; its shape, limits, and follow-ups are in `docs/mvp-smoke-dry-run.md`.
The sandbox-provider row covers U1.2's frozen `SandboxProvider` surface and the Docker adapter: spec
validation, the capability truth table and the typed unsupported paths in `packages/sandbox`'s unit
tests, plus ten Docker integration tests that create a sandbox from the pinned image, exec (buffered,
streamed, detached), round-trip 4096 bytes through upload/download, echo a link frame through
`tunnel()`, reach an in-sandbox port through `exposePort`, snapshot/stop/resume and restore from the
snapshot, kill an idle sandbox on its ttl, and remove exactly this unit's containers while two decoy
containers survive; its semantics, typed gaps, and follow-ups are in `docs/sandbox-provider.md`.
The run loop row covers U1.7's composition of the landed parts into one executing run: `packages/core`'s
seven-status record and its append-only journal, the landed `SeqLog`, the frozen `SandboxProvider`
behind Docker, `packages/review`'s gate and ledger, and the v1 envelope, driven by one pure loop over
injected ports. Its evidence boots a container from the pinned image and prints the run's status
trail, the decision table, the seq audit, both new wire frames (`run.status` and the tenth deny code
`user_denied`), and the label-scoped cleanup beside a surviving decoy. The model's turns are replayed
from the committed Pi transcript and the human's answers are scripted, because this driver runs the
loop against a replay provider on purpose so its assertions hold a fixed turn (order 9). Its shape, limits, and follow-ups (the scheduler's idle-kill and rejoin,
and spend caps, which are not wired) are in `docs/run-loop.md`.
The server-auth row covers U1.3's control-plane slice, now over the folded run path: 63 tests over the
refusal matrix, the oRPC round trip, a real WebSocket subscribe with replay-then-live ordering, the
resume path, the release of a closed socket's subscription, and two runs over one log in one tick,
plus 32 live checks against a really launched `apps/server/src/index.ts` (the token printed once, the
401/403/200 matrix as literal lines, the tunnel leg's two rebound-Host refusals and its agent reads
with their literal log bodies, one oRPC round trip, two runs parked, answered with deny over the
page's stream and driven to a terminal frame each, the container set back where it started, the
loopback-only bind, and a redaction check that fails the run rather than commit a token). Its threat
model, check order, token lifecycle, and explicit non-goals live in `docs/server-auth.md`.
The one run path row covers U2.1's fold and the surface that drives it: `apps/server`'s in-memory
control plane and its Hono run routes are deleted, the oRPC router drives one `RunService`, and the
page's own stream is a second transport over the same log. Its evidence boots the real server, opens
the real page with the operator token, starts two runs from the page's prompt box and answers one
allow and one deny, asserting the DOM, the socket handshakes and the container's own stdout. Its
shape, the token contract it kept, the three defects it found and fixed, and its follow-ups live in
`docs/one-run-path.md`.
The launch row covers U2.3's single entry point: `bun run up` boots the same two listeners
`apps/server/src/index.ts` boots, prints the one URL to open with the operator token already in its
fragment, and on Ctrl-C stops both listeners and removes the sandbox containers that launch created.
Its evidence takes the URL the launcher printed, opens that URL in headless Chrome and drives the
click through a parked approval to a terminal frame, on three launches that each ran while the
previous one was still serving: one parked until shutdown, one allowed, one denied. It also asserts
the pinned-port refusal, and that a launch SIGINTed with a run still parked leaves no container, no
listener and an exit code of 0. `docs/RUNNING.md` is the operator's page, and the launcher's shape,
its flags and its container record are in `apps/server/src/cli/`. Its follow-ups (the landed server
writes auth refusals to stdout after the URL line, and a hard `SIGKILL` still leaks a container) are
named in `docs/RUNNING.md`.
The keyed run row covers U2.4's swap of the run's model from the committed transcript to the vault's
provider. `apps/server/src/provider.ts` is the factory: a keyed choice that carries the connection, or
a replay choice that carries the transcript and the reason it stayed keyless, so a keyed choice
without a key cannot be built. `apps/server/src/vault.ts` is the run path's only reader of
`~/.freebot/provider.env`, in-process and never through the environment (order 8), and
`apps/server/src/keyed-provider.ts` is the adapter over `packages/providers`' OpenAI-compatible
client: it owns the wire, carries the prompt, the run's tools and every tool outcome to the model,
and turns the reply into the loop's turn, so a call the model asks for still leaves as a call the
gate judges. Its evidence is `live-ui-verified` and named `live-ui-verified` on purpose: a recorded
turn is not evidence for this unit. `bun packages/verify/scripts/keyed-run.ts` spawns
`bun run up --no-open` with no provider flag, opens the URL that launch printed in headless Chrome
over CDP, types a prompt into the page's own box, and drives one allowed run and one denied run from
two launches, asserting 69 checks and committing four frames at
`packages/verify/artifacts/keyed-run/a273e16/`. The artifact carries the launcher's own selection line
(`model mode auto, model deepseek/deepseek-v4.1-flash via api.commandcode.ai (key from the vault)`),
the request the server made (endpoint, model, message count, tool names, `Bearer <redacted>`), the
model's own text and tool call as the server read them off the wire, the provider's own token usage,
the container's own stdout read off the page, and the allow and deny decisions on the cards; the model's
second turn quotes the container's stdout, which no recording can produce. Both selection paths are
exercised in unit tests with no key on the machine. `docs/RUNNING.md` is the operator's page and
carries the flags and the startup line, `docs/providers.md` carries the key handling, and the
recorded half of the loop's own evidence is unchanged at `apps/server/src/run-loop-live.ts`. Commit
`085af4c` carries the driver the artifact was produced from after the U6.5 marker migration.
The files surface row covers U4.1's `list_files` and `read_file` arms and the Library tab that reads
them. A Bot's workspace is a host directory the run service creates once per Bot and bind-mounts at
`/workspace` into every container that Bot runs, because a run destroys its container on every path
and a file written to `/workspace` would go with it; the two arms read that directory back, and the
lifetime rule, the scoping rules and the limits are in `docs/files-surface.md`. Its evidence is
`live-ui-verified` for the reason the keyed run's is: the file the Library shows has to have been
written by a live model, so the driver asks one for a line carrying a nonce it minted, reads that
line back over the route surface, and commits the request and the bytes. It is the first row whose
artifact shows a refusal: an `escape.txt` symlink resolving outside the workspace is listed and then
refused as `403 symlink_escape` with no bytes rendered. The scoping rules are also asserted where
they live, in `apps/server/src/workspace-files.test.ts` (an absolute path, a `..` segment, a symlink
out, a missing path, a directory read as a file, a file listed as a directory, binary bytes, and the
read cap), and over HTTP in `apps/server/src/files-routes.test.ts`. Commit `bf67736` carries the
driver the artifact was produced from.
The bots and threads row covers U4.2's record model and the shell over it. The two lines that named
one Bot and one thread per run are gone from `apps/server/src/run-service.ts`: a run names the Bot it
belongs to and the thread it appends to, both records exist before the loop starts, and either is
refused by name when the server does not hold it. A thread holds many runs, owns its own journal, its
own log and its own persisted transcript, and each Bot owns the workspace directory its runs mount at
`/workspace`, so one Bot cannot see another's files. Its evidence is `live-ui-verified` for the reason the keyed run's is: the
file the per-Bot proof reads has to have been written by a live model, and the restart has to be a
real second process over the same directory. The store, the shell and the page's contract are also
asserted where they live: `packages/core/src/bot-store.test.ts` (idempotency, a refused thread for an
absent Bot, a torn trailing line, replay convergence), `packages/ui/src/bots.test.ts` (the rows and
the labels), and `apps/server/src/run-service.test.ts` (two Bots, two workspace directories, a second
process over the same root). Commit `b727146` carries the driver the artifact was produced from.
The provider setup row covers U4.3's page 1, the surface `UX.md` calls the first page a new person
sees. `apps/server/src/provider-setup.ts` writes the vault through `writeVault` and then tests, so a
refused connection is still saved and marked untested; the record it writes beside the vault holds the
flags and no key, and a record measured on another endpoint reads untested rather than letting a stale
`capable` outlive its connection. `packages/providers/src/capability.ts` is the test: one real request
carrying a tool definition over the run path's own client, the tool's result back so the closing reply
is observed, and the structured-output fallback when no call arrived, with the flags derived from the
observed turn. `packages/ui/src/provider.ts` and `packages/ui/browser/provider.ts` are the page, and
the router's two new arms are `get_provider` and `connect_provider`. Its evidence is `live-ui-verified`
for the reason the keyed run's is: the capable case is a real model through the real endpoint, and the
run that proves the saved connection has to be a real run. The same commit fixes
`resolveBotsRoot`, which ignored `FREEBOT_WORKSPACE` for a service started directly, so
`one-run-path.ts` ran over the machine's own bots root and its `run-1` assertion depended on what
another driver had left there (`run-3` on this branch, `run-5` on `main`); the driver passes 54/54 with
that fixed. The rationale, the limits, and the follow-ups are in `docs/provider-setup.md`. Commit
`7e63e57` carries the driver the artifact was produced from; `2703ae2` carries the same driver after biome's format and the page's static field text, and its run is the artifact the row names.

The design contract row covers U6.1, the frame every later parity unit sits in. It is `live-ui-verified`
in the weak sense the surface allows: both pages are real, and the app is the real launcher, but the
driver configures it in replay mode so that no provider is called and no Bot a person made is touched,
which is why the artifact's own disclosure says so. What makes the row evidence rather than an
assertion is that the numbers are read from two live pages rather than declared here. The token table
lives in `packages/ui/src/tokens.ts` with a source line per value, and `tokens.test.ts` asserts each
value against a literal, so a one-character edit to a token fails `bun run test`. The page's `:root`
block and this document's token table are generated from that one source and both are checked for
drift on every run. The harness then reads the same field from the app and from the export at the same
viewport and prints a delta per field, with geometry and computed styles as the assertion and the
pixel count reported as information. Two deltas are declared rather than closed, both of them the
export contradicting itself: `--aside-w` is 384px in its token block and 372px in its script, so the
frame ships the token and the harness prints the 12px it costs the thread column. The 980px media
query in the handoff's declared entry file is recorded as superseded rather than implemented, because
the fuller export file replaces it with 1120px and 860px and the two disagree across a 120px band. The
whole reconciliation, the surface map, the row of surfaces the export has and the app does not, and
the follow-ups are in `docs/DESIGN-CONTRACT.md`.

The first-run row covers U6.2, the screen a fresh install meets instead of an app that names a Bot
for the person. A store with no Bot opens it, and it is the export's own screen: three panes in the
fuller file's order and copy (`freebot-prototype.html:625-648`), the name pane's Continue making the
Bot through the same `create_bot` and `create_thread` arms the sidebar's own control uses, the purpose
pane writing the record's two new fields through `update_bot` and the `bot.update` journal command, and
the job pane filling the composer rather than starting the run (`:2240`). The provider pane is U4.3's
route entered a second time, `mountProvider` mounted with `surface: "first-run"`, so its four outcomes
are page 1's own code: the driver reaches all four against three local stubs it starts and removes, and
no key is read anywhere in the run. Its verdict is `live-ui-verified` because both pages are real and
the app is really launched; the two limits are stated in the artifact, that the provider outcomes are
stubs and that the composer's own focus call is not observable under CDP's focus emulation. The
argument for the screen, its boot table, its nine-viewport geometry result and the deltas it declares
rather than closes are in `docs/first-run.md`. This unit also changed four drivers' setup: a store with
no Bot opens the first-run screen, so `files-surface`, `bots-and-threads`, `launch` and `keyed-run` make
their first Bot over the route a page uses before opening a page, `design-contract` and `provider-setup`
do the same for the one Bot their subjects need, and no assertion was weakened: the records and the
literals those drivers expect are the ones they assert (`bot-local`, `Local Bot`, one thread), one step
earlier. Their artifacts above are the runs at this head.

The connectors row covers U8.1, the seam every later connector unit sits behind. MCP is the wire and
one adapter sits under a vendor-neutral interface: `packages/connectors/src/connector.ts` names the
four operations a model-facing tool needs plus a `TokenRef` that can be shown and not spent,
`mcp-client.ts` is the JSON-RPC 2.0 streamable-HTTP transport (revision 2025-06-18) written here so
the package's import graph holds no vendor, and `boundary.test.ts` enforces both halves of that
promise over the package's own source. A bare import outside the vendor-facing allowlist fails (the
list was empty at this commit and holds `composio.ts` since U8.3; the row below carries the current
state), and a stub adapter sharing no code with the MCP adapter is driven through the same
consumer, which is U8.3's "Composio without touching the seam" as a test rather than a sentence. A
connector call is a new arm in the run's one tool table (`apps/server/src/run-ports.ts`): the model's
tool list, the gate's governed names and the executor all derive from the same rows, so a connector
tool cannot be offered without a runner or run without being governed, and the landed `bash` arm,
its tests and the seven existing drivers are untouched at this head. The app reads the person's
`connectors.json` under the freebot home, answers `list_connectors` and `test_connector` with the
credential's reference and never a header value, and the launcher's boot line names the file, the
ids and the addresses only. The evidence's service is emulated on purpose, per the plan's tier 2:
the `emulate` GitHub fixture, seeded per run, whose own probes said that a missing credential is
refused `401` while any bearer write is accepted — so the row claims credential custody, and the
exact-match half is proven at the fixture MCP server's own bearer gate instead. `docs/connectors.md`
carries the interface table, the credential's path, the arm's shape, the three probe facts, and
what U8.2 and U8.3 must not repeat. Commit `ca04580` carries the code and the driver the artifact
was produced from.

The composio adapter row covers U8.3, the second vendor behind that seam. `composio.ts` is the one
module in the package allowed to name the vendor, and it does not speak a second wire: it mints a
session on the vendor's documented route and hands the endpoint the session answered with to
`McpConnector`, so the transport and everything above it are the ones that were already there. Two
claims in this unit are worth stating plainly rather than leaving to the row's parenthesis. The first
is that the delete test is a run: the driver moves `composio.ts` and its own test aside, runs the real
`bun run typecheck` and the real `bun test`, asserts exit 0 on both with `663 pass, 0 fail` and no
`composio.test.ts` in the run, and restores the file against its sha256. The adapter is therefore
provably not load-bearing today, which is what gate 8 asks for and not a claim about what a later
unit may add. The second is the custody rule, which is stricter here than for the first vendor because
this vendor hands back an endpoint: the project key reaches the session route and nothing else, the
endpoint gets `mcp.headers` when the session names any and nothing when it does not, and the driver
asserts both halves against the endpoint's own gate. Two things this row does not claim, and
`docs/connectors.md` carries both: the public schema for the session answer documents no headers
object while the vendor's SDK exposes one, so a headerless session is treated as ordinary; and no real
Composio account was ever reached, because this project owns none (order 33). Commit `c7e5326`
carries the code, the tests and the driver the artifact was produced from.

The glossary row covers U7.1, which adds no code. `GLOSSARY.md` gives one meaning and one source per
project word, its **Overload** lines spell out the words this repo uses in more than one sense
(`provider`, `gate`, `verdict`, `unit`, `landing`, `frame`, `run`, `matrix`), and `GLOSSARY-MAP.md`
routes a reader to the glossary and names the other vocabularies in the repo. Its check is a reading,
not a run. `bun run lint` and `bun run verify` both pass, and neither of them reads a definition, so
what makes the row evidence is that each entry was read against the file it cites and five entries
were re-read at random afterwards. The Commit cell names the commit the word list was read at rather
than a run's commit, because a docs-only row has no run to pin; the artifact is the two documents
themselves, which land with this PR.

The truth fix row covers U7.2, which adds no code. Four documents and the U2.1 driver's own
disclosure told a reader that a closed gate parks the model, which stopped being true when G1 opened:
`apps/server/src/provider.ts` builds a real `KeyedProvider` whenever the factory's choice is keyed,
and `auto` chooses keyed when `~/.freebot/provider.env` holds a key, so the app makes real model calls
today. The unit fixed every present-tense claim a reader acts on and left the dated build records
alone, naming each survivor with its reason in the artifact's census. The stale claim was always a
reason clause rather than a capability: both regenerated artifacts use the replay provider because
their driver pins it for a fixed recorded turn (order 9), which is what `launch.ts`'s own disclosure
has always said.

Every later feature gets its own row when its script lands.
