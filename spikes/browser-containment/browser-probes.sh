#!/bin/bash
# Browser containment probes, inside the contained netns (entrypoint.sh has
# already applied the default-deny ruleset). Runs seven Chromium arms and prints
# one PROBE(<id>) PASS|FAIL line each, with the observed evidence:
#
#   p1  contained but working: https://example.com through the proxy (flags on)
#   p2  contained but working: the host-served origin page through the proxy
#   p3  adversarial navigation: public URL, no proxy flags
#   p4  adversarial navigation: IP literal, no proxy flags. Also reads the UDP
#       rule counter around the arm, because a plain https navigation races QUIC
#       (UDP) against TCP and the QUIC half lands in that counter.
#   p5  adversarial in-page: DoH fetch (IP literal and hostname), IP-literal
#       fetch, public-hostname fetch and an image load, all from file:// with
#       --no-proxy-server. Renders its results into the page, and the screenshot
#       of that rendered denial is the visual receipt.
#   p6  --disable-quic measured twice: the same forced-QUIC navigation to an IP
#       literal with the flag off (UDP counter must advance) and on (must not).
#   p7  --host-resolver-rules="MAP * ~NOTFOUND" measured: the same in-page page
#       with the guard on; no resolution attempt and no connection attempt to a
#       non-excluded host or IP literal is made at all, so the UDP counter stays
#       at +0 while everything is still denied.
#
# Every arm names everything on the command line. No *_proxy environment
# variables are set anywhere, and the environment check below asserts that, so
# a PASS cannot come from env redirection.
set -u

PROXY_HOST="${PROXY_HOST:-host.docker.internal}"
PROXY_PORT="${PROXY_PORT:-8788}"
ORIGIN_PORT="${ORIGIN_PORT:-9109}"
PUBLIC_URL="${PUBLIC_URL:-https://example.com}"
PUBLIC_MARKER="${PUBLIC_MARKER:-Example Domain}"
IP_LITERAL="${IP_LITERAL:-https://1.1.1.1/}"
OUT="${OUT:-/out}"
WORK=/tmp/browser-probes

mkdir -p "$WORK" "$OUT"

failures=0
record() {
  # id status detail
  printf 'PROBE(%s) %s  %s\n' "$1" "$2" "$3"
  if [ "$2" != PASS ]; then
    failures=$((failures + 1))
  fi
}

rule_packets() {
  nft list chain inet freebot_containment output | grep -F "$1" | sed -n 's/.*packets \([0-9]*\).*/\1/p' | head -n1
}

udp_packets() { rule_packets 'all udp including quic'; }
proxy_packets() { rule_packets 'egress proxy only'; }

now_ms() { date +%s%3N; }
first_line() { printf '%s' "$1" | head -n1 | cut -c1-240; }
png_size() { stat -c '%s' "$1" 2>/dev/null || echo 0; }

CHROME_FLAGS_COMMON=(--headless=new --no-sandbox --disable-dev-shm-usage --disable-background-networking --hide-scrollbars --window-size=1280,900)
# The three flags the plan requires, plus two the run needed in practice:
# --proxy-bypass-list=<-loopback> lets a proxied browser reach a proxy-local
# service (Chromium implicitly bypasses the proxy for localhost otherwise, which
# would make the p2 control impossible), and EXCLUDE keeps the resolver guard
# from also erasing the proxy's own name (observed: without it, "MAP * ~NOTFOUND"
# fails the browser's lookup of the proxy host and nothing loads at all).
CHROME_FLAGS_PROXIED=(
  "--proxy-server=http://$PROXY_HOST:$PROXY_PORT"
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE $PROXY_HOST"
  --disable-quic
  '--proxy-bypass-list=<-loopback>'
)
CHROME_FLAGS_NO_PROXY=(--no-proxy-server)

run_chrome() {
  # run_chrome <arm> <virtual-time-ms> <extra flags...> -- <url>
  local arm="$1" budget="$2"
  shift 2
  local extra=()
  while [ "$1" != "--" ]; do extra+=("$1"); shift; done
  shift
  local url="$1"
  local dom="$WORK/$arm.dom" err="$WORK/$arm.err" log="$WORK/$arm.netlog.json"
  local t0 t1 rc
  t0="$(now_ms)"
  timeout 240 chromium \
    "${CHROME_FLAGS_COMMON[@]}" \
    --user-data-dir="/tmp/chrome-$arm" \
    --virtual-time-budget="$budget" \
    --log-net-log="$log" \
    --dump-dom \
    --screenshot="$OUT/$arm.png" \
    "${extra[@]}" \
    "$url" >"$dom" 2>"$err"
  rc=$?
  t1="$(now_ms)"
  LAST_RC="$rc"
  LAST_MS=$(( t1 - t0 ))
  LAST_DOM="$dom"
  LAST_ERR="$err"
  LAST_PNG="$OUT/$arm.png"
}

