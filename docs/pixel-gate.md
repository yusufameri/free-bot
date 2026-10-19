# The pixel gate

Order 36 makes the fidelity pass a hard pixel gate. The app and the export are rendered in the same
browser instance, at the same viewport, in the same run, and diffed against each other. This document
describes the harness and the pass U6.7 armed. It is the tool's contract: the command is a step of
`bun run verify` and of CI, and it exits non-zero on a chrome mismatch or on a box delta that is not
written into `docs/DESIGN-CONTRACT.md`.

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
| `--artifact <path>` | Write the artifact somewhere other than the convention. A directory that already exists and is not empty is refused, never cleared. |
| `--stability <a> <b>` | Compare two committed `run.json` files instead of running. Exits non-zero if any chrome region's differing-pixel count moved. |

The artifact directory is `packages/verify/artifacts/pixel-gate/<short-sha>/`, holding `assert.txt`,
`run.json`, `summary.json` and `shots/`. The short sha is the commit the run's pixels belong to,
computed with `git rev-parse --short HEAD`, not the commit the artifact was committed at.

## Arming it, and the proof it can fail

`bun run verify` runs `bun packages/pixel-gate/src/cli.ts --no-write` as its `pixel-gate` step, and
`.github/workflows/ci.yml` installs Chrome and sets `FREEBOT_CHROME` before that step, so the gate
runs on the build host and in CI. The command's exit code is `exitCodeFor(verdictFailures(...))`:
zero only when every carried chrome region's differing-pixel count is at or under the tolerance and
every moved box is either zero or matched by a declared delta.

The failure path has its own proof, and it does not wreck a page. `packages/pixel-gate/src/gate.test.ts`
builds the report shapes the run produces and shifts one number: one differing chrome pixel fails the
run by name (`09-wide-1920x1080 chrome.aside-edge: 1 differing pixel(s) over a tolerance of 0`), a
declared region moved off its declared pixels fails, an undeclared moved region fails with the
contract's path in the message, and a chrome box delta fails even when the pixels inside it happen to
match. A report with every delta declared and every chrome pixel at zero exits 0. The tests never
open a browser, so their result cannot depend on a screenshot looking right.

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

`bun test packages/pixel-gate/src` drives 66 tests over the three modules whose arithmetic a
verdict depends on. The diff tests call `diffRegion` and `digestImage` directly, and those two
functions are injected into the browser with `Function.prototype.toString`, so the tests drive the
same bytes the diff page runs rather than a re-implementation of them. The region tests drive the
snapping, the absence rule and the delta's sign over boxes written by hand. The report tests drive
the summing, the two-run proof and the JSON emitter, including the one shape that got a baseline
artifact a lint error: an array short enough to fit on its own but too long for the line its key
puts it on. They also drive the two-run proof's symmetry: a viewport or chrome region with no
counterpart in the other run fails it, whether the counterpart is simply missing or shares its id
under another kind.

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
| `content.center-composer` | content | export `.composer-wrap` | app `#composer-wrap` | A growing textarea with tools against one input, two buttons and the live meta line; both are pinned to the bottom edge. |
| `content.aside-strip` | content | export `.aside-tabs` | app `#aside .aside-tabs` | Seven tabs against four. |
| `content.aside-body` | content | export `#asideBody` | app `#asideBody` | A mock computer panel against the records this app really holds. |
| `content.sidebar-bot-row` | content | app `#bot-list .sb-row` | export `#sbList .sb-row` | U6.5's Bot row: a real Bot's run-derived dot against the export's seeded seven. |
| `content.item-turn-marker` | content | app `.tm` | export `.tm` | U6.5's one turn marker. Absent in the idle shell; the items driver measures its three phases. |
| `content.item-tool-card` | content | app `.tool-card` | export `.tcard:not(.gate)` | U6.5's tool card. Absent before a run; the items driver measures running, done, denied and failed. |
| `content.item-approval-card` | content | app `.approval-card` | export `.tcard.gate` | U6.5's approval card. Absent before a run; the items driver measures pending, allowed, denied and expired. |
| `content.overlay-palette` | content | app `#palette` | export `.palette` | U6.4's command palette. Absent until opened; the overlays driver measures the open panel. |
| `content.overlay-picker` | content | app `#picker` | export `.picker` | U6.4's Bot picker. Absent until opened; the overlays driver measures the open panel. |
| `content.overlay-modal` | content | app `#modal` | export `.modal` | U6.4's file modal. Absent until opened; the overlays driver measures the wide panel. |

