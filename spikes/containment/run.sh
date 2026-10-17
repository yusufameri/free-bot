#!/usr/bin/env bash
# One command for the whole containment spike:
#   build the arm64 image, start the throwaway proxy on the host, run the seven
#   container probes, run the overhead measurement, write the artifact.
#
#   bash spikes/containment/run.sh
#
# Artifact: packages/verify/artifacts/containment/<short-sha>/probes.txt
# Requires: Docker Desktop with a linux/arm64 engine, bun, curl.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

sha="$(git rev-parse --short HEAD)"
full_sha="$(git rev-parse HEAD)"
branch="$(git rev-parse --abbrev-ref HEAD)"
timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
image="freebot-containment-spike:$sha"
artifact_dir="packages/verify/artifacts/containment/$sha"
artifact="$artifact_dir/probes.txt"
proxy_port="${CONTAINMENT_PROXY_PORT:-8788}"

mkdir -p "$artifact_dir"
tmp="$(mktemp -d)"
mkdir -p "$tmp"

proxy_log="$tmp/proxy.log"
probes_log="$tmp/probes.log"
overhead_log="$tmp/overhead.log"
overall_ok=1

echo "[run] artifact: $artifact"
echo "[run] short sha: $sha on branch $branch"

echo "[run] docker engine check"
docker info --format '{{.ServerVersion}} {{.Architecture}} {{.KernelVersion}}' >/dev/null

echo "[run] typechecking the spike scripts (the root typecheck does not include spikes/)"
set +e
bun x tsc -p spikes/containment/tsconfig.json >"$tmp/tsc.log" 2>&1
tsc_rc=$?
set -e
if [ "$tsc_rc" -ne 0 ]; then
  echo "[run] spike typecheck failed:"
  cat "$tmp/tsc.log"
  exit 1
fi

echo "[run] building $image (linux/arm64)"
docker build --platform linux/arm64 -t "$image" spikes/containment

echo "[run] starting throwaway proxy on 127.0.0.1:$proxy_port"
PROXY_PORT="$proxy_port" PROXY_BIND=127.0.0.1 bun spikes/containment/proxy.ts >"$proxy_log" 2>&1 &
proxy_pid=$!
cleanup() {
  kill "$proxy_pid" 2>/dev/null || true
  wait "$proxy_pid" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

health=""
for _ in $(seq 1 60); do
  if health="$(curl -fsS -m 1 "http://127.0.0.1:$proxy_port/__health" 2>/dev/null)"; then
    break
  fi
  health=""
  sleep 0.25
done
if [ "$health" != "ok" ]; then
  echo "[run] proxy did not become healthy; log follows"
  cat "$proxy_log"
  exit 1
fi
echo "[run] proxy healthy"

echo "[run] container probes (cap-add NET_ADMIN, NET_RAW dropped, no privileged)"
set +e
docker run --rm --platform linux/arm64 \
  --cap-add=NET_ADMIN --cap-drop=NET_RAW \
  --add-host=host.docker.internal:host-gateway \
  -e PROXY_HOST=host.docker.internal \
  -e PROXY_PORT="$proxy_port" \
  "$image" >"$probes_log" 2>&1
container_rc=$?
set -e
echo "[run] container exited $container_rc"

echo "[run] overhead measurement (50 sequential GETs, direct vs through the proxy)"
set +e
bun spikes/containment/overhead.ts >"$overhead_log" 2>&1
overhead_rc=$?
set -e
echo "[run] overhead exited $overhead_rc"

container_version="$(docker version --format '{{.Client.Version}} {{.Client.Os}}/{{.Client.Arch}}')"
server_version="$(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}} kernel {{.Server.KernelVersion}}')"
server_platform="$(docker info --format '{{.OperatingSystem}} | engine {{.ServerVersion}} | {{.Architecture}} | {{.KernelVersion}}')"
host_platform="$(uname -srm)"

{
  echo "feature: containment spike (default-deny egress, proxy-only)"
  echo "command: bash spikes/containment/run.sh"
  echo "timestamp: $timestamp"
  echo "git sha: $full_sha"
  echo "git sha short: $sha"
  echo "branch: $branch"
  echo "host: $host_platform"
  echo "docker client: $container_version"
  echo "docker server: $server_version"
  echo "docker platform: $server_platform"
  echo "image: $image (FROM --platform=linux/arm64 debian:bookworm-slim + nftables curl dnsutils python3 netcat-openbsd)"
  echo "capabilities: --cap-add=NET_ADMIN, --cap-drop=NET_RAW (NET_RAW is in Docker's default set; nothing here needs it). --privileged: no."
  echo "network: docker default bridge, --add-host=host.docker.internal:host-gateway"
  echo "kernel policy: nft table inet freebot_containment, output hook policy drop, applied by spikes/containment/entrypoint.sh"
  echo "proxy: bun spikes/containment/proxy.ts on 127.0.0.1:$proxy_port (host), resolves DNS itself"
  echo
  echo "--- container probes (docker run, exit $container_rc) ---"
  cat "$probes_log"
  echo "--- end container probes ---"
  echo
  echo "--- proxy log (host side; the dial lines are the proxy resolving DNS itself) ---"
  cat "$proxy_log"
  echo "--- end proxy log ---"
  echo
  echo "--- overhead (exit $overhead_rc) ---"
  cat "$overhead_log"
  echo "--- end overhead ---"
  echo
  echo "--- probe summary ---"
  for id in a b c d e f g; do
    line="$(grep -m1 "^PROBE($id) " "$probes_log" || echo "PROBE($id) MISSING")"
    echo "$line"
  done
  echo
  if [ "$container_rc" -eq 0 ] && [ "$overhead_rc" -eq 0 ]; then
    echo "RESULT: PASS (7/7 probes, overhead measured)"
  else
    echo "RESULT: FAIL (container exit $container_rc, overhead exit $overhead_rc)"
    overall_ok=0
  fi
  echo
} >"$artifact"

cat "$artifact"
echo "[run] wrote $artifact"
exit "$(( overall_ok == 1 ? 0 : 1 ))"
