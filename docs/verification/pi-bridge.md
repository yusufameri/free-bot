feature: pi-bridge
script: `bun run verify && bun test packages/pi-bridge && bun packages/pi-bridge/scripts/smoke.ts`
verdict: unit-test-verified (replay transport, fail-closed gate tests; live keyed smoke parks without BYOK key)
artifact: `packages/verify/artifacts/pi-bridge/a67bc72/assert.txt`
commit: a67bc7248a9b0b04552f748dd683f86f35d3a19d
date: 2026-10-17
