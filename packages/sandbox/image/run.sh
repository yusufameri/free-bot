#!/usr/bin/env bash
# Build the pinned sandbox image, replay the same scripted turn twice inside it, compare the two
# transcripts, scan the container for host key material, and write the artifact under
# packages/verify/artifacts/sandbox-image/<short-sha>/.
#
#   bash packages/sandbox/image/run.sh
#
# Requires a working docker daemon (this Mac, Docker Desktop, arm64).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
short_sha=$(git -C "$repo" rev-parse --short HEAD)
art="$repo/packages/verify/artifacts/sandbox-image/$short_sha"
tag=freebot-sandbox:u0.6
rebuild_tag=freebot-sandbox:u0.6-rebuild
base_tag=node:24.22.0-bookworm-slim
base_digest=sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
canary_file=/tmp/freebot-keyscan/provider.env
log="$art/run.log"

mkdir -p "$art"
: > "$log"
say() { printf '%s\n' "$*" | tee -a "$log"; }
step() { say "\$ $*"; "$@" >>"$log" 2>&1; }

FAILED=0
note_step() { # $1 = exit code, rest = description
  local code=$1
  shift
  if [ "$code" -ne 0 ]; then
    say "FAILED (exit $code): $*"
    FAILED=1
  else
    say "ok: $*"
  fi
}

# --- canary on the host, outside any mount ---------------------------------------------------
canary="FREEBOT_FAKE_KEY_CANARY_$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
mkdir -p "$(dirname "$canary_file")"
printf '%s\n' "$canary" > "$canary_file"
{
  echo "== host control: the canary exists on the host, outside every container mount =="
  echo "\$ ls -l $canary_file"
  ls -l "$canary_file"
  echo "\$ grep -c -F <canary> $canary_file"
  echo "matches: $(grep -c -F -- "$canary" "$canary_file")"
  echo "\$ shasum -a 256 $canary_file"
  shasum -a 256 "$canary_file"
  echo "canary length: ${#canary}"
  echo "canary value is not printed anywhere in this artifact: it lives only in $canary_file"
} >>"$log"

# --- build -----------------------------------------------------------------------------------
say "== build =="
set +e
step docker build --platform linux/arm64 -t "$tag" -f "$here/Dockerfile" "$here"
build_code=$?
step docker build --platform linux/arm64 -t "$rebuild_tag" -f "$here/Dockerfile" "$here"
rebuild_code=$?
set -e
note_step "$build_code" "docker build $tag"
note_step "$rebuild_code" "docker build $rebuild_tag (rebuild)"

image_id=$(docker inspect --format '{{.Id}}' "$tag")
rebuild_id=$(docker inspect --format '{{.Id}}' "$rebuild_tag")

{
  echo "git commit: $(git -C "$repo" rev-parse HEAD)"
  echo "git short sha: $short_sha"
  echo "branch: $(git -C "$repo" rev-parse --abbrev-ref HEAD)"
  echo "docker build exit code: $build_code (rebuild: $rebuild_code)"
  echo
  echo "== base image =="
  echo "tag: $base_tag"
  echo "digest pinned in Dockerfile: $base_digest"
  echo "RepoDigests: $(docker inspect --format '{{json .RepoDigests}}' "$base_tag")"
  echo "Id: $(docker inspect --format '{{.Id}}' "$base_tag")"
  echo
  echo "== built image =="
  echo "tag: $tag"
  echo "Id: $image_id"
  echo "RepoDigests: $(docker inspect --format '{{json .RepoDigests}}' "$tag")"
  echo "Created: $(docker inspect --format '{{.Created}}' "$tag")"
  echo "Architecture: $(docker inspect --format '{{.Architecture}}' "$tag")"
  echo "node in image: $(docker run --rm "$tag" node --version)"
  echo "pi in image: $(docker run --rm "$tag" pi --version)"
  echo "image digest used for the pinned run env: $image_id"
  echo
  echo "== rebuild =="
  echo "tag: $rebuild_tag"
  echo "Id: $rebuild_id"
  if [ "$rebuild_id" = "$image_id" ]; then
    echo "rebuild outcome: identical image Id"
  else
    echo "rebuild outcome: different image Id (the OCI config carries build timestamps)"
  fi
  layers_a=$(docker image inspect --format '{{json .RootFS.Layers}}' "$tag")
  layers_b=$(docker image inspect --format '{{json .RootFS.Layers}}' "$rebuild_tag")
  if [ "$layers_a" = "$layers_b" ]; then
    echo "RootFS layers identical across the two builds: yes"
  else
    echo "RootFS layers identical across the two builds: no"
  fi
  echo "RootFS layers (build 1): $layers_a"
} >"$art/digest.txt"

