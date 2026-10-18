# The command palette, the Bot picker and the modal

Three overlays the export drew and this app did not have. Two of them carry the app's own records;
the third shows one file. All three are driven by a keyboard, and every state the export shows is
either asserted by a driver or written down here as a delta.

The export governs the pixels. `.palette` and `.picker` are its rules at
`freebot-prototype.html:441-493`, the modal is its `.modal` at `:441-450` with the opener at
`:918-931`, the sidebar head's two controls are at `:978-980`, and the action table's own entries are
at `:1794-1802` (`palette:open`, `palette:item`, `picker:open`, `picker:create`, `picker:row`) and
`:1831` (`file:open`). `UX.md:87` and `UX.md:330` govern the behaviour and the copy. Where they
disagree on a visual question the export wins.

## The three primitives and their entry points

| Primitive | Reached from | The export's own door |
| --- | --- | --- |
| The command palette | `Cmd/Ctrl+K` in `all` mode, `Cmd/Ctrl+Shift+F` in `bots` mode, and the sidebar's search button (which is `all`) | `:1987-1989` for the two keys and `:979` for the button, both `data-act="palette:open"` with `data-mode` |
| The Bot picker | the sidebar's `New chat` button and `Cmd/Ctrl+N` | `:980` (`picker:open`, `aria-label="New chat"`) and `:1990` for the key |
| The modal | the details pane's Library row | `:1364` inside the export's `tabLibrary`, the pane's own tab, where the row is `data-act="file:open"` and `:1831` opens `modal({ wide: true })` |

The brief names `openModal` among the export's functions; the export has no such function. Its opener
is `modal(opts)` at `:918` and its closer is `closeModal()` at `:917`, which removes every `.modal`
and `.scrim` and hides the picker and the palette. That is what this app implements.

One overlay is open at a time, which is the export's own model: `openPicker`, `openPalette` and
`modal` each close the other two before they appear (`:2091`, `:2110`, `:918`). The app keeps a stack
one deep for that reason, so `Escape` pops its top and nothing below it.

## The palette

**What it searches, and what it does not.** The rows come from the records the app really holds and
from the controls it really ships:

| Group | Source | Rows |
| --- | --- | --- |
| `Bots` | the app's own `list_bots`, through the shell's loaded list | one row per Bot, named by the record |
| `Threads` | the selected Bot's thread list, which is the record it was read from | one row per thread, titled by the record |
| `Pages` | the controls the app has: the two tabs and the provider page behind the sidebar footer | `Conversation`, `Library`, `Connect a provider` |
| `Actions` | two controls the app has | `New Bot` (which opens the picker) and `New thread` |

Three of the export's six groups have no source here and are declared rather than approximated:
`Routines` and `Groups` are Phase 3 (`UX.md:200-214`, `UX.md:134`), and `Messages` would need a
message-search route. No such route exists at this head: `packages/protocol/src/dto.ts` has no search
operation and `apps/server/src/router.ts` serves none. So the palette ships the MVP subset `UX.md:330`
names ("MVP for the palette, 1.5 for full search"), a quoted term matches nothing, and the no-results
line says so in words rather than pretending to search. **Do not invent a search backend**: the
follow-up is a `search_messages` route and the unit that adds it.

