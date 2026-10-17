# Web-stream spike (U0.10): a seq-ordered stream in one page

Status: PASS. 59/59 driver checks green across both answer paths (29 allow, 30 deny) at commit
`22433c7`, driven by `bun spikes/web-stream/run.ts`. Artifacts:
`packages/verify/artifacts/web-stream/<short-sha>/` (`assert.txt` plus 12 timestamped PNGs).
The page is the renderer the Phase 0 smoke reuses; here it runs off a stub replay of a recorded pi
RPC session, independent of G1.

## Question

Does the seq protocol survive contact with a rendering surface: does an event stream in dense seq
order render turns, tool-call cards, and an approval gate in one page, and does a mid-stream
disconnect resume from `last_seen_seq` without a gap, a duplicate, or a double render?

## Shape

```
page.html        static shell, element ids the driver asserts on
app.ts           browser module: socket, render, fail-loud on gap; window.__webStreamState() test hook
envelope.ts      the display envelope types and reducer state (frozen)
map.ts           recorded pi frames -> display frames (dense seq, approval gate inserted)
reducer.ts       pure state machine: applyFrame, duplicates ignored, gap throws
reducer.test.ts  11 tests, literal expectations, real fixture
stub-server.ts   Bun.serve: page + /bundle.js + /events replay; standalone-runnable
run.ts           CDP driver: allow and deny flows, screenshots, assert.txt
```

`stub-server.ts` bundles `app.ts` with `Bun.build` at startup; no framework, Bun built-ins only.
The fixture is the committed U0.7 transcript
(`packages/verify/artifacts/tunnel/bf0a4e6/transcript.jsonl`, scenario `a`, 124 seq-stamped pi
frames). The stub paces the replay at 90 ms per frame so a human can watch it; the driver reads
the same pacing.

## Display envelope

The spike-local envelope is `{seq, type, payload}` with types `turn_start`, `message_delta`,
`tool_call`, `tool_result`, `approval_request`, `approval_resolved`, `turn_end`, plus the
stub-only terminal `stream_end`. The production envelope with zod schemas arrives with T2
(`packages/protocol`); this shape exists to render and to prove the ordering contract.

The mapping from pi frames to display frames:

| Pi frame | Display frame | Notes |
| --- | --- | --- |
| `turn_start` | `turn_start {turn}` | turn counted 1..4 |
| `message_update` (`text_delta`) | `message_delta {text}` | one frame per delta |
| `tool_execution_start` | `tool_call {toolCallId, toolName, command, destructive}` | `command` is `name + JSON args`; `destructive` marks the gated call |
| `tool_execution_end` | `tool_result {toolCallId, ok, denied, output, durationMs}` | output is the text parts of the pi result |
| (inserted before the gated result) | `approval_request`, then `approval_resolved {decision: null}` | the stub fills the decision with the page's answer |
| `turn_end` | `turn_end {turn}` | |
| everything else | dropped | `response`, `agent_start/end/settled`, `message_start/end`, `text_start/end`, `toolcall_start/delta/end` |

Display seq is a dense renumbering of the mapped subset (1..84), not the pi seq. The real pipeline
will carry the pi-minted seq directly; the spike keeps density so the page can assert
`seq === lastSeq + 1`, and so a dropped frame type cannot fake a gap. Dropped frames are the
documented cost of that choice.

One deviation from the brief: the transcript's tool is `spike_echo`, the keyless stub model's
extension tool, not a bash command. There is no bash call anywhere in this fixture, so
`call_spike_2` is the step marked destructive, with the same gating semantics. The real bash tool
path arrives with the live pipeline (T2, G1).

## Stub protocol

`GET /events` upgrades to WebSocket. Query parameters:

- `last_seen_seq=N` — replay frames with `seq > N`.
- `echo_last=1` — also resend frame `N` itself, an at-least-once injector proving the page's
  dedupe against a real socket.
