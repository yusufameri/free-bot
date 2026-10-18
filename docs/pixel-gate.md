# The pixel gate

Order 36 makes the fidelity pass a hard pixel gate. The app and the export are rendered in the same
browser instance, at the same viewport, in the same run, and diffed against each other. This document
describes the harness U6.7 will use to arm that gate. It is the tool, not the gate: the command is not
in `bun run verify` and not in CI, and the section below says exactly what U6.7 must do to arm it.

The harness lives in `packages/pixel-gate/`, a workspace package with its own `package.json` (order
27). It depends on `@freebot/verify` for the shared CDP client and the artifact path helper, and on
nothing else. Its diff engine has no image library at all: both PNGs are decoded and compared inside
the browser (order 36e).

## The one command

```
bun packages/pixel-gate/src/cli.ts
```

Run from the repo root. It launches one headless Chrome, opens the real app and the committed export
in that same browser, sets each of the nine viewports `DESIGN-MANIFEST.json` names, screenshots both
sides at each one, and prints a literal diff statistic per viewport. It exits non-zero when a chrome
region exceeds its tolerance.

| Flag | Effect |
| --- | --- |
| `--viewport <name\|WxH>` | One viewport instead of the nine. `--viewport wide`, `--viewport 1920x1080` and a substring of the name all work. |
| `--repeat` | Capture each viewport twice and diff the two captures against each other. |
| `--json` | The per-viewport summary as JSON on stdout, with the human transcript on stderr. |
| `--no-write` | Print without writing the artifact directory. |
| `--artifact <path>` | Write the artifact somewhere other than the convention. |
| `--stability <a> <b>` | Compare two committed `run.json` files instead of running. Exits non-zero if any chrome region's differing-pixel count moved. |

The artifact directory is `packages/verify/artifacts/pixel-gate/<short-sha>/`, holding `assert.txt`,
`run.json`, `summary.json` and `shots/`. The short sha is the commit the run's pixels belong to,
computed with `git rev-parse --short HEAD`, not the commit the artifact was committed at.

## Same instance, same run

The unit's central claim is that the two pages are rendered in one browser, and a claim about code is
not evidence. So the run reads the claim back out of the browser. After opening the app, the export
and the diff page, it calls `Target.getTargets` over its one CDP connection and asserts that each of
the three URLs is present in that one list:

```
same instance: one Chrome Chrome/155.0.8059.85 over one CDP connection with 8 target(s); 3 of 3 belong to this run
  app: target C836330271FEDC3936D69FBBCF415C11 (page) http://127.0.0.1:55906/#token=<redacted>
  export: target EFCC9B646D98C45F71A19560EEB414CD (page) http://127.0.0.1:55908/
  diff: target CAE8CADD (...)
```

The app's URL carries its ephemeral port and its token, the export's carries its own ephemeral port,
and the diff page's carries a fragment nothing else uses, so the match is exact rather than
approximate. A second Chrome process would make one of the three absent from this list and the run
would fail in its first seconds rather than after nine viewports.

This is enforced at `packages/pixel-gate/src/gate.ts`'s `assertOneInstance`, called once per run
before any viewport is visited. One browser is launched in one place,
`packages/pixel-gate/src/page.ts`'s `startBrowser`, and one `Chrome` handle is threaded through every
capture. There is no second launch path in the package.

The third target is what makes the diff live. `openDiffPage` opens `about:blank#freebot-pixel-gate-diff`
and evaluates the in-page runtime into it. Both screenshots travel to that page as base64 in chunks
and are drawn into canvases there, and `getImageData` gives back the RGBA buffers the arithmetic runs
over. No file on disk is ever a comparison source, which is order 36c: the committed PNGs under
`shots/` are for a human to look at and are never read back.

## No golden images

Nothing under `packages/verify/artifacts/pixel-gate/` is an input to a later run. Every run compares
the app against the export as they are at that moment. A `run.json` is a record of what a run saw, and
`--stability` compares two records to prove the tool is deterministic; neither is a baseline the tool
diffs against. This is deliberate, and it is the part of order 36a that keeps the gate from rotting:
cross-platform and cross-browser-version rasterization drift is what makes stored-golden gates go
stale, and a same-run pair cancels it.

## The tests

`bun test packages/pixel-gate/src` drives 62 tests over the three modules whose arithmetic a
verdict depends on. The diff tests call `diffRegion` and `digestImage` directly, and those two
functions are injected into the browser with `Function.prototype.toString`, so the tests drive the
same bytes the diff page runs rather than a re-implementation of them. The region tests drive the
snapping, the absence rule and the delta's sign over boxes written by hand. The report tests drive
the summing, the two-run proof and the JSON emitter, including the one shape that got a baseline
artifact a lint error: an array short enough to fit on its own but too long for the line its key
puts it on.

