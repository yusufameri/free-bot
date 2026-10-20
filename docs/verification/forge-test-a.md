feature: forge test A
script: `bun spikes/forge-test-a/run.ts`
verdict: spike-verified (91/91 checks: matrix a–i plus positive controls and a throwing handler, every row read by literal in-VM canary reads, seq 1..239 with zero gaps and zero duplicates across a SIGKILLed composer; keyless stub model)
artifact: `packages/verify/artifacts/forge-test-a/a46071c/assert.txt`
commit: a46071ce2b0108ad5d1d650a3a55ba4225520ced
date: 2026-10-17
