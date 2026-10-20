feature: web-stream spike
script: `bun spikes/web-stream/run.ts`
verdict: spike-verified (59/59 CDP checks, both approval paths, reconnect resume with duplicate ignored, 12 frame captures)
artifact: `packages/verify/artifacts/web-stream/35bd852/assert.txt`
commit: 35bd8529a9b1f7986052838a8e4adbab2d901267
date: 2026-10-17
legacy-header: this run predates the writer's commit header and prints no full sha; the artifact directory's short sha and this row's commit are the only link
