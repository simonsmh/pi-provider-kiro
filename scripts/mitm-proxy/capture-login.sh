#!/usr/bin/env bash
# =============================================================================
# capture-login.sh — capture kiro-cli's Builder ID login + profile/model flow
# =============================================================================
# Purpose:
#   Reverse-engineer what the *real* kiro-cli does for AWS Builder ID tokens to
#   resolve a profileArn and list models — the sequence our provider currently
#   can't reproduce (ListAvailableProfiles / ListProfiles / GetProfile all reject
#   Builder ID tokens). See docs and the mitm-proxy/README.md.
#
# Unlike capture.sh (which captures a one-shot chat call with an API key), this:
#   1. Optionally logs out first for a clean OAuth flow (LOGOUT_FIRST=1, default 1)
#   2. Runs the interactive device-code login — it prints a URL + code; you
#      authorize in a browser, then it continues. The proxy stays up the whole time.
#   3. Runs a follow-up command that forces profile + model resolution, so we
#      capture GetProfile/ListAvailableProfiles/ListAvailableModels too.
#   4. Keeps the flow file and prints the management-plane requests.
#
# kiro-cli is a Rust binary (reqwest + rustls). It does NOT honor NODE_EXTRA_CA_CERTS.
# It DOES honor: HTTPS_PROXY/HTTP_PROXY/NO_PROXY, and Q_CUSTOM_CERT (custom CA path).
# We also set SSL_CERT_FILE as a belt-and-suspenders backup for the rustls loader.
#
# Usage:
#   ./scripts/mitm-proxy/capture-login.sh                 # Builder ID, device flow
#   LICENSE=pro IDP_URL=https://my.awsapps.com/start REGION=us-east-1 \
#     ./scripts/mitm-proxy/capture-login.sh               # IAM Identity Center
#   LOGOUT_FIRST=0 ./scripts/mitm-proxy/capture-login.sh  # keep existing session
#   FOLLOWUP_CMD="kiro-cli chat --no-interactive hi" ./scripts/mitm-proxy/capture-login.sh
# =============================================================================

set -euo pipefail

# --- Configuration (override via env) ---
PROXY_PORT="${PROXY_PORT:-8080}"
PROXY_HOST="${PROXY_HOST:-127.0.0.1}"
FLOW_FILE="${FLOW_FILE:-/tmp/kiro_login_capture.flow}"
MITM_CA_CERT="${MITM_CA_CERT:-$HOME/.mitmproxy/mitmproxy-ca-cert.pem}"
MITMDUMP_PID_FILE="${MITMDUMP_PID_FILE:-/tmp/mitmdump_login.pid}"

KIRO_BIN="${KIRO_BIN:-kiro-cli}"
LICENSE="${LICENSE:-free}"            # free = Builder ID / social, pro = IAM IdC
IDP_URL="${IDP_URL:-}"               # IAM Identity Center start URL (license=pro)
REGION="${REGION:-}"                 # IAM Identity Center region (license=pro)
USE_DEVICE_FLOW="${USE_DEVICE_FLOW:-1}"  # 1 = --use-device-flow (no browser redirect)
LOGOUT_FIRST="${LOGOUT_FIRST:-1}"    # 1 = logout before login for a clean capture
# Follow-up command run AFTER login to force profile+model resolution.
# Empty string disables it. Default lists models via a tiny non-interactive chat.
FOLLOWUP_CMD="${FOLLOWUP_CMD:-$KIRO_BIN chat --no-interactive hi}"
VERBOSE="${VERBOSE:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${CYAN}[capture-login]${NC} $*" >&2; }
warn() { echo -e "${YELLOW}[capture-login] WARN${NC} $*" >&2; }
err()  { echo -e "${RED}[capture-login] ERROR${NC} $*" >&2; }
ok()   { echo -e "${GREEN}[capture-login]${NC} $*" >&2; }

