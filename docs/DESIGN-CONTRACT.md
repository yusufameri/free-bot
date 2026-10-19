# The design contract

Order 32 makes the exported prototype the visual contract. It governs visuals, geometry, tokens,
motion and the responsive matrix, and where it conflicts with `UX.md` on a visual question the export
wins. This document records what the export says, which of its two files governs which surface, and
every place the app still differs from it.

The contract is enforced in three places, and a claim here that none of them checks is a claim this
document should not make.

- `packages/ui/src/tokens.ts` is the only place a token value is written, and
  `packages/ui/src/tokens.test.ts` asserts each value against a literal.
- `bun packages/ui/scripts/emit-tokens.ts --check` (and the same comparison inside
  `tokens.test.ts`) fails when `apps/web/host/index.html` or this document drifts from that table.
- `packages/verify/scripts/design-contract.ts` opens the app and `freebot-prototype.html` in the same
  headless browser at each of the nine viewports, measures both, and prints a delta per field. Its
  transcript is the evidence artifact named in `docs/VERIFICATION.md`.

## The export's four files

Committed byte-identical at `design/prototype-84c6b185/`, with the checksums in that directory's
README. They are a frozen artifact. Nothing reads them at runtime, and `biome.json` excludes the
directory so the formatter and the linter leave them alone.

| File | Role |
| --- | --- |
| `DESIGN-HANDOFF.md` | The export tool's prose handoff. Names `freebot-prototype-v1.html` as the entry file. |
| `DESIGN-MANIFEST.json` | The machine-readable map: screens, token names, interaction states, and the nine `responsiveViewports`. |
| `freebot-prototype-v1.html` | 72 KB. The handoff's declared entry. One media query, at 980px. The older token set. |
| `freebot-prototype.html` | 214 KB. Two media queries, at 1120px and 860px. The token set plan Part 10 enumerates. |

### Which file governs which surface

| Surface | Governing file | Why |
| --- | --- | --- |
| Tokens | `freebot-prototype.html` | Its `:root` carries the set plan Part 10 and this unit's acceptance name: `--sb-w: 264px`, `--aside-w: 384px`, the `--fs-h1` .. `--fs-meta` scale, the four `color-mix` fills, `--accent-2` as the selection wash. The v1 file carries an older set instead: `268px`/`360px`, `--fs-xs`..`--fs-lg`, no derived fills. |
| Shell geometry | `freebot-prototype.html` | Its `.app` is the three-column grid this unit builds, with a 5px resizer track between the thread column and the aside. The v1 file's `.app` has no resizer track. |
| Breakpoints | `freebot-prototype.html` | 1120px and 860px, two thresholds that separate "no aside" from "no sidebar". |
| Motion | `freebot-prototype.html` | The fuller set of durations. The v1 file uses two of them. |
| The nine-viewport matrix | `DESIGN-MANIFEST.json` | `responsiveViewports` names the nine widths and heights, each with `mustAvoidHorizontalScroll: true`. |
| The two screens (`welcome-provider`, `first-run`) | Neither, yet | Both files carry them; U6.2 builds page 2 and U4.3 already built page 1. Their structure is the same in both files. |
| A 980px single-collapse | `freebot-prototype-v1.html` | Only the v1 file has it. Recorded below as superseded, not implemented. |

### The reconciliation

The handoff declares `freebot-prototype-v1.html` as its entry file and names only that one in its
`Source map`. The manifest repeats it as `entryFile` while listing both files under
`sourceFiles.all`. Read against the two files, that declaration is the tool's first-listed file
rather than the newer one:

- `freebot-prototype.html` carries tokens the v1 file does not have at all (the four `color-mix`
  fills, `--accent-2`, the fluid `--fs-h1` scale) and a shell geometry the v1 file does not have (the
  resizer track). Plan Part 10 §10.1 enumerates the fuller set as the export's, and this unit's
  acceptance names 264px and 384px, which only the fuller file writes.
- Both files name the same two screens, `welcome-provider` and `app`, so the screen-level
  disagreement is nil. Where they disagree, it is always the fuller file that carries more.

So the fuller file governs every visual question, and the handoff's entry line is recorded here as a
declaration about which file to open first, not about which file is newer. A reader who starts from
the v1 file as instructed will find an older token set and must not implement it.

**The 980px breakpoint is not implemented.** The v1 file's single
`@media (max-width:980px)` collapses both the sidebar and the aside at once. The fuller file replaces
it with two thresholds, and at 861px to 980px the two files want opposite things. The fuller file
keeps the sidebar and hides only the aside, and the v1 file hides both. Implementing the 980px collapse
would hide the Bot list across a 120px band where the governing file keeps it. Recorded rather than
approximated, per plan §10.3.

## The tokens

