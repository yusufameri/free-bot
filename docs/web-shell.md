# The web chat surface (U1.5)

Status: PASS. 75/75 harness checks green at commit `326cf65`, driven by
`bun apps/web/scripts/capture.ts`, with eight committed key-state frames under
`packages/verify/artifacts/web-shell/761eca9/`. Verdict: live-ui-verified.

`apps/web` was a README-only placeholder; it is now the surface a user sees. One thread renders
streaming assistant text, tool-call cards and approval cards from the landed protocol DTOs, over a
deterministic replay of the recorded U0.10 smoke session. There is no model, no key, and no network
beyond `127.0.0.1`.

## Shape

```
packages/ui/src/thread.ts        the thread model: the only thing that reads protocol messages
packages/ui/src/frames.ts        the eight key states, their captions, and the distinctness guard
packages/ui/browser/render.ts    the DOM surface: model -> elements, plus the data-* contract
apps/web/host/                   the page shell and the thin host that wires socket to model
apps/web/fixtures/               the two committed replay sessions (allow, deny)
apps/web/scripts/fixture.ts      regenerates the fixtures from the protocol's own spike adapter
apps/web/scripts/server.ts       the replay server: page, bundle, /events, holds, kills
apps/web/scripts/capture.ts      the CDP driver: the eight states, the facts, the PNGs
apps/web/scripts/thread.test.ts  the model over the real fixtures
```

`apps/web` is thin on purpose: it owns the socket, the page and the evidence, and nothing about
what a thread is. Any later surface (desktop, mobile) mounts the same model and the same
`data-*` contract.

## Running the replay

```
bun apps/web/scripts/fixture.ts            # regenerate the committed fixtures
bun apps/web/scripts/server.ts allow       # watch it: http://127.0.0.1:<port>/?auto=allow
bun apps/web/scripts/capture.ts            # the evidence run: frames + assert.txt
bun run --cwd apps/web typecheck           # the surface's own tsconfigs (see below)
```

Server query parameters, all optional:

| Parameter | Effect |
| --- | --- |
| `last_seen_seq=N` | Replay messages with `seq > N`. The host sends its own watermark on every (re)connect. |
| `echo_last=1` | Also resend message `N`, an at-least-once injector for the duplicate rule. |
| `drop_at=N` | On the first connection only, close the socket after message `N`. |
| `hold_before=N[,M]` | Park before message `N` until the page sends `{type: "resume"}`. Holds are consumed once. |
| `auto=allow\|deny` | Answer a parked approval without a click. The driver uses the real buttons. |

`hold_before` is this unit's addition. Without it, a capture of a transient state (a call that is
`running`, a decision that has landed but whose result has not) races the replay, which is how
U0.11's denial frame quietly became a second copy of its terminal frame.

## The eight key states

| Frame | What it shows |
| --- | --- |
| `01-idle` | Connected, the empty thread, the stream not started. |
| `02-streaming` | Assistant text arriving token by token, before the first tool call is announced. |
| `03-tool-running` | A tool-call card running: the literal command and args, no result yet. |
| `04-resumed-after-kill` | Reconnected mid-turn: the resume banner names seq 33, the replayed seq rendered once. |
| `05-approval-pending` | A governed call parked: the card waits, the approval card names the exact command, the stream frozen at seq 55. |
| `06-post-approval` | Allowed once: the decided card, the issued grant, the governed call running. |
| `07-done` | The run finished: all 90 messages rendered, the terminal marker, no card left running. |
| `08-denied` | Denied: the refusal on the approval card, the governed card denied with no output, the run not yet ended. |

## How the evidence is produced

Each frame's facts are read from the live DOM, twice: once before the screenshot and once after, and
the run fails if they differ, so a capture that lost its race cannot be committed. The driver reads
the same facts a second time with its own DOM expression and fails unless it agrees with the
surface's hook. Every caption is a list of predicates over those facts, evaluated at capture time,
so a caption naming a state the frame does not show fails the run. Distinctness is pairwise over the
facts (28 pairs), so two frames may never document the same page whatever their bytes.

A frame also asserts that the element its caption is about actually landed inside the captured
viewport. That is the mechanical half of "the caption must describe what the frame shows": the
asserted facts cannot prove the pixels show them, and this check makes the element's box land
inside the pixels. What it still cannot do is read the image; a human should open the frames in the
PR.

Order 12 asks for a recording rather than stills. No assembler exists on this host (no ffmpeg, no
ImageMagick), so this unit ships the frame sequence plus the harness that regenerates it, and names
the exemption here rather than dropping it silently. The PNGs are content-stable: all eight hashes are
identical between the two runs of this harness, so a re-run reproduces the frames byte for byte.

## Deliberately missing

- **No live model, no provider, no key.** The decision source is the committed fixture (order 9).
- **No framework.** Plan 2.5 names Next.js for `apps/web` and React for `packages/ui`, and plan 2.7
  puts the shared components in `packages/ui`. Neither lands here, for an empirical reason: the root
  typecheck's include matches only `*.ts`, and a `.tsx` file holding `const x: number = "no"` passes
  `bun run typecheck` today (measured). That include list is outside this unit's write scope, so
  shipping components in `.tsx` now would make acceptance 1 green while checking none of the new
  code. The surface is therefore framework-agnostic TypeScript, split so that the shared half lives
  in `packages/ui` as plan 2.7 requires. Moving it onto React and Next.js needs one change to the
  root `tsconfig.json` include, and is the first follow-up below.
- **No auth wiring.** The localhost token and the Origin/Host allowlist are U1.3's; nothing here
  reads or sends one.
- **No multi-thread and no composer.** One thread per page, and the thread's user turn comes from
  `run.started.payload.prompt` rather than from an input box, because `start_run` is not wired yet.
- **No `api.ts` client.** U1.3 owns `packages/protocol/src/api.ts` and had not landed at this base;
  the surface consumes the DTO types and message schemas directly. The adapter from a live
  `get_events` / `approve` / `deny` client onto `applyMessage` is the second follow-up.

## Follow-ups

1. Add `*.tsx` to the root typecheck, then port the surface to the plan's Next.js + React shape.
2. Consume `packages/protocol/src/api.ts` once it lands, and replace the replay server with the real
   `get_events` stream and `approve` / `deny` calls.
3. A human answer that denies a call is recorded as the gate's `no_grant`, because the nine
   `DENY_CODES` have no code for a human refusal (U0.11's decision table calls it `user_denied`).
   Either the taxonomy or the mapping needs a decision.
4. The fixture's `tool_call.decision` messages are derived, because the spike's adapter deliberately
   synthesizes none (`packages/protocol/scripts/spike-map.ts` says why). The real producer is the
   control plane; U1.4 owns it.
