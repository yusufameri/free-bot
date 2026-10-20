# Artifact hygiene

`packages/verify/artifacts/` holds one directory per feature per run. A committed run is evidence and
stays on disk even after a newer run replaces it, because a `docs/VERIFICATION.md` row may still name
it (order 49). An uncommitted run is scratch from a pass, and the status routine leaves one per pass
(order 31). Four mechanisms keep the tree usable.

## Prune the scratch runs

```
bun run prune --dry-run
bun run prune
bun run prune --path packages/verify/artifacts/mvp-status/pass70-461dc46
```

The dry run prints `DELETE` and `KEEP` for every directory, and a tally. The command applies the same
plan when `--dry-run` is absent. `--path` narrows the plan to one run directory.

The rules, in order:

1. A run directory named by a row of `docs/VERIFICATION.md` is kept. The row is the authority.
2. A run directory tracked by git is kept. Committed evidence is history.
3. For each feature, the untracked run with the newest modification time is kept. Directories tied at
   that time are all kept, because the plan does not guess between them.
4. Everything else is deleted.

A missing table refuses the plan, because the rows are what makes a deletion safe. A path outside
`packages/verify/artifacts/`, the artifact root itself, a feature directory, and a path that does not
exist are each refused by name. The deletion step checks the same scope again, so a plan built by
hand cannot reach outside the tree. A run directory is one `<feature>/<run>` pair, never a feature
and never the root.

`packages/verify/src/prune.test.ts` covers the keeps, the deletion, the tie, the feature-level file,
each refusal, and the invariant that the committed index names no run this plan deletes.

## Ignore the Chrome profiles

A driver's browser profile lives in a temporary directory, and the shared client removes it on stop.
Two ignore rules cover a crashed run:

- `.freebot-chrome-profile-*/` covers the profile `packages/verify/scripts/status-capture.ts` creates
  at the repo root.
- `packages/verify/artifacts/**/chrome-profile*/` covers the throwaway status captures. The
  `capture*.ts` scripts under `packages/verify/artifacts/mvp-status/*/` point `--user-data-dir` at
  `chrome-profile`, `chrome-profile2` or `chrome-profile3` beside their screenshots.

## Exclude the tree from the linter

`biome.json` excludes `packages/verify/artifacts`. The tree is evidence, not source. Its capture
scripts are untracked, so a local `bun run lint` used to fail on them with errors CI never saw. The
exclusion covers only that directory, and a real error in a tracked source file still fails the gate.

## One capture helper

`saveScreenshot(cdp, sessionId, path)` in `packages/verify/src/cdp.ts` captures the viewport, writes
the PNG and returns the bytes, so a driver can digest what it wrote. It takes a `ScreenshotSource`,
which both CDP clients satisfy, so `apps/web/scripts` uses the same helper as `packages/verify`.

The drivers that moved off their own `Page.captureScreenshot` call are `launch.ts`, `keyed-run.ts`,
`files-surface.ts`, `bots-and-threads.ts`, `provider-setup.ts`, `status-capture.ts`,
`apps/web/scripts/capture.ts` and `apps/web/scripts/one-run-path.ts`. None of them changed which
state it captures or what it asserts about it.
