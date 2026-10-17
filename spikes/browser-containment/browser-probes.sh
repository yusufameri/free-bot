#!/bin/bash
# Browser containment probes, inside the contained netns (entrypoint.sh has
# already applied the default-deny ruleset). Runs seven Chromium arms and prints
# one PROBE(<id>) PASS|FAIL line each, with the observed evidence:
#
#   p1  contained but working: https://example.com through the proxy (flags on)
#   p2  contained but working: the host-served origin page through the proxy
#   p3  adversarial navigation: public URL, no proxy flags
#   p4  adversarial navigation: IP literal, no proxy flags
#   p5  adversarial in-page: DoH fetch (IP literal and hostname), IP-literal
#       fetch, public-hostname fetch and an image load, all from file:// with
#       --no-proxy-server. Renders its results into the page, and the screenshot
#       of that rendered denial is the visual receipt.
#   p6  --disable-quic measured twice on the same forced-QUIC navigation, read
#       from the udp/443 port bucket (the QUIC claim counted where it belongs),
#       with the flag's presence checked in the real Chromium process, not just
#       in the wrapper argv, and with a process-quiescence gate between arms.
#   p7  --host-resolver-rules="MAP * ~NOTFOUND" measured: the same in-page page
#       with the guard on; no resolution attempt and no connection attempt to a
#       non-excluded host or IP literal is made at all, so the UDP counters stay
#       at +0 while everything is still denied.
#
# Attribution scaffolding: three counter-only rules are inserted ahead of the
# policy's drop rule (counter, no verdict, so packets still fall through):
# udp/443 (QUIC), udp/53 (DNS) and other UDP. The whole-UDP counter cannot tell
# QUIC apart from DNS, and the browser runs hostname-based background traffic of
# its own, so every arm reads the buckets and reports them.
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
IP_HOST="${IP_LITERAL#*://}"
IP_HOST="${IP_HOST%%/*}"

mkdir -p "$WORK" "$OUT"

# Counter-only attribution rules. insert prepends, so the buckets see a packet
# before the policy rules that act on it; no verdict means nothing changes.
nft insert rule inet freebot_containment output meta l4proto udp udp dport 443 counter comment "bucket_udp443"
nft insert rule inet freebot_containment output meta l4proto udp udp dport 53 counter comment "bucket_udp53"
nft insert rule inet freebot_containment output meta l4proto udp udp dport != { 443, 53 } counter comment "bucket_udp_other"

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
udp443() { rule_packets 'bucket_udp443'; }
udp53() { rule_packets 'bucket_udp53'; }
udp_other() { rule_packets 'bucket_udp_other'; }
buckets_now() { printf 'udp443=%s udp53=%s other=%s' "$(udp443)" "$(udp53)" "$(udp_other)"; }
buckets_since() {
  # buckets_since "<p443 p53 pother>" -> "+443/+53/+other"
  local before="$1" a b c
  a="$(printf '%s' "$before" | awk '{print $1}')"
  b="$(printf '%s' "$before" | awk '{print $2}')"
  c="$(printf '%s' "$before" | awk '{print $3}')"
  printf '+%s/+%s/+%s' "$(( $(udp443) - a ))" "$(( $(udp53) - b ))" "$(( $(udp_other) - c ))"
}

now_ms() { date +%s%3N; }
first_line() { printf '%s' "$1" | head -n1 | cut -c1-240; }
png_size() { stat -c '%s' "$1" 2>/dev/null || echo 0; }
chromium_procs() {
  local n
  n="$(pgrep -c -f '/usr/lib/chromium/chromium' 2>/dev/null || true)"
  printf '%s' "${n:-0}"
}

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

sampler() {
  # sampler <outfile> <stopfile>: every 50 ms, record the cmdline of the
  # lowest-pid process that is the real Chromium binary (the /usr/bin/chromium
  # shell wrapper execs it, so this is the process that owns the network
  # context), plus the network service's once. Used to check that a flag reached
  # the process, not just the wrapper's argv.
  local out="$1" stop="$2" first=1 pid cmd npid
  : >"$out"
  while [ ! -f "$stop" ]; do
    pid="$(pgrep -f '/usr/lib/chromium/chromium' | head -n1 || true)"
    if [ -n "$pid" ]; then
      cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
      if [ -n "$cmd" ]; then
        printf '%s\n' "$cmd" >>"$out"
        if [ "$first" -eq 1 ]; then
          npid="$(pgrep -f 'utility-sub-type=network.mojom.NetworkService' | head -n1 || true)"
          if [ -n "$npid" ]; then
            printf 'NETSERVICE: %s\n' "$(tr '\0' ' ' <"/proc/$npid/cmdline" 2>/dev/null || true)" >>"$out"
          fi
          first=0
        fi
      fi
    fi
    sleep 0.05
  done
}

