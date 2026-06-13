#!/usr/bin/env bash
# =============================================================================
# mitm-capture — capture CLI tool HTTPS traffic via mitmproxy
# =============================================================================
# Usage:
#   # Kiro CLI
#   KIRO_API_KEY="ksk_..." ./scripts/mitm-proxy/capture.sh kiro-cli chat --no-interactive "hello"
#
#   # Qoder CLI
#   QODER_PERSONAL_ACCESS_TOKEN="pt-..." ./scripts/mitm-proxy/capture.sh qodercli -p "hello"
#
#   # Generic tool (specify env vars inline)
#   MY_TOKEN="xxx" ./scripts/mitm-proxy/capture.sh some-cli-tool arg1 arg2
#
#   # Custom proxy port & output
#   PROXY_PORT=8888 FLOW_FILE=/tmp/my.flow ./scripts/mitm-proxy/capture.sh ...
#
# The script:
#   1. Starts mitmdump in the background, writing flows to FLOW_FILE (.flow binary)
#      and optionally a live JSONL dump via dump_addon.py
#   2. Sets HTTPS_PROXY/HTTP_PROXY and NODE_EXTRA_CA_CERTS for the target
#   3. Runs the target command with all passed arguments
#   4. Stops mitmdump and cleans up on exit
# =============================================================================

set -euo pipefail

# --- Configuration (override via env) ---
PROXY_PORT="${PROXY_PORT:-8080}"
PROXY_HOST="${PROXY_HOST:-127.0.0.1}"
FLOW_FILE="${FLOW_FILE:-/tmp/mitm_capture.flow}"
JSONL_FILE="${JSONL_FILE:-/tmp/mitm_capture.jsonl}"
MITM_CA_CERT="${MITM_CA_CERT:-$HOME/.mitmproxy/mitmproxy-ca-cert.pem}"
MITMDUMP_PID_FILE="${MITMDUMP_PID_FILE:-/tmp/mitmdump.pid}"
VERBOSE="${VERBOSE:-0}"
# Set LIVE_JSONL=1 to also get a live JSONL dump alongside the binary .flow file
LIVE_JSONL="${LIVE_JSONL:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DUMP_ADDON="$SCRIPT_DIR/dump_addon.py"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[mitm-capture]${NC} $*" >&2; }
warn() { echo -e "${YELLOW}[mitm-capture] WARN${NC} $*" >&2; }
err()  { echo -e "${RED}[mitm-capture] ERROR${NC} $*" >&2; }
ok()   { echo -e "${GREEN}[mitm-capture]${NC} $*" >&2; }

cleanup() {
  local exit_code=$?
  log "Cleaning up..."

  # Stop mitmdump
  if [[ -f "$MITMDUMP_PID_FILE" ]]; then
    local pid
    pid=$(cat "$MITMDUMP_PID_FILE" 2>/dev/null || true)
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      log "Stopping mitmdump (pid=$pid)..."
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$MITMDUMP_PID_FILE"
  fi

  # Clean up flow file if requested
  if [[ "${KEEP_FLOW:-0}" != "1" ]]; then
    [[ -f "$FLOW_FILE" ]] && { log "Removing: $FLOW_FILE"; rm -f "$FLOW_FILE"; }
  fi

  exit "$exit_code"
}

trap cleanup EXIT INT TERM

# --- Pre-flight checks ---
check_deps() {
  if ! command -v mitmdump &>/dev/null; then
    err "mitmdump not found. Install mitmproxy: brew install --cask mitmproxy"
    exit 1
  fi

  if [[ ! -f "$MITM_CA_CERT" ]]; then
    warn "MITM CA cert not found at $MITM_CA_CERT"
    warn "Run 'mitmproxy' once (then Ctrl+C) to generate it, or set MITM_CA_CERT env var."
    exit 1
  fi

  if [[ ! -f "$DUMP_ADDON" ]]; then
    warn "dump_addon.py not found at $DUMP_ADDON (JSONL output disabled)"
    LIVE_JSONL=0
  fi

  local mitm_ver
  mitm_ver=$(mitmdump --version 2>/dev/null | head -1 || echo "unknown")
  log "mitmdump version: $mitm_ver"
  log "Using CA cert: $MITM_CA_CERT"
}