Extracted from `freebot-prototype.html`'s `:root` block. `origin` marks which values the export
writes as tokens and which are names this repo gives to values the export writes literally inside a
rule. The table below is generated from `packages/ui/src/tokens.ts`; the `Source` column is the
export and line each value was read from.

<!-- tokens:begin. Generated from packages/ui/src/tokens.ts by `bun packages/ui/scripts/emit-tokens.ts --write`. -->
| Token | Value | Source |
| --- | --- | --- |
| `--bg` | `#000000` | `freebot-prototype.html:12` |
| `--surface` | `#0a0a0a` | `freebot-prototype.html:13` |
| `--fg` | `#ffffff` | `freebot-prototype.html:14` |
| `--muted` | `#737373` | `freebot-prototype.html:15` |
| `--border` | `#242424` | `freebot-prototype.html:16` |
| `--accent` | `#000000` | `freebot-prototype.html:17` |
| `--accent-2` | `#0f172a` | `freebot-prototype.html:18` |
| `--hover` | `color-mix(in oklch, var(--fg) 7%, transparent)` | `freebot-prototype.html:21` |
| `--hover-2` | `color-mix(in oklch, var(--fg) 12%, transparent)` | `freebot-prototype.html:22` |
| `--fg-soft` | `color-mix(in oklch, var(--fg) 5%, transparent)` | `freebot-prototype.html:23` |
| `--muted-2` | `color-mix(in oklch, var(--muted) 45%, transparent)` | `freebot-prototype.html:24` |
| `--font-display` | `'Geist', 'Geist Sans', system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif` | `freebot-prototype.html:26` |
| `--font-body` | `'Geist', 'Geist Sans', system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif` | `freebot-prototype.html:27` |
| `--font-mono` | `ui-monospace, 'Geist Mono', 'SF Mono', Menlo, Consolas, monospace` | `freebot-prototype.html:28` |
| `--fs-h1` | `clamp(30px, 4.4vw, 46px)` | `freebot-prototype.html:30` |
| `--fs-h2` | `24px` | `freebot-prototype.html:31` |
| `--fs-h3` | `17px` | `freebot-prototype.html:32` |
| `--fs-body` | `15px` | `freebot-prototype.html:33` |
| `--fs-meta` | `12.5px` | `freebot-prototype.html:34` |
| `--radius` | `8px` | `freebot-prototype.html:36` |
| `--aside-w` | `384px` | `freebot-prototype.html:37` |
| `--sb-w` | `264px` | `freebot-prototype.html:38` |
| `--dur-fast` | `0.12s` | `freebot-prototype.html:230 .sb-row { transition: background 0.12s ease }` |
| `--dur` | `0.15s` | `freebot-prototype.html:120 .btn { transition: background 0.15s ease, ... }` |
| `--dur-slow` | `0.18s` | `freebot-prototype.html:332 .disc .chev { transition: transform 0.18s ease }` |
| `--dur-enter` | `0.25s` | `freebot-prototype.html:201 .flowline { animation: slide 0.25s ease }` |
| `--dur-pulse` | `1.5s` | `freebot-prototype.html:110 .pulse { animation: pulse 1.5s ease-in-out infinite }` |
| `--dur-spin` | `1s` | `freebot-prototype.html:112 .spin { animation: spin 1s linear infinite }` |
| `--ease` | `ease` | `freebot-prototype.html:120 the easing keyword every transition writes` |
<!-- tokens:end -->

The seven `derived` rows are the motion timings, because the export declares no motion custom
properties of its own. Its durations are read off the rules that use them. `design-contract.ts` compares the `export` rows
against the export by name, and the motion by effect rather than by name, on a paired element's
computed `transition-duration`.

## The shell's geometry

The export's `.app` is
`grid-template-columns: var(--sb-w) minmax(0, 1fr) 5px var(--aside-w)` on a `100vh` grid. The app's
`.shell[data-operator="true"]` is the same declaration with the same tokens. Measured by
`design-contract.ts` at each of the nine viewports, in `assert.txt` beside the PNGs.

| Region | App | Export |
| --- | --- | --- |
| Sidebar | `#sidebar` | `.sidebar` |
| Thread column | `#center` | `.main` |
| Resizer track | `#resizer` | `.resizer` |
| Details aside | `#aside` | `.aside` |

The app's aside is a frame and nothing else. Its tabs, its body, and the resizer's drag behavior with
a persisted width are U6.3's; this unit ships the 384px region, its `border-left`, and the 5px track,
so that U6.3 has the geometry to fill. The empty state is visible at the three viewports where the
export shows the aside, and it is recorded here rather than dressed up. Nothing in this frame
pretends to be the details panel.

Three things the harness asserts rather than assumes, per viewport:

- Every visible region's left edge is where the grid template puts it, in the order sidebar, thread
  column, resizer track, aside. A region that rendered somewhere else fails even if its width is
  right.