rows_from_dom() {
  # Compact "id=STATE(observed; ms)" summary of the probe page's result rows.
  python3 - "$1" <<'PY'
import re, sys
html = open(sys.argv[1], encoding="utf-8", errors="replace").read()
rows = re.findall(r'<tr id="row-([a-z-]+)">(.*?)</tr>', html, re.S)
out = []
for rid, body in rows:
    cells = [re.sub(r"<[^>]*>", "", c).strip() for c in re.findall(r"<td[^>]*>(.*?)</td>", body, re.S)]
    if len(cells) >= 5:
        out.append(f"{rid}={cells[2]}({cells[3]}; {cells[4]}ms)")
print("; ".join(out) if out else "no rows rendered")
PY
}

# Runtime-only markers from the probe page: the source file has class="pending"
# and the templates, so these strings cannot appear unless the page's JavaScript
# actually ran and reached its verdict.
page_contained() { grep -q 'id="verdict" class="contained"' "$1" 2>/dev/null; }
page_reached_rows() {
  local n
  n="$(grep -o 'class="reached"' "$1" 2>/dev/null | wc -l | tr -d ' ')"
  printf '%s' "${n:-0}"
}

netlog_errors() {
  # Histogram of net_error values from the netlog, most common first. Known
  # names: -3 ERR_ABORTED, -105 ERR_NAME_NOT_RESOLVED, -118
  # ERR_CONNECTION_TIMED_OUT, -102 ERR_CONNECTION_REFUSED, -137
  # ERR_NAME_RESOLUTION_FAILED, -356 ERR_QUIC_PROTOCOL_ERROR.
  grep -o '"net_error":-\?[0-9]*' "$1" 2>/dev/null | sort | uniq -c | sort -rn | head -8 | tr '\n' ';'
}

echo "=== browser containment probes ==="
echo "public target: $PUBLIC_URL (marker: $PUBLIC_MARKER)"
echo "host origin: http://localhost:$ORIGIN_PORT/host-origin (served by origin.ts on the host, reached through the proxy)"
echo "ip literal: $IP_LITERAL"
echo "proxy: http://$PROXY_HOST:$PROXY_PORT"
echo "chromium: $(chromium --version 2>&1 | head -n1)"
echo "flags, working arms: ${CHROME_FLAGS_COMMON[*]} ${CHROME_FLAGS_PROXIED[*]}"
echo "flags, adversarial arms: ${CHROME_FLAGS_COMMON[*]} ${CHROME_FLAGS_NO_PROXY[*]}"
echo

for var in http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY no_proxy NO_PROXY; do
  value="$(printenv "$var" 2>/dev/null || true)"
  if [ -n "$value" ]; then
    echo "PROBE(env) FAIL  $var=$value is set; the browser must get its proxy from flags, not the environment"
    exit 1
  fi
done
echo "environment: no *_proxy variables set (checked 8 names); the browser gets its proxy from command-line flags only"
echo

# ---------------------------------------------------------------- p1: public
echo "--- p1: $PUBLIC_URL through the proxy"
run_chrome p1-proxied-public 60000 "${CHROME_FLAGS_PROXIED[@]}" -- "$PUBLIC_URL"
p1_png="$(png_size "$LAST_PNG")"
if [ "$LAST_RC" -eq 0 ] && grep -q "$PUBLIC_MARKER" "$LAST_DOM" 2>/dev/null && [ "$p1_png" -gt 3000 ]; then
  record p1 PASS "proxied $PUBLIC_URL rendered after ${LAST_MS}ms; DOM contains '$PUBLIC_MARKER'; screenshot $LAST_PNG ($p1_png bytes)"
else
  record p1 FAIL "exit=$LAST_RC after ${LAST_MS}ms; png=$p1_png bytes; stderr: $(first_line "$(cat "$LAST_ERR" 2>/dev/null)")"
fi
echo

