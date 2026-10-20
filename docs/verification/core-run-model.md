feature: core run model
script: `bun packages/core/src/run-evidence.ts`
verdict: unit-test-verified (66 core tests over the seven statuses and their fourteen legal transitions, both idempotency cases, replay refusals, torn-journal repair, integer nano-USD money and the spend-cap compare; plus a 45-check evidence run that drives the smoke's lifecycle through the landed `SeqLog`, kills the journal's writer with a torn last line, reopens converged mid-step, rejoins at the seq after the kill on attempt 2, and reaches done through two parks; `freebot doctor` prints 4 PASS / 1 FAIL, the FAIL being the provider key check, which finds no key file in the driver's own temp home)
artifact: `packages/verify/artifacts/core-run-model/ba092ab/assert.txt`
commit: ba092ab0ec1dc0e5c870d56b00b6d2351852d124
date: 2026-10-17