LAST_GATE_BEFORE=0
LAST_GATE_AFTER=0

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
  # Quiescence gate: no process from a previous arm may be alive when this one
  # starts, or its retries would be counted against this arm.
  LAST_GATE_BEFORE="$(chromium_procs)"
  local waited=0
  while [ "$(chromium_procs)" -gt 0 ] && [ "$waited" -lt 50 ]; do sleep 0.1; waited=$((waited + 1)); done
  LAST_GATE_WAITED="$waited"
  local sampler_pid="" stop_file=""
  if [ -n "${SAMPLER_OUT:-}" ]; then
    stop_file="$WORK/.sampler-$arm.stop"; rm -f "$stop_file"
    sampler "$SAMPLER_OUT" "$stop_file" &
    sampler_pid=$!
  fi
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
  if [ -n "$sampler_pid" ]; then
    touch "$stop_file"
    wait "$sampler_pid" 2>/dev/null
    SAMPLER_OUT=""
  fi
  LAST_RC="$rc"
  LAST_MS=$(( t1 - t0 ))
  LAST_DOM="$dom"
  LAST_ERR="$err"
  LAST_PNG="$OUT/$arm.png"
  LAST_GATE_AFTER="$(chromium_procs)"
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
  # Histogram of net_error values from the netlog, most common first.
  grep -o '"net_error":-\?[0-9]*' "$1" 2>/dev/null | sort | uniq -c | sort -rn | head -8 | tr '\n' ';'
}

netlog_quic_facts() {
  # QUIC-specific net error codes present in the netlog, with the names from the
  # netlog's own enum map (-356 ERR_QUIC_PROTOCOL_ERROR, -358
  # ERR_QUIC_HANDSHAKE_FAILED, -380 ERR_QUIC_CERT_ROOT_NOT_KNOWN, -381
  # ERR_QUIC_GOAWAY_REQUEST_CAN_BE_RETRIED).
  local f="$1" out="" code n name c
  for code in -356:ERR_QUIC_PROTOCOL_ERROR -358:ERR_QUIC_HANDSHAKE_FAILED -380:ERR_QUIC_CERT_ROOT_NOT_KNOWN -381:ERR_QUIC_GOAWAY_REQUEST_CAN_BE_RETRIED; do
    n="${code%%:*}"; name="${code##*:}"
    c="$(grep -o "\"net_error\":$n" "$f" 2>/dev/null | wc -l | tr -d ' ')"
    if [ "${c:-0}" -gt 0 ]; then out="$out $name x$c;"; fi
  done
  printf '%s' "${out:- none}"
}

echo "=== browser containment probes ==="
echo "public target: $PUBLIC_URL (marker: $PUBLIC_MARKER)"
echo "host origin: http://localhost:$ORIGIN_PORT/host-origin (served by origin.ts on the host, reached through the proxy)"
echo "ip literal: $IP_LITERAL"
echo "proxy: http://$PROXY_HOST:$PROXY_PORT"
echo "chromium: $(chromium --version 2>&1 | head -n1)"
echo "flags, working arms: ${CHROME_FLAGS_COMMON[*]} ${CHROME_FLAGS_PROXIED[*]}"
echo "flags, adversarial arms: ${CHROME_FLAGS_COMMON[*]} ${CHROME_FLAGS_NO_PROXY[*]}"
echo "attribution buckets (counter-only rules ahead of the drop rule): udp/443 QUIC, udp/53 DNS, other UDP"
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
b_common="$(buckets_now)"
run_chrome p1-proxied-public 60000 "${CHROME_FLAGS_PROXIED[@]}" -- "$PUBLIC_URL"
p1_png="$(png_size "$LAST_PNG")"
if [ "$LAST_RC" -eq 0 ] && grep -q "$PUBLIC_MARKER" "$LAST_DOM" 2>/dev/null && [ "$p1_png" -gt 3000 ]; then
  record p1 PASS "proxied $PUBLIC_URL rendered after ${LAST_MS}ms; DOM contains '$PUBLIC_MARKER'; screenshot $LAST_PNG ($p1_png bytes); udp buckets for the arm +443/+53/+other = $(buckets_since "$b_common")"
