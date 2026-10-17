# Sandbox provider (U1.2): the frozen interface and the Docker adapter

Status: the `SandboxProvider` surface from plan 2.6 is frozen here and implemented for Docker, the
adapter the Phase 1 MVP runs Pi-in-sandbox on. Interface and error types live in
`packages/sandbox/src/interface.ts`; the adapter lives in `packages/sandbox/src/docker.ts`. Frozen
against the strictest adapter (boat: screen, suspend, fork), not against Docker, so E2B and boat
fill in capabilities without a redesign.

Artifact: `packages/verify/artifacts/sandbox-provider/dc875b3/assert.txt`, produced by
`bun test packages/sandbox/src/docker.test.ts` at commit `dc875b31769843ebd3b743fc8a68b3f43566b35f` on
branch `u1.2-sandbox-provider`.

## Running the integration suite

The Docker suite is the only one that needs a daemon, and it decides before any container exists
whether it can run. Two preconditions hold, and their absence is the only skip. The daemon must answer
`docker version`, and `docker image ls -q freebot-sandbox:u0.6` must print an id. A skip prints its
reason with the command that fixes it, records a `skip:` line in that run's artifact, and exits 0, so
the rest of `bun test` stays green.

| Situation | Behavior |
| --- | --- |
| No reachable daemon | skip, naming the failed `docker version` |
| Daemon up, pinned image absent | skip, naming `bash packages/sandbox/image/run.sh` |
| Daemon up, `image ls` itself fails | throw, because a half-working daemon is not absence |
| Pinned image present | all ten checks run; a drifted layer set fails inside `ensurePinnedImage` |
| `FREEBOT_DOCKER_TESTS=require` | any would-be skip throws instead |
| Any other `FREEBOT_DOCKER_TESTS` value | throws at load, so a typo cannot mean "optional" |

The image is arm64-only (order 18: this Mac builds), so the linux/amd64 CI runner cannot materialize
it. CI skips this suite by design, and the committed artifact is the local run.

## The interface, method by method

`SandboxHandle` is `{provider, id}`; `SandboxSpec` is `{name, image?, cmd?, env?, mounts?, stateDir?,
labels?, idleTtlMs?}`. Every method takes a handle produced by `create` or `fork` on the same
adapter instance.

| Method | Docker today | Typed gap / future adapter |
| --- | --- | --- |
| `create(spec)` | `docker run -d` from the pinned image, ownership labels, `mkdir -p stateDir` | E2B and boat boot their own VM kinds; `spec.image` is the only image knob |
| `exec(handle, cmd, {stream?, detached?})` | `docker exec`, `-w`/`-e` passthrough; returns `ExecResult`, `ExecStream`, or `DetachedExec` | same shape everywhere; E2B and boat add their own transport |
| `upload` / `download` | `docker cp` | boat and E2B move bytes over their own API |
| `snapshot(handle, name?)` | `docker commit`, disk only, taken while running (no quiesce) | E2B and boat snapshot on a schedule and on demand |
| `fork(fromHandle)` | **typed unsupported** (`UnsupportedCapabilityError`) | boat forks a live VM; E2B forks from a snapshot. Phase 2+ |
| `stop` / `resume` | `docker stop -t 2` / `docker start`; the writable layer is the state | E2B pause keeps memory (`memoryPause: true`) |
| `delete` | `docker rm -f` | same semantics, provider-native calls |
| `exposePort(handle, port)` | loopback forward: one `docker exec` byte bridge per connection, URL `http://127.0.0.1:<hostPort>` | E2B and boat return their public per-port URL |
| `desktop(handle)` | **typed unsupported** (`UnsupportedCapabilityError`) | mandatory in the interface; Docker gets Xvfb + noVNC in Phase 2, boat streams at 60fps |
| `tunnel(handle)` | duplex to the in-VM supervisor link, JSONL `SupervisorToAgent`/`AgentToSupervisor` frames | same wire shape over the provider's own channel |
| `capabilities()` | `{memoryPause: false, dockerInVm: false, kvm: false, gpu: false, regions: ["local"]}` | E2B `{memoryPause: true, regions: ["us","eu"]}`; boat `{dockerInVm: true, kvm: true, regions: ["eu"]}` |

Docker-only extension, not part of the frozen surface: `sweep()` (see cleanup below).

## Digest pinning

`create` resolves the image from the constant in `packages/sandbox/src/image.ts`, which carries what
U0.6 recorded in `docs/sandbox-image.md`: the tag `freebot-sandbox:u0.6`, the node base digest
pinned in the Dockerfile, and the seven RootFS layer digests the build produced. Docker gives a
locally built image no registry manifest digest, so the layer set is the content identity: `create`
asserts it on every call and fails loudly when the image was rebuilt from a changed recipe or on
another architecture. The image Id is recorded but not asserted, because it carries build
timestamps.

`ensurePinnedImage` builds from `packages/sandbox/image/Dockerfile` when the tag is absent, using the
same `--platform linux/arm64` the U0.6 recipe recorded (order 18: this Mac builds). A registry push
with a real manifest digest is still the follow-up the image doc names.

## Lifecycle

`create` starts a container whose only job is to stay alive (`sleep infinity` by default) and to
hold the writable layer that is the sandbox's state. `stop` sends SIGTERM with a 2 second grace
(the in-VM supervisor exits within 250ms) and keeps the layer; `resume` starts the same container, so
the disk state is exactly what it was at stop. `delete` forces removal and is idempotent.

