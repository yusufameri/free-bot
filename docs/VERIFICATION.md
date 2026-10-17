# Verification index

One row per verified feature, per plan 9.3. Artifacts live under `packages/verify/artifacts/`, one
directory per feature and git short sha. The row records the commit the artifact was produced at.

| Feature | Script | Verdict | Artifact | Commit | Date |
| --- | --- | --- | --- | --- | --- |
| scaffold | `bun run verify` | unit-test-verified | `packages/verify/artifacts/scaffold/8ed2aa4/assert.txt` | 8ed2aa49b5cdbe72869d98cf0a650f4e2cebb1d1 | 2026-10-16 |
| pi-rpc-spike | `bun spikes/pi-rpc/drive.ts` | spike-verified (39/39 assertions, keyless stub model, no test suite exists for it) | `packages/verify/artifacts/pi-rpc/e203adf/assert.txt` | e203adffa3e8dd0ce047b42216d7414fd1838c15 | 2026-10-17 |
| containment spike | `bash spikes/containment/run.sh` | unit-test-verified | `packages/verify/artifacts/containment/57a229d/probes.txt` | 57a229d8291ed58fcb7d291e29a9109e78d1a0bd | 2026-10-16 |
| sandbox image pin + replay + key scan | `bash packages/sandbox/image/run.sh` | unit-test-verified (two in-image replays equal after normalization, 0 canary hits) | `packages/verify/artifacts/sandbox-image/8d36ea7/assert.txt` | 8d36ea72a1dc1577d8f120e93e5858c666d8a71d | 2026-10-17 |

Coverage so far is the scaffold unit plus the pi-rpc and containment spikes. The scaffold row covers
workspace shape, typecheck, the `apps/server` health test, and a real HTTP probe of `GET /healthz` on
an ephemeral port. The sandbox image row covers the pinned image build, two in-image replays of the
same scripted Pi turn with an asserted-equal event sequence, and a zero-hit key-material scan; its
limits and normalization are stated in `docs/sandbox-image.md`. The pi-rpc row covers a live `pi --mode rpc` process driven over strict JSONL by
`spikes/pi-rpc/drive.ts` against a keyless local stub model; its verdict is `spike-verified` because
no `bun test` suite covers it, only the driver's own 39 assertions, all green in the committed
transcript. The containment row covers seven kernel-level egress probes inside a container netns
(direct https, proxy egress, DNS over UDP and TCP, raw TCP, UDP including the QUIC port, DoH, IP
literals) produced by a rerunnable script; its limits are stated in `docs/containment-spike.md`.
Rationale and citations for the pi-rpc spike live in `docs/pi-rpc-spike.md`. Every later feature gets
its own row when its script lands.