# --- two replay runs in the image ------------------------------------------------------------
for n in 1 2; do
  name="freebot-u0.6-replay$n"
  rm -f "$art/replay$n.jsonl"
  say "== replay $n =="
  set +e
  step docker run --name "$name" \
    -e SANDBOX_IMAGE_DIGEST="$image_id" \
    -v "$here:/image:ro" -v "$art:/out" \
    "$tag" node /image/replay.mjs "/out/replay$n.jsonl"
  code=$?
  set -e
  note_step "$code" "replay$n exit code"
  {
    echo "== container $name spec =="
    echo "Image: $(docker inspect --format '{{.Image}}' "$name")"
    echo "Env: $(docker inspect --format '{{json .Config.Env}}' "$name")"
    echo "Binds: $(docker inspect --format '{{json .HostConfig.Binds}}' "$name")"
    echo "NetworkMode: $(docker inspect --format '{{.HostConfig.NetworkMode}}' "$name")"
  } >>"$log"
  docker rm "$name" >>"$log" 2>&1
done

# --- equality check --------------------------------------------------------------------------
say "== compare =="
set +e
step docker run --rm -v "$here:/image:ro" -v "$art:/out:ro" \
  "$tag" node /image/compare.mjs /out/replay1.jsonl /out/replay2.jsonl
compare_code=$?
set -e
note_step "$compare_code" "replay equality (compare.mjs)"

# --- key scan --------------------------------------------------------------------------------
say "== keyscan =="
keyscan_name=freebot-u0.6-keyscan
set +e
docker run --name "$keyscan_name" -i \
  -v "$here:/image:ro" -v "$art:/out" \
  "$tag" sh /image/probe.sh <"$canary_file" >"$art/keyscan.txt" 2>&1
keyscan_code=$?
set -e
{
  echo "full scan output above is the raw stdout+stderr of:"
  echo "  docker run --name $keyscan_name -i -v $here:/image:ro -v $art:/out $tag sh /image/probe.sh < $canary_file"
  echo "probe exit code: $keyscan_code"
  echo
  echo "== container $keyscan_name spec (proves no key path is bound and no env is injected) =="
  echo "Image: $(docker inspect --format '{{.Image}}' "$keyscan_name")"
  echo "Env: $(docker inspect --format '{{json .Config.Env}}' "$keyscan_name")"
  echo "Binds: $(docker inspect --format '{{json .HostConfig.Binds}}' "$keyscan_name")"
  echo "NetworkMode: $(docker inspect --format '{{.HostConfig.NetworkMode}}' "$keyscan_name")"
  echo
  echo "== host control =="
  echo "\$ grep -c -F <canary> $canary_file"
  echo "matches: $(grep -c -- "$canary" "$canary_file" 2>/dev/null || true)"
  echo "shasum: $(shasum -a 256 "$canary_file")"
  echo
  echo "== assertion =="
  echo "canary hit count must be 0; the probe's own summary line is authoritative:"
  grep -E "CANARY HITS|PROBE RESULT|positive control" "$art/keyscan.txt" || true
} >>"$art/keyscan.txt"
docker rm "$keyscan_name" >>"$log" 2>&1
note_step "$keyscan_code" "keyscan probe"

