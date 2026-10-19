# FreeBot status

> Generated from the orchestration store at 2026-10-19T09:12Z, against `origin/main` `3e6b5a4`. The store is authoritative and this file is a snapshot the coordinator refreshes at every drain. The registers live outside the repository at `/Users/yusufameri/.opencode/orchestrate/freebot`: `units.tsv` (one row per unit), `ledger.tsv` (one verification row per PR and head), `decisions.tsv` (the decision trail), `gates.md`, `preferences.md` (the standing orders), `briefs/`, and `reports/`. The specification is `PLAN.md`.

## Against the done predicate

The plan's §9.1 states when this run ends. Each line needs its evidence, or a named blocker in `gates.md`.

| Predicate line | State |
| --- | --- |
| 1. Phase 0 exit, six checks green, artifact and ledger row each | Met. Eleven units in wave 0 carry ledger rows. One caveat: the artifacts live under their own feature directories rather than a single `verify/artifacts/phase0/` index. |
| 2. Phase 1 MVP, every feature merged and verified `live-ui-verified` | Nearly. The wired feature list is Met end to end, and the two partial lines landed as U10.3. The transcript still dies with the server, and U10.4 (running) closes it. |
| 3. Gates 1 to 8 hold | No open gates. G1 resolved with the vault key, G3 and G5 narrowed by the no-paid-dependency and no-account direction. |
| 4. Phase 1.5, goldens deterministic across two CI runs | Partly. The harness exists: U6.7a landed the pixel gate, which renders the app and the export in one browser instance and diffs them against each other rather than against a stored golden, so the cross-run rasterization problem order 36 names is designed out. The gate is not yet armed: U6.7 is still queued, and its brief carries the calibration and the shell mask the export's own baseline needs. |
| 5. Phases 2 to 7 | Not started. The tracks that opened instead are T6 design parity, T7 documentation truth, T8 connectors and sandbox backends, and T9 for the parked paid backends. |
| 6. Exclusions labeled | Met. `docs/VERIFICATION.md` states that arbitrary third-party MCP servers and arbitrary models sit outside the absolute bar. |

## The MVP feature list

The list is fixed by the plan's §5.2 re-cut.

| Feature | State | Unit |
| --- | --- | --- |
| Single Bot, local, one web surface | Met. Bots and threads are records now, not a hard coded single Bot. | U1.5, U2.3, U4.2 |
| Chat with terminal and filesystem tools, no browser | Met. The sandbox runs the bash tool and `/workspace` has a file view. | U1.7, U4.1 |
| Allow once and deny approvals | Met. The gate parks, an allow runs and shows the container's own output, a deny records `user_denied`. | U1.7, U2.1 |
| Ordered event protocol with schemas | Met. | U1.1 |
| Error taxonomy and `freebot doctor` | Met. The doctor prints five local facts, each a literal pass or fail. | U1.4 |
| BYOK provider with a real tool-call smoke test | Met. The keyed path was proven live against the vault's model. | U1.6, U2.4 |
| Pi in the sandbox over RPC through the tunnel | Met, including kill and rejoin with no lost or repeated event. | U0.2, U0.3, U0.7 |
| Streaming chat with tool-call and approval cards | Met. | U1.5, U2.1 |
| Localhost auth with a per-launch token | Met. | U1.3 |
| Replay stub for the provider | Met. A machine with no key replays a committed transcript, and the launch driver pins it. | U1.6, U2.5 |
| Async run model, `start_run` and `cancel_run` | Met. `start_run` is wired end to end, and a run can be stopped from the page: the control disables when nothing is in flight, the stop wakes a parked approval, and the run settles at `cancelled` with what arrived before the stop kept. | U1.7, U10.3 |
| Spend caps | Met. The run loop consults the cap before each provider turn, an over-cap total settles the run at `spend_cap` with the spend and the cap in the reason, and the launcher configures it through `FREEBOT_SPEND_CAP_USD` (default 5.00). | U1.4, U10.3 |

## Units

53 units in the register: 44 done, 1 running, 7 pending, 1 parked.

The verification ledger holds 49 rows: 14 `live-ui-verified`, 30 `unit-test-verified`, 2 `type-check-only`, 3 `docs-only`. A row names the artifact and the commit it was produced at, and CI green is an input to a verdict rather than the verdict.

Done, by wave. Each row names the PR, and a unit with no PR number landed directly on main during the scaffold wave.

