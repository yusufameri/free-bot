# FreeBot status

> Generated from the orchestration store at 2026-10-20T04:56Z, against `origin/main` `f0a688f`. The store is authoritative and this file is a snapshot the coordinator refreshes at every drain. The registers live outside the repository at `/Users/yusufameri/.opencode/orchestrate/freebot`: `units.tsv` (one row per unit), `ledger.tsv` (one verification row per PR and head), `decisions.tsv` (the decision trail), `gates.md`, `preferences.md` (the standing orders), `briefs/`, and `reports/`. The specification is `PLAN.md`.

## Against the done predicate

The plan's §9.1 states when this run ends. Each line needs its evidence, or a named blocker in `gates.md`.

| Predicate line | State |
| --- | --- |
| 1. Phase 0 exit, six checks green, artifact and ledger row each | Met. Eleven units in wave 0 carry ledger rows. One caveat: the artifacts live under their own feature directories rather than a single `verify/artifacts/phase0/` index. |
| 2. Phase 1 MVP, every feature merged and verified `live-ui-verified` | Met. Every wired feature is merged with live-ui evidence: the stop control and the spend cap landed as U10.3, and the transcript now survives a server restart (U10.4), proven live on a fresh instance and by its driver. |
| 3. Gates 1 to 8 hold | No open gates. G1 resolved with the vault key, G3 and G5 narrowed by the no-paid-dependency and no-account direction, G6 closed when the reviewer resumed, G7 closed when both scheduled hands landed again. |
| 4. Phase 1.5, goldens deterministic across two CI runs | Met. The gate is armed rather than queued: `bun run verify` runs `packages/pixel-gate/src/cli.ts --no-write`, CI installs Chrome and pins `FREEBOT_CHROME`, and the app and the export render in one browser instance at each of the nine manifest viewports. A chrome pixel, an undeclared moved box or a horizontal scroll fails the build. U6.7's fix removed the hidden-tab condition that made a slow CI runner fail a run that was still producing viewports. |
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
| A conversation survives a restart | Met. Frames persist per thread as an append-only JSONL file, a restart hydrates the conversation from disk, and a run the dead process held returns as `server_restart`. | U10.4 |

## Units

68 units in the register: 65 done, 0 running, 2 pending, 1 parked.

