#!/usr/bin/env bash
# One command for the browser-containment spike:
#   build the arm64 image, start the throwaway proxy and the host origin on the
#   host, run the seven Chromium probes inside the default-deny netns, capture
#   the screenshots into the artifact directory, write the artifact.
#
#   bash spikes/browser-containment/run.sh
#
# Artifact: packages/verify/artifacts/containment-browser/<short-sha>/probes.txt
#           plus the PNG screenshots next to it.
# Requires: Docker Desktop with a linux/arm64 engine, bun, curl, lsof.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

sha="$(git rev-parse --short HEAD)"
full_sha="$(git rev-parse HEAD)"
branch="$(git rev-parse --abbrev-ref HEAD)"
timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
image="freebot-browser-containment-spike:$sha"
artifact_dir="packages/verify/artifacts/containment-browser/$sha"
artifact="$artifact_dir/probes.txt"
proxy_port="${BROWSER_CONTAINMENT_PROXY_PORT:-8788}"
origin_port="${BROWSER_CONTAINMENT_ORIGIN_PORT:-9109}"
public_url="${BROWSER_CONTAINMENT_PUBLIC_URL:-https://example.com}"
public_host="${public_url#*://}"
public_host="${public_host%%/*}"

mkdir -p "$artifact_dir"
rm -f "$artifact_dir"/*.png
tmp="$(mktemp -d)"
mkdir -p "$tmp"

proxy_log="$tmp/proxy.log"
origin_log="$tmp/origin.log"
probes_log="$tmp/probes.log"
overall_ok=1

echo "[run] artifact: $artifact"
echo "[run] short sha: $sha on branch $branch"

echo "[run] docker engine check"
docker info --format '{{.ServerVersion}} {{.Architecture}} {{.KernelVersion}}' >/dev/null

echo "[run] typechecking the spike scripts (the root typecheck does not include spikes/)"
set +e
bun x tsc -p spikes/browser-containment/tsconfig.json >"$tmp/tsc.log" 2>&1
tsc_rc=$?
set -e
if [ "$tsc_rc" -ne 0 ]; then
  echo "[run] spike typecheck failed:"
  cat "$tmp/tsc.log"
  exit 1
fi

echo "[run] building $image (linux/arm64)"
docker build --platform linux/arm64 -t "$image" spikes/browser-containment

for spec in "proxy $proxy_port" "origin $origin_port"; do
  name="${spec%% *}"
  port="${spec##* }"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[run] port $port ($name) is already in use; stop that listener or set BROWSER_CONTAINMENT_*_PORT"
    lsof -nP -iTCP:"$port" -sTCP:LISTEN
    exit 1
  fi
done

echo "[run] starting throwaway proxy on 127.0.0.1:$proxy_port"
PROXY_PORT="$proxy_port" PROXY_BIND=127.0.0.1 bun spikes/browser-containment/proxy.ts >"$proxy_log" 2>&1 &
proxy_pid=$!
echo "[run] starting host origin on 127.0.0.1:$origin_port"
ORIGIN_PORT="$origin_port" bun spikes/browser-containment/origin.ts >"$origin_log" 2>&1 &
origin_pid=$!
cleanup() {
  kill "$proxy_pid" "$origin_pid" 2>/dev/null || true
  wait "$proxy_pid" "$origin_pid" 2>/dev/null || true
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
# The health check alone can be answered by a stale listener; require this run's
# proxy to be alive and to have logged its own bind.
if ! kill -0 "$proxy_pid" 2>/dev/null; then
  echo "[run] proxy process $proxy_pid is not running; log follows"
  cat "$proxy_log"
  exit 1
fi
if ! grep -q "proxy listening on 127.0.0.1:$proxy_port" "$proxy_log"; then
  echo "[run] proxy log has no bind line for port $proxy_port; log follows"
  cat "$proxy_log"
  exit 1
fi
echo "[run] proxy healthy (pid $proxy_pid, bound $proxy_port)"

origin_health=""
for _ in $(seq 1 60); do
  if origin_health="$(curl -fsS -m 1 "http://127.0.0.1:$origin_port/__health" 2>/dev/null)"; then
    break
  fi
  origin_health=""
  sleep 0.25
done
if [ "$origin_health" != "ok" ]; then
  echo "[run] host origin did not become healthy; log follows"
  cat "$origin_log"
  exit 1
fi
echo "[run] host origin healthy (pid $origin_pid, bound $origin_port)"

echo "[run] container browser probes (cap-add NET_ADMIN, NET_RAW dropped, no privileged)"
set +e
docker run --rm --platform linux/arm64 \
  --cap-add=NET_ADMIN --cap-drop=NET_RAW \
  --add-host=host.docker.internal:host-gateway \
  -e PROXY_HOST=host.docker.internal \
  -e PROXY_PORT="$proxy_port" \
  -e ORIGIN_PORT="$origin_port" \
  -e PUBLIC_URL="$public_url" \
  -v "$root/$artifact_dir:/out" \
  "$image" >"$probes_log" 2>&1
container_rc=$?
set -e
echo "[run] container exited $container_rc"

container_version="$(docker version --format '{{.Client.Version}} {{.Client.Os}}/{{.Client.Arch}}')"
server_version="$(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}} kernel {{.Server.KernelVersion}}')"
server_platform="$(docker info --format '{{.OperatingSystem}} | engine {{.ServerVersion}} | {{.Architecture}} | {{.KernelVersion}}')"
host_platform="$(uname -srm)"
chromium_version="$(grep -m1 -o 'Chromium [0-9][^ ]*' "$probes_log" || true)"

{
  echo "feature: browser containment spike (headless Chromium inside default-deny netns, proxy-only egress)"
  echo "command: bash spikes/browser-containment/run.sh"
  echo "timestamp: $timestamp"
  echo "git sha: $full_sha"
  echo "git sha short: $sha"
  echo "branch: $branch"
  echo "host: $host_platform"
  echo "docker client: $container_version"
  echo "docker server: $server_version"
  echo "docker platform: $server_platform"
  echo "image: $image (FROM --platform=linux/arm64 debian:bookworm-slim + chromium nftables curl dnsutils python3 fonts)"
  echo "browser: ${chromium_version:-unknown}"
  echo "capabilities: --cap-add=NET_ADMIN, --cap-drop=NET_RAW (NET_RAW is in Docker's default set; nothing here needs it). --privileged: no."
  echo "network: docker default bridge, --add-host=host.docker.internal:host-gateway"
  echo "kernel policy: nft table inet freebot_containment, output hook policy drop, applied by spikes/browser-containment/entrypoint.sh (copy of the U0.4 entrypoint)"
  echo "proxy: bun spikes/browser-containment/proxy.ts (copy of the U0.4 throwaway proxy) on 127.0.0.1:$proxy_port (host), resolves DNS itself"
  echo "origin: bun spikes/browser-containment/origin.ts on 127.0.0.1:$origin_port (host), the page served by us for the through-proxy control"
  echo
  echo "--- container browser probes (docker run, exit $container_rc) ---"
  cat "$probes_log"
  echo "--- end container browser probes ---"
  echo
  echo "--- proxy log (host side; the dial lines are the proxy resolving DNS itself) ---"
  cat "$proxy_log"
  echo "--- end proxy log ---"
  echo
  echo "--- origin log (host side) ---"
  cat "$origin_log"
  echo "--- end origin log ---"
  echo
  echo "--- screenshots written by the container into the artifact volume ---"
  for png in "$artifact_dir"/*.png; do
    if [ -f "$png" ]; then
      printf '%s %s bytes\n' "$(basename "$png")" "$(stat -f '%z' "$png")"
    fi
  done
  echo "--- end screenshots ---"
  echo
  echo "--- probe summary ---"
  for id in p1 p2 p3 p4 p5 p6 p7; do
    line="$(grep -m1 "^PROBE($id) " "$probes_log" || echo "PROBE($id) MISSING")"
    echo "$line"
  done
  echo
  dial_public="$(grep -c "proxy dial $public_host:" "$proxy_log" || true)"
  dial_origin="$(grep -c 'proxy dial localhost' "$proxy_log" || true)"
  echo "proxy dial lines: ${dial_public:-0} for $public_host, ${dial_origin:-0} for localhost:$origin_port"
  grep -m1 "proxy dial $public_host:" "$proxy_log" || true
  grep -m1 "proxy dial localhost" "$proxy_log" || true
  echo
  probe_summary="$(grep -c '^PROBE(.* PASS' "$probes_log" || true)"
  png_count="$(find "$artifact_dir" -name '*.png' -size +3k | wc -l | tr -d ' ')"
  if [ "$container_rc" -eq 0 ] && [ "$probe_summary" -ge 7 ] && [ "$png_count" -ge 4 ] && [ "$dial_public" -ge 1 ] && [ "$dial_origin" -ge 1 ]; then
    echo "RESULT: PASS (7/7 probes, $png_count screenshots, proxy dial lines present for both the public target and the host origin)"
  else
    echo "RESULT: FAIL (container exit $container_rc, probes PASS=$probe_summary, screenshots=$png_count, dials public=$dial_public origin=$dial_origin)"
    overall_ok=0
  fi
  echo
} >"$artifact"

cat "$artifact"
echo "[run] wrote $artifact"
exit "$(( overall_ok == 1 ? 0 : 1 ))"
