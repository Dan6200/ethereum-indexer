#!/usr/bin/env bash
# Run the pg-copy-streams benchmark under both runtimes with identical args.
#   ./run.sh [--rows N] [--runs M] [--baseline]
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH="$DIR/copy-streams-bench.mjs"
ARGS=("$@")

run_one() {
  local rt="$1"
  local log
  log="$(mktemp)"
  echo "=========================================================="
  echo " runtime: $rt"
  echo "=========================================================="
  set +e
  "$rt" "$BENCH" "${ARGS[@]}" >"$log" 2>&1
  local code=$?
  set -e
  cat "$log"
  echo
  echo "--- $rt summary ---"
  grep -E 'correctness|median rows/sec|best rows/sec|FAIL|FATAL' "$log" | sed 's/^/  /' || true
  echo
  rm -f "$log"
  return "$code"
}

set +e
run_one node
node_code=$?
run_one bun
bun_code=$?
set -e

echo "=========================================================="
echo " side-by-side summary"
echo "=========================================================="
if [ "$node_code" -ne 0 ] || [ "$bun_code" -ne 0 ]; then
  echo "node exit=$node_code, bun exit=$bun_code  (one or both FAILED)"
  exit 1
fi
echo "node exit=$node_code, bun exit=$bun_code  (both OK)"
exit 0
