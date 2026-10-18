# microsandbox: the no-account local sandbox backend (U9.2)

Status: a second `SandboxProvider`, passing the one conformance suite U9.1 landed
(`packages/sandbox/src/conformance.ts`). It runs on this Mac with no account, no payment and no
Docker under the engine, which is the promise of order 34 read literally: Docker first (already
shipped), then microsandbox for a local machine. Plan Part 12 commits this backend; this document is
what a person needs to install it, what the adapter does when it is absent, and every engine behavior
this unit had to find out by running it.

## Licence, version, host, and the beta warning

- **Licence**: Apache-2.0 (`superradcompany/microsandbox`, `LICENSE`).
- **Version this unit pinned**: `msb 0.7.8`, the release
  `install.microsandbox.dev` served on 2026-10-18. The installer always fetches the latest release
  and verifies its sha256 from the same release's `checksums.sha256`; the version every number in the
  committed artifact came from is 0.7.8, and the artifact records `msb --version` again.
- **Beta**: upstream's README calls microsandbox beta software and warns of breaking changes, missing
  features and rough edges. That label travels with the adapter: it is stated here, it is stated in
  `capabilities()`'s doc comment, and any surface that renders this backend's own words must carry it
  rather than presenting the backend as settled.
- **Host**: Apple Silicon macOS (this Mac runs the microVM on the Hypervisor framework), Linux with
  KVM, Windows with WHP. x86_64 macOS is refused by the installer.
- **What it is**: one microVM per sandbox, its own Linux kernel and filesystem, booting an OCI image
  through libkrun. There is no server and no daemon: `msb` starts a child process per VM.

## What a person installs, and what happens without it

```bash
curl -fsSL https://install.microsandbox.dev | sh   # macOS / Linux
msb doctor                                          # every line must be green
```

The installer writes `~/.microsandbox/{bin,lib}` and symlinks `~/.local/bin/msb`. No account, no
token, no Docker. `FREEBOT_MSB_BIN` names a different binary; without it the adapter runs `msb` from
`PATH`.

Nothing in this repository depends on the tool being present (order 27): the adapter shells out to a
host CLI, which is not a repository dependency.

- **Tool absent**: `packages/sandbox/src/microsandbox.test.ts` **skips** and prints why, so a machine
  without microsandbox still passes `bun run test`, `bun run verify` and `bun run lint`. The skip
  names the command that fixes it. `FREEBOT_MSB_TESTS=require bun test
  packages/sandbox/src/microsandbox.test.ts` turns that skip into a failure, the same shape and the
  same env convention the Docker suite uses.
- **Tool present, image missing**: `ensureMicrosandboxImage()` throws a typed `msb_cli`
  `SandboxError` naming both ways to close the gap, rather than reporting the engine's own words.
- **Tool present and broken**: loud. A `doctor` that fails is a skip; a broken `image` verb while
  `doctor` passes throws.

## The pinned image, and the one place Docker can appear

The image is an **OCI artifact**, not a Docker image: the tag `freebot-sandbox:u0.6` that
`packages/sandbox/image/Dockerfile` builds (node 24.22.0 plus Pi 1.3.0). Import it once:

```bash
msb image load -i <oci-archive.tar> --tag freebot-sandbox:u0.6
# or point FREEBOT_MICROSANDBOX_IMAGE_TAR at the archive and let the adapter load it
```

`msb image load` verifies every layer against the manifest digest and contacts no registry. From that
point the runtime path is `msb` alone: the adapter builds no argument vector for `docker`, and the
evidenced run proves it (the driver's census and the adapter's boundary are `msb` only).

**The honest boundary.** Producing the archive needs an OCI builder. The repo's own recipe is
`packages/sandbox/image/run.sh`, which uses Docker on the build host (order 18 makes this Mac the
build host and Docker Desktop the local sandbox). A person without Docker gets the same OCI image
from any OCI source, or builds it with buildah or podman; microsandbox has no image-build verb of its
own. Nothing here requires an account or a payment, and the import is one command on a machine that
already has the image. This is the one place Docker is named, and it is recorded rather than hidden.

## What the adapter answers, and how

Every sandbox the adapter creates carries the order-22 ownership labels `freebot.sandbox=<id>`,
`freebot.unit=<unit>` and `freebot.provider=microsandbox`. `sweep()` removes exactly the sandboxes
carrying this adapter's own unit label and the microsandbox provider label, and nothing else.

| `SandboxProvider` member | microsandbox |
| --- | --- |
| `create` | `msb create -n <name> --label ... [env] [mounts] <image>`, then `msb exec ... mkdir -p <stateDir>` |
| `exec` buffered | `msb exec --no-tty --no-stdin <name> -- <cmd>`, the command's own exit code |
| `exec` streamed | `msb exec --stream <name> -- <cmd>`, a real byte pipe |
| `exec` detached | `msb exec -d <name> -- <cmd>`, a runtime-owned job |
| `upload` / `download` | `msb copy <host> <name>:/abs` and back |
| `snapshot` | `msb snap create --sandbox <name> --group freebot-snapshot-<id> -n <member>` |
| `stop` / `resume` | `msb stop` / `msb start`, converged on the engine's own state |
| `delete` | `msb rm -f`, converging on absence |
| `tunnel` | the supervisor's loopback port read from `<stateDir>/supervisor.port`, bridged by the image's node over `msb exec --stream`, the same `link-bridge.ts` the Docker adapter uses |
| `exposePort` | a host loopback bridge, one `msb exec --stream` per connection (the engine publishes ports only at boot) |
| `fork` | `msb fork`, which the engine really supports |
| `desktop` | typed `UnsupportedCapabilityError`; the screen channel is Phase 2 |

