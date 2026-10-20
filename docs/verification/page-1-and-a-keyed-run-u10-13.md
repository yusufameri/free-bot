feature: page 1 and a keyed run (U10.13)
script: `bun packages/verify/scripts/provider-setup.ts`
verdict: live-ui-verified (95/95 checks). Page 1 is shown by the host's boot after it reads the provider record and the Bot list, not at the page's load event, so the first frame now waits for `__providerFacts().shown` before it captures; the earlier red was the driver photographing the app between load and that read. The artifact now ends with its own `RESULT: PASS (95/95)` line, which the sweep reads; before this head the driver printed the line and never wrote it. The artifact writer replaces the home directory with `~`, so the public run does not name the developer's vault path. The six frames, the capable, limited and refused saves, the keyed run and the key scan are unchanged. U10.18 re-ran this driver at `b917c1f` after the shared `pageErrorMessage` replaced its local evaluate copy: 95/95.
artifact: `packages/verify/artifacts/provider-setup/b917c1f/assert.txt`
commit: b917c1f4df5814afb325b6d063a3c946e847b6c4
date: 2026-10-19