The artifact's JSON is written by `canonicalJson` in `report.ts` rather than by
`JSON.stringify(value, null, 2)`, because `packages/verify/artifacts/**` is committed and
`bun run lint` runs Biome over the whole tree. Biome keeps a short array on one line and otherwise
expands it one element per line, and it measures the whole line, so a key's length is part of the
budget. The emitter's output for both real artifacts was diffed against `biome check` with no
difference.

## The region map

`packages/pixel-gate/src/regions.ts` is the one place a region is defined. Each entry is one
rectangle, measured from the box named by `source` and then applied to both screenshots. That is the
only way a pixel statistic has an attributable cause: two rectangles taken separately from two
differently laid out pages would differ for a reason the number cannot express.

A rectangle is snapped outward to whole device pixels, left and top floored and right and bottom
ceiled, because `getBoundingClientRect` reports fractional numbers and a pixel count is whole.

Every region also prints the **app-minus-export delta** of its own box, whether or not it is a chrome
region. The sign is fixed at the app minus the export, so a positive left is the app's box further
right than the export's, and a reader can say which page moved without reading the map.

| Region | Kind | Rectangle from | Counterpart | Why it is that kind |
| --- | --- | --- | --- | --- |
| `chrome.resizer` | chrome | export `.resizer` | app `#resizer` | The 5px track. Transparent at rest on both sides, so the contract is zero differing pixels. |
| `chrome.sidebar-edge` | chrome | export `.sidebar` right 1px | app `#sidebar` | The sidebar's `border-right`. Same token on both sides; also pins the column's right edge. |
| `chrome.aside-edge` | chrome | export `.aside` left 1px | app `#aside` | The pane's `border-left`. Pins the pane's left edge, which is where a resizer drag lands. |
| `chrome.aside-strip-rule` | chrome | export `.aside-tabs` bottom 1px | app `#aside .aside-tabs` | The rule under the pane's strip. Makes the strip's own height a pass condition without asserting the tabs inside it. |
| `content.sidebar-list` | content | export `#sbList` | app `.sb-scroll` | Lists seven seeded prototype Bots against the one real Bot this run creates. |
| `content.center-header` | content | export `.chead` | app `header` | Different controls and copy; the app adds a tab strip the export has no element for. |
| `content.center-transcript` | content | export `#transcript` | app `#thread` | A seeded conversation against the frames of a thread that has not run. |
| `content.center-composer` | content | export `.composer-wrap` | app `#operator` | A growing textarea pinned to the bottom against a one-line input above the transcript. |
| `content.aside-strip` | content | export `.aside-tabs` | app `#aside .aside-tabs` | Seven tabs against four. |
| `content.aside-body` | content | export `#asideBody` | app `#asideBody` | A mock computer panel against the records this app really holds. |

Four chrome regions and six content regions. Every entry's own comment names the line its rectangle
comes from on both sides, so U6.7 can extend the map without reading the whole source. A region with
no geometric counterpart on the other page is not carried, because its number would have no cause;
`content.center-tabs` was written and then removed for exactly that reason, the app's Conversation /
Library pill strip having no export element at any width. Structural differences of that kind are
named in the summary below and in `docs/DESIGN-CONTRACT.md` instead.

**A region is absent, not zero, when its column is not on screen.** Below 1120px both stylesheets
stand the pane and the resizer down, and below 860px they stand the sidebar down. An absent region
prints `absent` and no statistic. It is not a pass and not a failure; it is a region this viewport
does not carry.

**A zero over zero is an empty set, not a pass.** At 360x800 there are no chrome regions at all, so
the transcript prints that sentence where a `0/0` would read as a perfect score. The shell's evidence
at those widths is the box deltas and the content regions.

## Determinism

Three mechanisms, and the run's own artifact carries the proof of each.

**A pinned browser and a pinned rasterizer.** One Chrome build per run, its version printed at the top
of `assert.txt`. Three flags are set on that one instance so both sides are rendered identically and
neither is favoured: `--disable-lcd-text` removes the monitor's subpixel order from grayscale
antialiasing, `--font-render-hinting=none` removes the rasterizer's stem-snapping, and
`--force-color-profile=srgb` removes the display's colour transform. `--hide-scrollbars` comes from
the shared CDP client.

**Fonts.** The two pages resolve the same stack, and `assert.txt` prints both, with the advance width
of a `'Geist'`-family string against a family that cannot exist and against `system-ui`. On this build
host the three numbers are equal, so Geist has no face here and both pages render the stack's
fallback. Two pages using the same fallback are comparable to each other; the glyph shapes are the
host's rather than Geist's, which is recorded in `docs/DESIGN-CONTRACT.md` as the vendoring gap. This
is measured rather than asked, because `document.fonts.check('16px Geist')` answers `true` on a
machine with no Geist at all.

