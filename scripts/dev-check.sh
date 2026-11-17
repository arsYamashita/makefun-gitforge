#!/bin/sh
# Run the kit's sealed env against this forge on loopback and print every check's pass/fail line.
# usage: scripts/dev-check.sh [grep pattern for check ids, e.g. 'git\.' or 'mcp\.']
# KIT defaults to ../kit beside the repository.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
KIT=${KIT:-$ROOT/../kit}
WORK=$(mktemp -d)
PORT=${ENV_PORT:-$((20000 + $$ % 20000))}
export MAKEFUN_SHOP_TOKEN=${MAKEFUN_SHOP_TOKEN:-devtoken0123456789}
export MAKEFUN_TRIAL_NOW=${MAKEFUN_TRIAL_NOW:-2026-11-14T06:30:00Z}
MAKEFUN_STATE_DIR=$WORK MAKEFUN_ENV_HOST=127.0.0.1 MAKEFUN_ENV_PORT=$PORT node "$KIT/program/env/server.mjs" > "$WORK/env.log" 2>&1 &
ENV_PID=$!
sleep 0.5
MAKEFUN_ENV_URL=http://127.0.0.1:$PORT node "$ROOT/main.ts" > "$WORK/bot.log" 2>&1 || true
sleep 0.5
kill $ENV_PID 2>/dev/null || true
PAT=${1:-.}
grep -E '^\[env\] [a-z]+\.[a-z0-9-]+ (pass|fail)' "$WORK/env.log" | grep -E "$PAT" || true
echo "passed: $(grep -cE '^\[env\] [a-z]+\.[a-z0-9-]+ pass' "$WORK/env.log" || true) / 120"
grep -E 'bench|workload|p50' "$WORK/env.log" | tail -8 || true
echo "logs: $WORK (env.log, bot.log)"
