# Sandbox image (U0.6): the pinned image, an in-image replay, and the key scan

Status: first pinned sandbox image. It builds Pi 1.3.0 on a digest-pinned node base, runs Pi's RPC
mode inside the container against a keyless stub model, proves two runs of the same scripted turn
produce the same event sequence, and proves host key material is unreachable from inside. This
covers plan 5.2 expanded Phase 0 checks 5 and 6 (no raw key material reachable in-VM;
`{pi_version, image_digest}` recorded and asserted equal on a second replay).

Artifact: `packages/verify/artifacts/sandbox-image/8d36ea7/` (`assert.txt`, `digest.txt`,
`keyscan.txt`, `replay1.jsonl`, `replay2.jsonl`, `run.log`), produced by
`bash packages/sandbox/image/run.sh` at commit `8d36ea7`.

Files:

```
packages/sandbox/image/Dockerfile    base image with digest pin + content-addressed pi install
packages/sandbox/image/run.sh        the one command: build, replay twice, compare, scan, artifact
packages/sandbox/image/replay.mjs    in-image driver: spawns `pi --mode rpc`, records frames
packages/sandbox/image/stub-model.mjs keyless OpenAI-compatible SSE stub, node port of the spike's
packages/sandbox/image/replay-ext.ts one echo tool, no imports
packages/sandbox/image/compare.mjs   replay equality with the documented normalization
packages/sandbox/image/probe.sh      in-container key-material scan
```

## What is pinned, and what the rebuild measured

| Item | Value |
| --- | --- |
| Base tag | `node:24.22.0-bookworm-slim` (pulled 2026-10-16) |
| Base digest, pinned in the Dockerfile | `sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5` |
| Node in the image | `v24.22.0` (Pi 1.3.0 requires `>= 22.19.0`) |
| Pi | `@earendil-works/pi-coding-agent@1.3.0`, installed from a tarball whose sha512 must equal `V/WoCjA2hQSe3QLWIUB24cTRdtEdeLiIzkDqU5RMXV6VWuD+KGZnzVBMhglwdnQTySkehZsjt8a3g6Jd2g4nnw==` |
| Built image, this run | Id `sha256:9d0dfd169778839640084e90deae1dfd2aa08a2b1edac1c1451ef2e1531719f8` |

The build asserts two things and fails closed on both: the installed `pi --version` equals
`1.3.0`, and the tarball it installs matches the registry integrity hash the pi-rpc spike recorded
(`docs/pi-rpc-spike.md`). The tarball hash is what makes the install content-addressed rather than
just version-numbered.

Rebuild outcome, reported as measured. A second build of the same Dockerfile produced a different
image Id (`sha256:57ea864e…`) but a byte-identical RootFS layer set: all seven layer digests match,
including the `npm` install layer, which means the installed files are identical down to their
tarball timestamps. The Id differs because the image config carries build timestamps.
`digest.txt` records both. So the reproducible identity of this image is its layer set, and the
guarantee a consumer relies on is the Dockerfile (base digest plus content-addressed pi), not an
image Id.

`docker inspect` also reports a RepoDigest for the built image. On this Docker Desktop 28.3.2 with
the containerd image store that value is synthetic and equal to the image Id; it is not a registry
manifest digest. A real cross-machine digest needs a push, which is a follow-up.

```sh
bash packages/sandbox/image/run.sh
```

## The replay inside the image

Container spec (recorded per run in `run.log`): `freebot-sandbox:u0.6`, mounts
`packages/sandbox/image:/image:ro` and the artifact directory at `/out`, one env var
`SANDBOX_IMAGE_DIGEST` carrying the host-recorded image digest, default bridge network (nothing but
loopback is used), no capabilities added, no privileged mode.

The driver (`replay.mjs`) starts the keyless stub on `127.0.0.1:39412`, writes a `models.json`
whose provider `stub` points at it with the literal `apiKey: "keyless-stub-literal"`, and spawns:

```
pi --mode rpc --no-session --offline --no-approve --no-builtin-tools \
   --provider stub --model stub-1 -e /image/replay-ext.ts
```

with a hermetic `HOME` and `PI_CODING_AGENT_DIR` under `/tmp/replay`. The scripted turn is one
prompt, `replay: call replay_echo`; the stub answers with the tool call, the extension's tool
executes, the result goes back to the model as a second request, and the model answers with text.
Every frame Pi writes to stdout and every stub HTTP request is recorded in arrival order. Both
runs exited 0, produced 12 driver checks each (all PASS), and wrote 33-line transcripts (1 header
plus 32 frames). `stderrLines` was 0 in both, matching the spike.

