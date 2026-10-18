# FreeBot glossary

One entry per word, one meaning each. Every entry names the file it was read from, and the code
wins wherever a document and the code disagree. A word this project uses in more than one sense
carries an **Overload** line naming each sense and when to use which.

The words are the ones the code and the docs already use. Nothing here renames anything.

---

**artifact.** A committed file that holds what one evidence run observed, under
`packages/verify/artifacts/<feature>/<short-sha>/`: `assert.txt` with the literal checks, one PNG per
asserted UI state, and the feature's own fixtures. The latest green run per feature is kept and the
path is built by `artifactDir`.

Source: `packages/verify/src/index.ts`; the pipeline is plan Part 9 §9.3.

**Bot.** A named agent with its own instructions, memory, and computer. The app keeps it as a record
with an id, a name, a role, and a purpose, and that record owns a workspace directory and holds many
threads. The id is minted by the server and is one path segment; the first Bot in a fresh bots root
takes `bot-local`.

Source: `UX.md` vocabulary, the Bot row; the record's fields are in `packages/protocol/src/dto.ts`
(`botSchema`).

**Bot store.** The `BotStore` registry at `<bots root>/index.jsonl`: an append-only journal of two
commands, `bot.create` and `thread.create`, each idempotent by record id and replayed at boot. It is
the second store rather than a second convention, and it holds the two records that outlive a run. A
`thread.create` for a Bot the journal does not hold is refused by name.

Source: `packages/core/src/bot-store.ts`.

**brief.** The work order one worker is spawned with. It carries GOAL, SCOPE, CONTEXT, ACCEPTANCE,
VERIFY, TIMEBOX, FORBIDDEN, REPORT, and STANDING, and STANDING is `preferences.md` pasted verbatim.

Source: plan Part 9 §9.5; the live exemplars are the files under the store's `briefs/`.

**capability flag.** A fact about how one provider connection drives Pi's tool pipeline, observed in
one real turn and never guessed from a model name. `toolCalling` is `strong`, `weak`, or `none`;
`streaming`, `structuredOutput`, and `contextWindow` are observed or explicitly `null`; `notes`
carries what the observation could not settle. The derived table drives the provider page's
`capable` / `limited` / `untested` status.

Source: `packages/providers/src/flags.ts` (`CapabilityFlags`, `observeTurn`).

**computer.** The product's word for the sandbox container a Bot works in, as a person sees it on
the page. It is the same thing the code calls a sandbox or a container.

Source: `UX.md` vocabulary, the Computer row.

**container.** The Docker realization of one sandbox: one image, one name, one set of labels, created
per run and destroyed on every path that ends a run. Containers carry a per-run token in the name and
in the `freebot.unit` label so cleanup is label-scoped to the unit that made them.

Source: `packages/sandbox/src/docker.ts`; cleanup rule in `preferences.md` order 22.

**coordinator.** The one session that runs the program: it authors briefs, cuts and dispatches the
next ready units before any other bookkeeping, drains them, and merges. It never writes code, and
every act it takes is a brief, a drain, a landing, or a decision.

Source: `preferences.md` orders 3, 15, and 35.

**the design contract.** The exported prototype as the binding visual specification: visuals,
geometry, tokens, motion, and the nine-viewport responsive matrix. Where it conflicts with `UX.md` on
a visual question the export wins; where they conflict on behavior `UX.md` wins. The document of the
same name records what the export says, which of its files governs which surface, and every delta the
app still has.

Source: `docs/DESIGN-CONTRACT.md`; the standing order is `preferences.md` order 32.

**drain.** A coordinator pass that reads what landed, reconciles the store, and moves the frontier
forward. It merges finished branches by merge-forward with the union of both sides when units share a
file, records a ledger row only after the merge returns MERGED, and dispatches the next wave. A drain
never writes code.

Source: `preferences.md` orders 3, 28, and 35.

**driver.** A script under `packages/verify/scripts/` (and the older ones under `apps/web/scripts/`
and `apps/server/src/`) that drives the real product the way a person does, asserts literals it read
from that run, and writes its `assert.txt` and its PNGs into an artifact directory. A driver is the
thing that makes a verdict more than an assertion.

Source: `packages/verify/scripts/bots-and-threads.ts` and its siblings; plan Part 9 §9.3.

**evidence.** What a run of the committed product observed, written down. Evidence beats a claim: a
feature is done when a script drives the real surface and commits what it saw, not when its code
merges and CI is green. Where the product cannot be driven for real, the artifact says so and labels
the substitute.

Source: `VISION.md` ("Evidence beats a claim"); plan Part 9 §9.3.