- `drop_at=N` — on the first connection only, close the socket right after sending frame N.

The page answers an approval by sending `{type: "answer", decision: "allow" | "deny"}` on the same
socket. The stub holds the stream at the `approval_resolved` frame until the answer arrives (60 s
timeout), then sends the resolved frame and continues. On `deny` it rewrites the gated
`tool_result` to `{ok: false, denied: true, output: "denied: user denied approval"}`, because the
tool never ran.

Both answer paths are scriptable without a click: load the page with `?auto=allow` or `?auto=deny`
and the page answers itself when the approval card appears. The driver uses the real buttons
(`Allow once` / `Deny`) through `Runtime.evaluate`.

Standalone for manual watching: `bun spikes/web-stream/stub-server.ts`.

## Reconnect and resume

`drop_at=30` closes the socket mid-turn-2 right after frame 30. The page's socket close handler
reconnects after 250 ms, naming its `lastSeenSeq` in the URL. On open with `lastSeenSeq > 0` the
page shows the persistent banner `resumed from seq 30` (`data-resumed-from="30"`).

Idempotency has two proofs. The reducer drops any frame whose seq it has already applied and counts
it (`duplicates ignored: 1` in the header; unit test asserts `frameCount` unchanged with a literal).
The live socket resends seq 30 on resume (`echo_last=1`) and the driver asserts the DOM holds
exactly one element with `data-seq="30"` and the frame count still equals `lastSeq`.

Fail-loud: a gap (`seq !== lastSeq + 1`) or a seq that passed unseen throws in the reducer; the
page catches it, shows a red `stream error: gap: expected seq N, got M` banner, and stops the
stream. Unit tests pin both messages against literal strings.

## Evidence

`bun spikes/web-stream/run.ts` runs the whole flow twice on a fresh stub per path, in headless
Chrome 155 driven over CDP via bun's WebSocket client. Per path it asserts DOM facts against
literal expected values: `#conn` text, zero frames at idle, dense ascending seqs, the banner text,
the single element for the echoed seq, `duplicates ignored: 1`, awaiting-approval state frozen at
`lastSeq 53` for 700 ms, the approval buttons' labels, the decision text (`allowed once` / `denied`),
the gated card's status and output (`echo: two` on allow, empty and `echo: two`-free on deny),
markers at seqs 54 and 55, then 84 frames, 4 turns, and the three card statuses.

The 12 committed frames, one pair per path:

| Frame | What it shows |
| --- | --- |
| `*-01-idle` | connected, `last seq 0`, no frames |
| `*-02-streaming` | turn 1 text streaming, first tool card done with output |
| `*-03-reconnect-resume` | `resumed from seq 30`, `duplicates ignored: 1`, stream continued |
| `*-04-approval-pending` | destructive card `AWAITING APPROVAL`, approval card with Allow once / Deny, `last seq 53` frozen |
| `*-05-resolved` | allow: `allowed once`, card `DONE`, output `echo: two`; deny: `denied`, card `DENIED`, no output |
| `*-06-done` | all 84 frames, 4 turns, `stream complete` |

Rerun is deterministic in structure: same fixture, same dense seqs, same drop point, fixed 90 ms
pacing, localhost only. PNG bytes vary run to run (antialiasing, timestamps in filenames).

A video recording of this surface is deferred by standing order 12: no assembler exists on this
host and Phase 1.5 owns the recording and golden-screenshot infrastructure. The committed frame
sequence with its assertion log stands in as the interim proof.

## Limits

- The fixture's tool is `spike_echo`; this is not yet the real bash/filesystem tool path. U0.10
  proves ordering, rendering, gating, and resume, not tool semantics.
- The destructive call is marked by id in stub options, not by any policy evaluation.
- One thread, one page, no auth; the smoke's localhost token and envelope come later.
- Presentation is deliberately plain; the MVP surface restyles it. Only the DOM ids and card
  statuses are a contract and are exactly what the driver asserts.
