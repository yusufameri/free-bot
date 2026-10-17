# Verification index

One row per verified feature, per plan 9.3. Artifacts live under `packages/verify/artifacts/`, one
directory per feature and git short sha. The row records the commit the artifact was produced at.

| Feature | Script | Verdict | Artifact | Commit | Date |
| --- | --- | --- | --- | --- | --- |
| scaffold | `bun run verify` | unit-test-verified | `packages/verify/artifacts/scaffold/8ed2aa4/assert.txt` | 8ed2aa49b5cdbe72869d98cf0a650f4e2cebb1d1 | 2026-10-16 |
| pi-rpc-spike | `bun spikes/pi-rpc/drive.ts` | spike-verified (39/39 assertions, keyless stub model, no test suite exists for it) | `packages/verify/artifacts/pi-rpc/e203adf/assert.txt` | e203adffa3e8dd0ce047b42216d7414fd1838c15 | 2026-10-17 |
| pi-bridge | `bun run verify && bun test packages/pi-bridge && bun packages/pi-bridge/scripts/smoke.ts` | unit-test-verified (replay transport, fail-closed gate tests; live keyed smoke parks without BYOK key) | `packages/verify/artifacts/pi-bridge/a67bc72/assert.txt` | a67bc7248a9b0b04552f748dd683f86f35d3a19d | 2026-10-17 |
| containment spike | `bash spikes/containment/run.sh` | unit-test-verified | `packages/verify/artifacts/containment/57a229d/probes.txt` | 57a229d8291ed58fcb7d291e29a9109e78d1a0bd | 2026-10-16 |
| sandbox image pin + replay + key scan | `bash packages/sandbox/image/run.sh` | unit-test-verified (two in-image replays equal after normalization, 0 canary hits) | `packages/verify/artifacts/sandbox-image/8d36ea7/assert.txt` | 8d36ea72a1dc1577d8f120e93e5858c666d8a71d | 2026-10-17 |
| review-grants | `bun test packages/review && bun packages/review/src/scenario.ts` | unit-test-verified | `packages/verify/artifacts/review-grants/c8efced/assert.txt` | c8efcedebc75151a6dacb210f3c29f74328698c2 | 2026-10-17 |
| tunnel spike | `bun spikes/tunnel/kill-rejoin.ts` | spike-verified (34/34 checks, both kill scenarios: zero gaps, zero duplicates, stable pi pid) | `packages/verify/artifacts/tunnel/bf0a4e6/assert.txt` | bf0a4e67b8351cb1db3d7f160f2042ddd7850ff9 | 2026-10-17 |
| browser containment spike | `bash spikes/browser-containment/run.sh` | spike-verified (7/7 browser probes inside the default-deny netns, UDP attributed by port bucket) | `packages/verify/artifacts/containment-browser/27cf9de/probes.txt` | 27cf9dee665547356177d8c0ce3d39b2c8f623b9 | 2026-10-17 |
| forge test A | `bun spikes/forge-test-a/run.ts` | spike-verified (91/91 checks: matrix a–i plus positive controls and a throwing handler, every row read by literal in-VM canary reads, seq 1..239 with zero gaps and zero duplicates across a SIGKILLed composer; keyless stub model) | `packages/verify/artifacts/forge-test-a/a46071c/assert.txt` | a46071ce2b0108ad5d1d650a3a55ba4225520ced | 2026-10-17 |
| web-stream spike | `bun spikes/web-stream/run.ts` | spike-verified (59/59 CDP checks, both approval paths, reconnect resume with duplicate ignored, 12 frame captures) | `packages/verify/artifacts/web-stream/35bd852/assert.txt` | 35bd8529a9b1f7986052838a8e4adbab2d901267 | 2026-10-17 |
| mvp smoke dry run | `bun spikes/mvp-smoke/run.ts` | spike-verified (75/75 checks: the whole pipeline keyless end to end, approval allow and deny through the real grant gate, a mid-task relay+composer SIGKILL with page resume, zero gaps and zero duplicates across both logs, and seven committed frames asserted pairwise-distinct in the page facts they captured; keyless stub model) | `packages/verify/artifacts/mvp-smoke/333323c/assert.txt` | 333323c666cdf4bfea377fe972879be6683f3218 | 2026-10-17 |
| protocol | `bun packages/protocol/scripts/verify.ts` | unit-test-verified (90 tests: envelope round-trip and rejection per kind, DTO strictness per operation, all nine deny codes plus the allow path routed through the real `packages/review` gate into `tool_call.decision` payloads, grant lifecycle against its ledger, and the literal U0.10 fixture accepted under v1; 23 rejection cases with literal zod text; replay demo through `SeqLog` reports gaps 0 [], duplicates 0 [] and prints the strip-before-persist boundary) | `packages/verify/artifacts/protocol/efa0211/assert.txt` | efa021145e43002596f183381cac6b37826cf165 | 2026-10-17 |
| core run model | `bun packages/core/src/run-evidence.ts` | unit-test-verified (66 core tests over the seven statuses and their fourteen legal transitions, both idempotency cases, replay refusals, torn-journal repair, integer nano-USD money and the spend-cap compare; plus a 45-check evidence run that drives the smoke's lifecycle through the landed `SeqLog`, kills the journal's writer with a torn last line, reopens converged mid-step, rejoins at the seq after the kill on attempt 2, and reaches done through two parks; `freebot doctor` prints 4 PASS / 1 FAIL, the FAIL being the provider key gate G1 parks) | `packages/verify/artifacts/core-run-model/ba092ab/assert.txt` | ba092ab0ec1dc0e5c870d56b00b6d2351852d124 | 2026-10-17 |
| sandbox-provider | `bun test packages/sandbox/src/docker.test.ts` | unit-test-verified (Docker integration is the live surface: create from the pinned image, exec/upload/download, tunnel echo, snapshot/resume, idle-kill, label-scoped sweep against decoys; the suite skips itself where the pinned arm64 image is absent, so CI runs it as a skip and this artifact is the local run; no UI, so no live-ui claim) | `packages/verify/artifacts/sandbox-provider/dc875b3/assert.txt` | dc875b31769843ebd3b743fc8a68b3f43566b35f | 2026-10-17 |
| providers | `bun packages/providers/scripts/evidence.ts` | unit-test-verified (the injectable transport and the replay-mode probe are the tested surface: 36 tests covering the client's streaming and non-streaming parsing, the malformed tool-call shapes, the auth/rate-limit/refusal/malformed-call/timeout/transport error literals, the fallback's success and failure modes, and the flag derivation from one observed turn, one of them the parsable-reply-with-no-tool-call note; every artifact row asserts the literal it prints, so a regression fails the run rather than printing PASS; the live-provider run is gate-bound on G1 and is unobserved, so every observation line in the artifact is labelled replay or live and all of them are replay today) | `packages/verify/artifacts/providers/a980049/assert.txt` | a980049d0d892f15bbe92d8ead42aab9a2ca239c | 2026-10-17 |
| web chat surface | `bun apps/web/scripts/capture.ts` | live-ui-verified (76/76 CDP checks in headless Chrome 155: the eight key states with their DOM facts read before and after each capture and failing if they moved, every caption's claims evaluated against those facts, every caption's element asserted inside the captured viewport, and 28 pairwise distinctness comparisons with zero collisions; committed-fixture replay only, no model, no key) | `packages/verify/artifacts/web-shell/2f23017/assert.txt` | 2f230177008f1d369ee8f94bd90f16fc082e4ff7 | 2026-10-17 |
| server auth + oRPC control plane | `bun apps/server/scripts/verify.ts` | unit-test-verified (55 tests: the refusal matrix per code, the oRPC contract over HTTP, a real WebSocket subscribe with replay-then-live ordering, the resume path, and subscription release; plus 23 live checks against a really launched `apps/server/src/index.ts` on ephemeral ports: the 401/403/200 matrix as literal lines, the tunnel leg's rebound-Host refusals on `/events` and `/audit` alongside the in-sandbox agent's `host.docker.internal` Host still reading both, one oRPC round trip, one streamed event, the loopback-only bind, the token printed exactly once, and no token in any log line or in the artifact) | `packages/verify/artifacts/server-auth/0744562/assert.txt` | 0744562bf0e7027a8c8b56cf0eda78572d0a66ae | 2026-10-17 |
| type gate | `bun packages/verify/scripts/type-gate.ts` | type-check-only (the probe places a deliberate type error in a `.tsx` under `apps/web`, in a `.ts` under `apps/web/scripts`, and in a package script, one at a time: each fails the root typecheck and names its file, the removed file passes again, and the same three errors pass the pre-widening include in a run that proves all three were in the tree; a census asserts the root include is exactly the nine patterns it ships, measures a temporary `.tsx` file in each of the four `.tsx` families, asserts 12 named files are in the program, that the program grew from 89 to 105 repo files at this commit, and that the unreached set is exactly the four documented files; rationale, limits and follow-ups in `docs/type-gate.md`) | `packages/verify/artifacts/type-gate/21c263d/probe.txt` | 21c263d76432f2182eae4828e4a0b1441036b26c | 2026-10-17 |

