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
| protocol | `bun packages/protocol/scripts/verify.ts` | unit-test-verified (79 tests: envelope round-trip and rejection per kind, DTO strictness per operation, deny codes and grant lifecycle against `packages/review`, and the literal U0.10 fixture accepted under v1; 22 rejection cases with literal zod text; replay demo through `SeqLog` reports gaps 0 [], duplicates 0 []) | `packages/verify/artifacts/protocol/e025559/assert.txt` | e0255593449fb75bb5c2a397018b8da423dd6090 | 2026-10-17 |

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
return value; its shape, limits, and follow-ups are in `docs/forge-test-a.md`. Every later feature
gets its own row when its script
lands.
lands.