else
  record p1 FAIL "exit=$LAST_RC after ${LAST_MS}ms; png=$p1_png bytes; stderr: $(first_line "$(cat "$LAST_ERR" 2>/dev/null)")"
fi
echo

# ------------------------------------------------------------ p2: host origin
echo "--- p2: host-served origin through the proxy (loopback proxied too)"
b_common="$(buckets_now)"
run_chrome p2-proxied-host-origin 60000 "${CHROME_FLAGS_PROXIED[@]}" -- "http://localhost:$ORIGIN_PORT/host-origin"
p2_png="$(png_size "$LAST_PNG")"
if [ "$LAST_RC" -eq 0 ] && grep -q "FREEBOT-HOST-ORIGIN-OK" "$LAST_DOM" 2>/dev/null && [ "$p2_png" -gt 3000 ]; then
  record p2 PASS "host origin rendered through the proxy after ${LAST_MS}ms; screenshot $LAST_PNG ($p2_png bytes); udp buckets for the arm +443/+53/+other = $(buckets_since "$b_common")"
else
  record p2 FAIL "exit=$LAST_RC after ${LAST_MS}ms; png=$p2_png bytes; stderr: $(first_line "$(cat "$LAST_ERR" 2>/dev/null)")"
fi
echo

# --------------------------------------------------- p3: adversarial URL, nav
echo "--- p3: navigation to $PUBLIC_URL with --no-proxy-server"
b_common="$(buckets_now)"
run_chrome p3-nav-public-denied 60000 "${CHROME_FLAGS_NO_PROXY[@]}" -- "$PUBLIC_URL"
p3_buckets="$(buckets_since "$b_common")"
p3_dom_bytes="$(wc -c <"$LAST_DOM" | tr -d ' ')"
p3_png="$(png_size "$LAST_PNG")"
if [ "$LAST_RC" -ne 0 ] || ! grep -q "$PUBLIC_MARKER" "$LAST_DOM" 2>/dev/null; then
  record p3 PASS "denied: no page content (dom $p3_dom_bytes bytes, screenshot bytes=$p3_png; a failed navigation writes no capture) after ${LAST_MS}ms; udp buckets +443/+53/+other = $p3_buckets (the /53 half is the browser's own resolver attempts, dropped by the ruleset; each drop surfaces as ERR_ACCESS_DENIED to the browser); netlog: $(netlog_errors "$WORK/p3-nav-public-denied.netlog.json")"
else
  record p3 FAIL "navigation to $PUBLIC_URL succeeded without a proxy: exit=$LAST_RC after ${LAST_MS}ms"
fi
echo

# -------------------------------------------- p4: adversarial IP literal, nav
echo "--- p4: navigation to $IP_LITERAL with --no-proxy-server (no DNS involved; Chromium races QUIC and TCP)"
b_common="$(buckets_now)"
run_chrome p4-nav-ip-denied 200000 "${CHROME_FLAGS_NO_PROXY[@]}" -- "$IP_LITERAL"
p4_buckets="$(buckets_since "$b_common")"
p4_dom_bytes="$(wc -c <"$LAST_DOM" | tr -d ' ')"
p4_png="$(png_size "$LAST_PNG")"
if [ "$LAST_RC" -ne 0 ] || ! grep -q "<html" "$LAST_DOM" 2>/dev/null; then
  record p4 PASS "denied: no page content (dom $p4_dom_bytes bytes, screenshot bytes=$p4_png) after ${LAST_MS}ms; udp buckets +443/+53/+other = $p4_buckets (the browser races QUIC and TCP on this navigation; the QUIC half lands in /443, the /53 half is its own background lookups); netlog QUIC: $(netlog_quic_facts "$WORK/p4-nav-ip-denied.netlog.json"); netlog: $(netlog_errors "$WORK/p4-nav-ip-denied.netlog.json")"
else
  record p4 FAIL "IP-literal navigation succeeded without a proxy: exit=$LAST_RC after ${LAST_MS}ms"
fi
echo

