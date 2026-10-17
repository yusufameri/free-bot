# The root type gate

Status: PASS. 33/33 probe checks green at commit `28d8de0`, driven by
`bun packages/verify/scripts/type-gate.ts`, with the transcript under
`packages/verify/artifacts/type-gate/28d8de0/probe.txt`. Verdict: type-check-only.

`bun run typecheck` is the cheap gate every unit, every PR and CI runs. Until this unit it was blind
to 14 source files and to every `.tsx` file in the repo. It now covers each workspace's `src` and
`scripts` directories in both extensions. This closes follow-up 1 of `docs/web-shell.md`, which
parked the React and Next.js port on exactly this change.

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

The program goes from 82 to 97 repo files. The widened gate exits 0, so none of the 14 newly covered
files had a type error waiting. `tsconfig.base.json` gains `jsx: "preserve"` in the same change. It
transforms nothing under `noEmit`, and it is the value the port's Next.js config needs, so a `.tsx`
file parses in the root program and in `apps/web`'s configs alike.

## Two traps in the pattern list

**No brace expansion.** tsconfig `include` does not support it. A pattern written as
`packages/*/src/**/*.{ts,tsx}` matches nothing, and because the other patterns still match, the gate
exits 0 over a program that shrank. The first draft of this change had that bug and `bun run
typecheck` reported exit 0. Each extension therefore gets its own line. The census below is what
catches this class of mistake, since no exit code can.

**Patterns decide the roots, imports decide the rest.** A file outside every pattern is still
checked when an included file imports it. `packages/pi-bridge/extension/tool-gate.ts` sits outside
`src` and `scripts` and is in the program because `packages/pi-bridge/src/gate.test.ts` imports it.
The gate's real coverage is the patterns plus everything reachable from them, which is why the
census diffs the program against the tree instead of trusting the pattern list.

## What each project checks

| Surface | Project | Note |
| --- | --- | --- |
| every package `src` and `scripts`, every app `src` and `scripts`, `.ts` and `.tsx` | root `tsconfig.json` | the gate this unit widened |
| `packages/*/src` | `packages/*/tsconfig.json` | narrower than the root gate; a package's own config never covered its `scripts` |
| `apps/web/host`, `packages/ui/browser`, `packages/ui/src` | `apps/web/tsconfig.json` | DOM lib, and it excludes `*.test.ts` |
| `apps/web/scripts`, `packages/ui/src` | `apps/web/tsconfig.node.json` | no DOM lib |
| `spikes/*` | `spikes/*/tsconfig.json` | outside the root gate by design |

The per-app configs stay the stricter gate for their own surface, and `apps/web`'s two run as a
preflight in `apps/web/scripts/capture.ts`.

## What the gate still does not reach

These four are the complete set of `.ts`/`.tsx` files under `packages/` and `apps/` that no included
root reaches. The probe derives that set from the tree and asserts it equals this list, so a new
unreached file fails the probe.

| File | Why | Checked by |
| --- | --- | --- |
| `apps/web/host/main.ts` | browser code, needs `lib: DOM`, which the root program does not carry | `apps/web/tsconfig.json` |
| `packages/ui/browser/render.ts` | same, the DOM surface of the shared thread model | `apps/web/tsconfig.json` |
| `packages/sandbox/image/replay-ext.ts` | nothing imports it, and `image/` is not `src` or `scripts` | nothing |
| `packages/pi-bridge/extension/smoke-echo.ts` | nothing imports it (the smoke passes its path as a string) | nothing |

The two DOM files stay out on purpose. Adding `lib: DOM` to the shared root program would let
control-plane and server code call `document` without a complaint, which is a worse trade than
leaving the browser surface to the app config that already owns it.

## The probe

```
bun packages/verify/scripts/type-gate.ts
```

It writes `packages/verify/artifacts/type-gate/<short-sha>/probe.txt` and exits non-zero on any
failed check. Per run it does all of this against the real gate, `bun run typecheck`.

1. The clean tree passes.
2. A census compares the program against the tree. It asserts 12 named files are in the program,
   that the program grew, and that the unreached set is exactly the four above.
3. Three deliberate errors, one per covered location, are placed in the tree together. The
   pre-widening include accepts all three and does not reach them.
4. Each error alone makes the root typecheck fail and names its file. The file is removed and the
   tree passes again.
5. Nothing is left behind.

The three locations are a `.tsx` under `apps/web`, a `.ts` under `apps/web/scripts`, and a package
script, which are the three blind spots the U1.5 review measured.

## Limits

- No `.tsx` file exists in the repo yet. `.tsx` coverage is proven by the probe's own file, not by a
  real component, so the first component the port adds is the first true exercise of it.
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
