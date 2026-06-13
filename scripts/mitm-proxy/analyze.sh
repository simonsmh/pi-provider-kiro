#!/usr/bin/env bash
# =============================================================================
# analyze.sh — capture once, analyze multiple ways (convenience wrapper)
# =============================================================================
# Usage:
#   # Capture + analyze in one shot
#   KIRO_API_KEY="ksk_..." ./scripts/mitm-proxy/analyze.sh kiro-cli chat --no-interactive "hello"
#
#   # Analyze an existing flow file
#   ./scripts/mitm-proxy/analyze.sh --replay /tmp/mitm_capture.flow
#
#   # Replay with filters
#   ./scripts/mitm-proxy/analyze.sh --replay /tmp/mitm_capture.flow --host openapi.qoder.sh --method POST
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAPTURE_SH="$SCRIPT_DIR/capture.sh"
PARSE_PY="$SCRIPT_DIR/parse_flows.py"

RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[analyze]${NC} $*" >&2; }
err()  { echo -e "${RED}[analyze]${NC} $*" >&2; }

usage() {
  cat <<'EOF'
Usage:
  # Capture + analyze
  KIRO_API_KEY="ksk_..." ./scripts/mitm-proxy/analyze.sh kiro-cli chat --no-interactive "prompt"

  # Replay existing flow
  ./scripts/mitm-proxy/analyze.sh --replay /tmp/mitm_capture.flow

  # Replay with filters
  ./scripts/mitm-proxy/analyze.sh --replay /tmp/mitm_capture.flow --host api.example.com --method POST

  # Live JSONL output during capture
  LIVE_JSONL=1 KIRO_API_KEY="..." ./scripts/mitm-proxy/analyze.sh kiro-cli ... 

Options:
  --replay FILE     Skip capture, analyze existing .flow or .jsonl file
  --host HOST       Filter by hostname
  --method METHOD   Filter by HTTP method
  --no-mask         Show raw token values (DANGER: leaks secrets)
  --json            Output JSON instead of human-readable
  --keep-flow       Don't delete the flow file after analysis
EOF
  exit 0
}

main() {
  local replay_file=""
  local extra_args=()
  local keep_flow=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --replay)
        replay_file="$2"
        shift 2
        ;;
      --help|-h) usage ;;
      --keep-flow)
        keep_flow=1
        extra_args+=("$1")
        shift
        ;;
      *)
        extra_args+=("$1")
        shift
        ;;
    esac
  done

  if [[ -n "$replay_file" ]]; then
    # ── Replay mode ──
    if [[ ! -f "$replay_file" ]]; then
      err "Flow file not found: $replay_file"
      exit 1
    fi

    # Auto-detect .jsonl vs .flow
    if [[ "$replay_file" == *.jsonl ]]; then
      extra_args=("--jsonl" "${extra_args[@]}")
    fi

    log "Analyzing: $replay_file"

    echo ""
    echo "═══ Summary ═══"
    python3 "$PARSE_PY" --summary "${extra_args[@]}" "$replay_file"

    echo ""
    echo "═══ Full dump ═══"
    python3 "$PARSE_PY" "${extra_args[@]}" "$replay_file"

  else
    # ── Capture mode ──
    if [[ ${#extra_args[@]} -eq 0 ]]; then
      err "No command specified."
      usage
    fi

    local flow_file="/tmp/mitm_capture_$(date +%Y%m%d_%H%M%S).flow"
    export FLOW_FILE="$flow_file"
    [[ "$keep_flow" == "1" ]] && export KEEP_FLOW=1

    log "Capturing: ${extra_args[*]}"
    log "Flow file: $flow_file"

    set +e
    "$CAPTURE_SH" "${extra_args[@]}"
    local capture_exit=$?
    set -e

    if [[ ! -f "$flow_file" ]] || [[ ! -s "$flow_file" ]]; then
      err "No flows captured"
      exit 1
    fi

    echo ""
    log "Capture complete. Analyzing..."

    echo ""
    echo "═══ Summary ═══"
    python3 "$PARSE_PY" --summary "$flow_file"

    echo ""
    echo "═══ Full dump ═══"
    python3 "$PARSE_PY" "$flow_file"

    echo ""
    log "Flow file: $flow_file"
    log "To re-analyze later:"
    echo "  ./scripts/mitm-proxy/parse_flows.py --summary $flow_file"
    echo "  ./scripts/mitm-proxy/parse_flows.py --host api.example.com $flow_file"
  fi
}

main "$@"
