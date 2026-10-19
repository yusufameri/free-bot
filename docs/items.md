# The conversation's items and the Bot row

U6.5 makes the transcript's items the export's items and gives the Bot row a status derived from a
run. The visual contract is `design/prototype-84c6b185/freebot-prototype.html`; this note records
what the surface decides and where the record stops short.

## The items

- **Approval card.** `.tcard.gate` with `.tcard-head.gate-head`, a 2px `.gate-bar`, the body, a
  plain-word proposal, `View the full request` (a disclosure over the exact command), the scope and
  expiry row, and `Allow once` / `Deny`. Four states are reachable and distinct: `pending`
  (`Approval needed`, pulse, buttons), `allowed` (`Allowed once`, filled dot, the grant sentence),
  `denied` (`Denied`, ring, `Nothing ran`), and `expired` (`Expired`, ring, the window ran out
  unanswered). The card is the only place the approval fact appears.
- **Tool card.** `.tcard` with a status dot or pulse, `Tool call`, a `pending`/`done` tag, the
  command in a `.codeblock` with a copy control, and an output disclosure that opens when the result
  arrives. `running`, `done`, `denied` and `failed` are reachable; `failed` is a call that ran and
  reported a non-zero outcome, which is distinct from a denial. The card is the only place the
  result or the decision appears.
- **Turn marker.** One `.tm` per turn with a pulse and one of `Thinking it through`,
  `Working on your computer`, `Waiting on results`. The text follows the turn's phase: a new turn
  is thinking, a requested or parked call is working, and a result landing is waiting. There is no
  separate `.turn-title` and no `.turn-end` line, and no `.tool-decision`, `.tool-result`,
  `.approval-resolved`, `.run-status` or `.grant-lifecycle` marker either.

## The Bot row

The row is the export's `.sb-row`: a status dot, the name, and one sub line.

| Status | Dot | Sub line | When |
| --- | --- | --- | --- |
| `working` | `.pulse` | `working` | a run of that Bot is `queued`, `running`, `paused`, or `awaiting_approval` and no run is parked |
| `attention` | `.dot.on` | `needs you` | any run of that Bot is `awaiting_approval` |
| `failed` | `.dot.ring` | `failed` | nothing is in flight and the newest run failed |
| `idle` | `.dot` | the role's first word, or empty | everything else |

The derivation is `deriveBotStatus` in `packages/ui/src/bots.ts`. It reads the runs the shell holds
for every Bot: `load` and `refresh` call `list_threads` once per Bot, so a row's status is a real
per-Bot read rather than a label. While a run is on screen its stream outranks the store between
reads (`liveBotStatus`), and the override is cleared once the run's record is re-read at the end.

## The deltas this unit cannot close

- **Group chats and hidden Bots have no record.** The export's `botRow` and `renderSidebar` read
  `group`, `members`, `paused`, `holder`, `pinned`, `primary`, `section`, `initials`, and
  `state: hidden` (`freebot-prototype.html:962-999`, `:1054-1065`). This app's Bot record is
  `botId`, `name`, `role`, `purpose`, `createdAt`, `threadCount`; it carries none of those fields,
  so no group row and no hidden group is rendered and no fake Bot is seeded. Group chats are Phase 4
  (`UX.md` 5b) and `hidden` has no action that could produce it. `docs/DESIGN-CONTRACT.md` carries
  the delta and the export lines.
- **`unread` has no record either.** The export's `state: unread` (`:958`, `:964`) needs a
  per-thread or per-Bot read marker; the run record carries none.
- **The gate's countdown is static.** The card reads `expiresAt` when the request arrives and paints
  the bar once. A ticking bar would need a page timer and a second source for the remaining time;
  the expiry row names the seconds the request arrived with, and the `expired` state is the real
  timeout.
- **`Always allow · phase 5` is absent.** The export's pending card carries it (`:1132`); it is
  Phase 5 and this app has no rule store to write.
- **The copy control is labelled.** The export's copy control is an icon from its sprite
  (`:1112`); this page's sprite has no copy glyph, so the button reads `Copy` with an aria-label.
- **The output summary counts lines.** The export's seeded card counts matches (`Output · 2
  matches`, `:1113`); a bash call's output has lines, not matches, so the card counts those.

## A follow-up the evidence found

A second run of the same command in one process is denied `grant_consumed` rather than parking
again. The ledger is process-wide and a consumed grant is read as a refusal
(`packages/review/src/policy.ts:143-144`), so a person who allowed `echo hi` once is not asked again
for the same command until the process restarts. That is the landed gate's behavior, not this unit's
decision. The evidence driver therefore runs the expired state under a second launch over the same
bots root, which brings the Bots and the transcript back. Whether a consumed grant should re-park is
a policy question for the unit that owns the ledger.