| Unit | What it delivered | PR |
| --- | --- | --- |
| U0.1 | The repository skeleton, CI, and the verify harness | direct, `195f336` |
| U0.2 | Pi RPC in a container, driven over stdio | [#1](https://github.com/yusufameri/free-bot/pull/1) |
| U0.3 | The Pi bridge, JSONL framing, event mapping, replay | [#3](https://github.com/yusufameri/free-bot/pull/3) |
| U0.4 | Containment: default-deny egress, proxy only | [#2](https://github.com/yusufameri/free-bot/pull/2) |
| U0.5 | Browser containment: QUIC, DoH, and arbitrary IPs dropped | [#7](https://github.com/yusufameri/free-bot/pull/7) |
| U0.6 | The pinned sandbox image, replay equality, the key scan | [#4](https://github.com/yusufameri/free-bot/pull/4) |
| U0.7 | The tunnel, with kill and rejoin and no lost or duplicate event | [#6](https://github.com/yusufameri/free-bot/pull/6) |
| U0.8 | Grants: no in-container side effect without a matching grant | [#5](https://github.com/yusufameri/free-bot/pull/5) |
| U0.9 | Forge test A, the choke-point contract | [#8](https://github.com/yusufameri/free-bot/pull/8) |
| U0.10 | The event stream rendered in one page | [#9](https://github.com/yusufameri/free-bot/pull/9) |
| U0.11 | The keyless end-to-end dry run | [#11](https://github.com/yusufameri/free-bot/pull/11) |
| U1.1 | The protocol package: envelopes, nine deny codes, zod schemas | [#10](https://github.com/yusufameri/free-bot/pull/10) |
| U1.2 | The sandbox provider interface and its Docker adapter | [#12](https://github.com/yusufameri/free-bot/pull/12) |
| U1.3 | Localhost auth and the oRPC control plane | [#15](https://github.com/yusufameri/free-bot/pull/15) |
| U1.4 | The core run model, the status taxonomy, and `freebot doctor` | [#14](https://github.com/yusufameri/free-bot/pull/14) |
| U1.5 | The web chat surface: streamed text, tool cards, approval cards | [#16](https://github.com/yusufameri/free-bot/pull/16) |
| U1.6 | The BYOK client, the capability probe, the save-time smoke test | [#13](https://github.com/yusufameri/free-bot/pull/13) |
| U1.7 | The run loop end to end, plus the tenth deny code | [#18](https://github.com/yusufameri/free-bot/pull/18) |
| U1.10 | The root type gate covering every app and every `.tsx` | [#17](https://github.com/yusufameri/free-bot/pull/17) |
| U2.1 | One run path, with the page driving the loop | [#19](https://github.com/yusufameri/free-bot/pull/19) |
| U2.2 | Per-run container names, so two agents can test at once | [#20](https://github.com/yusufameri/free-bot/pull/20) |
| U2.3 | `bun run up`: one command that prints the one URL to open | [#21](https://github.com/yusufameri/free-bot/pull/21) |
| U2.4 | The keyed provider, so a typed prompt gets a real model | [#22](https://github.com/yusufameri/free-bot/pull/22) |
| U2.5 | The launch driver pinned to replay, and a subtitle true in both modes | [#24](https://github.com/yusufameri/free-bot/pull/24) |
| U3.1 | `UX.md` and `VISION.md` | [#23](https://github.com/yusufameri/free-bot/pull/23) |
| U4.1 | The `/workspace` file surface | [#25](https://github.com/yusufameri/free-bot/pull/25) |
| U4.2 | Bots and threads as records, so the sidebar and picker are real | [#26](https://github.com/yusufameri/free-bot/pull/26) |
| U4.3 | The provider page: connect, test, pick, and the four outcomes | [#27](https://github.com/yusufameri/free-bot/pull/27) |
| U6.1 | The design contract, measured from the exported prototype | [#28](https://github.com/yusufameri/free-bot/pull/28) |
| U6.2 | First run: the three-pane wizard and the model test | [#29](https://github.com/yusufameri/free-bot/pull/29) |
| U6.3 | The details pane, its notices, and the reconnect banner, with the measured geometry delta at zero | [#35](https://github.com/yusufameri/free-bot/pull/35) |
| U6.4 | The command palette, the Bot picker, and the modal, 105 checks over 19 committed screens | [#40](https://github.com/yusufameri/free-bot/pull/40) |
| U7.1 | `GLOSSARY.md` and its map | [#31](https://github.com/yusufameri/free-bot/pull/31) |
| U7.2 | The documentation truth fix: three documents that still called the keyed path parked | [#37](https://github.com/yusufameri/free-bot/pull/37) |
| U8.1 | The connector seam, proved against an emulator rather than an account | [#30](https://github.com/yusufameri/free-bot/pull/30) |
| U8.2 | Connector credentials in the person's own vault, with the routes that write and probe them | [#33](https://github.com/yusufameri/free-bot/pull/33) |
| U9.1 | The sandbox conformance suite, the one gate every backend passes | [#32](https://github.com/yusufameri/free-bot/pull/32) |
| U9.2 | The microsandbox backend, a local microVM that needs no account | [#38](https://github.com/yusufameri/free-bot/pull/38) |
| U6.7a | The pixel gate: app and export rendered and diffed in one browser instance, no stored golden | [#44](https://github.com/yusufameri/free-bot/pull/44) |
| U6.6 | The landing route at `/landing`, out of the app shell, with the repository's real state on it | [#45](https://github.com/yusufameri/free-bot/pull/45) |
| U8.3 | The Composio adapter behind the seam, with its MCP endpoint path and the gate-8 delete test | [#43](https://github.com/yusufameri/free-bot/pull/43) |
| U10.6 | The index checker: a row that disagrees with its artifact fails the build | [#46](https://github.com/yusufameri/free-bot/pull/46) |
| U9.5 | The sandbox backend selector, and the sabotage-drill honesty fix | [#49](https://github.com/yusufameri/free-bot/pull/49) |
| U10.3 | The stop control in the page, and the spend cap consulted by the run loop | [#51](https://github.com/yusufameri/free-bot/pull/51) |

## Not built yet

Running now, one unit, in its own worktree with its own brief. Liveness is read from a climbing turn count rather than from a status field, and file writes are the progress signal, a distinction order 41 records because a file-write read alone called three live workers idle.

| Unit | What it is | State |
| --- | --- | --- |
| U10.4 | Transcript persistence, so a restart brings back the conversation and not only the runs | running, branch `u10.4-transcript-persistence` |

Queued, with no brief written yet, which is deliberate so a queued slice cannot go stale.

| Unit | What it is |
| --- | --- |
| U6.5 | The item components and Bot status |
| U6.7 | The fidelity pass: every screen diffed against the export across nine viewports, under order 36's pixel gate, with every delta fixed or written down. Its brief must carry the shell mask the gate needs, since the export's own baseline contradicts itself in two places |
| U8.4 | The Connect apps surface: the export's own entry and its states, and the brief must name whether a Composio connector arrives as a preset that fills the url field or through a protocol change no unit owns |
| U9.3 | The E2B Embed backend for Linux hosts and CI |
| U10.1 | The verification record as data plus a check that reads it. The checker half landed as U10.6; this carries what remains |
| U10.2 | Artifact hygiene: a real prune script, an ignore rule for the Chrome profiles three throwaway capture scripts left behind, and one shared screenshot helper instead of the ten that hand-roll it |
| U10.5 | A scheduled sweep that runs the live drivers against current main and files a unit when one fails |
| U9.4 | Parked. A paid cloud backend, kept behind the same seam and never a requirement |

Two notes on honesty that the surface carries. The verification index is per-unit history rather than coverage of main: an artifact certifies the commit it was produced at, and the 39 checked rows (the checker's own tally) name commits between 2 and 322 commits behind head, which order 40 and U10.5 address. And the gaps below have no unit at all, named so they are not lost. The details pane's mobile drawers are unowned, so a narrow screen has no way into the pane. And the `Media` tab has no capture source, since this app never records a screen. Both are design work and belong with U6.5 and U6.7. Two other gaps closed since the last refresh and were MVP predicate lines rather than phase-later work: the stop control landed as U10.3, and the transcript is U10.4's, running. One honesty gap opened with U10.3: the static landing page still says the cap is not consulted, while `docs/landing.md` records the delta, and it is unfiled.

## Where things live

In the repository: `PLAN.md` (this plan), `STATUS.md` (this file), `README.md`, `UX.md` (the product specification), `VISION.md`, `GLOSSARY.md`, `docs/VERIFICATION.md` (one row per verified feature with its artifact and commit), `docs/DESIGN-CONTRACT.md` (the exported prototype's measured contract), and `design/prototype-84c6b185` (the export itself).

Outside the repository, on this machine: the master plan at `/Users/yusufameri/.opencode/plan/freebot-plan.md`, the orchestration store at `/Users/yusufameri/.opencode/orchestrate/freebot`, and the provider vault at `/Users/yusufameri/.freebot/provider.env` with mode 600.
