#!/bin/sh
# In-container key-material scan.
#
# The canary arrives on stdin, never as argv or env, so the scan cannot find its own needle in
# /proc/<pid>/cmdline or /proc/<pid>/environ. A positive control first proves the scanner finds a
# canary-shaped string placed inside the container at a known path; the canary scan must then
# return zero hits. The scanner's own pattern file is excluded by name and removed at the end.
set -u

CANARY="$(head -n 1)"
if [ -z "$CANARY" ]; then
  echo "PROBE FAIL: no canary on stdin"
  exit 2
fi

HITS=0
hit() { # $1 label, $2 count
  echo "$1: $2 hit(s)"
  HITS=$((HITS + $2))
}

echo "== target =="
echo "canary length: ${#CANARY}"
echo "user: $(id -un), HOME: ${HOME:-unset}"
echo "mount table:"
cat /proc/mounts

echo "== 1. environment =="
hit "env" "$(env | grep -c -F -- "$CANARY" || true)"

echo "== 2. process env and argv =="
PROC=0
for f in /proc/[0-9]*/environ; do
  [ -r "$f" ] || continue
  c=$(tr '\0' '\n' < "$f" 2>/dev/null | grep -c -F -- "$CANARY" || true)
  PROC=$((PROC + c))
done
ARGV=0
for f in /proc/[0-9]*/cmdline; do
  [ -r "$f" ] || continue
  c=$(tr '\0' '\n' < "$f" 2>/dev/null | grep -c -F -- "$CANARY" || true)
  ARGV=$((ARGV + c))
done
hit "/proc/*/environ" "$PROC"
hit "/proc/*/cmdline" "$ARGV"

echo "== 3. mount table =="
hit "mounts" "$(cat /proc/mounts /proc/self/mountinfo | grep -c -F -- "$CANARY" || true)"
if grep -q "freebot-keyscan" /proc/mounts; then
  echo "FOUND keyscan path in mount table"
  HITS=$((HITS + 1))
else
  echo "no keyscan path in mount table"
fi

echo "== 4. filesystem =="
NEEDLE=/.keyscan-needle
CONTROL_DIR=/tmp/probe-control
DECOY="DECOY_CANARY_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
mkdir -p "$CONTROL_DIR"
printf '%s\n' "$DECOY" > "$CONTROL_DIR/decoy.txt"
printf '%s\n' "$DECOY" > "$NEEDLE"
CONTROL=$(grep -r -l -a -F -f "$NEEDLE" / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev --exclude=.keyscan-needle 2>/dev/null | grep -c . || true)
echo "positive control: decoy string found in $CONTROL file(s), expected 1"

printf '%s\n' "$CANARY" > "$NEEDLE"
FS_LIST=$(grep -r -l -a -F -f "$NEEDLE" / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev --exclude=.keyscan-needle 2>/dev/null)
echo "filesystem hits:"
if [ -z "$FS_LIST" ]; then echo "  none"; else printf '  %s\n' "$FS_LIST"; fi
hit "filesystem" "$(printf '%s\n' "$FS_LIST" | grep -c . || true)"
rm -f "$NEEDLE"

echo "== 5. home and freebot paths =="
if [ -e "${HOME:-/root}/.freebot" ]; then
  echo "FOUND ${HOME:-/root}/.freebot"
  HITS=$((HITS + 1))
else
  echo "no ~/.freebot"
fi
if [ -e /home/yusufameri ]; then
  echo "FOUND /home/yusufameri"
  HITS=$((HITS + 1))
else
  echo "no /home/yusufameri"
fi
echo "ls -la /:"
ls -la /
echo "ls -la /home:"
ls -la /home 2>/dev/null || echo "  (no /home)"
echo "paths matching *keyscan* under / (excluding /proc):"
find / -maxdepth 3 -name '*keyscan*' 2>/dev/null | grep -v '^/proc' || echo "  none"

echo "== 6. private key headers (informational) =="
HEADERS=$(grep -r -l -a -e "BEGIN OPENSSH PRIVATE KEY" -e "BEGIN RSA PRIVATE KEY" -e "BEGIN EC PRIVATE KEY" / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null)
echo "private key header hits: $(printf '%s\n' "$HEADERS" | grep -c . || true)"
if [ -n "$HEADERS" ]; then printf '  %s\n' "$HEADERS"; fi

if [ "$CONTROL" -ne 1 ]; then
  echo "PROBE FAIL: positive control did not fire ($CONTROL), scan capability unproven"
  exit 3
fi

echo "== summary =="
echo "CANARY HITS: $HITS"
if [ "$HITS" -eq 0 ]; then
  echo "PROBE RESULT: PASS"
  exit 0
fi
echo "PROBE RESULT: FAIL"
exit 1
