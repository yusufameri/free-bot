# The sandbox conformance suite (U9.1)

Status: one suite names what a sandbox backend must do. Docker is the reference implementation and
passes it. A second backend (microsandbox in U9.2, E2B Embed in U9.3) runs the same function and is a
pass or a failure rather than a rewrite. Plan Part 12 is why this exists, and order 34 is the rule
behind it: no paid dependency may be required to run the MVP, so every free backend has to prove
itself against one bar.

The suite is `packages/sandbox/src/conformance.ts`. The evidence driver is
`packages/verify/scripts/sandbox-conformance.ts`. The Docker integration test in
`packages/sandbox/src/docker.test.ts` drives the suite rather than a second copy of its assertions,
so each operation is asserted once, in one place.

Artifact: `packages/verify/artifacts/sandbox-conformance/<short sha>/assert.txt`.

## One entry point

```ts
const subject: ConformanceSubject = ...;
const result = await runSandboxConformance(subject, { scratch, report: (line) => write(line) });
```

`result.ok` is true only when every operation ran and passed. `result.operations` holds each
operation's literal lines and, on a failure, the literal mismatch. The runner stops at the first
failure, because each later operation uses state the earlier ones left, and it reports the failure
rather than throwing so the caller's artifact carries the operation that failed and what it saw.

A subject is the frozen `SandboxProvider` from plan 2.6 plus an `SandboxOwnership` port. With
`dockerConformanceSubject({token, decoys})`, the Docker subject is about ten lines of glue. A
different backend writes its own glue and nothing else.

## How a backend runs the suite

1. Implement `SandboxProvider` from `packages/sandbox/src/interface.ts`. The suite calls `create`,
   `exec` (buffered, streamed and detached), `upload`, `download`, `tunnel`, `snapshot`, `stop`,
   `resume` and `delete`, and it reads `provider.id`.
2. Build a `ConformanceSubject`.
   - `id` is this run's token. Every sandbox the suite creates is named `<case>-<id>`, and the
     backend's ownership label carries it. Two runs on a shared engine must share no name and no
     label value, which is what makes the order-22 sweep safe.
   - `stateDir` is the in-sandbox directory the backend's agent link uses. `create` makes it. Docker
     uses `/var/freebot`, where the supervisor writes `supervisor.port`.
   - `image()` resolves and validates the image every sandbox boots from, and returns the reference
     the suite passes as `spec.image` plus what the backend observed about it.
   - `ownership` answers the questions the frozen interface cannot (see the gaps below).
3. Call `runSandboxConformance` from a driver and write `assert.txt` under
   `packages/verify/artifacts/sandbox-conformance/<short sha>/`, with every line the suite reports.
4. Run the drill below once. A backend that passes without failing the sabotaged run has proven
   nothing.

## What a backend must provide

| Area | What the suite needs | Docker |
| --- | --- | --- |
| image | A pinned image the suite can name, boot in about a minute, and read its own content from | `freebot-sandbox:u0.6`, built from `packages/sandbox/image/Dockerfile`, layer set asserted by `ensurePinnedImage` |
| exec | Buffered, streamed and detached execution, with the command's own exit code as data | `docker exec`, `-w`/`-e` passthrough |
| copy | Bytes in and bytes out, byte-equal in both directions, at an absolute remote path | `docker cp` |
| tunnel | A duplex to the backend's agent link, framed in `@freebot/sandbox-agent`'s JSONL, plus a typed error when no link is running | the supervisor's loopback port read from `supervisor.port` |
| lifecycle | `create`, `stop` keeping the disk, `resume` restoring it, `delete`, and an idle stop on `idleTtlMs` | `docker stop -t 2`, `docker start`, `docker rm -f`, and the adapter's own timer |
| snapshot | A reference another `create` can boot from, with the disk state inside it | `docker commit` to `freebot-snapshot/<id>:<name>` |
| ownership | A label-scoped sweep, a way to read what the engine holds for a sandbox id, and a way to create containers this run does not own | `sweep()`, `docker ps`/`docker inspect`, and three decoy containers |
| node inside | The suite uploads the landed link framing and a peer fixture and runs them with the sandbox's own node | the pinned image ships node 24.22.0 |

The image's content is asserted from inside the sandbox rather than restated here: `node --version`
must print `v24.22.0` and `pi --version` must print `1.3.0`. Those are the image's own answers, so a
backend that boots something else fails at the first operation.

## The operations, in order

| # | Operation | The assertion, as a literal |
| --- | --- | --- |
| 1 | create | The handle carries the subject's own provider id and the name it was given. `inspect` says the sandbox is running and carries `freebot.unit=<this run>`, `freebot.sandbox=<id>` and `freebot.provider=<id>`. Inside the sandbox, `node --version` is `v24.22.0\n` and `pi --version` is `1.3.0\n` |
| 2 | exec | `echo hello-from-sandbox` gives exit 0, stdout `hello-from-sandbox\n` and empty stderr. A streamed `printf` gives the same bytes and exit 0. `exit 7` gives exit 7 with empty stdout. A detached command returns `{started:true}` and its marker file is readable after the call returned |
| 3 | upload | 4096 random bytes are written to `<stateDir>/up.bin`, and the sandbox's own `sha256sum` equals the host's hash of those bytes |
| 4 | download | The same path comes back as 4096 bytes, byte-equal to what went in |
| 5 | tunnel | The first line on the duplex is `{"kind":"attached","acked":0,"lastSeq":0}`. An ack with seq 7 comes back as `{"kind":"frame","seq":7,"frame":{"type":"agent_settled"}}`. With no link running, `tunnel()` throws a `SandboxError` whose code is `link_error`. `delete` then removes that sandbox |
| 6 | snapshot-resume | `snapshot(handle, "u91-round-trip")` returns the tag `freebot-snapshot/<id>:u91-round-trip`. `stop` leaves the sandbox not running, `resume` brings it back running with the marker intact, and a new sandbox created from `snapshot.ref` reads the same marker |
| 7 | idle-kill | A sandbox created with `idleTtlMs=3000` stops with no adapter call. After `resume`, four calls at 200ms intervals against the same 3000ms ttl leave it running |
| 8 | sweep | The census before (every decoy, then every sandbox this run still holds), the sweep's engine ids equal to exactly those sandboxes, and the census after (this run holds nothing, and every decoy keeps the identity and running state it had) |

