feature: first run (U10.13)
script: `bun packages/verify/scripts/first-run.ts`
verdict: live-ui-verified (113/113 checks in headless Chrome 155, the same fresh-home wizard as the row above). The composer's `#prompt` measures 46px, not the 36 this driver expected: the export's own `.composer` sets `min-height: 46px` at `freebot-prototype.html:373`, and U6.8 moved the app to it. The pane, the record writes, the three provider stubs, the nine-viewport geometry and the replay run after the wizard are unchanged.
artifact: `packages/verify/artifacts/first-run/d64faae/assert.txt`
commit: d64faaef84a308a63414149c4475b9cf529d7a10
date: 2026-10-19
legacy-header: this run predates the writer's commit header and prints no full sha; the artifact directory's short sha and this row's commit are the only link
