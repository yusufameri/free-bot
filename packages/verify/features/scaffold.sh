#!/usr/bin/env sh
# Asserts the workspace shape from freebot-plan.md section 2.7.
set -eu

root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"

status=0

for pkg in protocol core sandbox pi-bridge providers connectors review ui verify; do
  if [ ! -f "packages/$pkg/package.json" ]; then
    echo "missing packages/$pkg/package.json"
    status=1
  fi
  if ! grep -q '"extends": "../../tsconfig.base.json"' "packages/$pkg/tsconfig.json" 2>/dev/null; then
    echo "packages/$pkg/tsconfig.json does not extend ../../tsconfig.base.json"
    status=1
  fi
done

for app in server web desktop mobile sandbox-agent; do
  if [ ! -f "apps/$app/package.json" ]; then
    echo "missing apps/$app/package.json"
    status=1
  fi
done

if [ ! -f "$root/package.json" ]; then
  echo "missing root package.json"
  status=1
fi

if [ "$status" -ne 0 ]; then
  exit 1
fi

echo "scaffold shape ok: 9 packages, 5 apps, every package extends tsconfig.base.json"
