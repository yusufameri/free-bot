# The landing route

The export carries a landing page, and U6.6 ships it at its own path, `/landing`, out of the app
shell. Nothing about `/` moves: a person who opens the URL `bun run up` prints still meets the
first-run wizard, exactly as before.

## The route

`apps/server/src/api-server.ts` registers two paths beside the host's own:

| Path | Serves |
| --- | --- |
| `/landing` | `apps/web/landing/index.html`, the document |
| `/landing.js` | the bundle of `apps/web/landing/main.ts` |

Both are built the way `/` is, from the directory beside the host's, and both answer behind only the
Host check. The landing carries no run state, so it needs no operator token: its controls link to
`/`, and its one script writes the clipboard. A page that asked the server for something would have
to present the token, and a marketing page has no business holding one.

The registration is additive. `hostPage()` and the routes it serves are untouched, and the driver
asserts the app's own document still serves at `/` with its own title and its first-run screen.

## The sections, from the export

The export is `freebot-prototype.html`, and its landing region is the `#onboard` section at
`:566-613`. That region is what this page implements, section for section, in its order:

| Element | Copy | Export line |
| --- | --- | --- |
| The brandmark | `FreeBot` | `:570-572` |
| The eyebrow | `Local agent workspace` | `:575` |
| The heading | `Bots that do the work, on a computer that stays yours.` | `:576` |
| The statement | `FreeBot ships no subscription. You bring a model — OpenAI-compatible, local, or hosted — and it gets its own sandbox, a durable workspace, and an approval gate before anything runs.` | `:578-579` |
| The primary control | `Connect a provider` | `:581` |
| The quieter control | `Run in replay mode — see it work without a key` | `:582` |

`packages/verify/scripts/landing.ts` reads those six out of the export at run time, by locating the
element in the region's own lines, and asserts each against the live DOM. A page that drifts from
the export fails there rather than being compared against a copy the driver made.

## What the page carries that the export does not

The export's landing region is one viewport of hero copy and nothing else. A landing that stopped
there would be six lines and two buttons on a black page. This page adds one section under the hero,
`What runs today`, and the driver asserts both bands render in order.

The section exists because of what this unit is: a page that ships no hosted-service implication and
no dead control has to say what the product actually is. So it states four things this repository
really does at the commit that served the page, and three it does not do yet.

| Claim | Read from |
| --- | --- |
| The command is `bun run up` | the root `package.json`'s own `scripts.up` |
| A replay launch needs no key | `apps/server/src/provider.ts`'s `chooseProvider` fallback |
| Each run gets one container from `freebot-sandbox:u0.6` | `packages/sandbox/src/image.ts`'s `PINNED_IMAGE.tag` |
| The key lives in the vault at mode 600 | `apps/server/src/vault.ts`'s `writeFileSync(…, { mode: 0o600 })` |
| The repository URL | `git remote get-url origin` |

The driver reads the first, third and fifth from those sources at run time and compares them to what
the page renders, so a version, a command or a tag that moves makes the page wrong and the driver say
so. The two gaps it names are the ones `UX.md`'s "What exists today" table already states: the run
cancel route exists with no control in the page (`apps/server/src/router.ts:41`), and the spend cap
is computed but not consulted (`packages/core/src/run-usage.ts`).

## The controls, and what each one does

| Control | Does |
| --- | --- |
| `Connect a provider` | A link to `/`. The app decides what a person meets there: a store with no Bot opens the first-run screen, a keyless machine with a Bot opens the provider page, a live one opens the shell. Deep-linking into a state the app would not have chosen would be the landing claiming to know something it does not. |
| `Run in replay mode — see it work without a key` | The same link. The export offers replay as a second path; in this app, `bun run up --replay` forces replay for the launch regardless of vault state, while auto mode checks the vault when each run starts and selects replay only when it is empty. The note under the controls states these rules. The label stays the export's copy because the hero band is the export's, and the note carries the mechanism the label cannot. |
| `Copy` | Writes `bun run up` to the clipboard and reports which of the two outcomes happened, the copy or the browser's refusal. |
| `The repository` | `https://github.com/yusufameri/free-bot`, the `origin` remote. |
| `How to run it` | `docs/RUNNING.md` on `main`. |