**A freeze, injected before any capture.** `packages/pixel-gate/src/page.ts`'s `FREEZE_CSS` removes
animations and transitions and hides the caret, and every running animation is cancelled through
`document.getAnimations()`. This is not cosmetic. The export animates at rest: its seeded Bot Atlas is
in the `working` state, so `renderSidebar` paints a `.pulse` span whose rule is
`animation: pulse 1.5s ease-in-out infinite` (`freebot-prototype.html:110`), and a page whose opacity
is a function of the clock cannot be compared to anything twice. Cancelling it leaves the element at
its own base style, which is one deterministic frame. The same stylesheet goes on the app, so the two
sides are captured under identical rules rather than one frozen and one live.

**The proof, as a command.** `--repeat` captures each viewport twice, in the same run, and diffs the
two captures against each other. On the committed baseline, every viewport's two captures are
pixel-identical:

| Viewport | app, first against second | export, first against second |
| --- | --- | --- |
| 360x800 | 0/288000 | 0/288000 |
| 390x844 | 0/329160 | 0/329160 |
| 430x932 | 0/400760 | 0/400760 |
| 600x960 | 0/576000 | 0/576000 |
| 820x1180 | 0/967600 | 0/967600 |
| 1024x768 | 0/786432 | 0/786432 |
| 1366x768 | 0/1049088 | 0/1049088 |
| 1440x900 | 0/1296000 | 0/1296000 |
| 1920x1080 | 0/2073600 | 0/2073600 |

Zero differing pixels over 7,766,640 pixels per side, with max channel 0 on every pair. A run whose
second capture differs from its first throws rather than reporting, so `--repeat` cannot pass while
the page is moving.

And two whole runs agree exactly. `bun packages/pixel-gate/src/cli.ts --stability <a> <b>` compares
two `run.json` files region by region: 36 chrome region comparisons and nine totals, all at delta 0,
`RESULT: STABLE`. Both runs also carry a digest of each shot's own bytes, and all eighteen digests are
equal across the two runs, so the two runs did not merely report the same statistic, they captured the
same pixels. The committed pair is under the baseline's `stability/`.

## The baseline

The committed baseline is `packages/verify/artifacts/pixel-gate/e247a9d/`, produced by
`bun packages/pixel-gate/src/cli.ts` at commit `e247a9d`, against the app as it stands. The app state
is stated in `assert.txt`: booted as `bun run up --no-open --replay` over a fresh temporary
`FREEBOT_HOME` and bots root, one Bot and one thread created over `/rpc` before the page opens, the
vault this run's own three-line placeholder at mode 600 in that temporary directory. No key is read,
no request leaves the machine, and the real vault at `~/.freebot/provider.env` is never opened.

| # | Viewport | Chrome regions | Chrome differing | Content share | Whole share | Boxes differing |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 360x800 | 0 | 0/0 (none on screen) | 32.9717% | 49.9521% | 3 |
| 2 | 390x844 | 0 | 0/0 | 31.2546% | 43.3649% | 3 |
| 3 | 430x932 | 0 | 0/0 | 43.8881% | 46.3095% | 3 |
| 4 | 600x960 | 0 | 0/0 | 55.5591% | 56.6024% | 3 |
| 5 | 820x1180 | 0 | 0/0 | 42.9239% | 43.8372% | 3 |
| 6 | 1024x768 | 1 | 0/768 | 37.9575% | 38.1776% | 4 |
| 7 | 1366x768 | 4 | 0/6118 | 37.2256% | 34.5790% | 4 |
| 8 | 1440x900 | 4 | 0/7042 | 31.1238% | 29.9856% | 4 |
| 9 | 1920x1080 | 4 | 0/8302 | 25.6566% | 26.0033% | 4 |

**Chrome is zero everywhere it exists.** 0 differing pixels over 22,230 chrome pixels, summed across
every viewport that carries a chrome region. With a tolerance of zero and every non-zero pixel a
failure, the shell as it stands passes the gate this unit builds. That is the load-bearing result:
the four separators and tracks land on the same device pixel on both pages at all nine widths.

**What dominates the content numbers is layout, not styling, and the box deltas say which.** Four
boxes differ at every desktop width and three at every mobile one:

- **The middle column's vertical order differs.** The export's header is 55.8px tall with the
  transcript immediately under it and the composer pinned to the bottom edge of the column. The app's
  header is 137.61px at 360 wide and 118.23px at 1920, with its own tab strip and a 48px composer row
  under it and the transcript filling what is left. At 1920 that is the transcript starting 97.43px
  lower and running 48.63px taller than the export's, and the composer sitting 689.71px higher. The
  transcript also loses the export's `flex-end` pinning, so its band ends where the app's flex layout
  puts it.