`capabilities()` is `{memoryPause: false, dockerInVm: false, kvm: <host is Linux>, gpu: false,
regions: ["local"]}`. `memoryPause` is false because the frozen interface models stop/resume and a
stopped microVM keeps its disk but not its memory; the engine's own `pause`/`resume` do keep memory,
and that pair is not this interface.

## The four interface gaps, decided through the ownership port

U9.1 named four things the frozen interface does not carry. Each is answered by
`microsandboxConformanceSubject` through `msb`; none of them forks the suite, and no second copy of an
assertion exists.

| Gap | How microsandbox answers it |
| --- | --- |
| No cleanup operation | `sweep()` = `msb ls --label freebot.unit=<this run> --label freebot.provider=microsandbox -q`, then `msb rm -f <those names>`. Label-scoped, never by name pattern, never pruning |
| No ownership or liveness fact | `inspect(id)` = `msb inspect <name> --format json`, read as `status` plus `active_config.labels`, and `null` when the engine holds nothing |
| No way to make a sandbox this run does not own | `addDecoys` creates three sandboxes with `msb create`: another unit's label, a sibling run's label, and one with no ownership label at all |
| No image identity operation | `image()` resolves the engine's cached OCI image and reports its digest and layer count; the suite still proves the image from inside by `node --version` and `pi --version` |

**What stands in for Docker's ownership label** is `--label` at `create` time. It is filtered with
`--label key=value` (AND-matched) on `msb ls`, and the namespace is `freebot.` exactly as Docker's is,
so one census reads the same way on either engine. Where Docker identifies a container by a 64-hex id
and prints 12 characters, microsandbox identifies a sandbox by its name; `OwnerFact.id` is therefore
the sandbox name in this adapter, and `sweep()` returns those same names, so the suite's
`removed === live` comparison holds.

## Engine behavior this unit found by running it

Each of these is a fact from `msb 0.7.8` on this Mac, not an assumption:

- **Idle TTL granularity.** The engine's `--idle-timeout` takes whole seconds and rejects `600ms`
  (`invalid digit found in string`), while the interface's `idleTtlMs` is milliseconds. The adapter
  therefore keeps its own TTL timer, exactly as the Docker adapter does, and passes no idle flag.
- **Snapshot group names.** `[A-Za-z0-9._-]` only; `/` is refused (`invalid group`). The engine's
  reference is therefore `freebot-snapshot-<id>:<member>`, while `snapshot.tag` stays the suite's
  literal `freebot-snapshot/<id>:<member>`.
- **`msb snap restore` has no `--label`.** The ownership labels are applied afterwards with
  `msb modify <name> --label ... --restart`. Without `--restart` the engine refuses
  (`cannot modify ... without a restart`); with it the labels apply at once and the disk is kept.
- **Bind-mount host paths through a symlink are refused.** `/var` on this Mac is one, and the Bot
  workspace lives under a temp directory there, so the adapter resolves a mount's host path with
  `realpathSync` before handing it over.
- **`stop` converges, `start` races it.** The engine can report a sandbox stopped a moment before its
  runtime releases it, so a `start` issued then fails with `already running`. Both verbs are
  idempotent here and wait, bounded, for the state the caller asked for.
- **`delete` converges on absence.** A `rm -f` for a sandbox that is already gone exits non-zero
  (`sandbox not found`), and a run's own `destroy` reaches that path. `docs/sandbox-conformance.md`
  records that Docker throws here and that naming converge-on-absence would settle it; this adapter
  converges.
- **U9.1's `sweep` sabotage is Docker-coupled.** `sabotageOperation(subject, "sweep", names)` removes
  its decoys with `dockerCli`. Against a non-Docker backend that removes nothing, and
  `docker rm -f <missing>` exits **0** on Docker 28.3.2, so the sabotaged sweep passes and the drill
  proves nothing. The driver records that as a finding and seeds the same defect through `msb rm` so
  the census assertion is still shown to fail. Fixing the arm to remove decoys through the subject's
  own ownership port would close it for every backend.

## Evidence

`bun packages/verify/scripts/sandbox-microsandbox.ts` writes
`packages/verify/artifacts/sandbox-microsandbox/<short sha>/assert.txt`. It boots the app's real
server with a microsandbox-backed sandbox port, drives one run with the vault's own model choice
(keyed when a key is present, the replay when not), answers the approval on the app's `events` socket,
and reads the file the run wrote both through `read_file` and off the host; it then runs the suite,
and it runs three negative controls (a sabotaged upload, the finding above, and the engine-seeded
sweep). `bun test packages/sandbox/src/microsandbox.test.ts` drives the same suite inside the repo's
own test run and skips where `msb` is absent.

This unit adds no user-visible surface: no web route, no page, no copy. The one surface that could
render the backend's words is the provider list, and the beta label is recorded here and in
`capabilities()` so that surface carries it when it exists.