Coverage so far is the scaffold unit, the pi-rpc and containment spikes, the pi-bridge client, and the
sandbox image pin. The scaffold row covers workspace shape, typecheck, the `apps/server` health test,
and a real HTTP probe of `GET /healthz` on an ephemeral port. The pi-rpc row covers a live `pi --mode
rpc` process driven over strict JSONL by `spikes/pi-rpc/drive.ts` against a keyless local stub model;
its verdict is `spike-verified` because no `bun test` suite covers it, only the driver's own 39
assertions, all green in the committed transcript. The pi-bridge row covers `packages/pi-bridge`: 28
replay-driven tests (frame parsing against the frozen transcript, session correlation and ordered
events, fail-closed gate paths), all green in `bun run verify`, plus the smoke's parked path. Its
live keyed smoke (one real gated tool call) is unobserved while gate G1 parks. The containment row
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
The server-auth row covers U1.3's control-plane slice: 55 tests over the refusal matrix, the oRPC
round trip, a real WebSocket subscribe with replay-then-live ordering, the resume path, and the
release of a closed socket's subscription, plus 23 live checks against a really launched
`apps/server/src/index.ts` (the token printed once, the 401/403/200 matrix as literal lines, the
tunnel leg's two rebound-Host refusals and its agent reads with their literal log bodies, one oRPC
call, one streamed event, the loopback-only bind, and a redaction check that fails the run rather
than commit a token). Its threat model, check order, token lifecycle, and explicit non-goals live in
`docs/server-auth.md`.
Every later feature gets its own row when its script
lands.