# ------------------------------------------------- p5: adversarial in-page JS
echo "--- p5: in-page JS attempts (DoH x2, IP literal, public host, image) with --no-proxy-server"
b_common="$(buckets_now)"
run_chrome p5-inpage-denied 200000 "${CHROME_FLAGS_NO_PROXY[@]}" -- "file:///probe-page.html"
p5_buckets="$(buckets_since "$b_common")"
p5_png="$(png_size "$LAST_PNG")"
p5_reached="$(page_reached_rows "$LAST_DOM")"
p5_rows="$(rows_from_dom "$LAST_DOM")"
if [ "$LAST_RC" -eq 0 ] && page_contained "$LAST_DOM" && [ "$p5_reached" -eq 0 ] && [ "$p5_png" -gt 3000 ]; then
  record p5 PASS "all in-page attempts denied after ${LAST_MS}ms; rows: $p5_rows; udp buckets +443/+53/+other = $p5_buckets; screenshot $LAST_PNG ($p5_png bytes); netlog QUIC: $(netlog_quic_facts "$WORK/p5-inpage-denied.netlog.json"); netlog: $(netlog_errors "$WORK/p5-inpage-denied.netlog.json")"
else
  record p5 FAIL "exit=$LAST_RC after ${LAST_MS}ms, reached_rows=$p5_reached, png=$p5_png; rows: $p5_rows; stderr: $(first_line "$(cat "$LAST_ERR" 2>/dev/null)")"
fi
echo
echo "  note: every wall in this arm is the kernel's, and the buckets are read per arm so the browser's own"
echo "  background traffic cannot be mistaken for the probe's: the DoH fetches and the DNS-requiring fetch"
echo "  want UDP (/53), the IP-literal fetches want TCP plus a QUIC race (/443), and none of it leaves."
echo

# ---------------------------------------------------------------- p6: --disable-quic
echo "--- p6: forced QUIC at $IP_LITERAL, twice: without --disable-quic, then with it"
echo "         (read from the udp/443 bucket; flag presence checked in the real process; gate between arms)"
echo "  quiescence before p6a: $(chromium_procs) chromium processes"
b_common="$(buckets_now)"
SAMPLER_OUT="$WORK/p6a.cmdline"; run_chrome p6a-quic-forced 60000 "${CHROME_FLAGS_NO_PROXY[@]}" "--origin-to-force-quic-on=$IP_HOST:443" -- "$IP_LITERAL"
p6a_buckets="$(buckets_since "$b_common")"
p6a_ms="$LAST_MS"
p6a_samples="$(wc -l <"$WORK/p6a.cmdline" | tr -d ' ')"
p6a_dom_bytes="$(wc -c <"$LAST_DOM" | tr -d ' ')"
p6a_cmdline_flag="$(grep -c -- '--disable-quic' "$WORK/p6a.cmdline" 2>/dev/null || true)"
[ -z "$p6a_cmdline_flag" ] && p6a_cmdline_flag=0
p6a_quic="$(netlog_quic_facts "$WORK/p6a-quic-forced.netlog.json")"
p6a_net_flag="$(grep '^NETSERVICE:' "$WORK/p6a.cmdline" 2>/dev/null | grep -c -- '--disable-quic' || true)"
b_common="$(buckets_now)"
SAMPLER_OUT="$WORK/p6b.cmdline"; run_chrome p6b-quic-forced-disabled 60000 "${CHROME_FLAGS_NO_PROXY[@]}" --disable-quic "--origin-to-force-quic-on=$IP_HOST:443" -- "$IP_LITERAL"
p6b_buckets="$(buckets_since "$b_common")"
p6b_ms="$LAST_MS"
p6b_samples="$(wc -l <"$WORK/p6b.cmdline" | tr -d ' ')"
p6b_dom_bytes="$(wc -c <"$LAST_DOM" | tr -d ' ')"
p6b_cmdline_flag="$(grep -c -- '--disable-quic' "$WORK/p6b.cmdline" 2>/dev/null || true)"
[ -z "$p6b_cmdline_flag" ] && p6b_cmdline_flag=0
p6b_quic="$(netlog_quic_facts "$WORK/p6b-quic-forced-disabled.netlog.json")"
p6b_net_flag="$(grep '^NETSERVICE:' "$WORK/p6b.cmdline" 2>/dev/null | grep -c -- '--disable-quic' || true)"
p6a_443="$(printf '%s' "$p6a_buckets" | sed 's|+\([0-9]*\)/+.*|\1|')"
p6b_443="$(printf '%s' "$p6b_buckets" | sed 's|+\([0-9]*\)/+.*|\1|')"
case "$p6a_443" in ''|*[!0-9]*) p6a_443=0 ;; esac
case "$p6b_443" in ''|*[!0-9]*) p6b_443=0 ;; esac
if [ "$p6a_443" -gt 0 ] && [ "$p6a_dom_bytes" -eq 0 ] && [ "$p6a_cmdline_flag" -eq 0 ] && [ "$p6b_443" -eq 0 ] && [ "$p6b_dom_bytes" -eq 0 ] && [ "$p6b_cmdline_flag" -gt 0 ]; then
  record p6 PASS "QUIC is denied at the kernel and --disable-quic removes the attempt. Without it: the forced navigation emitted $p6a_443 datagrams to udp/443 inside ${p6a_ms}ms (bucket +443/+53/+other = $p6a_buckets; the /53 packets are the browser's own lookups), rendered nothing, and the netlog records QUIC failures:$p6a_quic; its real Chromium process cmdline (sampled $p6a_samples times) does not carry --disable-quic ($p6a_cmdline_flag). With it: the identical navigation emitted 0 datagrams to udp/443 (+443/+53/+other = $p6b_buckets, the /53 remainder is the same background lookups during ${p6b_ms}ms of denied TCP), rendered nothing, netlog QUIC:$p6b_quic, and --disable-quic is present in the real process cmdline ($p6b_cmdline_flag of $p6b_samples samples; network-service cmdline carries it $p6b_net_flag times)."