Four chrome regions and thirteen content regions. Every entry's own comment names the line its
rectangle comes from on both sides. A region with no geometric counterpart on the other page is not
carried, because its number would have no cause; `content.center-tabs` was written and then removed
for exactly that reason. The four item and three overlay entries are taken from the app's side, so a
viewport where the app has not rendered the surface reports `absent` rather than measuring the
export's box over whatever happens to sit under it. Structural differences of that kind are named in
the summary below and in `docs/DESIGN-CONTRACT.md` instead.

The two mobile drawers are not in the map: the export's `.aside.open` and `.sidebar.open` have no
counterpart selector in this app at all, because this frame ships no trigger and no drawer
(`docs/DESIGN-CONTRACT.md` names that as an open surface). They stay out rather than being measured
against nothing.

**Notices are dismissed before the probe.** Both pages raise notices from data (this app from the
provider record, the export from its seed), and their heights differ for a reason that is not the
shell's. The run clears both stacks once per visit, so the band between the header and the composer
is the shell's own. The notice surface is `packages/verify/scripts/aside.ts`'s subject, not this
tool's.

**A region is absent, not zero, when its column is not on screen.** Below 1120px both stylesheets
stand the pane and the resizer down, and below 860px they stand the sidebar down. An absent region
prints `absent` and no statistic. It is not a pass and not a failure; it is a region this viewport
does not carry.

**A zero over zero is an empty set, not a pass.** At 360x800 there are no chrome regions at all, so
the transcript prints that sentence where a `0/0` would read as a perfect score. The shell's evidence
at those widths is the box deltas and the content regions.

**A clipped region is still checked.** When a rectangle has to be cut at the viewport's edge the
region prints `clipped` instead of `measured`, and it keeps its pixel statistic. A clipped chrome
region is summed into the chrome total and checked against the tolerance like any other. Only
`absent` is left out, because a region that is not on screen has nothing to compare.

## Determinism

Three mechanisms, and the run's own artifact carries the proof of each.

**A pinned browser and a pinned rasterizer.** One Chrome build per run, its version printed at the top
of `assert.txt`. Three flags are set on that one instance so both sides are rendered identically and
neither is favoured: `--disable-lcd-text` removes the monitor's subpixel order from grayscale
antialiasing, `--font-render-hinting=none` removes the rasterizer's stem-snapping, and
`--force-color-profile=srgb` removes the display's colour transform. `--hide-scrollbars` comes from
the shared CDP client.

**Fonts.** Both pages resolve the same stack, and `assert.txt` prints both, with the advance width
of a `'Geist'`-family string against a family that cannot exist. Geist is vendored: one variable
woff2 at `apps/web/host/fonts/geist-var.woff2` with its SIL OFL 1.1 licence beside it, served by
`apps/server` at `/fonts/geist-var.woff2` and by the export's own run server at the same path. The
app's page declares the `@font-face`; the harness injects the same declaration into the frozen export
before any capture, because the export is a frozen artifact whose stylesheet only names the family.
On the build host the Geist string measures 243.62px against the absent family's 215.98px, so the
face is in use on both sides rather than the stack's fallback. `assert.txt` prints that pair, and a
run where the two numbers are equal reports the fallback instead. This is measured rather than asked,
because `document.fonts.check('16px Geist')` answers `true` on a machine with no Geist at all; the
run also waits on `document.fonts.ready` before its first probe, so a capture cannot hold the
fallback while the face is still in flight.

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

The U6.7a baseline is `packages/verify/artifacts/pixel-gate/df87bca/`, produced by
`bun packages/pixel-gate/src/cli.ts --repeat` at commit `df87bca`, against the app as it stands. The app state
is stated in `assert.txt`: booted as `bun run up --no-open --replay` over a fresh temporary
`FREEBOT_HOME` and bots root, one Bot and one thread created over `/rpc` before the page opens, the
vault this run's own three-line placeholder at mode 600 in that temporary directory. No key is read,
no request leaves the machine, and the real vault at `~/.freebot/provider.env` is never opened.

