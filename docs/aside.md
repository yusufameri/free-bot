# The details pane, the notices and the banner

Before U6.3 the right-hand column of the shell was a frame: the grid carried the export's
`--aside-w` column and nothing in it. This unit fills it with the export's own aside — a tab strip, a
scrolling body, and a 5px drag track beside it — and adds the two lines the stream itself raises
above the conversation: the reconnect banner and the notice stack.

The export governs the pixels: `.aside-tabs` and `.aside-tab` at `freebot-prototype.html:391-401`,
the strip's markup at `:1183-1197`, the resizer at `:2247-2258`, the banner at `:1044` and the notice
stack at `:1045-1053`. `UX.md:33` governs which tabs exist. What follows is what this app renders in
them, where each value comes from, and the deltas.

## The pane

`packages/ui/src/aside.ts` owns the words and the numbers: the tab list, the clamps, the width
default, and the rows each tab shows. `packages/ui/browser/aside.ts` renders that model and decides
nothing, the same split `shell.ts` and `library.ts` keep. The host (`apps/web/host/main.ts`) hands
both of them records it already holds, so the pane never asks a server for anything the page has not
already read.

| Tab | The body | Its source |
| --- | --- | --- |
| `Computer` | the run's computer: the run's id, status and start, the stream's connection, frame count and last sequence, and the newest tool call with its command, decision and output | the thread model's own state (`runId`, `failed`, `done`, `awaiting`, `toolCards` in `packages/ui/browser/render.ts`) and the transcript the page already has |
| `Details` | this Bot: name, label, purpose, thread count and creation time; then this thread: title, runs and creation time; then the model: model, connection status, last test and endpoint host | the Bot and thread records the shell holds (`get_bot`, `get_thread`) and the provider record page 1 read (`get_provider`) |
| `Tasks` | the newest run as a card, and every run in the thread as one row with its id, time and status | the thread record's own `runs` (`packages/protocol/src/dto.ts`), with the live run's status derived from the thread model |
| `Library` | the Bot's `/workspace`, grouped `Today`/`This week`/`Older`, pinned at `/workspace`, one row per file with its name, path and size | the same listing the Library surface shows: one `list_files` read, held by `mountLibrary` and rendered in both places |

Every row is a value some record really holds. `packages/ui/src/aside.ts` names what the app cannot
fill rather than approximating it: no Bot selected, no thread selected, no runs, and — on the
Computer tab — the sentence saying the sandbox is the run's, not the Bot's. The export's data strings
(`pre-run-4f3a`, `waiting on approval`) appear nowhere in the app, and the driver asserts that over
each tab's own rendered text, over the document, and over the bundle the server serves. `Teach a
task` left that list when U6.8 shipped it as the Skills page's own action copy; the workspace driver
asserts it there, and this one no longer calls chrome copy prototype data.

The transcript check follows the renderer's row contract. Seven message types get a row of their own
(`run.started`, `turn.started`, `message.text.delta`, `tool_call.requested`, `approval.requested`,
`run.finished`, `run.failed`), and every one of those must appear once in wire order. Decisions,
results, resolved approvals and status frames update the card or the counter they belong to instead
of adding a row, so the driver compares the page's rendered seqs to that set rather than to every seq
the log holds. The page's own `lastSeq` still has to equal the log's tail, so a folded frame is
proven received even when it has no row.

Two things only the host can do leave the pane through callbacks: opening a Library row asks the
Library surface to show the file in its own viewer, and opening the Library tab asks it to re-read
the workspace, so the pane and that surface render one listing rather than two.

## The width

The export declares `--aside-w: 384px` (`freebot-prototype.html:37`) and then overwrites it at boot
with `S.asideW || 372` (`:2248`, seeded at `:829`). This app keeps the declared token and writes the
same rendered value the export writes, so both pages render 372px on a fresh profile; the token table
in `packages/ui/src/tokens.ts` still says 384px, which is what `bun packages/ui/scripts/emit-tokens.ts`
checks.

A drag on the 5px track sets the width from the right edge — `window.innerWidth - clientX` — clamped
to 280 through 560, the export's own numbers at `:2252`. `localStorage` under `freebot.aside` keeps
the width, the selected tab and the collapsed state, so a reload restores all three, and the header's
own button and the strip's `Collapse the pane` button both toggle the same state. Both are the
export's controls, and the space they live in is the export's too.

## The two lines above the conversation

**The banner binds to the page's own socket.** `main.ts` already tracked the stream and set
`reconnecting` on close; the banner reads that state and nothing else, and shows while the socket is
dropped or trying again. Its copy is the export's, verbatim. When the socket answers, the page
resumes from the sequence it last applied, so the transcript refills from the store rather than from
a guess.

**A notice comes from a record.** Two sources exist today: the provider connection's own outcome
(`untested`, `limited`, or a refusal, over page 1's headline and refusal sentence, with `Open` to
that page), and a run the thread's store reports as failed. A notice's id is stable — `provider-…`,
`run-failed-…` — so a dismissal lands on the same notice after a reload. `Dismiss` and `Dismiss all`
write to `localStorage` under `freebot.notices.dismissed`. With no signal the stack is not on the
page at all: it is an empty element the module fills.

## What proves it

`bun packages/verify/scripts/aside.ts` runs in headless Chrome against two really launched apps and
its artifact lands at `packages/verify/artifacts/aside/<short-sha>/`, with the PNGs it captured. Its
sections, in order:

1. what it runs: launch A is `bun run up --no-open --replay` over a fresh home and bots root, its own
   placeholder vault at mode 600, and the page is opened through a TCP relay this driver owns;
2. the pane's frame: the strip's roles, the four tabs, the close button's label and sprite icon, the
   header's control, and the rendered width;
3. the notices, from the records they come from, with `Dismiss` and `Dismiss all` across a reload;
4. the resizer: a drag to one page x, both clamps, and the width across a reload;
5. collapse and expand, from the header's control, across reloads;
6. a run the page itself starts, and every tab read back against its own source;
7. where the placeholder strings were looked for;
8. the banner, over a stream really severed;
9. the nine `DESIGN-MANIFEST.json` viewports with the pane present, and both clamps at each one;
10. launch B: a run against a port nothing listens on, which really fails, and the notice it raises;
11. launch B with its signal taken away: a page with none renders no stack;
12. containment: what the driver left behind, by label.

The severing is the driver's, not the page's: every connection through the relay is destroyed, so the
page's own WebSocket to `/events` closes and the page cannot tell the difference from a dropped
network. While the page is blind the app keeps working — the run's log grows — and when the relay is
restored the page reads the missing frames back by sequence and reports no gap. No class is toggled
anywhere in that section, and the assertions read the page's facts rather than the driver's intent.

## Deltas and follow-ups

The tab set, the header's single control, the missing mobile drawers, the read-only Details tab, the
Computer tab's absent machine controls and the Tasks tab's absent `Stop now` are recorded with their
reasons in `docs/DESIGN-CONTRACT.md` under `## Deltas this frame cannot close`. Two follow-ups this
unit leaves: `Stop now` needs the unit that owns the run's own controls, and the drawers below 1120px
have no owner yet — a narrow screen has no way to reach the pane at all until one exists.
