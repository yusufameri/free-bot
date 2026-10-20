feature: protocol
script: `bun packages/protocol/scripts/verify.ts`
verdict: unit-test-verified (90 tests: envelope round-trip and rejection per kind, DTO strictness per operation, all nine deny codes plus the allow path routed through the real `packages/review` gate into `tool_call.decision` payloads, grant lifecycle against its ledger, and the literal U0.10 fixture accepted under v1; 23 rejection cases with literal zod text; replay demo through `SeqLog` reports gaps 0 [], duplicates 0 [] and prints the strip-before-persist boundary)
artifact: `packages/verify/artifacts/protocol/efa0211/assert.txt`
commit: efa021145e43002596f183381cac6b37826cf165
date: 2026-10-17
