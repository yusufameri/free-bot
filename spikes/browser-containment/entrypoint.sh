#!/bin/sh
# COPY of spikes/containment/entrypoint.sh (U0.4 evidence, do not modify that
# directory). Same default-deny egress policy, applied inside this container's
# network namespace before the browser starts. Runs as root.
#
# Ruleset shape (see docs/containment-spike.md for why each line is there):
#   policy drop on the output hook, so anything not matched never leaves.
#   Docker's embedded DNS at 127.0.0.11 is dropped: the container needs no
#   name resolution at all, because the proxy does its own.
#   Loopback stays open, the proxy listener is the only allowed destination.
#   All UDP is dropped explicitly, which is what closes QUIC/HTTP-3.
set -eu

PROXY_HOST="${PROXY_HOST:-host.docker.internal}"
PROXY_PORT="${PROXY_PORT:-8788}"

# The proxy address comes from /etc/hosts (--add-host at run time), never from
# DNS: resolution is blocked below on purpose.
proxy_ip="$(getent ahostsv4 "$PROXY_HOST" | awk 'NR == 1 { print $1 }')"
if [ -z "$proxy_ip" ]; then
  echo "entrypoint: cannot resolve $PROXY_HOST from /etc/hosts; run with --add-host=$PROXY_HOST:host-gateway" >&2
  exit 1
fi

nft -f - <<EOF
table inet freebot_containment {
  chain output {
    type filter hook output priority filter; policy drop;

    ip daddr 127.0.0.11 counter drop comment "docker embedded dns"
    oifname "lo" counter accept comment "loopback"
    ip daddr $proxy_ip tcp dport $PROXY_PORT ct state new,established,related counter accept comment "egress proxy only"
    meta l4proto udp counter drop comment "all udp including quic"
  }
}
EOF

echo "=== containment policy ==="
echo "proxy host: $PROXY_HOST ($proxy_ip:$PROXY_PORT)"
echo "capabilities (effective, of this process):"
grep '^CapEff:' /proc/self/status
python3 - <<'PY'
NAMES = [
    "CHOWN", "DAC_OVERRIDE", "DAC_READ_SEARCH", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID",
    "SETPCAP", "LINUX_IMMUTABLE", "NET_BIND_SERVICE", "NET_BROADCAST", "NET_ADMIN", "NET_RAW",
    "IPC_LOCK", "IPC_OWNER", "SYS_MODULE", "SYS_RAWIO", "SYS_CHROOT", "SYS_PTRACE", "SYS_PACCT",
    "SYS_ADMIN", "SYS_BOOT", "SYS_NICE", "SYS_RESOURCE", "SYS_TIME", "SYS_TTY_CONFIG", "MKNOD",
    "LEASE", "AUDIT_WRITE", "AUDIT_CONTROL", "SETFCAP", "MAC_OVERRIDE", "MAC_ADMIN", "SYSLOG",
    "WAKE_ALARM", "BLOCK_SUSPEND", "AUDIT_READ",
]
status = open("/proc/self/status", encoding="utf-8").read()
eff = int(status.split("CapEff:")[1].split("\n")[0].strip(), 16)
print("capabilities decoded: " + (", ".join(n for i, n in enumerate(NAMES) if eff >> i & 1) or "none"))
PY
echo "=== nft ruleset after entrypoint ==="
nft list chain inet freebot_containment output
echo "=== end containment policy ==="

exec "$@"
