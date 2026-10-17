# Verification index

One row per verified feature, per plan 9.3. Artifacts live under `packages/verify/artifacts/`, one
directory per feature and git short sha. The row records the commit the artifact was produced at.

| Feature | Script | Verdict | Artifact | Commit | Date |
| --- | --- | --- | --- | --- | --- |
| scaffold | `bun run verify` | unit-test-verified | `packages/verify/artifacts/scaffold/8ed2aa4/assert.txt` | 8ed2aa49b5cdbe72869d98cf0a650f4e2cebb1d1 | 2026-10-16 |
| containment spike | `bash spikes/containment/run.sh` | unit-test-verified | `packages/verify/artifacts/containment/57a229d/probes.txt` | 57a229d8291ed58fcb7d291e29a9109e78d1a0bd | 2026-10-16 |

Coverage so far is the scaffold unit and the containment spike: workspace shape, typecheck, the
`apps/server` health test, a real HTTP probe of `GET /healthz` on an ephemeral port, and seven
kernel-level egress probes inside a container netns (direct https, proxy egress, DNS over UDP and
TCP, raw TCP, UDP including the QUIC port, DoH, IP literals) produced by a rerunnable script. Every
later feature gets its own row when its script lands.