# --- assert.txt ------------------------------------------------------------------------------
{
  echo "sandbox image replay + key scan"
  echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "commands:"
  echo "  1. docker build --platform linux/arm64 -t $tag -f packages/sandbox/image/Dockerfile packages/sandbox/image  (exit $build_code)"
  echo "  2. docker run --name freebot-u0.6-replay1 -e SANDBOX_IMAGE_DIGEST=$image_id -v packages/sandbox/image:/image:ro -v <artifact>:/out $tag node /image/replay.mjs /out/replay1.jsonl"
  echo "  3. docker run --name freebot-u0.6-replay2 ... /out/replay2.jsonl"
  echo "  4. docker run --rm ... $tag node /image/compare.mjs /out/replay1.jsonl /out/replay2.jsonl  (exit $compare_code)"
  echo "  5. docker build ... -t $rebuild_tag ...  (exit $rebuild_code)"
  echo "  6. docker run --name freebot-u0.6-keyscan -i -v packages/sandbox/image:/image:ro -v <artifact>:/out $tag sh /image/probe.sh < /tmp/freebot-keyscan/provider.env  (exit $keyscan_code)"
  echo
  echo "recorded identity:"
  echo "  node base tag: $base_tag"
  echo "  node base digest: $base_digest"
  echo "  pi version: $(docker run --rm "$tag" pi --version 2>/dev/null || echo unknown)"
  echo "  image Id: $image_id"
  echo "  rebuild image Id: $rebuild_id"
  echo "  rebuild identical image Id: $([ "$rebuild_id" = "$image_id" ] && echo yes || echo no)"
  echo "  rebuild layer digest sets identical: $(grep -oE 'RootFS layers identical across the two builds: (yes|no)' "$art/digest.txt" | sed 's/.*: //')"
  echo
  echo "normalization for replay equality (compare.mjs):"
  echo "  every frame is re-serialized with object keys sorted, then the keys id, timestamp,"
  echo "  durationMs, sessionId, toolCallId and parentToolCallId are removed wherever they appear."
  echo "  Those are the values that cannot be equal across two processes: correlation ids, tool"
  echo "  call ids, the generated session id, clocks, and measured durations. Every other field,"
  echo "  including frame order, must match exactly. pi_command and the header's pi_version and"
  echo "  image_digest are compared without dropping anything."
  echo
  echo "results:"
  echo "  replay1: exit code recorded above, transcript packages/verify/artifacts/sandbox-image/$short_sha/replay1.jsonl ($(wc -l <"$art/replay1.jsonl" 2>/dev/null || echo 0) lines)"
  echo "  replay2: exit code recorded above, transcript packages/verify/artifacts/sandbox-image/$short_sha/replay2.jsonl ($(wc -l <"$art/replay2.jsonl" 2>/dev/null || echo 0) lines)"
  echo "  pi version in both headers: $(grep -o '"pi_version":"[^"]*"' "$art/replay1.jsonl" 2>/dev/null | head -1)"
  echo "  image digest in both headers: $(grep -o '"image_digest":"[^"]*"' "$art/replay1.jsonl" 2>/dev/null | head -1)"
  echo "  keyscan canary hits: $(grep -oE 'CANARY HITS: [0-9]+' "$art/keyscan.txt" 2>/dev/null | head -1)"
  echo "  keyscan probe result: $(grep -oE 'PROBE RESULT: [A-Z]+' "$art/keyscan.txt" 2>/dev/null | head -1)"
  echo
  echo "compare output:"
  grep -E "^(PASS|FAIL)|^first difference|^run[12]:" "$log" || echo "  (compare output not found in run.log)"
  echo
  if [ "$FAILED" -eq 0 ]; then
    echo "RESULT: PASS"
  else
    echo "RESULT: FAIL (see run.log)"
  fi
} >"$art/assert.txt"

say "artifact: packages/verify/artifacts/sandbox-image/$short_sha"
tail -1 "$art/assert.txt" | tee -a "$log"
exit "$FAILED"