The export's own placeholder for the field (`Bots, settings, actions, routines — or "a quoted phrase"
for messages`) names three groups this app does not have, so the field says what the field does:
`Bots, threads and actions`. The picker's field says `Find a Bot, or name a new one`, which is what
that control does: it filters once three characters land and otherwise offers the create row.
Neither of the export's two placeholder strings ships, and the driver asserts both absent.

**The matching rule is the export's.** A query matches a row's label or its group by substring,
case-insensitively, the group order is the ranking (`UX.md:330`: Bots, then the rest, before
messages), the matched substring is drawn in a `mark`, and the list is capped at the export's forty
rows (`:2136`). A quoted term returns nothing here.

**Every row carries a command, and the host runs it through the same call the matching button
makes.** `New Bot` and `New thread` are `shell.createBot` and `shell.createThread`; a Bot row is
`shell.selectBot`; a thread row is `shell.selectThread`; `Library` and `Conversation` are
`library.show`; `Connect a provider` is `providerPage.show`. Two of them the driver proves by
running both doors and comparing the state they land in: the sidebar row and the palette row leave
one selection, one thread list and one title.

## The picker

The rows are the export's: the create row first, then the Bots, with the hint line under them while a
name is too short to search with. Typing turns the create row into `Create "name" Bot`; three
characters filter the Bot rows; below that the hint counts what is missing. The name a create carries
is the raw field, and `shell.createBot` trims it and answers `New Bot` for an empty one, so the picker
and the sidebar's own name field mint the same name for the same input.

Choosing a Bot selects it, which is what a sidebar row does. The `Creating…` state is the create row
disabled and relabelled while the call is in flight, which is `UX.md:87`'s state and the export's own
`:1797-1800`. The driver reaches it without the page faking a delay: the app's own TCP relay holds
one `POST /rpc/create_bot` back for 900 ms, so the row really waits on a slow server.

## The modal

The export opens a wide modal for a file, with the name as the title, the path on one line and the
byte count as a tag, and the bytes below. This app does the same. The read is the Library's own call,
so the pane's modal and the Library surface's inline view render one read rather than two that can
disagree.

Two states are this app's own rather than the export's, because the export's files never fail and
this app's reads have named refusals: a refused path shows the server's own name (`Could not open
escape.txt: symlink_escape`) and no bytes, and a file longer than the panel scrolls inside it
(`.modal-file` is capped at `50vh`) so the panel stays inside the viewport it was measured in.

## The keyboard

| Key | What it does |
| --- | --- |
| `Cmd/Ctrl+K` | opens the palette in `all` mode, clearing the field |
| `Cmd/Ctrl+Shift+F` | opens the palette in `bots` mode |
| `Cmd/Ctrl+N` | opens the picker |
| `ArrowDown` / `ArrowUp` | moves the active row, wrapping at either end |
| `Enter` | chooses the active row when the field holds the focus; a focused row chooses itself |
| `Tab` / `Shift+Tab` | cycles the focusables inside the open panel, wrapping at both ends |
| `Escape` | closes the topmost overlay and nothing else |

Three of those are this app's own, because a keyboard needs them and the export has none: the arrows
that move the active row, the trap that keeps focus inside an open panel, and the restore that hands
focus back to the element an overlay was opened from. The export's rows are plain buttons with no
selection state at all; the active row here wears the export's own hover wash
(`--hover-2`, `:476`), and the driver asserts that the row under the pointer wears the same colour as
the row the arrows moved to.

Two facts about the harness rather than the page: the driver reads `document.activeElement` for every
focus claim, never a handler's intent, and it lands running transitions before it reads a colour,
because a background target does not advance its own animation clock.

## What proves it

`bun packages/verify/scripts/overlays.ts` runs in headless Chrome against one really launched app and
its artifact lands at `packages/verify/artifacts/overlays/<short-sha>/`, with the PNGs it captured.
Its sections, in order:

1. what it runs: `bun run up --no-open --replay` over a fresh home and bots root, its own placeholder
   vault at mode 600, two Bots it makes over `/rpc`, a workspace holding a note, a 400-line file and
   a symlink out of the tree, and the relay that holds one create back;
2. the three primitives and the entry point each is reached from;
3. the palette: the empty query, the marked result, the no-results state, a quoted term, the `bots`
   mode, the arrows and the wrap, hover, the trap, and a keyboard-only open-move-choose-close;
4. the picker: the default rows, the two hint lengths, the three-character threshold, the filtered
   rows, the trap, and the create in flight;
5. the modal: the pane's row reached by Tab, `Enter` opening it, the title, the path, the size, the
   bytes, the close control, the trap, `Escape`, the scrim, the named refusal and the long file;
6. the palette as another door to the same room, against the sidebar's own rows;
7. where the export's chrome and its prototype data were looked for;
8. the nine `DESIGN-MANIFEST.json` viewports with each overlay open;
9. containment, by label.

## Deltas and follow-ups

The Library surface's own rows still open the file in its own inline view, while the pane's row opens
the modal. That is a real difference between two doors to one file, and it stands for two reasons: the
export opens the modal from the pane's tab (`:1364` is inside `tabLibrary`), previews are Phase 2
(`UX.md:256`, "MVP for the file list, 2 for previews"), and the surface's inline view is landed
evidence that its own driver asserts. Moving the Library surface's row onto the modal belongs to the
unit that owns previews.

The sidebar keeps its own name field and `New Bot` button beside the export's two head controls. That
control is U4.2's, it mints the same record through the same arm, and its own driver drives it; the
picker is the export's richer door to the same creation. Removing one of them is a product decision,
not a fidelity one.

Three follow-ups: a message-search route and the palette's `Messages` group with it; the Library
surface's row moving onto the modal when previews get their own unit; and `Escape` reaching the
pane's own card menus when those exist, which is U6.5's surface. `docs/DESIGN-CONTRACT.md` carries the
delta list with the measured pixels.
