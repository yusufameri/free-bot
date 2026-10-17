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
- **No model key.** Gate G1 parks the keyed provider, so a run's model turns are replayed from the
  committed transcript `packages/pi-bridge/fixtures/rpc-handshake.jsonl`. `docs/providers.md`
  records the key situation and the vault path. Everything else is real: the gate, the run store,
  the log, the container, the page and its stream.
- **A browser.** On macOS the launcher opens it for you. Chrome is only needed for the evidence
  driver, not for running freebot.

## What you see

```
$ bun run up
freebot up: page and run on 127.0.0.1:60203, tunnel on 127.0.0.1:60202
freebot up: the operator token rides the URL's fragment and is printed nowhere else
freebot up: opened the URL in your browser
freebot up: Ctrl-C stops the servers and removes this launch's sandbox containers
http://127.0.0.1:60203/#token=<43 url-safe characters>
```

The first four lines are diagnostics on stderr. The last line is stdout, and it is the only URL the
launcher prints. The token is in the fragment, the one URL part a browser never sends to a server,
so it reaches no access log and no `Referer` (`docs/one-run-path.md` has the token contract).

## The click

The page opens on `127.0.0.1` with the prompt box already showing. Type anything and press
**Start run**.

| Step | What you see |
| --- | --- |
| 1. Armed | Connected, nothing rendered yet, the prompt box is the way in. |
| 2. Parked | The run asked to run `echo native-should-not-run` in a container, and the approval card waits for your answer. The tool card reads `awaiting approval`, so a parked run does not look frozen. |
| 3. Allowed once | The card shows `allowed once`, the command runs inside the container, and the output block holds the container's own stdout. The run reaches its terminal frame. |
| 4. Denied | The card shows `denied`, the call produces no output, the decision marker reads `deny (user_denied)`, and the run still reaches its terminal frame. |

The four committed frames, from the evidence run at commit `103cc49`:

- `packages/verify/artifacts/launch/103cc49/01-armed.png`
- `packages/verify/artifacts/launch/103cc49/02-parked.png`
- `packages/verify/artifacts/launch/103cc49/03-finished.png`
- `packages/verify/artifacts/launch/103cc49/04-denied.png`

One launch parks only its first run. Once you answer a card, the landed ledger holds that action's
grant and the same call again is refused as `grant_consumed` rather than parked, which is why
`packages/review/src/policy.ts` and its tests are the place to look if a second run of the same
command behaves differently from the first.

## Flags

| Flag | Meaning |
| --- | --- |
| `--no-open` | Print the URL, do not open a browser. This is the path the evidence driver uses. |
| `--api-port <n>` | The page and its stream. Default 0, which asks the OS for a free port. |
| `--tunnel-port <n>` | The tunnel leg. Default 0, which asks the OS for a free port. |
| `-h`, `--help` | Print the usage. |

`--no-open --api-port <n>` on a port that is already taken exits 1 and names the port. Two launches
on the default flags cannot collide, because each takes a free port.

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
3. Starting a run shows the approval card with the command above.
4. After Ctrl-C: nothing listens on either port, and
   `docker ps -a --filter label=freebot.unit=u1.7` is as empty as it was before the launch.

## Re-running the evidence

```
bun packages/verify/scripts/launch.ts
```

It boots real launchers with `bun run up`, opens the URL each one printed in headless Chrome over
CDP, drives the click, launches a second and a third instance at the same time, provokes the
pinned-port refusal, and SIGINTs a launch while a run still holds a live container. It writes
`packages/verify/artifacts/launch/<short sha>/assert.txt` plus one PNG per asserted state, and fails
rather than write a token into the artifact. `docs/VERIFICATION.md` carries the row.

## What is not live today

- The model's turns, which the replay provider produces until gate G1 clears.
- The default browser-open path was checked against a stand-in `open` on `PATH` rather than a real
  browser window, so a person's first `bun run up` is what actually opens one.
