# Running freebot

One command boots the server, the page it serves, and the run behind them, then prints one URL.
The operator token is already in that URL's fragment, so the page is armed the moment it loads.
Nothing is copied out of a log.

```
bun run up
```

## What you need

- **bun** 1.2 or later (`bun --version`).
- **A sandbox backend: Docker, or microsandbox.** Docker Desktop on this Mac is the reference, and a
  run creates one container from the pinned image `freebot-sandbox:u0.6` and removes it when the run
  ends; the adapter builds the image on first use if it is not there yet, which takes a few minutes
  once. A machine with no Docker can run the same runs on microsandbox instead, one microVM per
  sandbox, no account and no payment (order 34). Install it with
  `curl -fsSL https://install.microsandbox.dev | sh` and read `docs/microsandbox.md`, which carries
  the licence, the pinned version and what the adapter does when the tool is absent. `bun run up`
  picks between them itself; see "The sandbox backend" below.
- **A model key, or none.** Gate G1 is open, so a run calls a real model when
  `~/.freebot/provider.env` holds `FREEBOT_BYOK_KEY`, with `FREEBOT_BYOK_BASE_URL` and
  `FREEBOT_BYOK_MODEL` beside it. Without a key the run replays
  `packages/pi-bridge/fixtures/rpc-handshake.jsonl` and the launcher says so at startup. The key is
  read out of that file by the server and never out of the environment (order 8). Everything else is
  real either way: the gate, the run store, the log, the sandbox, the page and its stream. See
  "The model" below and `docs/providers.md`.
- **A browser.** On macOS the launcher opens it for you. Chrome is only needed for the evidence
  driver, not for running freebot.

## What you see

```
$ bun run up
freebot up: page and run on 127.0.0.1:60203, tunnel on 127.0.0.1:60202
freebot up: sandbox backend docker (chosen by auto: the Docker daemon answered)
freebot up: model mode auto, model deepseek/deepseek-v4.1-flash via api.commandcode.ai (key from the vault)
freebot up: vault /Users/you/.freebot/provider.env present, mode 600
freebot up: bots under /Users/you/.freebot/bots; each Bot's workspace is mounted at /workspace and kept across runs
freebot up: spend cap 5.00 USD per run; no token prices configured, so a keyed run reports no cost
freebot up: the operator token rides the URL's fragment and is printed nowhere else
freebot up: opened the URL in your browser
freebot up: Ctrl-C stops the servers and removes this launch's sandboxes (docker)
http://127.0.0.1:60203/#token=<43 url-safe characters>
```

The lines above the URL are diagnostics on stderr. The last line is stdout, and it is the only URL the
launcher prints. The token is in the fragment, the one URL part a browser never sends to a server,
so it reaches no access log and no `Referer` (`docs/one-run-path.md` has the token contract).

## The sandbox backend

`bun run up` runs every run's sandbox on one backend for the whole launch, and it decides which one
at boot from `apps/server/src/cli/sandbox-backend.ts`. The backend it chose is printed on stderr,
with the fact that decided it, so the line an evidence driver asserts is the launcher's own account
of what it built.

| Value | Backend |
| --- | --- |
| `docker` | Docker, the reference implementation. |
| `microsandbox` | microsandbox, one microVM per sandbox, no account. `docs/microsandbox.md`. |
| `auto` | The default. Docker if the daemon answers, otherwise microsandbox. |

```bash
bun run up --sandbox microsandbox     # one launch, on microsandbox
FREEBOT_SANDBOX=microsandbox bun run up   # the default for a started process
```

`--sandbox` wins over `FREEBOT_SANDBOX`, and both take the three values above. A value naming no
backend is refused by name rather than guessed at, because auto-detecting past a misspelled request
would run somewhere the person did not ask for. `auto` tries Docker first and microsandbox second,
which is plan Part 12's order, so the reference backend wins a tie; its boot line names both probes:

```
freebot up: sandbox backend microsandbox (chosen by auto: the Docker daemon did not answer; msb doctor answered)
```