**the export.** The OpenDesign handoff and its two HTML exports, committed byte-identical as a frozen
artifact at `design/prototype-84c6b185/` and excluded from the formatter. `freebot-prototype.html`
(214 KB) governs every visual question; `freebot-prototype-v1.html` (72 KB) is the handoff's declared
entry file and carries an older token set and a superseded 980px breakpoint. `DESIGN-MANIFEST.json`
carries the machine-readable map.

Source: `docs/DESIGN-CONTRACT.md`; the standing order is `preferences.md` order 32.

**frame.** One log-ordered message on the wire: `{v, seq, ts, runId, type, payload}`, stamped with
its `seq` once by its origin, the sandbox supervisor. `stream.*` markers are the exception; they
address log positions and carry no `seq`.

Source: `packages/protocol/src/envelope.ts`.

Overload. `frame` is also the app's outer layout, the shell or the aside shell, as in "the frame
every later parity unit sits in" and "this frame is 384px". A wire frame is a message; a layout frame
is a region. The design documents mean the second sense.

**frontier.** The set of units currently in flight, named as the PR list with their head SHAs. It is
the coordinator's working set, recomputed on restart.

Source: plan Part 9 §9.10 ("the frontier, PR list plus SHAs") and §9.9 ("recompute the frontier"); the
live copy is the store's `frontier.json` and `status.md`.

**gate.** A control that stands between a proposed tool call and its execution. The gate lives in the
control plane (`createGrantPolicy`), it allows a call only when it consumes a matching live grant,
and every other path denies with one of ten named codes. The denial code the loop acts on is a
`GateVerdict`. The two denial codes a human answers, `no_grant` and `grant_mismatch`, park the run;
every other denial is fail-closed and never becomes a prompt.

Source: `packages/review/src/policy.ts` and `packages/core/src/run-loop.ts` (`GateVerdict`).

Overload. `gate` is also the program's word for a parked human decision, as in "gate G1" and
`gates.md`. A gate in the product judges one tool call; a program gate is a question for the human
that parks while work continues around it. The store's `gates.md` and plan Part 9 §9.8 mean the
second sense.

**landing.** A unit's recorded merge, written down only after the merge lands: the ledger row and the
store's mark of done follow the MERGED result, never precede it. Landing is continuous, not a
terminal phase.

Source: `preferences.md` order 28; plan Part 9 §9.9.

Overload. `landing` is also the product's landing page, the one surface the export adds and U6.6
builds as its own route. A landing in the program is a merge; a landing page is a screen.

**the matrix.** The nine viewports the export's `DESIGN-MANIFEST.json` names, each with
`mustAvoidHorizontalScroll: true`: 360x800, 390x844, 430x932, 600x960, 820x1180, 1024x768, 1366x768,
1440x900, and 1920x1080. A parity claim is checked at each of them rather than at one.

Source: `docs/DESIGN-CONTRACT.md` ("The responsive matrix"); `design/prototype-84c6b185/`
`DESIGN-MANIFEST.json`.

Overload. Other tables in these docs are also called matrices, such as the refusal matrix in
`docs/server-auth.md` and the capability truth table. Unqualified, `the matrix` means the nine
viewports. A different matrix is named where it is used.

**provider.** A connection that answers a model's turns. FreeBot targets the OpenAI-compatible
contract, so any `/v1/chat/completions` endpoint is a provider, keyed by `FREEBOT_BYOK_KEY` in the
vault. A provider carries capability flags and is saved and tested from the provider page.

Source: `docs/providers.md`; the route is `apps/server/src/provider-setup.ts`.

Overload. The code also says provider for the sandbox backend: `SandboxProvider`, and
`ProviderId` = `docker | e2b | boat | firecracker`. A model provider answers turns; a sandbox provider
runs the computer. This glossary writes "model provider" or "sandbox provider" when a sentence would
otherwise be ambiguous.

**replay.** The keyless mode where the model's turns come from a committed Pi transcript instead of a
live endpoint, so tests and demos cost nothing and repeat exactly. The launcher prints `keyless,
replaying`, and a run labels its replayed turns. Replay is a whole provider (`ReplayProvider`), not a
mock inside the loop.

Source: `apps/server/src/replay-provider.ts`; `docs/RUNNING.md` ("The model").

**run.** One execution from a prompt to a terminal state. A run names the Bot it acts for and the
thread it appends to, both records existing before the loop starts, and it carries its own status
trail and its own seq space. `RunStore` owns the record.

Source: `UX.md` vocabulary, the Run row; the record is in `packages/core/src/run-store.ts`.

