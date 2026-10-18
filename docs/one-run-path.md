# One run path (U2.1)

`apps/server` carried two run surfaces. U1.7 landed the loop behind Hono routes (`POST /runs`,
`POST /approvals/:id/allow`, `GET /runs/events`), and U1.3 landed an in-memory control plane behind
the oRPC router (`start_run`, `cancel_run`, `get_run`, `subscribe_events`). Only the loop executes
anything, so a client on the oRPC surface could start a run that never ran: the control plane minted
`run.started` itself and kept its own run table.

This unit deletes the second surface. One `RunService` now owns a run, the oRPC router and the page's
stream are two transports over it, and the page starts, watches and answers a real run.

## Shape

```
apps/server/src/run-service.ts        the run authority: one SeqLog, one RunStore, the loop behind it
apps/server/src/router.ts             the four oRPC handlers, all over RunService
apps/server/src/api-server.ts         the operator server: /rpc, /rpc-ws, /events, / and /main.js
apps/server/src/app.ts                healthz only now
apps/server/src/run-ports.ts          the landed packages adapted into the loop's ports
apps/server/src/run-service.test.ts   the service's own contract: one log, many runs, many readers
apps/server/src/router.test.ts        a run started over start_run, its frames read off the stream
apps/server/src/api-server.test.ts    the gate and the three transports
apps/web/host/main.ts                 the page: connect, drive the thread model, start and answer
apps/web/host/index.html              the page markup, including the operator's prompt box
apps/web/scripts/one-run-path.ts      the evidence driver: the real server, the real page, two runs
```

## What was deleted, and what owns a run now

Deleted: `apps/server/src/control-plane.ts` in full, the Hono `runRoutes` in `run-service.ts`, and
the `app.route("/", runRoutes(runService))` mount in `app.ts`.

A run is now owned by `RunService` and nothing else. It owns the `SeqLog` that records it, the
`RunStore` that holds its status, the `GrantStore` and refusal set behind the gate, and the pending
approvals that answer a park. `start(prompt)` creates the record and launches the loop; `cancel` and
`answer` reach the same store and the same consent port. `stream(lastSeq, signal)` is the one reader,
and every stream is a view of it: `subscribe_events` over oRPC and the page's `/events` socket
subscribe to the identical generator.

The four oRPC procedures keep their names and their wire shapes. `get_run` projects
`packages/core`'s seven statuses onto the contract's three arms through a `Record` over the core
union, so a status the core model adds is a compile error here rather than a silent read of
`running`. `startedAt` is the record's `createdAt`, `endedAt` is its `updatedAt` once the status is
terminal, and `lastSeq` is the log's head at read time, which is the watermark a display resumes from.

The detection that matters: `start_run` returns before the loop does anything, so the record is
created in `start` rather than inside the loop. A `cancel_run` or a `get_run` that arrives in the
same tick as `start_run` has a run to address. The loop's own `store.start` for that id is a no-op.

## The transports, and the token contract

| Surface | Transport | Gate |
| --- | --- | --- |
| `start_run`, `cancel_run`, `get_run` | `POST /rpc/<name>` | `Host`, then `Origin`, then `Authorization: Bearer <token>` |
| `subscribe_events` | `ws://…/rpc-ws?token=<token>` | the same three, the token from the query |
| the page's stream and its two control messages | `ws://…/events?token=<token>` | the same three, the token from the query |
| the page markup and its bundle | `GET /`, `GET /main.js` | `Host` only |
| liveness | `GET /healthz` | `Host` only |

The token contract U1.3 set is unchanged: one token minted per launch, printed once by
`apps/server/src/index.ts`, never stored, compared hash-first, accepted as a bearer header on
`/rpc` and as `?token=` on a WebSocket upgrade because a browser cannot set headers on one. The
evidence still asserts the token appears exactly once in the server's output and in no artifact.

A WebSocket cannot carry a header, so the page's token has to be somewhere a URL can hold. The page
reads it from the **URL fragment**: `http://127.0.0.1:<api-port>/#token=<token>`. A fragment is the
one part of a URL a browser never sends to a server, so the token reaches no access log and no
`Referer`, and the page copies it into the socket's query string, which is the single query read the
gate performs. `docs/server-auth.md` records the consequence: the page markup itself answers the
`Host` check and nothing more, which is affordable because it is static markup carrying no run state.

The page's two control messages are `{type:"start",prompt}` and `{type:"answer",decision,approvalId}`.
Both land on `service.start` and `service.answer`. There is no third place a run can be started from.

## Operator mode, and why the fixture page did not change

The prompt box is revealed when the page is opened with a token, and hidden otherwise. That one rule
is what keeps `packages/verify/artifacts/web-shell` reproducible: the fixture server
(`apps/web/scripts/server.ts`) serves the same page with no token, so the page it renders is the page
it rendered before this unit, and its committed frames stay valid.