The verification ledger holds 86 rows: 26 `live-ui-verified`, 37 `unit-test-verified`, 3 `type-check-only`, 20 `docs-only`. A row names the artifact and the commit it was produced at, and CI green is an input to a verdict rather than the verdict.

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
| U10.4 | The transcript across a restart: per-thread JSONL, hydrate on boot, `server_restart` | [#53](https://github.com/yusufameri/free-bot/pull/53) |
| U10.7 | The `bots-and-threads` driver asserting the transcript that now survives a restart | [#54](https://github.com/yusufameri/free-bot/pull/54) |
| U6.5 | The item components and the real Bot status dot, with the run state moved to the header | [#55](https://github.com/yusufameri/free-bot/pull/55) |
| U6.7 | The fidelity pass armed in the build: the pixel gate inside `bun run verify` and CI | [#56](https://github.com/yusufameri/free-bot/pull/56) |
| U10.8 | The sandbox pin repairs itself: an off-pin tag is re-pointed at a layer-matching image, and a build that cannot match the pin refuses and says so | [#58](https://github.com/yusufameri/free-bot/pull/58) |
| U10.9 | The landing page's spend-cap sentence now states what the run loop does, asserted from the DOM | [#60](https://github.com/yusufameri/free-bot/pull/60) |
| U10.10 | The landing page's cancel row now says a run can be stopped from the page, asserted from the DOM | [#62](https://github.com/yusufameri/free-bot/pull/62) |
| U10.11 | The status capture as a committed driver: probe and state tables, a selector that fails by name, and a subject manifest | [#64](https://github.com/yusufameri/free-bot/pull/64) |
| U6.8 | The export's sidebar and Workspace pages on real records: `arrange_bot`, group rooms, seven pages, the chat column order | [#65](https://github.com/yusufameri/free-bot/pull/65) |
| U10.5 | The main-line sweep: nineteen drivers enumerated from the manifest, one log per driver, a proposed unit per red | [#69](https://github.com/yusufameri/free-bot/pull/69) |
| U8.4 | The Connect apps surface inside the U6.8 shell: the install's connector records, detail pages, and the real routes | [#70](https://github.com/yusufameri/free-bot/pull/70) |
| U10.14 | The landing's later-phases sentence drops Settings and in-page connectors, asserted from `#landing-later-phases` | [#71](https://github.com/yusufameri/free-bot/pull/71) |
| U10.13 | The eight red drivers triaged: six stale claims fixed and re-run, two product defects filed, and a lost-tail socket write fixed | [#73](https://github.com/yusufameri/free-bot/pull/73) |
| U10.16 | The restart run path: the driver scoped to the new run id, and a run whose setup throws settles instead of staying queued | [#74](https://github.com/yusufameri/free-bot/pull/74) |
| U10.12 | The status driver reads the composer it has (input, textarea, or a named failure), and a page error carries its own message | [#77](https://github.com/yusufameri/free-bot/pull/77) |
| U10.17 | The group-chat form opens empty with `Name this room`, and Create without a name refuses | [#79](https://github.com/yusufameri/free-bot/pull/79) |
| U10.18 | Five drivers call the shared page-error helper, so a page exception reaches the driver's error with its own message | [#81](https://github.com/yusufameri/free-bot/pull/81) |
| U10.19 | The type gate back to 38/38: census from `git ls-files`, sixteen documented files, and a byte-identical restore test | [#83](https://github.com/yusufameri/free-bot/pull/83) |
| U10.20 | Both missing gates inside `bun run verify`: lint with `--error-on-warnings` and the type gate, with the stylesheet ordered by rising specificity | [#85](https://github.com/yusufameri/free-bot/pull/85) |
| U10.2 | Artifact hygiene: `bun run prune` with keep and refusal rules, the Chrome-profile ignore rule, one shared `saveScreenshot`, and the artifact lint exclusion | [#87](https://github.com/yusufameri/free-bot/pull/87) |
| U10.1 | The proof index as data: 56 row files, a renderer, and a checker that fails a planted mismatch by name | [#89](https://github.com/yusufameri/free-bot/pull/89) |

## Not built yet

Nothing is running. U10.12 landed the routine's driver fix, so the status pass can prove the predicate
from its own frames again instead of borrowing them: the composer is written through the prototype its
real tag asks for, and the shared evaluate wrapper now reports a page exception's own message rather than
`Uncaught :: <expression>`. U10.17 removed the prototype's sample room name, which was the overlays red. The sweep's last red is
now the type gate itself: it fails 31/38 at main, including 'the tree passes with every probe file
removed' and 'the restored tree passes', so the instrument that proves the typecheck is not blind is
itself broken; U10.19 owns it. U10.18 carries the hidden-error defect still copied in five drivers.

Queued, each with a brief at `briefs/<id>.md`: U9.3 (needs a Linux/KVM host) and U10.21 (worktree hygiene).

| Unit | What it is |
| --- | --- |
| U9.3 | The E2B Embed backend for Linux hosts and CI |
| U10.1 | The verification record as data plus a check that reads it. The checker half landed as U10.6; this carries what remains, including the unreferenced-artifact rule order 49 gives it |
| U10.2 | Artifact hygiene: a real prune script, an ignore rule for the Chrome profiles, and one shared screenshot helper instead of ten |
| U10.20 | The lint gate: nine specificity errors at main, and no lint step in the verify ladder for CI to read |
| U10.18 | Five drivers still read `exceptionDetails.text`, so their page errors hide the page's own message |
| U9.4 | Parked. A paid cloud backend, kept behind the same seam and never a requirement |
| U10.12 | Parked and folded into U10.13: its brief is superseded, and the composer fix is that unit's item 7 |

Three notes on honesty that the surface carries. The sandbox pin repairs itself rather than refusing a
run (U10.8). The verification index is per-unit history rather than coverage of main: the checker's tally
is 46 checked rows and 50 artifacts, `RESULT: PASS (158/158)`; four rows are count-unverified by design.
And the live suite is now green: a manual sweep against `71fe3eb` reported runnable 23, passed 23, failed 0,
skipped 1 (the skip is the status capture, by name, because no live instance is named), and order 40's mechanism is
scheduled every six hours. The index is no longer hand-written: `docs/verification/` holds one row file per feature,
`render-index.ts` generates `docs/VERIFICATION.md`, and the checker fails a planted mismatch by name. The first sweep ran drivers against
the drivers are history until U10.13 separates stale claims from defects and the filed units land. The
landing page's claims about app behavior now carry DOM ids and assertions in the landing driver (order
52), so the three drifts of this week cannot recur silently. Two gaps still have no unit: the details
pane's mobile drawers, and the `Media` tab's capture source.

## Where things live

In the repository: `PLAN.md` (this plan), `STATUS.md` (this file), `README.md`, `UX.md` (the product specification), `VISION.md`, `GLOSSARY.md`, `docs/VERIFICATION.md` (one row per verified feature with its artifact and commit), `docs/DESIGN-CONTRACT.md` (the exported prototype's measured contract), and `design/prototype-84c6b185` (the export itself).

Outside the repository, on this machine: the master plan at `/Users/yusufameri/.opencode/plan/freebot-plan.md`, the orchestration store at `/Users/yusufameri/.opencode/orchestrate/freebot`, and the provider vault at `~/.freebot/provider.env` with mode 600.

One local note, because it affects what a person sees from this checkout: the main working tree carried nine uncommitted files of export-shell work from 09:09 to 09:14 today (`apps/server/src/router.ts`, `apps/web/host/index.html`, `packages/core/src/bot-store.ts`, `packages/protocol/src/api.ts`, `dto.ts`, `dto.test.ts`, `packages/ui/browser/icons.ts`, `shell.ts`, `packages/ui/src/bots.ts`). They blocked the fast-forward after #56, so they were stashed intact as `stash@{0}` rather than discarded. They are not on main and no unit owns them.