Overload. The verify harness also says "a run" for one execution of a driver, as in "the run's own
output". A product run is one agent execution; a verification run is one driver's pass. The
`docs/VERIFICATION.md` rows and the artifacts mean the second sense.

**run journal.** One file per thread, `threads/<threadId>/runs.jsonl`: the `RunStore`'s append-only
journal of run commands, replayed at boot so a restart brings a thread's runs and their prompts back.
It is not the frame log; frames of a finished conversation are the live `SeqLog` and are not
persisted.

Source: `packages/core/src/run-store.ts`; `docs/bots-and-threads.md` ("A thread's runs").

**sandbox.** Either the `SandboxProvider` interface from plan 2.6, frozen against the strictest
adapter, or the one sandbox a run creates through it: a `SandboxSpec` becomes a `SandboxHandle`, and a
capability a provider lacks is a typed `UnsupportedCapabilityError` at call time, never a silent
no-op. Docker is the adapter that runs today; the interface is what keeps the others behind one
contract.

Source: `packages/sandbox/src/interface.ts`.

**seq.** A message's own place in the one log. It starts at 1, is sticky, and is never reused; `0` is
a reader's cursor and never a message. The origin mints it once, every transport reads the one log,
and a rejoin names `last_seen_seq` to receive exactly the frames after it. `SeqLog.audit()` recomputes
gaps and duplicates from the stored entries rather than trusting a counter.

Source: `packages/core/src/seq-log.ts`; `packages/protocol/src/envelope.ts`.

**thread.** One conversation with one Bot. A thread holds many runs, owns its own run journal and its
own in-memory `SeqLog`, so its seq space is its own and a stream must name the thread it follows.

Source: `UX.md` vocabulary, the Thread row; `docs/bots-and-threads.md`.

**track.** A lane of the plan's execution program: T0 scaffold, T1 Phase 0 spikes, T2 control plane
MVP, T3 sandbox, T4 web surface, T5 verification harness, T6 design parity, and the tracks added
later for connectors and sandbox backends. A unit belongs to exactly one track.

Source: plan Part 9 §9.2; the live assignment is the `track` column of the store's `units.tsv`.

**turn.** One model response inside a run, including the tool calls it asked for. The outcomes of one
turn are the `results` of the next, and a turn with no tool calls ends the run.

Source: `UX.md` vocabulary, the Turn row; the loop's step is in `docs/run-loop.md`.

**unit.** One briefed piece of work with its own branch, its own evidence, and one writer: `U7.1` is
this glossary. Its id is `U<track>.<n>` and it is recorded as one row in `units.tsv`.

Source: the store's `units.tsv` and `briefs/`; the rule is `preferences.md` order 3.

Overload. Two other senses share the word. A "unit test" and the verdict `unit-test-verified` mean a
`bun test` suite rather than a briefed piece of work, and the container label `freebot.unit` names the
work unit that created a container so cleanup stays label-scoped. The `units.tsv` rows and a brief
mean the first sense.

**vault.** The one file outside the repo where a key lives, `~/.freebot/provider.env`, at mode 600.
The run path reads it in-process and never through the environment, and it is the only place a BYOK
key or a connector token may sit. An absent vault is the keyless machine and is not an error.

Source: `apps/server/src/vault.ts`; the rule is `preferences.md` order 8.

**verdict.** The label a `docs/VERIFICATION.md` row carries for one feature: `live-ui-verified` when a
driver drove the real surface, `unit-test-verified` when a test suite is the surface, `type-check-only`
for the type gate, `spike-verified` where a spike's own driver is the only cover, or `docs-only` where
the check is a reading of a document and no driver runs. CI green is an input to a verdict, never the
verdict.

Source: `docs/VERIFICATION.md`; the values are named in `VISION.md`.

Overload. The gate's answer for one tool call is also called a verdict (`GateVerdict`, "the gate's
verdict"). A row verdict labels evidence; a gate verdict is one allow or deny. This glossary writes
"the gate's verdict" when it means the second sense.

**worker.** The `poteto-agent` subagent a coordinator spawns to do one unit. It reads the
`poteto-mode` skill in full before any work, works only in its own worktree, pushes its branch, opens
its PR, and never merges.

Source: `preferences.md` orders 15, 20, and 26.

**workspace.** `/workspace` inside the computer, the durable file area. Every run of a Bot mounts the
host directory `<bots root>/<botId>/workspace` at `/workspace`, so a file survives the run that wrote
it, two Bots cannot see each other's files, and the `list_files` and `read_file` arms name the Bot
they read.

Source: `UX.md` vocabulary, the Workspace row; `docs/files-surface.md`.