Rendering the run's status is the other page change. The loop emits `run.status` at every transition
and the page rendered none of them, so a run parked at the gate looked like a run that had frozen,
and one rendered message per seq could not hold. `packages/ui/browser/render.ts` gained the arm. It is
additive and invisible to the fixture page, whose committed fixtures carry no `run.status` frame.

## The evidence

`bun apps/web/scripts/one-run-path.ts` writes
`packages/verify/artifacts/one-run-path/<short-sha>/assert.txt` and one PNG per asserted state. It
boots `apps/server/src/index.ts` as an operator does, reads the token and the port out of its
standard output, asserts both directions of the token on the page's stream, opens the page in headless
Chrome with the token in the fragment, starts a run from the page's own prompt box, and answers the
approval card once allow and once deny, with one server per path so each page's stream carries
exactly one run.

| Real | Replayed | Pinned |
| --- | --- | --- |
| the loop, the gate and its grant ledger, the run store, the seq log | the model's turns, from `packages/pi-bridge/fixtures/rpc-handshake.jsonl`, because this driver boots the driver-facing `apps/server/src/index.ts`, which states the replay provider so a recorded turn is what the assertions hold (order 9) | the sandbox image, `freebot-sandbox:u0.6` |
| the container the run creates and destroys, and its stdout | | |
| the server, the two sockets, the page and the DOM | | |

The four committed states are the idle operator page, the parked approval, the allowed run at its
terminal frame, and the denied run at its terminal frame. There is deliberately no "answered, still
running" frame: after a decision the loop appends the rest of the run in one synchronous burst and
turn 2 asks for no call, so such a frame would race the finish and fail as often as it passed. The
decided card, the `user_denied` marker and the container's own stdout are asserted in the terminal
frames, where nothing races.

Two facts in the artifact are the reason the verdict is `live-ui-verified` rather than a test result.
The allowed run's tool card shows the string `native-should-not-run\n`, which is the container's own
stdout and not a replayed frame. And the denied run's decision marker reads
`decision <toolCallId>: deny (user_denied)`, which no surface could produce before this unit's fold
because the run that produced it never ran.

## Two defects this unit found and fixed

**One log, one counter.** The log port seeded a private seq counter from the log's tail when the port
was built. One service serves every run from one log, so two runs that started in the same tick both
held a counter starting at the same slot, the second run's first frame was refused as a duplicate,
and the rejection took the server process down. The seq is now read from the log at append time, so
the log's own `lastSeq` is the only counter there is. `run-service.test.ts` starts two runs in the
same tick and asserts both finish over one dense seq space.

**Read-then-wait loses a wake.** The stream registered its append waiter *after* reading the log, so a
frame appended while the reader was between the read and the wait woke nobody and the reader slept
through frames the log already held. The waiter is now registered before the read: an append is
either already visible to the read or it resolves the waiter the read registered. `router.test.ts`
catches it, because a run started after the subscribe appends its opening frames in a burst.

A third fix is defensive. The sandbox is named from the run id, which is `run-<n>` per process, so a
container a hard-killed launch left behind collided with the next launch's `run-1` and its run failed
as `sandbox_unavailable`. The user-visible run id stays readable and the container name now carries a
per-launch tag.

## What remains

- **A killed launch leaks its container.** The loop destroys its sandbox on every path it can reach,
  and a `SIGKILL` reaches none of them: the container survives with no process to remove it. Nothing
  sweeps stale containers at startup today, and the per-launch name tag only stops that from breaking
  the next launch. A startup sweep, or recording the handle so a repair pass can find it, is the fix.
- **Concurrent runs share one thread.** One `SeqLog` and one page hold every run, so two runs started
  at once interleave their frames in the order they happened, and a page that joins a log with two
  runs renders both. The page is built for one run at a time; a run selector is the surface work.
- **A page that joins an existing log replays all of it**, including runs that finished before it
  opened. That is the resume contract working as designed, and it is what makes the second path's
  fresh server necessary in the evidence.
- **The keyed model is not this unit's.** This unit's evidence pins the replay provider, because it
  boots the driver-facing `apps/server/src/index.ts` and asserts a recorded turn (order 9). The real
  path is the factory's choice: `auto` follows the vault and builds a real `KeyedProvider` when
  `~/.freebot/provider.env` holds a key. `packages/verify/scripts/keyed-run.ts` (U2.4) is the driver
  that exercises it and asserts the model's own turns.
- **`get_events`, `approve` and `deny`** still have zod shapes and no contract arm. The page's stream
  is how an approval is answered today, and the oRPC contract gains `approve` and `deny` when a
  client that needs them lands. `list_files` and `read_file` gained their arms in U4.1, backed by the
  run service's workspace reader; `docs/files-surface.md` is that unit's page.
