feature: sandbox-provider
script: `bun test packages/sandbox/src/docker.test.ts`
verdict: unit-test-verified (Docker integration is the live surface: create from the pinned image, exec/upload/download, tunnel echo, snapshot/resume, idle-kill, and the label-scoped sweep. Every container the suite creates carries a per-run token in its name and in its `freebot.unit` label, so two suites run at once on the shared engine both pass 10/10 with their containers alive at the same moment; the sweep test asserts the run owns exactly three containers, the sweep removes exactly those, and three decoys survive with their ids and their running state, one under another unit's label, one under a sibling run's label and one unlabelled. The suite skips itself where the pinned arm64 image is absent, so CI runs it as a skip and this artifact is the local run; no UI, so no live-ui claim)
artifact: `packages/verify/artifacts/sandbox-provider/7032a72/assert.txt`
commit: 7032a72c9c7c01e2cc35f103e9c42c7b6dad8f66
date: 2026-10-17
legacy-header: this run predates the writer's commit header and prints no full sha; the artifact directory's short sha and this row's commit are the only link