- Every token name the export declares is read from both pages twice, once from the `:root` rule
  and once from `documentElement`. The first read is what the page declares and the second is what it
  uses. The declared values are the contract; the used values are compared as well, because that is
  where an inline override would show up. One name, `--aside-w`, is declared differently by the export and is listed
  below.
- No region's content is wider than the region. The document pair the matrix asks for is reported
  per viewport, and because this frame's `body` carries the export's `overflow: hidden`, that pair is
  trivially equal on any page that cannot scroll; the region pairs are what actually catch a
  horizontal overflow, and they are reported for `#center`, `#sidebar`, `#aside`, `#resizer`,
  `#thread`, `#library`, `#tabs`, `#operator`, `header` and `.meta`.

The harness earned its keep on its first green-candidate run. It found the sidebar 45px wider than
itself at every viewport above 860px. The footer's row carries a model id and a status
(`providerRowLabel`), and a realistic id such as `deepseek/deepseek-v4.1-flash` is longer than the
246px the row has, so a `white-space: nowrap` label pushed the sidebar's scroll width to 308px. The
fix is the export's own treatment for a long row label, the ellipsis on `.sb-row .name` at
`freebot-prototype.html:234`, applied to `#provider-open`. Before that fix the run reported
`#sidebar scrollWidth 308 > clientWidth 263` at each of the four viewports wide enough to show the
sidebar; after it, the pair is equal at all nine.

## The breakpoints

| Threshold | Governing file and line | Effect |
| --- | --- | --- |
| 1120px | `freebot-prototype.html:540` | The aside and the resizer track leave the grid; the sidebar and the thread column remain. |
| 860px | `freebot-prototype.html:549` | The grid becomes one column and the sidebar leaves it. |
| 980px | `freebot-prototype-v1.html:248` | Superseded. Not implemented, per the reconciliation above. |

Both governing media queries also carry drawer behavior for the hidden region (`.aside.open`,
`.sidebar.open`, and a `.mob-only` trigger). This frame does not have the drawers. At 1120px and
below the aside is unreachable, and at 860px and below the Bot list is unreachable, because there is
no trigger for either. That is a real gap in the app rather than a difference in rendering, so it is
named here and in the delta list below.

## The responsive matrix

The nine viewports from `DESIGN-MANIFEST.json`, each with `mustAvoidHorizontalScroll: true`. Every
one of them is captured and asserted by `design-contract.ts`, one PNG each, at the manifest's exact
width and height.

| Name | Width | Height | Category | Sidebar | Resizer | Aside |
| --- | --- | --- | --- | --- | --- | --- |
| mobile-compact | 360 | 800 | mobile | hidden | hidden | hidden |
| mobile-standard | 390 | 844 | mobile | hidden | hidden | hidden |
| mobile-large | 430 | 932 | mobile | hidden | hidden | hidden |
| foldable-small-tablet | 600 | 960 | foldable-tablet | hidden | hidden | hidden |
| tablet-portrait | 820 | 1180 | tablet | hidden | hidden | hidden |
| tablet-landscape | 1024 | 768 | tablet | shown, 264px | hidden | hidden |
| laptop | 1366 | 768 | desktop | shown, 264px | shown, 5px | shown |
| desktop | 1440 | 900 | desktop | shown, 264px | shown, 5px | shown |
| wide | 1920 | 1080 | wide | shown, 264px | shown, 5px | shown |

The last three columns are what the two breakpoints produce, and they are what the harness asserts
per viewport rather than a table anyone maintains by hand. Each viewport's row in `assert.txt` is
the measured width, the export's width at the same viewport, and the delta between them.

## The evidence artifact

`packages/verify/artifacts/design-contract/<short-sha>/` holds `assert.txt` and one PNG per viewport
at the manifest's exact width, plus the export's own shot of the same viewport under `reference/` so
a reviewer can compare the two without running anything. `assert.txt` carries the nine rows with
their per-field deltas, the two token assertions per row, the nine document overflow pairs, the ten
region overflow pairs per viewport, the token table with its source lines, and the pixel share with
its reason.

Run it yourself from the repo root: `bun packages/verify/scripts/design-contract.ts`. It boots the
app with `bun run up --no-open --replay` over a temporary home and bots root of its own, so it
touches no Bot, no run and no provider, and it needs no Docker and no key. The one thing it writes
outside its artifact directory is that temporary directory, which it deletes on the way out.

## Follow-ups this unit leaves

- Six drivers still carry their own copy of the CDP client this unit extracted into
  `packages/verify/src/cdp.ts`: `packages/verify/scripts/{launch,keyed-run,files-surface,type-gate}.ts`
  and `apps/web/scripts/{capture,one-run-path}.ts`. Their copies are untouched on purpose, so this
  diff stays reviewable; moving them onto the shared module is a follow-up, not a rewrite smuggled
  in with a visual change.