- **The app's composer is above the transcript; the export's is below it.** This is the same finding
  from the other side and the largest single number in the block: -376.52px at 360 wide and -689.71px
  at 1920, both negative because the app's composer sits above the export's either way.
- **The sidebar list starts 3.73px higher and runs 81.73px taller** than the export's, which follows
  from the two heads being different heights rather than from a padding difference.
- **The header's height delta** at 1920 is 62.43px, the app's `h1` plus subtitle plus Bot title plus
  meta row against the export's single 53px control row.

The regions whose boxes agree exactly are the pane's: `content.aside-strip` at 0,0,0,0 and
`content.aside-body` at 0,0,0,0, because U6.3 rendered the export's own boot-written 372px and the
strip and body land where the export's do. The content share inside them is data, and it is named as
such: 1090/16695 pixels in the strip (seven tabs against four) and the body's panel count.

**Nothing overflows.** `documentElement.scrollWidth <= window.innerWidth` at all nine viewports, and
no probed region's content is wider than its box, at every one. That is `mustAvoidHorizontalScroll:
true` from the manifest, checked rather than assumed.

**The whole-frame share is information, not a verdict,** and it is not what the command's exit code
reads. It runs from 26.00% at 1920x1080 to 56.60% at 600x960. The export paints seven seeded Bots and
a run in progress; the app paints one real Bot and an idle thread. Two pages whose content differs
render different pixels whatever their styling, which is why the content regions carry a named reason
each and the exit code reads only the chrome regions.

## What U6.7 must add or calibrate before arming the gate

1. **Decide the region map's final shape.** Four chrome regions cover the separators and tracks that
   exist today. U6.4's overlays, U6.5's cards and the mobile drawers of the export's `.aside.open` and
   `.sidebar.open` will each want a rectangle, and each needs a counterpart selector on the app's side
   to be carryable. The map's own rule is that a region without a counterpart is not a region.
2. **Calibrate the tolerance, or keep it at zero.** `CHROME_TOLERANCE_DEFAULT` in `regions.ts` is the
   one named place, and the report prints the value it used beside every verdict. Zero is the current
   answer and the baseline passes it, so raising it needs a reason from the delta list rather than a
   flaky pixel. If a font change or a Chrome update moves a separator by one pixel, that is a decision
   for `docs/DESIGN-CONTRACT.md`, not a quiet epsilon.
3. **Fix the middle column's order, or declare it.** The box deltas above are the four numbers U6.7's
   pass has to close on the desktop widths. Each one is either the app moving to the export's order or
   a delta with its reason and its pixels in the contract's delta list.
4. **Add the delta list's pixels.** The contract's `DECLARED_DELTAS` is empty and a new delta fails
   `design-contract.ts`. Every delta this harness reports that U6.7 decides to keep needs its entry
   there with the pixels that differ and the reason, per order 36's last sentence.
5. **Vendor Geist, or state that the glyphs are the host's.** A route for a woff2 in `apps/server` is
   the mechanism; until then both pages render the host's fallback and the type is compared by size
   rather than by shape. `/pixel-gate`'s font line reports which of the two states the run is in.
6. **Arm it.** Add the command to `bun run verify` or to CI, which is a one-line change this unit
   deliberately did not make. The command already exits non-zero on a chrome failure, so arming is
   wiring, not construction. The cost to weigh is the run's wall time: nine viewports is about a
   minute and a half on the build host, and `--repeat` roughly doubles it.
7. **Add a driver-subject entry if someone else's change can break it.** Order 40's per-driver subject
   manifest wants a driver that a file change can invalidate to be named by the file. This tool reads
   `apps/web/host/index.html`, `apps/web/host/main.ts`, `packages/ui/browser/**` and the export, so a
   change to any of them is a reason to re-run it at that PR's head.

## What this unit did not do, on purpose

- **No CI wiring and no `bun run verify` entry.** Acceptance 6: the command is usable as a gate and is
  not one yet.
- **No edits under `apps/**` or `packages/ui/**`.** The harness is read-only against the app. Nothing
  in this unit fixes a delta it found; the deltas are the baseline U6.7 works from.
- **No edits to `docs/DESIGN-CONTRACT.md`.** Calibration and exceptions are U6.7's.
- **No dependency beyond `@freebot/verify`.** The diff runs in the browser precisely so that no image
  library enters the lockfile.

## Running it yourself

```
bun packages/pixel-gate/src/cli.ts --viewport wide
bun packages/pixel-gate/src/cli.ts --repeat --artifact /tmp/pixel-gate-repeat
bun packages/pixel-gate/src/cli.ts --stability <a>/run.json <b>/run.json
bun test packages/pixel-gate/src
```

It needs Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, no Docker, and no
key. The only thing it writes outside its artifact directory is the temporary home it deletes on the
way out.