cleanup() {
  local exit_code=$?
  if [[ -f "$MITMDUMP_PID_FILE" ]]; then
    local pid; pid=$(cat "$MITMDUMP_PID_FILE" 2>/dev/null || true)
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      log "Stopping mitmdump (pid=$pid)..."
      kill "$pid" 2>/dev/null || true; sleep 1; kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$MITMDUMP_PID_FILE"
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

check_deps() {
  command -v mitmdump &>/dev/null || { err "mitmdump not found: brew install --cask mitmproxy"; exit 1; }
  command -v "$KIRO_BIN" &>/dev/null || { err "$KIRO_BIN not found on PATH"; exit 1; }
  [[ -f "$MITM_CA_CERT" ]] || { err "MITM CA cert not found at $MITM_CA_CERT (run mitmproxy once to generate)"; exit 1; }
  log "mitmdump: $(mitmdump --version 2>/dev/null | head -1)"
  log "kiro-cli: $($KIRO_BIN --version 2>/dev/null || echo '?')"
  log "CA cert:  $MITM_CA_CERT"
}

start_proxy() {
  log "Starting mitmdump on ${PROXY_HOST}:${PROXY_PORT}, flow -> $FLOW_FILE"
  rm -f "$FLOW_FILE"
  mitmdump \
    --listen-host "$PROXY_HOST" \
    --listen-port "$PROXY_PORT" \
    --save-stream-file "$FLOW_FILE" \
    --set stream_large_bodies=10m \
    >/tmp/mitmdump_login.out 2>&1 &
  local pid=$!
  echo "$pid" > "$MITMDUMP_PID_FILE"
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || { err "mitmdump failed to start; see /tmp/mitmdump_login.out"; exit 1; }
    nc -z "$PROXY_HOST" "$PROXY_PORT" 2>/dev/null && { ok "mitmdump ready (pid=$pid)"; return 0; }
    sleep 0.5
  done
  ok "mitmdump running (pid=$pid, assuming port open)"
}

set_proxy_env() {
  export HTTPS_PROXY="http://${PROXY_HOST}:${PROXY_PORT}"
  export HTTP_PROXY="http://${PROXY_HOST}:${PROXY_PORT}"
  export https_proxy="$HTTPS_PROXY"
  export http_proxy="$HTTP_PROXY"
  # kiro-cli (Rust/rustls) trust: dedicated env var + rustls PEM loader backup.
  export Q_CUSTOM_CERT="$MITM_CA_CERT"
  export SSL_CERT_FILE="$MITM_CA_CERT"
  export SSL_CERT_DIR=""
  # Don't proxy the proxy itself / loopback.
  export no_proxy="127.0.0.1,localhost,${PROXY_HOST}"
  export NO_PROXY="$no_proxy"
  # Note: keep this as an if-block, not `[[ ]] && ...`, so the function's exit
  # status stays 0 under `set -e` (a false [[ ]] would abort the whole script).
  if [[ "$VERBOSE" == "1" ]]; then
    export KIRO_LOG_LEVEL="${KIRO_LOG_LEVEL:-debug}"
  fi
}

build_login_args() {
  LOGIN_ARGS=(login --license "$LICENSE")
  if [[ "$LICENSE" == "pro" ]]; then
    [[ -n "$IDP_URL" ]] && LOGIN_ARGS+=(--identity-provider "$IDP_URL")
    [[ -n "$REGION"  ]] && LOGIN_ARGS+=(--region "$REGION")
  fi
  [[ "$USE_DEVICE_FLOW" == "1" ]] && LOGIN_ARGS+=(--use-device-flow)
}

main() {
  check_deps
  start_proxy
  set_proxy_env
  sleep 1

  if [[ "$LOGOUT_FIRST" == "1" ]]; then
    log "Logging out first (clean OAuth flow)..."
    "$KIRO_BIN" logout >/dev/null 2>&1 || warn "logout returned non-zero (continuing)"
  fi

  build_login_args
  echo "----------------------------------------" >&2
  log "Running: $KIRO_BIN ${LOGIN_ARGS[*]}"
  warn "A device-code URL + code will print below. Authorize in your browser, then return here."
  echo "----------------------------------------" >&2
  set +e
  "$KIRO_BIN" "${LOGIN_ARGS[@]}"
  local login_rc=$?
  set -e
  echo "----------------------------------------" >&2
  log "login exited with code: $login_rc"

  if [[ -n "$FOLLOWUP_CMD" ]]; then
    log "Running follow-up to force profile/model resolution: $FOLLOWUP_CMD"
    echo "----------------------------------------" >&2
    set +e
    eval "$FOLLOWUP_CMD"
    local follow_rc=$?
    set -e
    echo "----------------------------------------" >&2
    log "follow-up exited with code: $follow_rc"
  fi

  sleep 1
  if [[ -f "$FLOW_FILE" ]]; then
    ok "Captured flows: $FLOW_FILE ($(wc -c < "$FLOW_FILE") bytes)"
    echo "" >&2
    log "Management-plane / profile / model requests (summary):"
    "$SCRIPT_DIR/parse_flows.py" --summary "$FLOW_FILE" 2>/dev/null \
      | grep -iE "management\.|GetProfile|ListProfiles|ListAvailableProfiles|ListAvailableModels|getUsageLimits|oidc|sso|CreateToken|RegisterClient|StartDeviceAuthorization|profile|token" \
      || "$SCRIPT_DIR/parse_flows.py" --summary "$FLOW_FILE" 2>/dev/null || true
    echo "" >&2
    echo "Full analysis:" >&2
    echo "  $SCRIPT_DIR/parse_flows.py $FLOW_FILE" >&2
    echo "  $SCRIPT_DIR/parse_flows.py --no-mask --host management.us-east-1.kiro.dev $FLOW_FILE   # reveal ARNs" >&2
    echo "  mitmproxy -r $FLOW_FILE   # interactive step-through" >&2
  else
    warn "No flows captured. If TLS failed, kiro-cli may have rejected the MITM CA."
    warn "Check /tmp/mitmdump_login.out and confirm Q_CUSTOM_CERT was honored."
  fi
}

main "$@"
