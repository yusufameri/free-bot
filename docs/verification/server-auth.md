feature: server-auth
script: `bun apps/server/scripts/verify.ts`
verdict: unit-test-verified (63 tests: the refusal matrix per code, the oRPC contract over HTTP, a real WebSocket subscribe with replay-then-live ordering, the resume path, subscription release, and two runs over one log in one tick; plus 32 live checks against a really launched `apps/server/src/index.ts` on ephemeral ports: the 401/403/200 matrix as literal lines, the tunnel leg's rebound-Host refusals on `/events` and `/audit` alongside the in-sandbox agent's `host.docker.internal` Host still reading both, one oRPC round trip, two runs parked at the gate and answered with deny over the page's own stream so both reach a terminal frame and both put `user_denied` in the log, the container set back where it started, the loopback-only bind, the token printed exactly once, and no token in any log line or in the artifact. The model is replayed from the committed Pi transcript and the sandbox is the pinned image)
artifact: `packages/verify/artifacts/server-auth/0b4cb7b/assert.txt`
commit: 0b4cb7b2285620485ee970d2cbeb57992537643a
date: 2026-10-17
legacy-count: the driver printed one PASS line per check (32 of them) and a bare 'PASS server-auth', with no RESULT line
