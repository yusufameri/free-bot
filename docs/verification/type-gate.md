feature: type gate
script: `bun packages/verify/scripts/type-gate.ts`
verdict: type-check-only (the probe places a deliberate type error in a `.tsx` under `apps/web`, in a `.ts` under `apps/web/scripts`, and in a package script, one at a time: each fails the root typecheck and names its file, the removed file passes again, and the same three errors pass the pre-widening include in a run that proves all three were in the tree; a census asserts the root include is exactly the nine patterns it ships, measures a temporary `.tsx` file in each of the four `.tsx` families, asserts 12 named files are in the program, that the program grew from 96 to 112 repo files at this commit, and that the unreached set is exactly the four documented files; rationale, limits and follow-ups in `docs/type-gate.md`)
artifact: `packages/verify/artifacts/type-gate/8d892fa/probe.txt`
commit: 8d892faff1aa28f65bfdcd522df8c685bb35981b
date: 2026-10-18
