feature: run loop
script: `bun apps/server/src/run-loop-live.ts`
verdict: unit-test-verified (the live surface is a real container from the pinned image plus the real loop: 16 loop tests drive the transitions over fake ports with the real gate and a real `SeqLog`, and the evidence run makes 20 checks pass against a booted container — the pinned layer set, the status trail, the decision table, the seq audit with zero gaps and zero duplicates over 25 frames, both new wire frames as they sit in the log, and the label-scoped cleanup with a surviving decoy. The endpoint tests that drove `start_run` and the approve and deny routes are gone with those routes; `router.test.ts` drives the same surface over oRPC now. The model is replayed from the committed Pi transcript and the human's two answers are scripted, because this driver runs the loop against a replay provider on purpose so its assertions hold a fixed turn, not because a key is missing (order 9); no key material is read or written anywhere)
artifact: `packages/verify/artifacts/run-loop/12730d2/assert.txt`
commit: 12730d2a8d0831adca3b42fe2f73426399ada988
date: 2026-10-17
legacy-count: the driver ended with 'checks: 20/20 PASS' and a bare 'PASS run-loop', with no RESULT line