# --- Start mitmdump ---
start_proxy() {
  log "Starting mitmdump on ${PROXY_HOST}:${PROXY_PORT}..."
  log "Binary flow output: $FLOW_FILE"
  [[ "$LIVE_JSONL" == "1" ]] && log "Live JSONL output: $JSONL_FILE"

  rm -f "$FLOW_FILE" "$JSONL_FILE"

  # Build mitmdump args
  local mitm_args=(
    --listen-host "$PROXY_HOST"
    --listen-port "$PROXY_PORT"
    --save-stream-file "$FLOW_FILE"
    --set stream_large_bodies=10m
  )

  # Add live JSONL addon if requested
  if [[ "$LIVE_JSONL" == "1" ]]; then
    mitm_args+=(-s "$DUMP_ADDON")
    export MITM_DUMP_OUTPUT="$JSONL_FILE"
  fi

  mitmdump "${mitm_args[@]}" &
  local pid=$!
  echo "$pid" > "$MITMDUMP_PID_FILE"

  # Wait for mitmdump to be ready
  log "Waiting for mitmdump to be ready..."
  for i in $(seq 1 10); do
    if kill -0 "$pid" 2>/dev/null; then
      if nc -z "$PROXY_HOST" "$PROXY_PORT" 2>/dev/null; then
        ok "mitmdump is ready (pid=$pid, port=$PROXY_PORT)"
        return 0
      fi
    else
      err "mitmdump failed to start"
      exit 1
    fi
    sleep 0.5
  done

  ok "mitmdump is running (pid=$pid, assuming port $PROXY_PORT is open)"
  return 0
}

# --- Run the target command ---
run_target() {
  local cmd=("$@")
  if [[ ${#cmd[@]} -eq 0 ]]; then
    err "No command specified. Usage: $0 <command> [args...]"
    exit 1
  fi

  log "Running target: ${cmd[*]}"
  echo "----------------------------------------" >&2

  # Build proxy env: inherit everything, add proxy + CA settings
  export HTTPS_PROXY="http://${PROXY_HOST}:${PROXY_PORT}"
  export HTTP_PROXY="http://${PROXY_HOST}:${PROXY_PORT}"
  export https_proxy="http://${PROXY_HOST}:${PROXY_PORT}"
  export http_proxy="http://${PROXY_HOST}:${PROXY_PORT}"
  export NODE_EXTRA_CA_CERTS="$MITM_CA_CERT"
  export SSL_CERT_FILE="$MITM_CA_CERT"
  export REQUESTS_CA_BUNDLE="$MITM_CA_CERT"
  export CURL_CA_BUNDLE="$MITM_CA_CERT"

  # Don't MITM our own proxy connections
  export no_proxy="127.0.0.1,localhost,${PROXY_HOST}"
  export NO_PROXY="127.0.0.1,localhost,${PROXY_HOST}"

  if [[ "${VERBOSE}" == "1" ]]; then
    for var in KIRO_API_KEY QODER_PERSONAL_ACCESS_TOKEN MY_TOKEN; do
      if [[ -n "${!var:-}" ]]; then
        local masked="${!var:0:8}...${!var: -4}"
        log "  $var = $masked"
      fi
    done
  fi

  set +e
  "${cmd[@]}"
  local exit_code=$?
  set -e

  echo "----------------------------------------" >&2
  log "Target exited with code: $exit_code"
  return "$exit_code"
}

# --- Main ---
main() {
  check_deps
  start_proxy

  sleep 1

  run_target "$@"
  local target_exit=$?

  sleep 1

  if [[ -f "$FLOW_FILE" ]]; then
    local flow_size
    flow_size=$(wc -c < "$FLOW_FILE" 2>/dev/null || echo 0)
    ok "Captured flows saved to: $FLOW_FILE ($flow_size bytes)"

    if [[ -f "$JSONL_FILE" ]]; then
      local jsonl_size
      jsonl_size=$(wc -c < "$JSONL_FILE" 2>/dev/null || echo 0)
      ok "Live JSONL dump: $JSONL_FILE ($jsonl_size bytes)"
    fi

    echo ""
    echo "To analyze:"
    echo "  ./scripts/mitm-proxy/parse_flows.py --summary $FLOW_FILE"
    echo "  ./scripts/mitm-proxy/parse_flows.py $FLOW_FILE"
    if [[ -f "$JSONL_FILE" ]]; then
      echo "  # or directly from JSONL:"
      echo "  ./scripts/mitm-proxy/parse_flows.py --jsonl --summary $JSONL_FILE"
    fi
  else
    warn "No flows captured (target may not have made any HTTPS requests)"
  fi

  return "$target_exit"
}

main "$@"