- ~~No route serves a font file, so Geist cannot be vendored without one.~~ U6.7 added the route at
  `apps/server/src/api-server.ts` and committed the face and its licence under
  `apps/web/host/fonts/`; both pages now measure it.

## Surfaces the export has and the app does not yet

| Export surface | Owner |
| --- | --- |
| The strip's `Memory`, `Routines` and `Media` tabs and their bodies | no unit yet. `Memory` and `Routines` are Phase 3 (`UX.md:198`, `:200-214`) and no record in this app carries either; `Media`'s subject is a screen capture and this app captures no screen. U6.3 ships the other four. |
| The mobile drawers (`.aside.open` at 1120px, `.sidebar.open` and `.mob-only` at 860px) | no unit yet. U6.3 declares the delta; below 1120px this app has no way to reach the pane at all. |
| The right-click menus (`.menu` at `:452-470`) and the composer's own popover (`.pop` at `:466`) | no unit yet. U6.4 ships the palette, the picker and the modal; these two are the export's other overlays, and both hang off surfaces that belong to other units (the Bot row's menu off U6.5's rows, the composer's off the composer U6.5 and U6.6 touch). |
| The approval card, the tool call, the turn marker, the Bot status dot and Bot groups | U6.5 |
| The landing page | U6.6 |
| The item-level states inside every one of the above | U6.7 owns the pass that audits them |

## The pane's width, settled

The frame before this one declared `--aside-w: 384px` and rendered 384, twelve pixels wider than the
export, and carried the difference as a declared delta. U6.3 renders the export's own number. The
token stays 384px, because the export's stylesheet declares it there (`freebot-prototype.html:37`),
and the page writes 372px at boot, because the export's own script does: `:2248` runs
`setProperty('--aside-w', (S.asideW || 372) + 'px')`, over the seed `asideW: 372` at `:829`. The
app's write is `packages/ui/browser/aside.ts`'s; 372 is the width the export gives a fresh profile.
The user's drag then moves it, clamped to 280 through 560 at `:2252`, and `localStorage` under
`freebot.aside` holds the width, the tab and the collapsed state, so a reload restores all three.

The measurement is in `design-contract`'s `assert.txt`, per viewport: at 1366 the aside is 372px on
both pages and the thread column is 725px on both; at 1440 it is 372px and 799px; at 1920 it is 372px
and 1279px; below 1120 both pages stand the pane down and both measure 0. Delta 0 on every geometry
row. `DECLARED_DELTAS` in `packages/verify/scripts/design-contract.ts` is empty and prints `none`
where it used to list the entry, and the `--aside-w` token note now explains a write both pages make
rather than a difference between them. A nonzero delta here means one side's boot write or drag
default moved.

## The pixel gate's declared deltas (U6.7)

Order 36 makes the fidelity pass a hard pixel gate. `packages/pixel-gate/src/cli.ts --repeat` renders
the app and the export in one browser instance, at the same viewport, in the same run, and prints a
literal chrome statistic and a box delta per region. Chrome tolerance is zero and every nonzero
chrome pixel fails the run. The entries below are the content-region deltas that remain, with the
pixels that differ and the reason each stands. `packages/pixel-gate/src/deltas.ts` is the
machine-readable copy; `DECLARED_DELTAS` in `packages/verify/scripts/design-contract.ts` re-exports
it, and a test compares this block to that module character for character after parsing, so neither
can drift.

The five box deltas the U6.7a baseline named closed as follows. The middle column's order is the
export's: the transcript is the composer's `flex: 1` sibling, starts on the header's bottom edge and
ends on the composer's top edge, and the composer is the column's last child, pinned to the bottom.
The export's header is 55.8px and this page's is 56px (a 0.2px delta inside the half-pixel box
tolerance). The sidebar list's 2px start delta closed by adopting the export's 10px head padding and
its 2px list inset. What remains is the app's shorter composer and its shorter sidebar foot, both
recorded below.

<!-- pixel-gate-deltas:begin -->
```json
[
  {
    "field": "pixel-gate content.sidebar-list",
    "allow": [
      78
    ],
    "reason": "The app's list ends 78px lower than the export's. The export's foot is 125px: Connect apps, the model row and the account row. This app's foot is 47px: the one provider row. The account and the apps surface have no record in this build, so the list takes the space they would occupy; the head's own 2px start delta was closed by adopting the export's 10px head padding and 2px list inset.",
    "pixels": {
      "tablet-landscape": {
        "left": 0,
        "top": 0,
        "width": 0,
        "height": 78
      },
      "laptop": {
        "left": 0,
        "top": 0,
        "width": 0,
        "height": 78
      },
      "desktop": {
        "left": 0,
        "top": 0,
        "width": 0,
        "height": 78
      },
      "wide": {
        "left": 0,
        "top": 0,
        "width": 0,
        "height": 78
      }
    }
  },
  {
    "field": "pixel-gate content.sidebar-bot-row",
    "allow": [
      32.25
    ],
    "reason": "The app's first Bot row starts 32.25px higher. The export groups its rows under Pinned, Primary and Unassigned labels (freebot-prototype.html:984-993) and this app renders one Bots heading, because the Bot record holds no group, pinned or primary field; the row's own 34px height and 9px gap are the export's.",
    "pixels": {
      "tablet-landscape": {
        "left": 0,
        "top": -32.25,
        "width": 0,
        "height": 0
      },
      "laptop": {
        "left": 0,
        "top": -32.25,
        "width": 0,
        "height": 0
      },
      "desktop": {
        "left": 0,
        "top": -32.25,
        "width": 0,
        "height": 0
      },
      "wide": {
        "left": 0,
        "top": -32.25,
        "width": 0,
        "height": 0
      }
    }
  },
  {
    "field": "pixel-gate content.center-transcript",
    "allow": [
      0.2,
      70.3,
      52.49,
      56.49
    ],
    "reason": "Both transcripts start on the header's bottom edge (the 0.2px top is the export's 55.8px header against this page's 56px) and end on the composer's top edge. This app's transcript is taller by the amount its composer is shorter, because the export's composer carries a growing textarea, a five-control tools row and a hint row while this app's carries one input, two buttons and the live stream line. The `flex: 1` transcript and the bottom-pinned composer are the export's own order.",
    "pixels": {
      "mobile-compact": {
        "left": 0,
        "top": 0.2,
        "width": 0,
        "height": 70.3
      },
      "mobile-standard": {
        "left": 0,
        "top": 0.2,
        "width": 0,
        "height": 70.3
      },
      "mobile-large": {
        "left": 0,
        "top": 0.2,
        "width": 0,
        "height": 52.49
      },
      "foldable-small-tablet": {
        "left": 0,
        "top": 0.2,
        "width": 0,
        "height": 52.49
      },
      "tablet-portrait": {
        "left": 0,
        "top": 0.2,
        "width": 0,
        "height": 52.49
      },
      "tablet-landscape": {
        "left": 0,
        "top": 0.2,
        "width": 0,
        "height": 56.49
      },
      "laptop": {
        "left": 0,
        "top": 0.2,
        "width": 0,
        "height": 56.49
      },
      "desktop": {
        "left": 0,
        "top": 0.2,
        "width": 0,
        "height": 56.49
      },
      "wide": {
        "left": 0,
        "top": 0.2,
        "width": 0,
        "height": 56.49
      }
    }
  },
  {
    "field": "pixel-gate content.center-composer",
    "allow": [
      70.5,
      52.69,
      56.69,
      52.68,
      56.68
    ],
    "reason": "The composer band is pinned to the bottom edge on both pages, so the app's top edge sits lower and its height is smaller by the same amount. The export's band is 146.06px at 1920 and 159.88px at 360; this app's is 89.38px at 1920 and 89.38px at 360, because the product's composer is one input, a Start and a Stop control and the stream's own meta line against the export's textarea, five tool controls and hint. Control count and copy are named in `docs/DESIGN-CONTRACT.md`; the bottom edge is identical.",
    "pixels": {
      "mobile-compact": {
        "left": 0,
        "top": 70.5,
        "width": 0,
        "height": -70.5
      },
      "mobile-standard": {
        "left": 0,
        "top": 70.5,
        "width": 0,
        "height": -70.5
      },
      "mobile-large": {
        "left": 0,
        "top": 52.69,
        "width": 0,
        "height": -52.68
      },
      "foldable-small-tablet": {
        "left": 0,
        "top": 52.69,
        "width": 0,
        "height": -52.68
      },
      "tablet-portrait": {
        "left": 0,
        "top": 52.69,
        "width": 0,
        "height": -52.68
      },
      "tablet-landscape": {
        "left": 0,
        "top": 56.69,
        "width": 0,
        "height": -56.68
      },
      "laptop": {
        "left": 0,
        "top": 56.69,
        "width": 0,
        "height": -56.68
      },
      "desktop": {
        "left": 0,
        "top": 56.69,
        "width": 0,
        "height": -56.68
      },
      "wide": {
        "left": 0,
        "top": 56.69,
        "width": 0,
        "height": -56.68
      }
    }
  }
]
```
<!-- pixel-gate-deltas:end -->

Each `pixels` object is the app-minus-export delta at that viewport, the same sign the gate prints.
A region not in the list must agree with the export's box to within half a pixel; a new delta is a
failure until it is either fixed or written here. The numeric box deltas are `docs/pixel-gate.md`'s
subject and are reproduced with the artifact's own rows there.

## Deltas this frame cannot close

**The strip carries four of the export's seven tabs.** `freebot-prototype.html:1183` lists `computer`,
`details`, `memory`, `routines`, `tasks`, `library`, `media`, and `UX.md:33` names five of them,
calling the split FreeBot's own. This frame ships `computer`, `details`, `tasks` and `library`, which
is `UX.md:33`'s list minus `Media`. `Media`'s subject is a screen capture, and this app captures no
screen: a run produces a filesystem and a transcript, not frames, so the tab's body could only be an
empty state for a feature no record can fill. The export's other two, `Memory` and `Routines`, are
Phase 3 (`UX.md:198` for memory, `:200-214` for routines) and no record in this app carries either.
The ids, the order, the roles (`role="tablist"`, one `role="tab"` per tab with `aria-selected`), the
`is-active` class and the strip's own `Collapse the pane` button (`:1187-1188`) are the export's.

**The header's control is one stable button; the export's are three that come and go.** The export
opens details from the Bot's own name (`:1035`), from a `Details` button that is present only while
the pane is collapsed (`:1040`), and from a mobile-only icon (`:1041`); the pane's own strip closes
it. This frame ships one labelled control, `Details`, at every width that carries the pane: it
collapses and expands, keeps its text in both states, and carries `aria-pressed` plus an aria-label
naming which direction the next press goes. A frame with no drawer and no Bot-name button needs one
place that does both directions.

**Below 1120px the pane and its control are both gone, and the export answers with a drawer.** The
export's `.aside.open` with its `.mob-only` details icon is how a narrow screen reaches the pane, and
`.sidebar.open` with `Open the Bot list` does the same for the sidebar below 860px (`:540-551`).
This frame ships neither drawer and hides the header's control with the pane, because a control that
cannot show anything is worse than no control. A narrow screen therefore has no way to the pane at
all, which is the largest surface this unit leaves open and which no unit in this plan owns yet.

**The Details tab reports the record; the export's edits the Bot.** The export's `tabDetails`
(`:1229-1277`) is a profile editor: name and label inputs bound to the Bot's record, an avatar with
three controls, a notifications switch, the soul text with its version, diff and save, a model
override, a tool allowlist, a Runtime block whose Memory row counts memory rows, and
`Rename Bot`/`Duplicate`/`Delete`. This app's Bot is a name, a role, a purpose, a creation time and a
thread count (`packages/protocol/src/dto.ts`), and it has no soul, no avatar and no memory, so this
tab reports those five fields, the current thread's title, runs and creation time, and the model
connection's model, status, last test and endpoint. Every row is read-only here: the record is
written where it is asked for, and an in-place editor belongs to the unit that owns the Bot's own
settings, which is not a T6 unit.

**The Computer tab reports the run's computer; the export's reports the Bot's.** The export's
`tabComputer` (`:1199-1226`) paints a mock desktop, `Full screen`/`Take control`/`Skip the step`/
`Teach a task`, a Lifecycle block (`Idle auto-stop`, `Egress`, `Snapshot`, `Isolation`) and a
Recovery block (`Retry`, `Recover computer`, `Update computer`, `Reset computer`), all of them a
per-Bot container's controls. This app's sandbox is per-run: a container is created for a run and
removed when the run ends, so none of those controls has a subject, and the delta is stated on the
tab itself rather than papered over. What the tab reports instead is what the page really holds — the
live run's id, status and start, the stream's connection, frame count and last sequence, and the last
command the run made with its decision and output. `Teach a task` is absent for the same reason the
tab cannot render it: no record of a taught task exists.

**The Tasks tab reports a run and does not stop one.** The export's `Current run` card carries
`Stop now` (`:1345`), a `Steps 3 of 5` row and a `Blocked on` row (`:1342-1344`). This app's card
shows the live run's id, its status and when it started, and the thread's recent runs read from the
run store. `Stop now` is left off — `cancel_run` exists in the contract
(`packages/protocol/src/dto.ts`) and in `apps/server/src/router.ts`, so this is a missing control
rather than a missing source, and it belongs with whatever unit owns the controls the run itself
carries. `Steps` and `Blocked on` are absent because the thread model holds no step counter and the
parked approval is the card on the conversation, which is U6.5's surface.

**The Library tab lists the same workspace, and its rows open rather than download.** The export's
`tabLibrary` (`:1354-1372`) carries `Files · page 11`, `Download all`, and a per-row `Download` and
`Copy the path`. This frame renders the Library surface's own listing — the same `groupEntries`
grouping, the same pinned `/workspace` row, name, path and size per file — and a row opens the file
in the Library's own view, because this app reads a workspace and has no download route. The result
is one listing with two views rather than two reads that can disagree.

**The notices are bound to real signals, and the export's are seeded.** The export seeds two
(`:870-871`: Atlas waiting on an approval, and a run at 82% of a monthly cap) and offers
`Set credit limit` and `Raise the cap` on the second (`:1049`). This app raises a notice from the
provider connection's own outcome — `untested`, `limited`, or a refusal, over page 1's own headline
and refusal sentence — and from a run the thread's store reports as failed. It has no credit cap to
raise, and a parked approval is the conversation's own card rather than a notice. `Open` leads to
page 1's provider surface; `Dismiss` and `Dismiss all` are the export's controls, and the dismissals
persist in `localStorage` under `freebot.notices.dismissed`, which the export's in-memory state does
not do.

**Geist is vendored and resolves on both pages.** The three stacks name `'Geist'` first, exactly as
the export's do, and the face now travels with the app: one variable woff2 at
`apps/web/host/fonts/geist-var.woff2` (SIL OFL 1.1, `OFL.txt` beside it), served by
`apps/server/src/api-server.ts` at `/fonts/geist-var.woff2` and answered by the export's own run
server at the same path. The app's page declares the `@font-face`; the pixel gate injects the same
declaration into the frozen export before capture, because the export is a frozen artifact whose
stylesheet only names the family. The harness measures rather than asks, because
`document.fonts.check('16px Geist')` answers `true` on a machine with no Geist at all: at this head a
Geist-family string measures 243.62px against the absent family's 215.98px on the app, and the export
measures the same pair, so both pages use the vendored face rather than the stack's fallback. The
run waits on `document.fonts.ready` before its first probe, so a capture cannot hold the fallback
while the face is still in flight. The pixel gate's artifact prints the literal pair.

**The provider row's label is cut rather than allowed to widen the sidebar.** Recorded in the
geometry section above as the one overflow this unit's own harness found.

**A whole-page pixel difference is not this frame's pass condition, and the harness says so.** The
export renders prototype data (Bots named Atlas, Scout, Patch, Quill, a launch room, threads that
were never run) while the app renders real records and an empty conversation. Two pages whose
content differs render different pixels whatever their styling, so `design-contract.ts` reports the
differing-pixel share as information with that reason attached, and asserts geometry and computed
styles instead. A number that cannot be attributed to a cause is not a pass, and this frame does not
present one. The share runs from 59.43% at 360x800 down to 29.41% at 1920x1080, which follows
the same content story rather than a styling one. On the narrow viewports the export paints a
populated conversation across the whole width while the app paints one line of metadata, and the
wider the viewport the larger the share of the frame that is chrome both pages agree on. The literal
per-viewport numbers, and the export's own shot of each viewport under `reference/`, are in the
evidence artifact above.

**`color-scheme: dark` is an addition.** It is not in the export's token block. It is here so the
page's own controls and scrollbars are dark; the export instead styles `::-webkit-scrollbar` and has
no `color-scheme` of its own. Both are present in the app.

**The reconnect banner and the error box have no export colour to match.** The export's palette is
monochrome, and it has no error token and no warning token. The app's `#resume` uses the soft wash
the export uses for a notice (`.gate-head`, `--fg-soft`) and `#error` uses the strongest line in the
system (`--fg`), because a monochrome system distinguishes by line weight and wash rather than by
hue. U6.5 owns the item-level treatment; this maps the values onto tokens without inventing a colour
the export does not have.

## The overlays (U6.4)

The command palette, the Bot picker and the modal, built once each. `docs/overlays.md` carries what
they search, how they behave and where their entry points are; this section carries the visual
sources, the measured geometry, and every place they differ from the export.

**The sources.** `.scrim` and `.modal` are the export's (`freebot-prototype.html:441-450`),
`.modal.wide` is its own variant (`:448`), `.picker` and `.palette` are `:478-493` including the
`.pop-item` row (`:472-477`), the `mark` a matched term wears (`:493`), and the sidebar head's search
control with its `.kbd` hint (`:213-220`, `:381-384`). Class names are the export's own. Two of its
names are not carried: `hidden` (a panel is attached and detached instead of toggled, and the driver
asserts no node wears that class) and `lbl` (the group header ships as `pal-group` with the export's
declarations).

**The measured geometry.** `packages/verify/artifacts/overlays/<short-sha>/assert.txt` carries one
line per overlay per viewport, and every one of the nine is `ok`: no document overflow, no region
overflow, and the panel's own box inside the viewport at every width. The palette and the picker are
`min(600px, 100vw - 28px)` wide, which measures 332px at 360, 402px at 430, 572px at 600 and 600px
from 820 up. The modal is `min(720px, 100vw - 32px)`, which measures 328px at 360 and 720px from 752
up. Both sit at the export's `top: 12vh`, offset by 14px from each edge at 360 and centred above 628.

**`.modal-file` caps the bytes at `50vh` and scrolls them.** The export's modal is `overflow: auto`
with `max-height: calc(100vh - 64px)`, so a long file pushes its own panel and the panel's scrollbar
appears. This app keeps the panel inside the viewport and scrolls the file box instead, which is the
same bytes and one fewer scrollbar. Measured: a 22,800-byte file makes `.modal-file` scroll at
1440x900 and leaves the panel at its own height.

**Two deltas this unit cannot close.**

**The Library surface's rows keep their inline view; the pane's row opens the modal.** The export's
`tabLibrary` rows are `data-act="file:open"` (`:1364`) and open the wide modal, and this unit ships
that for the pane. The Library surface's own rows still open `#library-view` in the page, because
previews are Phase 2 (`UX.md:256`), that view is landed evidence its own driver asserts, and moving it
would be a preview unit's change rather than an overlay's. One file therefore has two doors with two
views, which is recorded here as a difference rather than left to be discovered.

**The modal has no Download and no Copy path.** The export's file modal ends with those two buttons
(`:1833`). This app has a read route and no download route, which U6.3 recorded for the pane's Library
tab as well; the modal carries the name, the path, the size and the bytes and nothing that pretends
to move them.

**The palette's own copy.** The export's field placeholder names `settings`, `actions`, `routines`
and a quoted message search. This app's palette has no settings, routine or message group, so the
field says `Bots, threads and actions` and the no-results line says message search is not in this
build. The picker's placeholder is this app's own for the same reason: `Find a Bot, or name a new
one`, which is what that field does. The driver asserts both of the export's placeholder strings
absent from every overlay's rendered text, from the document and from the served bundle.

**Items.** The active row wears the export's hover wash; the export's own rows have no selection
state, so a keyboard that moves a selection needs one. The row's `.sub` carries what the row is
(`bot`, `thread`, `page`, `action`), which is the export's own vocabulary, and the picker's Bot rows
carry no avatar because this app's Bot record holds no initials.

## The items and the Bot rows (U6.5)

The conversation's items now use the export's own structure: the approval card is
`.tcard.gate` with `.tcard-head.gate-head`, a 2px `.gate-bar`, the body, the plain-word proposal,
`View the full request`, the scope and expiry row, and `Allow once` / `Deny` (`:1116-1135`); the tool
card is `.tcard` with a status dot or pulse, `Tool call`, a done/pending tag, the command in a
`.codeblock` with a copy control, and an output disclosure (`:1106-1114`); and the turn marker is one
`.tm` with the pulse and FreeBot's three lines (`:1104-1105`, `UX.md:115`, `:132`). The duplicate
marker lines are gone: `.turn-title`, `.turn-end`, `.tool-decision`, `.tool-result`,
`.approval-resolved`, `.run-status` and `.grant-lifecycle` no longer render, because the card is the
only place its fact appears. `docs/items.md` carries the state vocabulary. The cards keep the app's
stable harness aliases (`tool-card`, `approval-card`, `cmd`, `status`, `output-details`,
`approval-result`, `allow-once`, `deny`) beside the export's classes, because the drivers that click
and read them are other units' files and this unit does not edit them.

The Bot row is the export's `.sb-row` with a state dot, a name and a sub line
(`:955-970`). Its status is derived from the Bot's runs, not written as a label: `working` is a run
in flight, `attention` is a parked approval (the row says `needs you`), `failed` is the newest run
failed, and `idle` is everything else. The shell reads `list_threads` once per Bot so every row's dot
is a real per-Bot read; the selected Bot's stream outranks the store until the run's record is
re-read. `docs/items.md` carries the table and `packages/ui/src/bots.ts` is the derivation.

### The delta: groups, hidden Bots and unread have no record

The export's rows carry fields this app's Bot record does not hold. The export's `stateDot` reads
`b.state` (`working`, `attention`, `unread`, `hidden`) and `b.container` (`failed`), and `botRow`
reads `b.group`, `b.initials` and `b.role` for the sub line (`freebot-prototype.html:955-970`).
`renderSidebar` groups the rows by `pinned`, `section` and `primary`, and renders a `Hidden Bots`
label with a count and a disclosure around the rows whose `state === 'hidden'`
(`:972-999`). The conversation's group bar reads `b.group`, `b.members`, `b.paused` and `b.holder`
(`:1054-1065`).

`packages/protocol/src/dto.ts`'s `botSchema` holds `botId`, `name`, `role`, `purpose`, `createdAt`
and `threadCount`. It has no `group`, `members`, `paused`, `holder`, `pinned`, `primary`, `section`,
`initials`, `state` or `container`, and no record or action anywhere produces `hidden` or `unread`.
This unit therefore renders no group row and no hidden group, and seeds no prototype Bot to make
either visible. Group chats are Phase 4 (`UX.md` 5b, where the group thread, the member rows and the
shared `/shared` path live); a hidden Bot needs a hide action and a record field; `unread` needs a
read marker. Those three are the delta, named here rather than approximated. The in-flight and failed
parts of the export's dot are carried by the run-derived status above; the export's `container`
failure is a per-Bot container, which this app does not keep (its sandbox is per run).

