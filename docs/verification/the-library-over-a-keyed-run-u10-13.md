feature: the Library over a keyed run (U10.13)
script: `bun packages/verify/scripts/files-surface.ts`
verdict: live-ui-verified (54/54 checks against a really launched `bun run up --no-open` and the vault's keyed model). The two failures were the driver reading the wrong surface. The composer clears when the run takes the prompt, so the check now reads the run's own user row and the cleared box together, and the model's file and its nonce prove the prompt arrived. The approval card gained the export's `›View the full request` disclosure, so the answer check reads `.approval-actions` and also asserts the disclosure is closed. The Library, the refused symlink and the on-disk file are unchanged. U10.18 re-ran this driver at `b917c1f` after the shared `pageErrorMessage` replaced its local evaluate copy: 54/54.
artifact: `packages/verify/artifacts/files-surface/b917c1f/assert.txt`
commit: b917c1f4df5814afb325b6d063a3c946e847b6c4
date: 2026-10-19