### Normalization, in full

`compare.mjs` re-serializes every frame with object keys sorted, then drops these keys wherever
they appear: `id`, `timestamp`, `durationMs`, `sessionId`, `toolCallId`, `parentToolCallId`. Those
are the values that cannot be equal across two processes: correlation ids, tool-call ids, the
generated session id, clocks, and measured durations. Everything else must match exactly, frame
order included. The header is compared as a whole, without dropping anything, which covers
`pi_version`, `image_digest`, node version, platform, and the Pi command line.

Result at `8d36ea7`: headers identical, 32 / 32 events equal, `RESULT: PASS`. The two raw files are
not byte-identical and are not expected to be: `replay1.jsonl` and `replay2.jsonl` differ first at
char 922 of line 2, inside the dropped `timestamp` of the `get_state` response.

## The key scan

The host writes `/tmp/freebot-keyscan/provider.env` containing one line, a fake canary
`FREEBOT_FAKE_KEY_CANARY_<32 hex>`. That path is never mounted, and no env var carries its value.
The scan runs with the same spec as a replay run: same image, same mounts (`/image:ro` and the
artifact directory at `/out`), no key path bound, no `-e`. `keyscan.txt` records the container's
`Env`, `Binds`, and `NetworkMode` from `docker inspect` next to the raw scan output.

The canary reaches the probe on stdin, never as argv or env, so the scan cannot find its own
needle in `/proc/<pid>/environ` or `/proc/<pid>/cmdline`. `probe.sh` exhausts:

1. `env`.
2. `/proc/*/environ`, then `/proc/*/cmdline` (read as NUL-separated text).
3. `/proc/mounts` and `/proc/self/mountinfo`, plus a check that no `keyscan` path appears in the
   mount table.
4. The whole filesystem with `grep -r -l -a`, excluding `/proc`, `/sys`, `/dev`, and the scanner's
   own pattern file `/.keyscan-needle` (created for the run, removed at the end).
5. `~/.freebot`, `/home/yusufameri`, and any path matching `*keyscan*`.
6. Informational only: `BEGIN OPENSSH|RSA|EC PRIVATE KEY` headers.

Before scanning for the canary it runs a positive control: a decoy canary-shaped string is written
to `/tmp/probe-control/decoy.txt`, and the same machinery must find it. It did, in exactly 1 file.
That is what makes the negative result meaningful, and it is the first thing the probe reports.

Result: 0 hits in every category, `CANARY HITS: 0`, `PROBE RESULT: PASS`, probe exit 0. The host
control in the same file shows `grep -c` finding the canary once in
`/tmp/freebot-keyscan/provider.env` and its sha256. The canary value itself is printed nowhere: not
in the artifact, not in the repository, not in the image.

The informational scan reported 2 files containing private-key headers:
`/usr/lib/aarch64-linux-gnu/libgnutls.so.30.34.3` (string table in a system library) and
`/image/probe.sh` (the scanner's own pattern list). Neither is key material; the count is recorded
rather than suppressed so the raw output is readable as-is.

## What this does not prove

- **Anything about keys other than the canary.** The scan proves this image, run with this spec,
  has no readable copy of one specific string. It cannot prove the absence of key material it does
  not know the shape of. The plan's rule is structural: keys live in the vault path and never enter
  the sandbox (standing order 8); this artifact is evidence for one build, not for every future
  image.
- **Containment.** No nftables, no egress policy, no Chromium. The container keeps the default
  bridge network. Network containment is the U0.4 spike's territory and the production startup
  step is still a follow-up there.
- **The tunnel, the bridge, and approvals.** This run is a single scripted turn driven directly
  over `pi --mode rpc`; the gate extension from the pi-rpc spike is not loaded.
- **Cross-machine reproducibility.** The pin is a Dockerfile and a base digest. Until this image
  is pushed to a registry, two machines each build their own Id.

## Follow-ups

1. Push the built image to a registry and record its manifest digest, so later units can pin by
   digest instead of rebuilding.
2. pi's transitive dependencies are version-pinned by npm and integrity-checked by npm at download
   time, but the Dockerfile does not pin their hashes; a lockfile-driven build would.
3. Extend the in-image replay to the gate and approval turns (`spikes/pi-rpc/gate-ext.ts`) once the
   pi-bridge unit's replay mode exists.
4. The stub port is fixed at 39412 so headers stay comparable; a collision fails the run loudly
   rather than silently shifting a field.