An explicit request is honoured or it fails, never quietly replaced. Asking for `docker` on a machine
whose daemon is down, or for `microsandbox` where `msb` is absent, exits 2 and names what was missing
and what to install. With neither present, `auto` exits 2 naming both install paths rather than
starting a launch whose runs could not run:

```
freebot up: no sandbox backend: the Docker daemon did not answer; msb doctor did not answer; install and start Docker Desktop (docs/RUNNING.md, "What you need") or install microsandbox: `curl -fsSL https://install.microsandbox.dev | sh` (docs/microsandbox.md)
```

Every backend that table can select is free and needs no account (order 34). The table is a `Record`
over the id union, so a backend added to the type and forgotten there fails the typecheck instead of
becoming unreachable; that is the slot plan Part 12's E2B Embed grows into.


## The Library

The page has two tabs. `Conversation` is the thread a run writes into. `Library` lists the Bot's
workspace: `/workspace` pinned at the top, then the entries grouped as `Today`, `This week`, and
`Older` by their own timestamps. Opening a file shows its bytes. Opening a path that resolves outside
the workspace is refused by name and shows no bytes.

The workspace is a real directory on this computer, and the launcher names it on stderr:

```
freebot up: workspace /Users/you/.freebot/bots/bot-local/workspace mounted at /workspace, kept across runs
```

Every run of this Bot mounts that directory at `/workspace`, so what a run writes there outlives the
run. The container does not: anything outside `/workspace`, and anything installed into the
container, is gone when the run ends. `docs/files-surface.md` states the whole rule, the scoping
rules, and the limits.

`FREEBOT_WORKSPACE=<path>` points the launch at a different workspace directory, which is how the
evidence driver starts from an empty one.

## The click

The page opens on `127.0.0.1` with the prompt box already showing. Type anything and press
**Start run**. The model decides what to do with your prompt; the example below is what a real turn
looks like when you ask it to print today's date.

| Step | What you see |
| --- | --- |
| 1. Armed | Connected, nothing rendered yet, the prompt box is the way in. |
| 2. Streaming | The model's first turn arrives: its own text, then the tool call it asked for. |
| 3. Parked | The run asked to run that command in a container, and the approval card waits for your answer. The tool card reads `awaiting approval`, so a parked run does not look frozen. |
| 4. Allowed once | The card shows `allowed once`, the command runs inside the container, and the output block holds the container's own stdout. The model then reads that output and answers in its own words. |
| 5. Denied | The card shows `denied`, the call produces no output, the decision marker reads `deny (user_denied)`, and the run still reaches its terminal frame. |

The four committed frames from a live run, at commit `5333adb`:

- `packages/verify/artifacts/keyed-run/5333adb/01-armed.png`
- `packages/verify/artifacts/keyed-run/5333adb/02-parked.png`
- `packages/verify/artifacts/keyed-run/5333adb/03-finished.png`
- `packages/verify/artifacts/keyed-run/5333adb/04-denied.png`

The same four states were first committed for a replaying model, at `packages/verify/artifacts/launch/8fdb87f/`.

One launch parks only its first run. Once you answer a card, the landed ledger holds that action's
grant and the same call again is refused as `grant_consumed` rather than parked, which is why
`packages/review/src/policy.ts` and its tests are the place to look if a second run of the same
command behaves differently from the first.

## Stopping a run

The composer's **Stop run** control is enabled only while a run is in flight. It calls the contract's
`cancel_run`, and the run settles at `cancelled`: the transcript keeps every frame that arrived
before the stop, the approval card that was waiting reads `run stopped` with its buttons disabled,
and the run's container is removed by the loop's own cleanup. The stop control is disabled again and
the composer is ready for the next run. A run parked at the gate is woken immediately; a provider
call already on the wire finishes before the loop reaches its next check.

The details:

- A run's terminal state is shown by its `run.status` frame (`run cancelled`), by the header's
  `data-run-status`, and by the Computer tab's `Status` row.
- `packages/verify/scripts/cancel-run.ts` is the live evidence. Its three committed frames are
  `01-no-run`, `02-in-flight` and `03-cancelled`.
- The taxonomy's `cancelled` entry is the only producer of this state; the loop emits no
  `run.finished` for a stop, because a stop is not a completion.

## The spend cap

The run loop consults a per-run spend ceiling before every provider turn. It reads the run's settled
usage, not an estimate: each turn's adapter reports what the call cost, and a total over the cap
settles the run at the taxonomy's `spend_cap` with a `run.failed` reason naming the spend, the cap
and the overage. The provider call that would cross the cap is never made. Spending exactly the cap
is still within it.

`bun run up` configures the two halves from the environment:

| Variable | Meaning |
| --- | --- |
| `FREEBOT_SPEND_CAP_USD` | The per-run ceiling. The launch defaults to `5.00` when unset. |
| `FREEBOT_PRICE_INPUT_PER_MTOK` | Input tokens' price in USD per million. |
| `FREEBOT_PRICE_OUTPUT_PER_MTOK` | Output tokens' price in USD per million. |
| `FREEBOT_PRICE_CACHE_READ_PER_MTOK` | Cache-read tokens' price. |
| `FREEBOT_PRICE_CACHE_WRITE_PER_MTOK` | Cache-write tokens' price. |

The four prices are all four or none: a partial set is refused at boot rather than defaulted. With
none set, a keyed adapter reports no cost and the cap has nothing to measure, which the boot line
says. With all four set, every keyed turn is priced and the cap applies. The cap measures provider
calls; a connector's own vendor billing is not part of the run's token cost.

## The model

The launcher names what it chose on stderr, before the URL:

```
freebot up: model mode auto, model deepseek/deepseek-v4.1-flash via api.commandcode.ai (key from the vault)
freebot up: vault /Users/you/.freebot/provider.env present, mode 600
```

`auto` is the default, and it follows the vault. A key there makes every run a real model turn: the
server posts to `FREEBOT_BYOK_BASE_URL` with the model `FREEBOT_BYOK_MODEL` names, sends the prompt
and the run's tools, and turns the reply into the loop's turn. A missing key replays the transcript
instead, and the line says so.

- `--live` asks for the vault explicitly and refuses to start when the file holds no key.
- `--replay` records on purpose, which is what an evidence driver that asserts a recorded turn wants.
- `FREEBOT_PROVIDER=live|replay|auto` sets the same default for anything that spawns the launcher
  without a flag. The mode carries no secret, so it may ride the environment; the key may not.

The key itself never leaves the vault file and the one `Authorization` header built from it. The
server reads `~/.freebot/provider.env` itself rather than through the environment, so no child
process and no `ps` listing can see it (order 8). The per-turn lines the server prints name the
endpoint, the model, the tool names and `Bearer <redacted>`, and nothing else.

Two callers stay recorded on purpose. `apps/server/src/index.ts` states `replay` where it builds the
run service, because it is the peer the other evidence drivers boot and a golden run must not bill a
provider or vary with this machine's vault (order 9). And `packages/verify/scripts/launch.ts` drives
`bun run up` and asserts a recorded turn, so it pins `FREEBOT_PROVIDER=replay` in the environment of
every launch it spawns: run it bare as `bun packages/verify/scripts/launch.ts`.

A rate limit is a normal answer, not a bug. The provider's 429 settles the run as
`provider_rate_limit`, and the failure line carries the wire's own retry hint; there is no retry
loop, so the run ends and the next one starts fresh.

## Flags

| Flag | Meaning |
| --- | --- |
| `--no-open` | Print the URL, do not open a browser. This is the path the evidence driver uses. |
| `--live` | Use the key in `~/.freebot/provider.env`, and refuse to start without one. |
| `--replay` | Replay the committed transcript instead of calling a model. |
| `--sandbox <id>` | The sandbox backend: `docker`, `microsandbox`, or `auto`. Default `auto`. |
| `--api-port <n>` | The page and its stream. Default 0, which asks the OS for a free port. |
| `--tunnel-port <n>` | The tunnel leg. Default 0, which asks the OS for a free port. |
| `-h`, `--help` | Print the usage. |

`--no-open --api-port <n>` on a port that is already taken exits 1 and names the port. Two launches
on the default flags cannot collide, because each takes a free port. `--live` on a machine whose
vault holds no key exits 2 and names the file it looked at, rather than quietly replaying. A
`--sandbox` value naming no backend, or naming one this machine cannot run, also exits 2 and names
what was missing; see "The sandbox backend".

## Stopping it

Ctrl-C stops both listeners, then removes the sandboxes this launch created, through whichever
backend's adapter the launch chose, and exits 0:

```
freebot up: stopping
freebot up: removed sandbox freebot-sbx-run-1-fglyezgr (docker)
freebot up: stopped
```

On microsandbox the same line names the sandbox and `(microsandbox)`. A launch that cannot remove
one says `FAILED to remove sandbox <name>` and exits 1 rather than reporting a clean stop.

A sandbox left behind by a `SIGKILL` (not a Ctrl-C) belongs to a launch that no longer exists, so
nothing this launch does removes it. `docker ps -a --filter label=freebot.unit=u1.7` lists the
containers this repo's runs create, including that one; on microsandbox the same question is
`msb ls --label freebot.unit=u1.7`. Cleanup is always label- and name-scoped to the sandboxes a
launch made, never a `prune` (order 22).

## Confirming it worked

1. `curl http://127.0.0.1:<page port>/healthz` answers `{"status":"ok","service":"freebot-server"}`.
2. The page's header reads `connected`, and the operator box is visible. Without a token the box
   stays hidden.
