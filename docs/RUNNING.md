# Running freebot

One command boots the server, the page it serves, and the run behind them, then prints one URL.
The operator token is already in that URL's fragment, so the page is armed the moment it loads.
Nothing is copied out of a log.

```
bun run up
```

## What you need

- **bun** 1.2 or later (`bun --version`).
- **Docker running** (Docker Desktop on this Mac). A run creates one container from the pinned
  image `freebot-sandbox:u0.6` and removes it when the run ends. The adapter builds the image on
  first use if it is not there yet, which takes a few minutes once.
- **A model key, or none.** Gate G1 is open, so a run calls a real model when
  `~/.freebot/provider.env` holds `FREEBOT_BYOK_KEY`, with `FREEBOT_BYOK_BASE_URL` and
  `FREEBOT_BYOK_MODEL` beside it. Without a key the run replays
  `packages/pi-bridge/fixtures/rpc-handshake.jsonl` and the launcher says so at startup. The key is
  read out of that file by the server and never out of the environment (order 8). Everything else is
  real either way: the gate, the run store, the log, the container, the page and its stream. See
  "The model" below and `docs/providers.md`.
- **A browser.** On macOS the launcher opens it for you. Chrome is only needed for the evidence
  driver, not for running freebot.

## What you see

```
$ bun run up
freebot up: page and run on 127.0.0.1:60203, tunnel on 127.0.0.1:60202
freebot up: model mode auto, model deepseek/deepseek-v4.1-flash via api.commandcode.ai (key from the vault)
freebot up: vault /Users/you/.freebot/provider.env present, mode 600
freebot up: workspace /Users/you/.freebot/bots/bot-local/workspace mounted at /workspace, kept across runs
freebot up: the operator token rides the URL's fragment and is printed nowhere else
freebot up: opened the URL in your browser
freebot up: Ctrl-C stops the servers and removes this launch's sandbox containers
http://127.0.0.1:60203/#token=<43 url-safe characters>
```

The lines above the URL are diagnostics on stderr. The last line is stdout, and it is the only URL the
launcher prints. The token is in the fragment, the one URL part a browser never sends to a server,
so it reaches no access log and no `Referer` (`docs/one-run-path.md` has the token contract).

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
| `--api-port <n>` | The page and its stream. Default 0, which asks the OS for a free port. |
| `--tunnel-port <n>` | The tunnel leg. Default 0, which asks the OS for a free port. |
| `-h`, `--help` | Print the usage. |

`--no-open --api-port <n>` on a port that is already taken exits 1 and names the port. Two launches
on the default flags cannot collide, because each takes a free port. `--live` on a machine whose
vault holds no key exits 2 and names the file it looked at, rather than quietly replaying.

## Stopping it

Ctrl-C stops both listeners, then removes the sandbox containers this launch created, and exits 0:

```
freebot up: stopping
freebot up: removed sandbox container freebot-sbx-run-1-fglyezgr
freebot up: stopped
```

A container left behind by a `SIGKILL` (not a Ctrl-C) belongs to a launch that no longer exists, so
nothing this launch does removes it. `docker ps -a --filter label=freebot.unit=u1.7` lists the
containers this repo's runs create, including that one. Cleanup is always label- and name-scoped to
the containers a launch made, never a `prune` (order 22).

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
- **Spend caps.** Usage is now real and printed, but nothing consults `checkSpendCap` yet.
- **The scheduler.** Idle-kill, auto-stop and rejoin after `sandbox_lost_mid_run` are still its.
- **A hard `SIGKILL`** still leaves a container behind that no launch owns.
- **The default browser-open path** was checked against a stand-in `open` on `PATH` rather than a
  real browser window, so a person's first `bun run up` is what actually opens one.
