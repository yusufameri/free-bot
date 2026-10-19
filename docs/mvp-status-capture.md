# The MVP status capture (U10.11)

Order 31's readiness routine proves the predicate by booting the app and driving the page. Before
this unit each pass did that with a copy of the previous pass's script. The copy had no owner, so
a landed surface change did not migrate it. At pass 56 the copy still read `#thread .run-status`
after U6.5 moved the run state to `#run[data-run-status]`. The selector matched nothing, the empty
array read as green, and the capture asserted nothing.

`packages/verify/scripts/status-capture.ts` is that script, once. It drives a live instance the
caller started, writes labelled PNGs, a machine-readable facts log and an assertion log, and fails
by selector name when a surface it needs is gone.

## How a pass invokes it

Start the app the way a person does, then pass its URL and the directory the pass wants the
evidence in.

```sh
bun run up --no-open --replay
# copy the printed http://127.0.0.1:<port>/#token=<token> URL

bun packages/verify/scripts/status-capture.ts \
  --url 'http://127.0.0.1:<port>/#token=<token>' \
  --out reports/pass-69
```

The driver removes its own Chrome profile and writes nothing outside `--out`. A pass labels the
directory with the commit it ran at, usually `packages/verify/artifacts/mvp-status/<pass>-<sha>/`.
The token is redacted in `assert.txt` and the driver refuses to write an output that contains it.

## Modes

| Mode | What it drives |
| --- | --- |
| `predicate` | The five states of one run, from the empty shell to the settled transcript. |
| `landing` | `/landing` at 1440x900 and 430x932, with a horizontal-overflow check at each. |
| `both` | The predicate first, then the landing, in one browser. |

The five predicate states are `A-shell-with-bot`, `B-run-streaming`, `C-approval-waiting`,
`D-after-answer` and `E-settled`. Each writes one PNG, one `facts.jsonl` line and its own
assertions.

## The selector table

Every fact is a probe with a subject, one selector and the expression that reads it. A state names
the probes it requires. A probe whose selector matches nothing raises
`missing selector "<selector>" (<subject>)`, so a rename fails the capture instead of reading an
empty list.

| Subject | Selector |
| --- | --- |
| the connection state | `#conn` |
| operator mode | `.shell[data-operator="true"]` |
| the first-run Skip control | `#frSkip` |
| the Bot row | `.bot-row` |
| the composer input | `#prompt` |
| the Start run control | `#start` |
| the Stop run control | `#stop` |
| the run element's id | `#run` |
| the header run status | `#run[data-run-status]` |
| the last sequence counter | `#lastseq` |
| the empty thread's note | `#thread #idle-note` |
| the thread turns | `#thread .message, #thread .turn` |
| the tool cards and their states | `#thread .tool-card` |
| the approval card and its decision | `#thread .approval-card` |
| the approval card's result | `#thread .approval-card .approval-result` |
| the approval actions | `#thread .approval-card .approval-actions button` |
| the approval command | `#thread .approval-card .cmd` |
| the landing title and overflow | `html` |
| the landing heading | `#landing-hero` |
| the landing controls | `#landing-controls a` |
| the landing sections | `.landing h2` |

`packages/verify/driver-subjects.json` names the files whose change obliges this driver to be
re-run and updated, so orders 47 and 49 treat it like any other driver. The files are the shell,
the composer, the thread renderer, the approval card, the header status and the recorded turn the
states are built from.

## In `bun run verify`

`bun run verify` has a `status-capture` step that is skipped by name when `FREEBOT_STATUS_URL` is
unset. CI has no instance, so the step prints `SKIP step status-capture (...)` and the run stays
green. A pass that wants the capture inside the ladder sets the URL, and optionally
`FREEBOT_STATUS_OUT`, before the run.

## Evidence

The committed artifact under `packages/verify/artifacts/mvp-status-capture/` carries the five
predicate PNGs, the two landing PNGs, `facts.jsonl` and `assert.txt`. The verification index row
names the commit the capture ran at, and that commit is an ancestor of the landing.
