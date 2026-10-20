feature: providers
script: `bun packages/providers/scripts/evidence.ts`
verdict: unit-test-verified (the injectable transport and the replay-mode probe are the tested surface: 36 tests covering the client's streaming and non-streaming parsing, the malformed tool-call shapes, the auth/rate-limit/refusal/malformed-call/timeout/transport error literals, the fallback's success and failure modes, and the flag derivation from one observed turn, one of them the parsable-reply-with-no-tool-call note; every artifact row asserts the literal it prints, so a regression fails the run rather than printing PASS; the gate's smoke step asks for `--replay`, so it takes one path whether or not a key exists, and the artifact carries that step's own output. Gate G1 is open: the artifact says what that changes, the live half was run once outside the gate against the real endpoint and is committed beside it as `live.txt`, `mode=live toolCalling=strong`, and the key never left the vault)
artifact: `packages/verify/artifacts/providers/7032a72/assert.txt`
commit: 7032a72c9c7c01e2cc35f103e9c42c7b6dad8f66
date: 2026-10-17
