# Verification index

One row per verified feature, per plan 9.3. Artifacts live under `packages/verify/artifacts/`, one
directory per feature and git short sha. The row records the commit the artifact was produced at.

| Feature | Script | Verdict | Artifact | Commit | Date |
| --- | --- | --- | --- | --- | --- |
| scaffold | `bun run verify` | unit-test-verified | `packages/verify/artifacts/scaffold/8ed2aa4/assert.txt` | 8ed2aa49b5cdbe72869d98cf0a650f4e2cebb1d1 | 2026-10-16 |
| pi-rpc-spike | `bun spikes/pi-rpc/drive.ts` | spike-verified (39/39 assertions, keyless stub model, no test suite exists for it) | `packages/verify/artifacts/pi-rpc/e203adf/assert.txt` | e203adffa3e8dd0ce047b42216d7414fd1838c15 | 2026-10-17 |
| pi-bridge | `bun run verify && bun test packages/pi-bridge && bun packages/pi-bridge/scripts/smoke.ts` | unit-test-verified (replay transport, fail-closed gate tests; live keyed smoke parks without BYOK key) | `packages/verify/artifacts/pi-bridge/a67bc72/assert.txt` | a67bc7248a9b0b04552f748dd683f86f35d3a19d | 2026-10-17 |

Coverage so far is the scaffold unit, the pi-rpc spike, and the pi-bridge client. The scaffold row covers
workspace shape, typecheck, the `apps/server` health test, and a real HTTP probe of `GET /healthz` on an
ephemeral port. The pi-rpc row covers a live `pi --mode rpc` process driven over strict JSONL by
`spikes/pi-rpc/drive.ts` against a keyless local stub model; its verdict is `spike-verified` because
no `bun test` suite covers it, only the driver's own 39 assertions, all green in the committed
transcript. The pi-bridge row covers `packages/pi-bridge`: 28 replay-driven tests (frame parsing
against the frozen transcript, session correlation and ordered events, fail-closed gate paths),
all green in `bun run verify`, plus the smoke's parked path. Its live keyed smoke (one real gated
tool call) is unobserved while gate G1 parks. Rationale and citations live in `docs/pi-rpc-spike.md`
and `docs/pi-bridge.md`. Every later feature gets its own row when its script lands.