# ------------------------------------------------------------ p2: host origin
echo "--- p2: host-served origin through the proxy (loopback proxied too)"
run_chrome p2-proxied-host-origin 60000 "${CHROME_FLAGS_PROXIED[@]}" -- "http://localhost:$ORIGIN_PORT/host-origin"
p2_png="$(png_size "$LAST_PNG")"
if [ "$LAST_RC" -eq 0 ] && grep -q "FREEBOT-HOST-ORIGIN-OK" "$LAST_DOM" 2>/dev/null && [ "$p2_png" -gt 3000 ]; then
  record p2 PASS "host origin rendered through the proxy after ${LAST_MS}ms; screenshot $LAST_PNG ($p2_png bytes)"
else
  record p2 FAIL "exit=$LAST_RC after ${LAST_MS}ms; png=$p2_png bytes; stderr: $(first_line "$(cat "$LAST_ERR" 2>/dev/null)")"
fi
echo

# --------------------------------------------------- p3: adversarial URL, nav
echo "--- p3: navigation to $PUBLIC_URL with --no-proxy-server"
udp_before_p3="$(udp_packets)"
run_chrome p3-nav-public-denied 60000 "${CHROME_FLAGS_NO_PROXY[@]}" -- "$PUBLIC_URL"
udp_after_p3="$(udp_packets)"
p3_dom_bytes="$(wc -c <"$LAST_DOM" | tr -d ' ')"
p3_png="$(png_size "$LAST_PNG")"
if [ "$LAST_RC" -ne 0 ] || ! grep -q "$PUBLIC_MARKER" "$LAST_DOM" 2>/dev/null; then
  record p3 PASS "denied: no page content (dom $p3_dom_bytes bytes, screenshot bytes=$p3_png; a failed navigation writes no capture) after ${LAST_MS}ms; the browser's own resolver attempts are in the udp drop counter (+$(( udp_after_p3 - udp_before_p3 )) packets); netlog: $(netlog_errors "$WORK/p3-nav-public-denied.netlog.json")"
else
  record p3 FAIL "navigation to $PUBLIC_URL succeeded without a proxy: exit=$LAST_RC after ${LAST_MS}ms"
fi
echo

# -------------------------------------------- p4: adversarial IP literal, nav
echo "--- p4: navigation to $IP_LITERAL with --no-proxy-server (no DNS involved; Chromium races QUIC and TCP)"
udp_before_p4="$(udp_packets)"
run_chrome p4-nav-ip-denied 200000 "${CHROME_FLAGS_NO_PROXY[@]}" -- "$IP_LITERAL"
udp_after_p4="$(udp_packets)"
p4_dom_bytes="$(wc -c <"$LAST_DOM" | tr -d ' ')"
p4_png="$(png_size "$LAST_PNG")"
if [ "$LAST_RC" -ne 0 ] || ! grep -q "<html" "$LAST_DOM" 2>/dev/null; then
  record p4 PASS "denied: no page content (dom $p4_dom_bytes bytes, screenshot bytes=$p4_png) after ${LAST_MS}ms; udp drop counter +$(( udp_after_p4 - udp_before_p4 )) packets during the arm (the QUIC half of the race, which Chromium sends even without prior knowledge of the origin); netlog: $(netlog_errors "$WORK/p4-nav-ip-denied.netlog.json")"
else
  record p4 FAIL "IP-literal navigation succeeded without a proxy: exit=$LAST_RC after ${LAST_MS}ms"
fi
echo

# ------------------------------------------------- p5: adversarial in-page JS
echo "--- p5: in-page JS attempts (DoH x2, IP literal, public host, image) with --no-proxy-server"
udp_before_p5="$(udp_packets)"
run_chrome p5-inpage-denied 200000 "${CHROME_FLAGS_NO_PROXY[@]}" -- "file:///probe-page.html"
udp_after_p5="$(udp_packets)"
p5_delta=$(( udp_after_p5 - udp_before_p5 ))
p5_png="$(png_size "$LAST_PNG")"
p5_reached="$(page_reached_rows "$LAST_DOM")"
p5_rows="$(rows_from_dom "$LAST_DOM")"
if [ "$LAST_RC" -eq 0 ] && page_contained "$LAST_DOM" && [ "$p5_reached" -eq 0 ] && [ "$p5_png" -gt 3000 ]; then
  record p5 PASS "all in-page attempts denied after ${LAST_MS}ms; rows: $p5_rows; udp drop counter +$p5_delta packets for the arm; screenshot $LAST_PNG ($p5_png bytes); netlog: $(netlog_errors "$WORK/p5-inpage-denied.netlog.json")"