else
  record p6 FAIL "forced QUIC: p6a udp443 +$p6a_443 (dom $p6a_dom_bytes bytes, cmdline flag $p6a_cmdline_flag) netlog QUIC:$p6a_quic; p6b udp443 +$p6b_443 (dom $p6b_dom_bytes bytes, cmdline flag $p6b_cmdline_flag) netlog QUIC:$p6b_quic"
fi
echo "  quiescence after p6b: before-arm $(printf '%s' "$LAST_GATE_BEFORE"), waited ${LAST_GATE_WAITED}x0.1s, after-arm $(printf '%s' "$LAST_GATE_AFTER") chromium processes"
echo

# -------------------------------------------------- p7: --host-resolver-rules
echo "--- p7: the same in-page page with --host-resolver-rules=MAP * ~NOTFOUND (no proxy flags)"
b_common="$(buckets_now)"
b_total="$(udp_packets)"
run_chrome p7-inpage-resolver-guard 60000 "${CHROME_FLAGS_NO_PROXY[@]}" '--host-resolver-rules=MAP * ~NOTFOUND' -- "file:///probe-page.html"
p7_buckets="$(buckets_since "$b_common")"
p7_total=$(( $(udp_packets) - b_total ))
p7_png="$(png_size "$LAST_PNG")"
p7_reached="$(page_reached_rows "$LAST_DOM")"
p7_rows="$(rows_from_dom "$LAST_DOM")"
if [ "$LAST_RC" -eq 0 ] && page_contained "$LAST_DOM" && [ "$p7_reached" -eq 0 ] && [ "$p7_buckets" = "+0/+0/+0" ] && [ "$p7_total" -eq 0 ]; then
  record p7 PASS "with the resolver guard on, the same attempt set is denied after ${LAST_MS}ms and emits nothing at all: udp buckets +443/+53/+other = $p7_buckets and the whole-UDP counter +$p7_total (without the guard, p5's buckets were +443/+53/+other = $p5_buckets), because the guard answers every non-excluded name and IP literal with NOTFOUND before any socket is opened; rows: $p7_rows; screenshot $LAST_PNG ($p7_png bytes)"
else
  record p7 FAIL "exit=$LAST_RC, reached_rows=$p7_reached, udp buckets +443/+53/+other = $p7_buckets, whole-UDP +$p7_total, png=$p7_png bytes; rows: $p7_rows"
fi
echo

echo "=== notes ==="
echo "the browser never sees a *_proxy variable; every working arm passes its proxy via --proxy-server, every adversarial arm via --no-proxy-server"
echo "chromium runs with --no-sandbox because this container's process is root; the containment under test is the netns ruleset, which --no-sandbox cannot bypass"
echo "p2 exists because Chromium implicitly bypasses the proxy for loopback; --proxy-bypass-list=<-loopback> is what makes a proxy-local service reachable at all"
echo "the udp/443 and udp/53 buckets are counter-only rules ahead of the drop rule; they attribute packets, they do not decide them"
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