| # | Viewport | Chrome regions | Chrome differing | Content share | Whole share | Boxes differing |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 360x800 | 0 | 0/0 (none on screen) | 40.2218% | 49.9521% | 3 |
| 2 | 390x844 | 0 | 0/0 | 37.7931% | 43.3649% | 3 |
| 3 | 430x932 | 0 | 0/0 | 43.8881% | 46.3095% | 3 |
| 4 | 600x960 | 0 | 0/0 | 55.5591% | 56.6024% | 3 |
| 5 | 820x1180 | 0 | 0/0 | 42.9239% | 43.8372% | 3 |
| 6 | 1024x768 | 1 | 0/768 | 37.4262% | 37.6520% | 4 |
| 7 | 1366x768 | 4 | 0/6118 | 33.6667% | 34.1849% | 4 |
| 8 | 1440x900 | 4 | 0/7042 | 28.5261% | 29.6667% | 4 |
| 9 | 1920x1080 | 4 | 0/8302 | 24.0723% | 25.8039% | 4 |

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
- **The sidebar list starts 2px higher and runs 80px taller** than the export's, which follows
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
reads. It runs from 25.80% at 1920x1080 to 56.60% at 600x960. The export paints seven seeded Bots and
a run in progress; the app paints one real Bot and an idle thread. Two pages whose content differs
render different pixels whatever their styling, which is why the content regions carry a named reason
each and the exit code reads only the chrome regions.

## The U6.7 pass, at the head it armed

The armed artifact is `packages/verify/artifacts/pixel-gate/8d23e06/`, produced by
`bun packages/pixel-gate/src/cli.ts --repeat` at commit `8d23e06`. The chrome statistic is unchanged
from the U6.7a baseline, and that is the point: the shell already landed on the same device pixels.
What moved is the middle column's structure and the font, and the box deltas below are the literal
record of it.

| # | Viewport | Chrome regions | Chrome differing | Content regions | Content share | Whole share | Boxes differing |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 360x800 | 0 | 0/0 (none on screen) | 3 | 51.8724% | 52.0021% | 2 |
| 2 | 390x844 | 0 | 0/0 | 3 | 48.2724% | 48.3868% | 2 |
| 3 | 430x932 | 0 | 0/0 | 3 | 48.3096% | 48.4133% | 2 |
| 4 | 600x960 | 0 | 0/0 | 3 | 46.4645% | 46.5613% | 2 |
| 5 | 820x1180 | 0 | 0/0 | 3 | 37.8127% | 37.8768% | 2 |
| 6 | 1024x768 | 1 | 0/768 | 5 | 33.9611% | 31.8707% | 4 |
| 7 | 1366x768 | 4 | 0/6118 | 7 | 31.6888% | 30.0735% | 4 |
| 8 | 1440x900 | 4 | 0/7042 | 7 | 31.2501% | 29.8829% | 4 |
| 9 | 1920x1080 | 4 | 0/8302 | 7 | 24.0461% | 23.3717% | 4 |

**Chrome is still zero everywhere it exists: 0 differing pixels over 22,230 chrome pixels**, summed
across every viewport that carries a chrome region, with the tolerance at 0. Every viewport's two
captures are pixel-identical (`--repeat`), and two runs at this commit are `RESULT: STABLE` across 36
chrome region comparisons and nine totals. The whole-frame share fell from 25.8039% to 23.3717% at
1920x1080 and from 49.9521% to 52.0021% at 360x800; it is information, not the verdict.

The five box deltas U6.7a named, before and after:

