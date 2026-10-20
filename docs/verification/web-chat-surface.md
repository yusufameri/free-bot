feature: web chat surface
script: `bun apps/web/scripts/capture.ts`
verdict: live-ui-verified (76/76 CDP checks in headless Chrome 155: the eight key states with their DOM facts read before and after each capture and failing if they moved, every caption's claims evaluated against those facts, every caption's element asserted inside the captured viewport, and 28 pairwise distinctness comparisons with zero collisions; the decisions are the cards' own `data-status`/`data-finished` and `data-state`/`data-decision`/`.approval-result`, with no marker line; committed-fixture replay only, no model, no key)
artifact: `packages/verify/artifacts/web-shell/a273e16/assert.txt`
commit: a273e16c7639925c3afdcfb5915b8d0957a95217
date: 2026-10-19
legacy-header: this run predates the writer's commit header and prints no full sha; the artifact directory's short sha and this row's commit are the only link
