# The first-run screen

A fresh FreeBot store holds no Bot. Before U6.2 the page answered that by naming one itself: the host
created `bot-local`, called it `Local Bot`, and gave it a thread, so a person who ran `bun run up` got
a conversation to type into. U6.2 replaces that answer with the export's own first-run screen, and the
old behaviour survives in exactly one place, the Skip path.

## What a person sees

Three panes, one question each, in the export's order: the name, then what the Bot is for, then a
starting job. The provider pane sits under the job chips, where the export puts its provisioning
block, and it is optional. The footer holds one primary and Skip.

| Pane | Title | Copy from |
| --- | --- | --- |
| 1 | `Who is this Bot?` | `design/prototype-84c6b185/freebot-prototype.html:625` |
| 2 | `What is it for?` | `freebot-prototype.html:632-637` |
| 3 | `Start with a job.` | `freebot-prototype.html:641-648` |
| 4 (the provider pane) | `Test a real tool call before we save it.` | `freebot-prototype.html:588-590`, `:609` |

The fuller export file governs this screen. The other file, `freebot-prototype-v1.html`, carries the
same screen with less: it asks one question (`What should we call your first Bot?`, `:338`), then a
purpose (`What is it for?`, `:342`), then three jobs (`:349-351`). The fuller file asks for a name, a
label and a purpose, and offers four jobs, so its copy is what the screen ships.

`packages/ui/src/first-run.ts` holds the words that move with the step: the three step captions, the
four jobs, and the three footer labels. The panes' standing copy is the page's own markup, exactly as
the export writes it inline in its HTML. `packages/verify/scripts/first-run.ts` asserts both against
literals read from the export.

## What Continue does

**Pane one makes the Bot.** Continue calls the same arm the sidebar's own control calls
(`create_bot`, then `create_thread`), so the record, its id and its first thread are the ones a
person's click in the Bot list would have made. Nothing is created before that click, and nothing
names the Bot but the person.

**Pane two keeps the purpose.** The record gains `role` and `purpose`, written by `update_bot` and
journalled as `bot.update` in `packages/core/src/bot-store.ts`. A journal written before those fields
existed replays with both empty, so no install needs a migration step.

**Pane three fills the prompt.** A chosen job writes its task into the composer and takes the focus,
which is what the export does at `freebot-prototype.html:2240`. It does not start the run: the person
presses the page's own `Start run`.

**The provider pane is page 1's route, entered a second time.** It is
`packages/ui/browser/provider.ts` mounted again with `surface: "first-run"`, so the smoke request, the
four outcome states and the capability flags are page 1's own code over `get_provider` and
`connect_provider`. Nothing here re-derives a flag or calls a second endpoint. The pane does not ship
page 1's two exits (`Continue to your Bots`, `Run in replay mode`), because the screen's own footer
owns moving on.

**Skip is honest.** Skip never writes a connection and never picks the job up. A person who skips
after naming a Bot lands in the app with that Bot and an empty composer. A person who skips before
naming one gets `Local Bot`, which is the only path left to the old behaviour.

## Which screen a boot opens

| The store | The vault | The screen |
| --- | --- | --- |
| no Bot | either | the first-run screen |
| a Bot | no connection | page 1, the welcome and connect surface (U4.3's, unchanged) |
| a Bot | a connection | the shell |

Page 1 stays reachable afterwards from the sidebar footer's provider row, which is U4.3's own control.

## The geometry

At each of the nine viewports `DESIGN-MANIFEST.json` names, `packages/verify/scripts/first-run.ts`
measures the screen's frame against the export's own first-run screen, served from the committed file
with its initial screen changed to `firstrun`. Seven fields are compared and all seven are equal at
all nine viewports: the inner column's width, its box, the title's box and font size, the hint's font
size, the brandmark's gap, and the step caption's font size. No delta is declared, because none was
needed. The frame and each of the three panes also carry no horizontal overflow at 360x800 and at
1440x900.

## Deltas and follow-ups

**The provisioning block is not shipped.** The export's `#frProv` shows `Starting your computer` and
`Updating your computer` while a fake sandbox boots (`freebot-prototype.html:649-659`), and `#frFail`
offers `Try again` and `See the logs`. U6.2 may not touch the sandbox, so the fourth moment is the
provider test instead, and the sandbox's own states are a follow-up for whoever wires first-run
provisioning to a real container.

**The name field is empty rather than pre-filled.** The export seeds its own field with its
placeholder text (`freebot-prototype.html:2221` sets `n.value = 'Atlas'`), which makes its primary
never invalid. A screen whose whole job is to stop the app naming a Bot for a person cannot name one
for them, so `Atlas` stays the placeholder and the primary is held down until the field has an answer.

**A job that is not chosen.** The export's pane three hint says a job may be skipped and typed
instead, so its primary is enabled with nothing picked. The record's purpose, by contrast, is what the
pane asks for, so a blank purpose holds that pane's primary down. Skip remains the way past it.

**The provider pane always shows.** On a machine that already holds a connection it paints that
connection's state rather than its empty ask, which is honest but not needed by anyone who already has
a working model. Hiding it where a connection exists is a follow-up rather than a decision this unit
made.
