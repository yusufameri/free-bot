#!/bin/sh
# Seven containment probes from freebot-plan.md section 5.2 finding 34.
# Runs inside the container after entrypoint.sh applies the default-deny nft
# ruleset. Prints one "PROBE(<id>) PASS|FAIL" line per probe, with the observed
# evidence on the same line. Exits non-zero if any probe fails.
#
# No proxy environment variables are set or honored: each proxied request names
# the proxy with curl -x, so a PASS is kernel-level denial, not env redirection.
set -u

PROXY_HOST="${PROXY_HOST:-host.docker.internal}"
PROXY_PORT="${PROXY_PORT:-8788}"
PROXY="http://$PROXY_HOST:$PROXY_PORT"
TARGET="${TARGET:-https://example.com}"
RAW_TCP="1.1.1.1:443"
UDP_DNS="8.8.8.8:53"

failures=0
record() {
  # id status detail
  printf 'PROBE(%s) %s  %s\n' "$1" "$2" "$3"
  if [ "$2" != PASS ]; then
    failures=$((failures + 1))
  fi
}

now_ms() {
  date +%s%3N
}

# Packets the kernel dropped on one rule, read from its counter. This is the
# positive evidence that a datagram was denied by the ruleset, not merely that
# no reply came back.
rule_packets() {
  nft list chain inet freebot_containment output | grep -F "$1" | sed -n 's/.*packets \([0-9]*\).*/\1/p' | head -n1
}

first_line() {
  printf '%s' "$1" | head -n1 | cut -c1-200
}

echo "=== probes ==="
echo "target: $TARGET"
echo "proxy: $PROXY"
echo "curl: $(curl -V | head -n1)"
echo "dig: $(dig -v 2>&1 | head -n1)"
echo

for var in http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY no_proxy NO_PROXY; do
  value="$(printenv "$var" 2>/dev/null || true)"
  if [ -n "$value" ]; then
    echo "PROBE(env) FAIL  $var=$value is set; the spike must prove kernel-level denial, not env redirection"
    exit 1
  fi
done
echo "environment: no *_proxy variables set (checked 9 names)"
echo

# (a) direct https, no proxy, no DNS-free path.
start="$(now_ms)"
err="$(curl -sS --connect-timeout 4 --max-time 8 -o /dev/null "$TARGET" 2>&1)"
rc=$?
elapsed=$(( $(now_ms) - start ))
if [ "$rc" -ne 0 ]; then
  record a PASS "direct curl $TARGET exit=$rc after ${elapsed}ms: $(first_line "$err")"
else
  record a FAIL "direct curl $TARGET exit=0: egress escaped without the proxy"
fi
echo "  note: probe (a) is denied at name resolution because DNS is blocked; denial of the TCP path itself is probes (d) and (g)"

# (b) the same request through the proxy must succeed. This is the control: it
# proves the failure in (a) is the ruleset, not a broken network stack.
start="$(now_ms)"
code="$(curl -sS --connect-timeout 5 --max-time 20 -x "$PROXY" -o /dev/null -w '%{http_code}' "$TARGET" 2>/tmp/curl-b.err)"
rc=$?
elapsed=$(( $(now_ms) - start ))
if [ "$rc" -eq 0 ] && [ "$code" = "200" ]; then
  record b PASS "curl -x $PROXY $TARGET -> HTTP $code after ${elapsed}ms"
else
  record b FAIL "curl -x $PROXY $TARGET exit=$rc code=${code}: $(first_line "$(cat /tmp/curl-b.err 2>/dev/null)")"
fi

# (c) resolver access from inside the container: UDP and TCP, dig and nslookup.
# The resolver address is whatever Docker put in /etc/resolv.conf, which is what
# dig queries; on this engine that is not 127.0.0.11.
resolver="$(awk '/^nameserver/ { print $2; exit }' /etc/resolv.conf)"
echo "resolver from /etc/resolv.conf: ${resolver:-none}; resolv.conf: $(tr '\n' ' ' </etc/resolv.conf | cut -c1-160)"
udp_before_c="$(rule_packets 'all udp including quic')"
start="$(now_ms)"
dig_err="$(timeout 10 dig +time=3 +tries=1 +short example.com 2>&1)"
dig_rc=$?
dig_ms=$(( $(now_ms) - start ))
nsl_err="$(timeout 10 nslookup example.com 2>&1)"
nsl_rc=$?
dig_tcp_err="$(timeout 10 dig +tcp +time=3 +tries=1 +short example.com 2>&1)"
dig_tcp_rc=$?
udp_after_c="$(rule_packets 'all udp including quic')"
udp_delta_c=$(( udp_after_c - udp_before_c ))
if [ "$dig_rc" -ne 0 ] && [ "$nsl_rc" -ne 0 ] && [ "$dig_tcp_rc" -ne 0 ]; then
  record c PASS "dig exit=$dig_rc after ${dig_ms}ms ($(first_line "$dig_err")); nslookup exit=$nsl_rc ($(first_line "$nsl_err")); dig +tcp exit=$dig_tcp_rc ($(first_line "$dig_tcp_err"))"
else
  record c FAIL "dig exit=$dig_rc, nslookup exit=$nsl_rc, dig +tcp exit=$dig_tcp_rc: name resolution still works"
