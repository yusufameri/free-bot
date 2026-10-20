feature: sandbox image pin + replay + key scan
script: `bash packages/sandbox/image/run.sh`
verdict: unit-test-verified (two in-image replays equal after normalization, 0 canary hits)
artifact: `packages/verify/artifacts/sandbox-image/8d36ea7/assert.txt`
commit: 8d36ea72a1dc1577d8f120e93e5858c666d8a71d
date: 2026-10-17
legacy-header: this run predates the writer's commit header and prints no full sha; the artifact directory's short sha and this row's commit are the only link
