# The root type gate

Status: PASS. 38/38 probe checks green at commit `2c9b605`, driven by
`bun packages/verify/scripts/type-gate.ts`, with the transcript under
`packages/verify/artifacts/type-gate/2c9b605/probe.txt`. Verdict: type-check-only. That commit is the
merge of `main` at `0a7b527` (U1.7's run loop); the counts below were re-measured there rather than
carried over from the pre-merge head.

`bun run typecheck` is the cheap gate every unit, every PR and CI runs. Until this unit it was blind
to 14 source files and to every `.tsx` file in the repo. It now covers each workspace's `src` and
`scripts` directories in both extensions. At this commit the widened include reaches 16 files the
pre-widening one does not, 112 repo files against 96. The two beyond U1.5's measurement are this
unit's own probe script and `apps/server/scripts/verify.ts`, which landed on `main` while this branch
waited. This closes follow-up 1 of `docs/web-shell.md`, which parked the React and Next.js port on
exactly this change.

## The include, before and after

Before, as measured by the U1.5 review:

```
packages/*/src/**/*.ts
packages/verify/*.ts
apps/*/src/**/*.ts
```

After, in the root `tsconfig.json`:

```
packages/*/src/**/*.ts
packages/*/src/**/*.tsx
packages/*/scripts/**/*.ts
packages/*/scripts/**/*.tsx
packages/verify/*.ts
apps/*/src/**/*.ts
apps/*/src/**/*.tsx
apps/*/scripts/**/*.ts
apps/*/scripts/**/*.tsx
```

The program went from 82 to 97 repo files when this landed, and measures 96 to 112 at this commit.
The widened gate exits 0 at each head, so none of the newly covered files had a type error waiting.
`tsconfig.base.json` gains `jsx: "preserve"` in the same change. It transforms nothing under
`noEmit`, and it is the value the port's Next.js config needs, so a `.tsx` file parses in the root
program and in `apps/web`'s configs alike.

## Two traps in the pattern list

**No brace expansion.** tsconfig `include` does not support it. A pattern written as
`packages/*/src/**/*.{ts,tsx}` matches nothing, and because the other patterns still match, the gate
exits 0 over a program that shrank. The first draft of this change had that bug and `bun run
typecheck` reported exit 0. Each extension therefore gets its own line. The census below is what
catches this class of mistake, since no exit code can: it compares the include against the nine
patterns it ships, pattern for pattern, and measures a real `.tsx` file in each `.tsx` family.

**Patterns decide the roots, imports decide the rest.** A file outside every pattern is still
checked when an included file imports it. `packages/pi-bridge/extension/tool-gate.ts` sits outside
`src` and `scripts` and is in the program because `packages/pi-bridge/src/gate.test.ts` imports it.
`spikes/web-stream/envelope.ts` was already in the pre-widening program, reached from
`packages/protocol/src/spike-compat.test.ts`, and `spikes/web-stream/map.ts` joins it at this head,
reached from `packages/protocol/scripts/spike-fixture.ts`. The gate's real coverage is the patterns
plus everything reachable from them, which is why the census diffs the program against the tree
instead of trusting the pattern list.

## What each project checks

| Surface | Project | Note |
| --- | --- | --- |
| every package `src` and `scripts`, every app `src` and `scripts`, `.ts` and `.tsx` | root `tsconfig.json` | the gate this unit widened |
| `packages/*/src` | `packages/*/tsconfig.json` | narrower than the root gate; a package's own config never covered its `scripts` |
| `apps/web/host`, `packages/ui/browser`, `packages/ui/src` | `apps/web/tsconfig.json` | DOM lib, and it excludes `*.test.ts` |
| `apps/web/scripts`, `packages/ui/src` | `apps/web/tsconfig.node.json` | no DOM lib |
| `spikes/*` | `spikes/*/tsconfig.json` | an unimported spike file is outside the root gate; an imported one is checked transitively |

The per-app configs stay the stricter gate for their own surface, and `apps/web`'s two run as a
preflight in `apps/web/scripts/capture.ts`.

## What the gate still does not reach

These eleven are the complete set of `.ts`/`.tsx` files under `packages/` and `apps/` that no
included root reaches. The probe derives that set from the tree and asserts it equals this list, so a
new unreached file fails the probe.

| File | Why | Checked by |
| --- | --- | --- |
| `apps/web/host/main.ts` | browser code, needs `lib: DOM`, which the root program does not carry | `apps/web/tsconfig.json` |
| `packages/ui/browser/render.ts` | same, the DOM surface of the shared thread model | `apps/web/tsconfig.json` |
| `packages/ui/browser/library.ts` | same, the DOM surface of the shared Library model (U4.1) | `apps/web/tsconfig.json` |
| `packages/ui/browser/provider.ts` | same, the DOM surface of page 1's provider model (U4.3) | `apps/web/tsconfig.json` |
| `packages/ui/browser/shell.ts` | same, the DOM surface of the Bot sidebar and thread list (U4.2) | `apps/web/tsconfig.json` |
| `packages/ui/browser/first-run.ts` | same, the DOM surface of the first-run screen (U6.2) | `apps/web/tsconfig.json` |
| `packages/ui/browser/aside.ts` | same, the DOM surface of the details pane (U6.3) | `apps/web/tsconfig.json` |
| `packages/ui/browser/notices.ts` | same, the DOM surface of the banner and notice stack (U6.3) | `apps/web/tsconfig.json` |
| `packages/ui/browser/icons.ts` | same, the sprite icons the pane and the notices draw (U6.3) | `apps/web/tsconfig.json` |
| `packages/sandbox/image/replay-ext.ts` | nothing imports it, and `image/` is not `src` or `scripts` | nothing |
| `packages/pi-bridge/extension/smoke-echo.ts` | nothing imports it (the smoke passes its path as a string) | nothing |

The nine DOM files stay out on purpose. Adding `lib: DOM` to the shared root program would let
control-plane and server code call `document` without a complaint, which is a worse trade than
leaving the browser surface to the app config that already owns it. U6.3's three arrived with a real
defect behind them: `notices.ts` called an unimported helper, and `bun run typecheck` was silent
because the whole host graph is out of the program. `apps/web/tsconfig.json` catches it, and the
driver caught it in the browser.

## The probe

```
bun packages/verify/scripts/type-gate.ts
```

It writes `packages/verify/artifacts/type-gate/<short-sha>/probe.txt` and exits non-zero on any
failed check. Per run it does all of this against the real gate, `bun run typecheck`. The artifact
for the blind-set change U4.1 made is `packages/verify/artifacts/type-gate/e7cb536/probe.txt`, and the
one U4.2 made, which adds `packages/ui/browser/shell.ts` to the list, is
`packages/verify/artifacts/type-gate/bdf5f12/probe.txt`, the one U4.3 makes, which adds
`packages/ui/browser/provider.ts`, is `packages/verify/artifacts/type-gate/d22c487/probe.txt`, the
one U6.2 makes, which adds `packages/ui/browser/first-run.ts`, is
`packages/verify/artifacts/type-gate/<short-sha>/probe.txt` for this branch's head, and the one U6.3
makes, which adds `packages/ui/browser/aside.ts`, `notices.ts` and `icons.ts`, is
`packages/verify/artifacts/type-gate/<short-sha>/probe.txt` for U6.3's head.

1. The clean tree passes.
2. A census compares the program against the tree. It asserts the root include is exactly the nine
   patterns above, measures a temporary `.tsx` file in each of the four `.tsx` families, asserts 12
   named files are in the program, that the program grew, and that the unreached set is exactly the
   eleven above.
3. Three deliberate errors, one per covered location, are placed in the tree together. The
   pre-widening include accepts all three and does not reach them.
4. Each error alone makes the root typecheck fail and names its file. The file is removed and the
   tree passes again.
5. Nothing is left behind.

The three locations are a `.tsx` under `apps/web`, a `.ts` under `apps/web/scripts`, and a package
script, which are the three blind spots the U1.5 review measured.

## Limits

- No `.tsx` file exists in the repo yet. `.tsx` coverage is proven by four temporary files the probe
  writes, one per `.tsx` pattern family, which shows each pattern matches. It does not show that a
  real component typechecks, so the first component the port adds is the first true exercise of that.
- `jsx: "preserve"` parses JSX but does not type it. JSX element typing needs the React types, which
  arrive with the port. Today a `.tsx` file containing JSX would fail the root gate for that reason.
- The probe mutates the tree for a few seconds per case and restores it. It asserts afterwards that
  its own paths are clean.
- The pre-widening include is a literal in the probe, so the contrast stays rerunnable after the
  config moves on. It is a copy of the measured history, not a build input.

## Follow-ups

1. `packages/sandbox/image/replay-ext.ts` has four implicit-any parameters that `strict` refuses,
   and no project reaches it. Either give it an include line and fix those four, or record why it
   stays out.
2. `packages/pi-bridge/extension/smoke-echo.ts` is clean and unreached. Adding
   `packages/*/extension/**/*.ts` covers it and its sibling. The probe's blind-set check fails when
   that lands, by design, and names this doc.
3. The probe is a manual run. `bun run verify` already covers the widened set, since its typecheck
   step is the same root command, but only the probe notices a narrowed include. Wiring it into
   `packages/verify/run.ts` would put that guard in CI.
4. The framework port adds real `.tsx` components under the widened gate. A component under
   `apps/*/src` is checked by the root gate as soon as React types are installed. A component under
   `apps/web/host` or a Next.js `app/` directory needs the DOM-aware project, so the port either
   lands components under `apps/web/src` or extends the include with a DOM-aware project of its own.
5. `packages/verify/run.ts` runs the root typecheck only, so `apps/web/host` and
   `packages/ui/browser` are gated only when a human drives `apps/web/scripts/capture.ts`, whose
   preflight runs the app's own configs. Add a step to `packages/verify/run.ts` that shell-calls the
   app's typecheck, so the DOM surface is covered by CI and not only by a capture run.