3. Starting a run shows the model's own tool call on an approval card, and the launcher's stderr says
   which model answered.
4. After Ctrl-C: nothing listens on either port, and
   `docker ps -a --filter label=freebot.unit=u1.7` is as empty as it was before the launch.

## Re-running the evidence

```
bun packages/verify/scripts/keyed-run.ts
```

This is the live one. It spawns `bun run up --no-open` with no provider flag, so the model is
whatever the vault selects, opens the URL that launch printed in headless Chrome over CDP, types a
prompt into the page's own box, and drives one allowed run and one denied run from two launches. It
writes `packages/verify/artifacts/keyed-run/<short sha>/assert.txt` plus one PNG per asserted state,
and it fails rather than write a token or a key-shaped literal into the artifact. The artifact
carries the request the server made (endpoint, model, tool names, `Bearer <redacted>`), the model's
own text and tool call as the server read them off the wire, the provider's own token usage, and the
container's own stdout read off the page.

```
bun packages/verify/scripts/launch.ts
```

This is the launcher's own evidence, and it asserts a recorded turn, so it pins the replay provider
in every launch it spawns. It boots real launchers with `bun run up`, opens the URL each one printed,
drives the click, launches a second and a third instance at the same time, provokes the pinned-port
refusal, and SIGINTs a launch while a run still holds a live container. It writes
`packages/verify/artifacts/launch/<short sha>/`. `docs/VERIFICATION.md` carries both rows.

## What is not live today

- **Per-token streaming.** The loop's provider port returns a whole turn, so the model's text arrives
  as one frame and the page renders it in one piece. Streaming it needs a port that yields, which is
  a change to `packages/core`.
- **Priced spend.** The loop consults the cap, but a keyed turn reports a cost only when the four
  `FREEBOT_PRICE_*` variables are set. Without them the adapter reports no cost rather than a zero.
  The cap also measures provider calls, not a connector's own vendor billing.
- **An in-flight stop.** A stop is checked between provider calls; a call already on the wire is not
  aborted mid-call. A run parked at the gate is woken immediately.
- **The scheduler.** Idle-kill, auto-stop and rejoin after `sandbox_lost_mid_run` are still its.
- **A hard `SIGKILL`** still leaves a container behind that no launch owns.
- **The default browser-open path** was checked against a stand-in `open` on `PATH` rather than a
  real browser window, so a person's first `bun run up` is what actually opens one.