fi
echo "  note: resolver=$resolver, udp drop counter +$udp_delta_c packets during probe (c); DNS over TCP falls under the policy drop"

# (d) raw TCP to a public resolver, no TLS, no HTTP.
start="$(now_ms)"
nc_err="$(timeout 8 nc -w 4 -z 1.1.1.1 443 2>&1)"
nc_rc=$?
nc_ms=$(( $(now_ms) - start ))
if [ "$nc_rc" -ne 0 ]; then
  record d PASS "nc -z $RAW_TCP exit=$nc_rc after ${nc_ms}ms: $(first_line "$nc_err")"
else
  record d FAIL "nc -z $RAW_TCP exit=0: raw TCP reached the internet"
fi

# (e) UDP: a DNS query to a public resolver and QUIC-sized datagrams to udp/443.
# The counter delta is the proof that the kernel dropped them; note that a
# dropped locally generated datagram surfaces as EPERM from sendto in Linux,
# so EPERM plus an incremented drop counter is denial by the ruleset, not by a
# missing capability or a dead socket.
udp_before="$(rule_packets 'all udp including quic')"
start="$(now_ms)"
udp_dns_err="$(timeout 10 dig +time=3 +tries=1 @8.8.8.8 example.com 2>&1)"
udp_dns_rc=$?
udp_dns_ms=$(( $(now_ms) - start ))
udp_py_before="$(rule_packets 'all udp including quic')"
quic_out="$(python3 - <<'PY' 2>&1
import socket

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.settimeout(3.0)
for size in (1200, 64):
    try:
        sent = sock.sendto(b"\xc0" + b"\x00" * (size - 1), ("1.1.1.1", 443))
        print(f"sendto {size}B to 1.1.1.1:443 returned {sent}")
    except OSError as error:
        print(f"sendto {size}B to 1.1.1.1:443 -> errno {error.errno} {error.strerror}")
try:
    data, _ = sock.recvfrom(1500)
    print(f"reply of {len(data)} bytes from 1.1.1.1:443: UDP escaped")
    raise SystemExit(1)
except socket.timeout:
    print("no reply from 1.1.1.1:443 within 3s")
PY
)"
quic_rc=$?
udp_py_after="$(rule_packets 'all udp including quic')"
udp_after="$(rule_packets 'all udp including quic')"
udp_delta=$(( udp_after - udp_before ))
udp_py_delta=$(( udp_py_after - udp_py_before ))
if [ "$udp_dns_rc" -ne 0 ] && [ "$quic_rc" -eq 0 ] && [ "$udp_py_delta" -ge 2 ]; then
  record e PASS "dig @$UDP_DNS exit=$udp_dns_rc after ${udp_dns_ms}ms ($(first_line "$udp_dns_err")); $(printf '%s' "$quic_out" | tr '\n' '; '); udp drop counter +$udp_delta packets for the probe, +$udp_py_delta for the two QUIC-port datagrams"
else
  record e FAIL "dig @$UDP_DNS exit=$udp_dns_rc, quic exit=$quic_rc, udp drop counter +$udp_delta packets (+$udp_py_delta for the datagrams): $(first_line "$quic_out")"
fi

# (f) DoH to an IP literal, twice: curl's own --doh-url path, and a direct
# application/dns-message GET.
doh_url_err="$(curl -sS --connect-timeout 4 --max-time 8 --doh-url https://1.1.1.1/dns-query -o /dev/null "$TARGET" 2>&1)"
doh_url_rc=$?
doh_get_err="$(curl -sS --connect-timeout 4 --max-time 8 -H 'accept: application/dns-message' -o /dev/null 'https://1.1.1.1/dns-query?dns=AAABAAABAAAAAAAAA3d3dwdleGFtcGxlA2NvbQAAAQAB' 2>&1)"
doh_get_rc=$?
if [ "$doh_url_rc" -ne 0 ] && [ "$doh_get_rc" -ne 0 ]; then
  record f PASS "--doh-url exit=$doh_url_rc ($(first_line "$doh_url_err")); DoH GET exit=$doh_get_rc ($(first_line "$doh_get_err"))"
else
  record f FAIL "--doh-url exit=$doh_url_rc, DoH GET exit=$doh_get_rc: a DoH endpoint answered"
fi

# (g) https to a bare IP literal.
start="$(now_ms)"
ip_err="$(curl -sS -k --connect-timeout 4 --max-time 8 -o /dev/null 'https://1.1.1.1/' 2>&1)"
ip_rc=$?
ip_ms=$(( $(now_ms) - start ))
if [ "$ip_rc" -ne 0 ]; then
  record g PASS "curl -k https://1.1.1.1/ exit=$ip_rc after ${ip_ms}ms: $(first_line "$ip_err")"
else
  record g FAIL "curl -k https://1.1.1.1/ exit=0: IP-literal https reached the internet"
fi

echo
echo "=== notes ==="
echo "the container has no *_proxy environment variables; every proxied request names the proxy with curl -x"
echo "the proxy (spikes/containment/proxy.ts) resolves example.com itself on the host and streams bytes unbuffered"
echo "(a) is denied at name resolution; the TCP path itself is denied in (d) and (g)"
echo "(e) drops show up as EPERM from sendto plus an incremented udp rule counter, which is netfilter's output-hook drop"
echo "=== end notes ==="
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