`snapshot(handle, name?)` commits the running container to `freebot-snapshot/<sandbox-id>:<name>`
and returns `{ref: imageId, tag, createdAt, ...}`. Semantics, stated plainly: it is manual, taken
from a running container with no filesystem quiesce and no memory, and durable past the container's
own lifetime. Restoring it today means `create({name, image: snapshot.ref})`, which the integration
suite exercises; `fork` is the typed-unsupported path because forking a live sandbox is a different
guarantee (boat's memory fork). `resume` does not read a snapshot: the container layer already holds
the state.

### Idle-kill, the Phase 1 cut

`spec.idleTtlMs` arms a timer at `create` and re-arms on every adapter call. At expiry, if no tunnel
or port forward is open, the adapter stops the sandbox (`stop`, not `delete`: disk survives and
`resume` brings it back). An open tunnel or forward holds the sandbox awake and its release re-arms
the timer; a stopped or deleted handle is disarmed until `resume`.

What this cut does not do, and the scheduler follow-up owns: activity-based idle that reads frame
traffic rather than adapter calls, a TTL policy per Bot rather than per `create`, auto-stop across
adapter restarts (this timer lives in the creating process's memory), and auto-delete. The timer is
process-local by design; nothing else in the repo reads it.

## Cleanup (order 22)

Every container this adapter creates carries three labels: `freebot.sandbox=<id>`,
`freebot.unit=<unit>` (default `u1.2`), and `freebot.provider=docker`. `sweep()` lists containers by
both ownership labels and `docker rm -f`s exactly those; it never prunes, never matches a name
pattern, and cannot reach another unit's containers, which is what makes it safe on the shared
Docker engine this repo and its sibling units run on. Callers cannot set labels in the `freebot.*`
namespace; spec validation rejects them.

The integration suite proves the boundary rather than asserting it: it creates a decoy container
labelled `freebot.unit=u0.11` and an unlabelled one, runs `sweep()`, and asserts the unit's three
containers are gone while both decoys keep their ids and their running state.

## The error contract

Errors are typed, and the message is literal and assertable.

| Code | Thrown by | Meaning |
| --- | --- | --- |
| `invalid_spec` | `validateSandboxSpec`, `snapshot`, `upload`/`download`, `exposePort`, `create` | the call cannot be expressed; the message names the field and the rule |
| `invalid_handle` | every method | the handle belongs to another provider, or has no id |
| `invalid_command` | `exec` | empty command vector |
| `unsupported_capability` | `fork`, `desktop` | `UnsupportedCapabilityError`; carries `capability` and `provider`, never a silent no-op |
| `docker_cli` | CLI boundary | non-zero exit or timeout, with docker's own stderr and the argument vector in the message |
| `link_error` | `tunnel` | no supervisor port file, no handshake, or a first line that is not an `attached` frame |

`exec` does not throw for a command that ran and failed: the exit code is data in `ExecResult`. A
buffered or detached `exec` is bounded like every other collected call (120s; 600s for a first image
build), so a stuck daemon becomes a `docker_cli` error instead of a hang. The unbounded calls are the
ones that carry a connection rather than an outcome: a streamed `exec`, `tunnel()` and `exposePort`'s
per-connection bridge. Their lifetime is the connection's, nothing here kills them, and a streamed
`result` settles when the command itself exits.

## The tunnel

`tunnel(handle)` returns a `Duplex` to the same endpoint a tunnel agent attaches to: the supervisor's
loopback link inside the sandbox. The bytes on it are the link's own JSONL frames, framed by
`splitLines`/`encodeLine` from `apps/sandbox-agent` (imported, not copied). The adapter reads the
`attached` handshake with that framing, refuses anything else with `link_error`, and then re-emits
the handshake ahead of the live bytes, so the caller's first line is the one every agent sees. The
port comes from `<stateDir>/supervisor.port`, the file the landed supervisor writes.

What a caller wires: the duplex carries frames up and acks down, which is exactly what
`apps/server`'s `/tunnel` ingest consumes, but nothing connects the two yet. Follow-ups: starting the
supervisor inside the sandbox (no unit owns sandbox startup yet), and the host-to-Pi direction that
`docs/forge-test-a.md` names, which is still missing from the landed link.

A destroyed duplex aborts reads in flight and emits an `error`; a caller holding one across a
`stop` must listen for it, as the integration suite does.

## Two Docker facts the adapter works around

- The pinned image ships node and Pi, not bun, so the in-VM daemon (which is bun code) needs an
  image built `FROM` the pinned recipe plus bun, the way `spikes/forge-test-a/Dockerfile` does. This
  is why the tunnel test's peer is a small node process that speaks the link frames, not the
  supervisor itself. Adding bun to the pinned image is an image-unit follow-up, deliberately not
  done here.
- `exposePort` cannot add a published port to a container created earlier, and a container's own IP
  is not reachable from a Docker Desktop host, so the forward is per-connection `docker exec`
  bridges. It costs an exec per connection and closes with `stop`/`delete`.

## What this does not prove

The Docker integration suite is the live surface: create from the pinned image, exec (buffered,
streamed, detached), upload/download byte equality, a tunnel echo through the link, `exposePort`, a
snapshot/stop/resume round trip plus a disk-only restore, the idle cut, and the label-scoped sweep
with decoys. It does not exercise Pi inside the sandbox, the desktop channel, `fork`, a multi-host
provider, or E2B and boat, whose adapters do not exist yet. It is not a UI surface, so no screenshot
artifact applies.