| Region and axis | U6.7a baseline (df87bca) | U6.7 head (8d23e06) | How it closed or why it stands |
| --- | --- | --- | --- |
| `content.center-header` height, 1920 | +62.43 | +0.2 | Closed. The header is one 56px row on the export's `min-height: 53px` and 10px padding; the 0.2px is the export's 55.8px and is inside the half-pixel box tolerance. |
| `content.center-transcript` top, 1920 | +97.43 | +0.2 | Closed. Both notices are dismissed before the probe and both transcripts start on the header's bottom edge. |
| `content.center-transcript` height, 1920 | +48.63 | +56.49 | Declared. The transcript is the composer's `flex: 1` sibling, so it is taller by the amount the app's shorter composer gives back. |
| `content.center-composer` top, 1920 | -689.71 | +56.69 | Closed as a structural defect: the composer is the column's last child and pinned to the bottom. The remaining top is the height difference below. |
| `content.center-composer` height, 1920 | -98.06 | -56.68 | Declared. One input, a Start and a Stop control and the live meta line against the export's growing textarea, five tool controls and hint. |
| `content.sidebar-list` top, 1920 | -2 | 0 | Closed. The head is the export's 10px padding and the list its 2px inset. |
| `content.sidebar-list` height, 1920 | +80 | +78 | Declared. The export's foot carries Connect apps, the model row and the account row (125px); this app's foot is the one provider row (47px). |

At 360x800 the same rows read: header +0.2, transcript top +0.2 and height +70.3, composer top
+70.5 and height -70.5. The four declarations, with every viewport's literal pixels, are in
`docs/DESIGN-CONTRACT.md`'s pixel-gate block and in `packages/pixel-gate/src/deltas.ts`.

## What U6.7 changed

1. **The region map is final.** Four chrome regions and thirteen content regions: the six shell and
   pane regions, U6.5's Bot row and three conversation items, and U6.4's three overlay panels. The
   item and overlay entries come from the app's side so their idle state is `absent` rather than a
   measurement of the export's box; the items and overlays drivers measure their open states. The
   two mobile drawers are not carried because this app has no counterpart selector for either, and
   `docs/DESIGN-CONTRACT.md` names that as an open surface.
2. **Tolerance stays zero.** `CHROME_TOLERANCE_DEFAULT` is still `0`, and the report prints
   `chrome tolerance: 0 differing pixel(s) per chrome region` in the artifact and beside every
   verdict. No entry in the delta list justifies a number, because no chrome pixel differs.
3. **The middle column is the export's order.** The transcript is the composer's `flex: 1` sibling,
   the composer is the column's last child and pinned to the bottom edge, and the transcript carries
   the export's bottom pinning (`justify-content: flex-end` plus a first-row auto margin so a long
   transcript can still be scrolled to its top). The header is one 56px row, the export's
   `min-height: 53px` plus its 10px padding: `h1`, the copy that holds in both provider modes, the
   Bot-and-thread title, the Conversation/Library strip and the Details control, all truncating
   rather than wrapping. The export's header measures 55.8px, so the header delta is 0.2px, inside
   the half-pixel box tolerance.
4. **The delta list has its pixels.** Four content-region entries remain, in
   `docs/DESIGN-CONTRACT.md` and in `packages/pixel-gate/src/deltas.ts`, re-exported as
   `DECLARED_DELTAS` in `packages/verify/scripts/design-contract.ts`. A moved box that is not in the
   list fails the run, and a declared box that moves off its recorded pixels fails it too.
5. **Geist is vendored.** One variable woff2 and its OFL licence at `apps/web/host/fonts/`, served by
   `apps/server` at `/fonts/geist-var.woff2`; the export's run server serves the same bytes and the
   harness injects the `@font-face` into the frozen export. Both pages measure the face, not the
   fallback.
6. **It is armed.** `bun run verify` has the `pixel-gate` step, CI installs Chrome and pins
   `FREEBOT_CHROME`, and the gate tests prove the failure by name without a browser.
7. **Order 40's subject entry exists.** `packages/verify/driver-subjects.json` lists `pixel-gate`
   with every file whose change invalidates it: the host page and bundle, the vendored font, the
   server route, `packages/ui/browser/**`, the tokens, the export, the manifest and this tool.

## What this unit did not do, on purpose

- **No new dependency.** The diff still runs in the browser, so no image library enters the
  lockfile; the font is a committed asset, not a package.
- **No edit to the frozen export.** Its `@font-face` arrives by injection into the browser at run
  time, never into `design/prototype-84c6b185/`.
- **No drawer.** The mobile drawers stay out of the map and out of the app; they need a trigger and
  a record this build does not have, and `docs/DESIGN-CONTRACT.md` records that rather than
  approximating it.

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