else
  record p5 FAIL "exit=$LAST_RC after ${LAST_MS}ms, reached_rows=$p5_reached, png=$p5_png; rows: $p5_rows; stderr: $(first_line "$(cat "$LAST_ERR" 2>/dev/null)")"
fi
echo
echo "  note: the denials in this arm are the kernel's, and the counters are per-arm so the browser's own"
echo "  background noise cannot flatter a denial: the DoH fetches and the DNS-requiring fetch want UDP,"
echo "  the IP-literal fetches want TCP (and a QUIC race), and the udp counter above counts the UDP half."
echo

# ---------------------------------------------------------------- p6: --disable-quic
echo "--- p6: forced QUIC at $IP_LITERAL, twice: without --disable-quic, then with it"
udp_before_p6a="$(udp_packets)"
run_chrome p6a-quic-forced 60000 "${CHROME_FLAGS_NO_PROXY[@]}" "--origin-to-force-quic-on=1.1.1.1:443" -- "$IP_LITERAL"
udp_after_p6a="$(udp_packets)"
p6a_delta=$(( udp_after_p6a - udp_before_p6a ))
udp_before_p6b="$(udp_packets)"
run_chrome p6b-quic-forced-disabled 60000 "${CHROME_FLAGS_NO_PROXY[@]}" --disable-quic "--origin-to-force-quic-on=1.1.1.1:443" -- "$IP_LITERAL"
udp_after_p6b="$(udp_packets)"
p6b_delta=$(( udp_after_p6b - udp_before_p6b ))
p6a_denied=1
grep -q "<html" "$WORK/p6a-quic-forced.dom" 2>/dev/null && p6a_denied=0
if [ "$p6a_delta" -gt 0 ] && [ "$p6a_denied" -eq 1 ] && [ "$p6b_delta" -eq 0 ]; then
  record p6 PASS "--disable-quic is what removes the QUIC attempt: with QUIC allowed the forced navigation sent $p6a_delta datagrams to the ruleset (dropped there, no page after ${LAST_MS}ms) and with --disable-quic the same navigation sent $p6b_delta"
else
  record p6 FAIL "forced QUIC: without --disable-quic udp drop counter +$p6a_delta (denied=$p6a_denied), with --disable-quic +$p6b_delta; expected >0 then 0"
fi
echo

# -------------------------------------------------- p7: --host-resolver-rules
echo "--- p7: the same in-page page with --host-resolver-rules=MAP * ~NOTFOUND (no proxy flags)"
udp_before_p7="$(udp_packets)"
run_chrome p7-inpage-resolver-guard 60000 "${CHROME_FLAGS_NO_PROXY[@]}" '--host-resolver-rules=MAP * ~NOTFOUND' -- "file:///probe-page.html"
udp_after_p7="$(udp_packets)"
p7_delta=$(( udp_after_p7 - udp_before_p7 ))
p7_png="$(png_size "$LAST_PNG")"
p7_reached="$(page_reached_rows "$LAST_DOM")"
p7_rows="$(rows_from_dom "$LAST_DOM")"
if [ "$LAST_RC" -eq 0 ] && page_contained "$LAST_DOM" && [ "$p7_reached" -eq 0 ] && [ "$p7_delta" -eq 0 ]; then
  record p7 PASS "with the resolver guard on, the same attempt set is denied after ${LAST_MS}ms and emits nothing: udp drop counter +0 (was +$p5_delta without the guard), because the guard answers every non-excluded name and IP literal with NOTFOUND before any socket is opened; rows: $p7_rows; screenshot $LAST_PNG ($p7_png bytes)"
else
  record p7 FAIL "exit=$LAST_RC, reached_rows=$p7_reached, udp drop counter +$p7_delta (was +$p5_delta without the guard), png=$p7_png bytes; rows: $p7_rows"
fi
echo

echo "=== notes ==="
echo "the browser never sees a *_proxy variable; every working arm passes its proxy via --proxy-server, every adversarial arm via --no-proxy-server"
echo "chromium runs with --no-sandbox because this container's process is root; the containment under test is the netns ruleset, which --no-sandbox cannot bypass"
echo "p2 exists because Chromium implicitly bypasses the proxy for loopback; --proxy-bypass-list=<-loopback> is what makes a proxy-local service reachable at all"
echo "==="
echo
echo "=== nft counters after probes ==="
nft list chain inet freebot_containment output
echo "=== end counters ==="
echo
echo "probes failed: $failures of 7"
if [ "$failures" -eq 0 ]; then
  echo "RESULT: PASS"
  exit 0
fi
echo "RESULT: FAIL"
exit 1
