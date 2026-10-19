# The main sweep

`packages/verify/scripts/sweep-main.ts` answers one question. Does current `origin/main` still pass
the drivers this repo commits artifacts for? Every committed artifact certifies the commit it was
produced at. None certifies the commit main moved to since.

Run it from the repo root:

```sh
bun packages/verify/scripts/sweep-main.ts
```

The command exits 0 when every runnable driver passed. It exits non-zero when one failed or when
its own arithmetic does not add up. `--keep` leaves the isolated checkout on disk for inspection.

## What it does

1. Fetches `origin/main` and resolves the commit.
2. Adds a detached git worktree of that commit under the system temp directory and runs
   `bun install --frozen-lockfile` inside it.
3. Reads `packages/verify/driver-subjects.json`. That manifest is the driver list.
4. Probes the host once for Docker, the microsandbox toolchain with the pinned image, headless
   Chrome, the vault's model key, and a live instance named by `FREEBOT_STATUS_URL`.
5. Runs each runnable driver in the isolated checkout, one at a time.
6. Writes `packages/verify/artifacts/sweep-main/<short sha>/sweep.txt` in the caller's checkout,
   plus one `<driver>.log` for each driver that ran.
7. Removes the isolated worktree, unless `--keep` was passed.

## Isolation

The worktree is the boundary. It holds the exact commit being swept, and the drivers resolve their
repo root from their own file URLs. A dirty, half-migrated, or older caller checkout cannot reach a
driver's imports or its `git rev-parse`. The caller supplies the commit to sweep and the directory
the artifact is written into, nothing else.

The caller's environment is inherited on purpose. That is how a driver reaches the machine's vault
and how the status capture reaches `FREEBOT_STATUS_URL`. No driver runs with a key passed on its
command line.

## The manifest

Each `drivers` entry names its command, its artifact directory, and the files whose change obliges a
re-run. Its `sweep` block gives the sweep what it needs:

```json
{
  "id": "launch",
  "command": "bun packages/verify/scripts/launch.ts",
  "artifact": "packages/verify/artifacts/launch",
  "subjects": ["packages/verify/scripts/launch.ts", "apps/web/**"],
  "sweep": {
    "argv": ["bun", "packages/verify/scripts/launch.ts"],
    "artifactFile": "assert.txt",
    "subject": "one command, one URL, the whole click, and the reap on SIGINT",
    "needs": [["docker"], ["chrome"]]
  }
}
```

`artifactFile` defaults to `assert.txt`. `needs` is a list of requirement groups. A group is met
when any capability it lists is present, so `[["docker", "microsandbox"]]` reads as one sandbox
backend or the other.

`argv` may carry four placeholders, filled after the isolated checkout exists:

- `{checkout}` is the isolated checkout's path.
- `{shortSha}` is the swept commit's short sha.
- `{statusUrl}` is `FREEBOT_STATUS_URL`.
- `{artifactOut}` is `packages/verify/artifacts/sweep-main/<short sha>` inside the checkout.

The status capture uses `{statusUrl}` and `{artifactOut}`. When the variable is unset it is a named
skip with that reason.

A driver the manifest names without a `sweep` block is also a named skip. That keeps a newly added
driver visible in the summary instead of silently outside the sweep.

## Output

The last lines of `sweep.txt` carry the counts a scheduled prompt reads:

```
runnable 19, passed 18, failed 1, skipped 1
RESULT: FAIL (18/19)
```

Every skip has its own line and its reason:

```
SKIP mvp-status-capture: needs a live instance named by FREEBOT_STATUS_URL (FREEBOT_STATUS_URL is not set)
```

Every failure prints the driver, the path of the committed log that proves it, and one line a
coordinator can file as a unit:

```
file a unit: "sweep-main: keyed-run is red against main". The keyed-run driver (... ) exited 1 with
"RESULT: FAIL (12/13)" at 2ab7a8f. Proof packages/verify/artifacts/sweep-main/2ab7a8f/keyed-run.log.
```

The log holds the driver's own artifact text and its captured output. The sweep refuses to write a
log that carries a key-shaped literal or any key, token, secret or password value from the vault,
and fails that driver instead.

## The scheduled prompt

The coordinator owns the schedule. One prompt is enough:

> Run `bun packages/verify/scripts/sweep-main.ts`. Read its `runnable N, passed P, failed F,
> skipped S` line. For each `file a unit:` line, file that unit. Do not merge.

The command does not schedule itself, and it does not file anything.

## Limits

The capability probes are local. A machine without Docker, the microsandbox image, Chrome, or the
vault key reports those drivers as skipped rather than passed. There is no Linux/KVM driver in the
manifest today. When one lands, it declares `needs` for the capability it requires and skips by name
everywhere else.

A driver that exits 0 without a verdict line is a failure, not a pass. The sweep reads the driver's
own artifact first and its printed output second, and it accepts `PASS`, `STABLE`, or a `RESULT:`
line carrying either.