The driver asserts both hero controls are links with a non-empty `href`, that each resolves to `/`,
and that `/` really serves the app's document. It also asserts that every `button` on the page
carries an id the driver knows, which is what makes "no dead control" checkable rather than asserted.

## What is absent, and why

- **No download or install control.** FreeBot has no release artifact to point at. `bun run up` from
  a clone is the whole install, which is what the commands section says.
- **No pricing, plan, or waitlist.** Order 33: this project ships no credentials and owns no
  account, and a person brings their own model key. A pricing table would imply a service that does
  not exist.
- **No sign-in or hosted-service implication.** The page states the opposite in the export's own
  words, `FreeBot ships no subscription`.
- **No product screenshot.** This is a deliberate departure from `DESIGN-MANIFEST.json`'s
  `landingPage.requiredSections`, which lists "product proof/screenshots". The app's own screens are
  the subject of U6.7's fidelity pass against the export, and a capture embedded here would be a
  second copy of that evidence with no assertion behind it. The page's product evidence is instead
  the real command, the real pinned image tag, and the two real gaps. Recorded here per plan §10.3,
  which says a parity unit that cannot match a surface states the delta rather than approximating it.
- **No OS widget surface.** The manifest's `osWidgets` note says not to invent one where none is
  present, and the export carries none.

## The export's provider panel

The export reveals a provider form under the hero when `Connect a provider` is pressed
(`:585-611`, the `#onbForm` block). This page does not carry it, because the app already has a real
connect flow with a real smoke test: page 1 of the app, built by U4.3 and wired to `connect_provider`
and `get_provider`. A second, static copy on the landing would be a control that looks identical and
behaves differently, which is exactly the thing this unit's acceptance forbids. The primary control
opens the real one.

## The tokens

The landing document carries a `tokens:begin` block, written by `bun packages/ui/scripts/emit-tokens.ts`
from `packages/ui/src/tokens.ts` — the same table `apps/web/host/index.html` and
`docs/DESIGN-CONTRACT.md` are written from. `packages/ui/src/tokens.ts` declares it as
`LANDING_TOKENS`, so the emitter's `--check` mode and `tokens.test.ts` both fail when the page drifts
from the table. This is a second page, not a second token set.

## No design chrome

The export's `data-od-id` attributes, its `lbl` annotations, and its prototype placeholder strings
(`pre-run-4f3a`, `Teach a task`, `waiting on approval`) are absent, the way U6.3 asserted them absent
for the pane. `packages/verify/scripts/landing.ts` checks each literal over four surfaces: the
page's rendered text, the parsed markup, the served HTML file and the served bundle.

## Evidence

`bun packages/verify/scripts/landing.ts` boots the real launcher the way a person does
(`bun run up --no-open --replay`) over a `FREEBOT_HOME` and bots root of its own, keyless, with no
run started and no container created. It opens `/landing` in headless Chrome and writes
`packages/verify/artifacts/landing/<short-sha>/`:

- `hero-1440x900.png` and `hero-430x932.png`, the two viewports this unit pins.
- one PNG per viewport of the manifest's nine, named `<index>-<name>-<width>x<height>.png`.
- `root-1440x900.png`, the app's own `/`, captured in the same run so a landing that moved what `/`
  serves shows up in this artifact.
- `assert.txt`, every check with its actual and expected value.

## What U6.7 needs to know

U6.7 pixel-diffs each screen against the export. Three things about this route matter there:

1. **There is no export screen to diff against for the band below the hero.** The export's landing
   region is the hero alone, and `design-contract.ts` already serves the export with its initial
   screen rewritten to `app` so it boots into the shell rather than the welcome screen. Diffing
   `/landing` against the export wants the reverse edit: serve the export unchanged and let it open
   on `welcome`, then compare the hero band only, above the fold.
2. **The hero band is a fair comparison; the rest is not.** The brandmark, the eyebrow, the `h1`,
   the statement and the two controls are the export's own elements with the export's own copy, so a
   near-zero tolerance applies exactly as it does to the shell. The `What runs today` section has no
   counterpart in the export and would be a total diff below the fold.
3. **`--fs-h1` is fluid.** The export's `clamp(30px, 4.4vw, 46px)` resolves against each page's own
   viewport width, and both pages get the same one, so the `h1` measures equal at all nine. Nothing
   about the landing needs a declared delta.