## The negative control

`sabotageOperation(subject, operation, decoys)` returns the same subject with one operation
deliberately wrong. Only the operations a wrapper can falsify from outside the provider are
supported, which is what keeps the drill honest. `upload` moves the right number of wrong bytes,
`sweep` removes the decoys it does not own, and `exec` under-reports a success (because `create`
proves the pinned image with two exec calls, that one surfaces in `create`).

The sweep arm removes its decoys through the subject's own ownership port, `removeDecoys`, so the
defect is seeded on whatever engine the subject runs on. That matters because the alternative is
silently backend-specific: U9.1's arm called `dockerCli` directly, which removes nothing on a
non-Docker backend, and `docker rm -f <missing>` exits **0** on Docker 28.3.2, so against
microsandbox the sabotaged sweep passed and the drill proved nothing while reading as a pass. U9.5
found that and fixed it; `docs/microsandbox.md` records it. A backend that answers `removeDecoys` with
its own engine therefore gets a sabotage that really breaks its decoys.

The drill is the same suite run again against the sabotaged subject, and it must report that
operation failing. U9.2 and U9.3 each run it once and commit both outputs. A backend's pass means
nothing until its sabotage fails, because a suite that cannot fail is not evidence.

Both arms of the drill are asserted on both backends (criterion 3 of U9.5): the sabotaged sweep fails
with the decoy's own census change on Docker **and** on microsandbox, and the unsabotaged sweep passes
on both. The literal Docker records is
`the decoy another unit's label: expected "...=d04da4da... running", got "...=gone"`, and
microsandbox's is the same sentence with its own decoy name and `gone`.

## The gaps the interface does not yet carry

The suite asserts the frozen interface's operations and four more things beside it. Each of the four
is a gap rather than an invention, and a follow-up owns closing it in `interface.ts`.

| Gap | Why the suite needs it | What the suite does today |
| --- | --- | --- |
| No cleanup operation | `sweep()` is a Docker-only extension on the adapter, not on `SandboxProvider`, yet order 22 makes label-scoped cleanup repo-wide policy | The port carries `sweep()`, and the suite asserts the sweep's ids and the decoy census around it |
| No ownership or liveness fact | A handle is `{provider, id}`. Nothing reads the engine, so nothing can say whether a sandbox is running or what labels it carries | The port carries `inspect(id)`, and the suite asserts the running state and the three ownership labels through it |
| No way to make a sandbox this run does not own | A backend's engine is not in the interface, so a decoy has to be made by the backend itself | The port carries `addDecoys`, `observeDecoy` and `removeDecoys`, and the suite compares the census before and after |
| No image identity operation | `ensurePinnedImage()` is Docker's, and no interface method answers what image a sandbox is running | The suite proves the image from inside by its own content, and the backend resolves and asserts its own pin |

Three further deltas are recorded rather than closed.

- `delete` is documented as idempotent in `docs/sandbox-provider.md`, but the Docker adapter's second
  `delete` for a container that is already gone throws `docker_cli`, because `docker rm -f` exits
  non-zero. The end state converges either way, which is what the suite asserts: one `delete`, then
  the absence. A backend that answers ok on a second delete differs from Docker here, and an interface
  that named converge-on-absence would settle it.
- `exposePort` is on the interface and is not in the suite. Docker's implementation is a host-side
  loopback bridge, one `docker exec` per connection, which no other backend shares. It stays asserted
  in `packages/sandbox/src/docker.test.ts`, and a follow-up either moves it into the suite behind a
  port operation or leaves it as a per-backend extra.
- `desktop` and `fork` are on the interface and are typed-unsupported for Docker
  (`UnsupportedCapabilityError`). The suite cannot assert them for Docker without asserting the
  Docker adapter's gap as the contract, so a backend that supports either is untested here until the
  suite grows an optional operation for it.

## What the evidence driver proves

`bun packages/verify/scripts/sandbox-conformance.ts` launches the app the way a person does,
`bun run up --no-open`, over a home and a bots root it made, with the replay provider pinned. It then
starts one run through the app's own `start_run`, so the app's containers are live under
`freebot.unit=u1.7` while the suite's sweep runs. The artifact carries the launcher's own boot line,
the status its printed URL answers, the app's container census before and after the suite, every
operation's literals, the decoy census around the sweep, and both sabotaged runs with the literal
each reported. A run of this driver takes about three minutes on this host, most of it the twelve
containers the suite and the driver create and remove.

## What this does not prove

The suite proves the sandbox seam, not the product. It does not exercise Pi inside the sandbox, the
desktop channel, `fork`, a multi-host provider, `exposePort` (see above), the scheduler's idle policy
across adapter restarts, or the run loop. Those stay with their own units and docs. The image is
arm64-only (order 18), so a linux/amd64 CI runner cannot materialize it and skips the Docker-backed
suites; the committed artifact is the local run.
