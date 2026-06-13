#!/usr/bin/env python3
"""
mitm-proxy flow parser — reads a .flow file and prints request/response details.

No mitmproxy Python bindings required — this shells out to mitmdump (which has
its own embedded Python) to convert the binary .flow format to JSONL, then
parses the JSONL for display.

Usage:
  # Full dump (URL, method, status, headers, body)
  ./scripts/mitm-proxy/parse_flows.py /tmp/mitm_capture.flow

  # Summary only (one line per request)
  ./scripts/mitm-proxy/parse_flows.py --summary /tmp/mitm_capture.flow

  # JSON output for programmatic consumption
  ./scripts/mitm-proxy/parse_flows.py --json /tmp/mitm_capture.flow

  # Filter by host
  ./scripts/mitm-proxy/parse_flows.py --host openapi.qoder.sh /tmp/mitm_capture.flow

  # Filter by request method
  ./scripts/mitm-proxy/parse_flows.py --method POST /tmp/mitm_capture.flow

  # Mask sensitive tokens (default: on, use --no-mask to see raw values)
  ./scripts/mitm-proxy/parse_flows.py --no-mask /tmp/mitm_capture.flow

  # Parse a JSONL file directly (if already converted)
  ./scripts/mitm-proxy/parse_flows.py --jsonl /tmp/dump.jsonl
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

# ── Paths ───────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).resolve().parent
DUMP_ADDON = SCRIPT_DIR / "dump_addon.py"

# ── Token / PII masking ─────────────────────────────────────────────────────

# Patterns for known API key/token formats
TOKEN_PATTERNS = [
    (re.compile(r"ksk_[A-Za-z0-9_-]{20,}"), "ksk_***"),
    (re.compile(r"pt-[A-Za-z0-9_-]{20,}"), "pt-***"),
    (re.compile(r"jt-[A-Za-z0-9_-]{20,}"), "jt-***"),
    (re.compile(r"sk-[A-Za-z0-9_-]{20,}"), "sk-***"),
    (re.compile(r"AKIA[A-Z0-9]{16}"), "AKIA***"),
    (re.compile(r"(?i)aws_secret_access_key[\"' ]*[:=][\"' ]*[A-Za-z0-9/+=]{30,}"), "aws_secret_access_key=***"),
    (re.compile(r"(?i)eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"), "eyJ***.eyJ***.eyJ***"),  # JWT
]

PII_PATTERNS = [
    (re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"), "***@***.***"),
    (re.compile(r"\b\d{12}\b"), "000000000000"),
]

SENSITIVE_HEADERS = {
    "authorization", "x-api-key", "cookie", "set-cookie",
    "x-amz-security-token",
}

_SENSITIVE_JSON_KEYS = {
    "accesstoken", "access_token", "refreshtoken", "refresh_token",
    "personaltoken", "personal_token", "jobtoken", "job_token",
    "apikey", "api_key", "secret", "password", "credential",
    "authorization", "token", "bearer", "clientsecret", "client_secret",
    "email", "userid", "user_id", "username", "user_name",
    "profilearn", "profile_arn",
}


def mask_value(value: str) -> str:
    for pattern, replacement in TOKEN_PATTERNS:
        value = pattern.sub(replacement, value)
    for pattern, replacement in PII_PATTERNS:
        value = pattern.sub(replacement, value)
    return value


def mask_headers(headers: dict) -> dict:
    masked = {}
    for key, values in headers.items():
        if key.lower() in SENSITIVE_HEADERS:
            if isinstance(values, list):
                masked[key] = [f"{v[:12]}..." if len(str(v)) > 12 else "***" for v in values]
            else:
                v = str(values)
                masked[key] = f"{v[:12]}..." if len(v) > 12 else "***"
        else:
            masked[key] = values
    return masked


def mask_body(body: str, content_type: str = "") -> str:
    if not body:
        return body
    stripped = body.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            data = json.loads(stripped)
            masked_data = _mask_json_recursive(data)
            return json.dumps(masked_data, indent=2, ensure_ascii=False)
        except (json.JSONDecodeError, TypeError):
            pass
    return mask_value(body)


def _mask_json_recursive(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {
            k: _mask_json_recursive(v) if k.lower().replace("-", "_") not in _SENSITIVE_JSON_KEYS
            else _mask_sensitive_value(v)
            for k, v in obj.items()
        }
    elif isinstance(obj, list):
        return [_mask_json_recursive(item) for item in obj]
    elif isinstance(obj, str):
        return mask_value(obj)
    return obj


def _mask_sensitive_value(value: Any) -> str:
    if isinstance(value, str):
        if len(value) > 12:
            return f"{value[:6]}...{value[-4:]}"
        return "***"
    return "***"


# ── Flow conversion (.flow → JSONL) ─────────────────────────────────────────

def flow_to_jsonl(flow_path: str) -> list[dict]:
    """Convert a .flow file to parsed JSON using mitmdump + dump_addon.py."""
    if not os.path.isfile(flow_path):
        print(f"ERROR: Flow file not found: {flow_path}", file=sys.stderr)
        sys.exit(1)

    if not os.path.isfile(DUMP_ADDON):
        print(f"ERROR: dump_addon.py not found at {DUMP_ADDON}", file=sys.stderr)
        sys.exit(1)

    env = os.environ.copy()
    env["MITM_DUMP_REPLAY"] = "1"

    try:
        result = subprocess.run(
            [
                "mitmdump",
                "-r", flow_path,
                "-s", str(DUMP_ADDON),
                "--no-server",
            ],
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )
    except FileNotFoundError:
        print(
            "ERROR: mitmdump not found. Install mitmproxy:\n"
            "  brew install --cask mitmproxy",
            file=sys.stderr,
        )
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print("ERROR: mitmdump timed out during replay", file=sys.stderr)
        sys.exit(1)

    # mitmdump may print warnings to stdout; extract only JSON lines
    flows = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                flows.append(json.loads(line))
            except json.JSONDecodeError:
                pass  # skip non-JSON output (mitmproxy log messages)

    if not flows and result.stderr:
        # Try to extract useful error info
        err_lines = result.stderr.strip().splitlines()
        last_line = err_lines[-1] if err_lines else result.stderr.strip()
        print(f"WARNING: mitmdump produced no JSON flows. stderr: {last_line[:200]}", file=sys.stderr)

    return flows


def jsonl_to_flows(jsonl_path: str) -> list[dict]:
    """Read a JSONL file directly."""
    flows = []
    with open(jsonl_path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    flows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return flows


# ── Output formatters ───────────────────────────────────────────────────────

def print_summary(flows: list[dict]) -> None:
    if not flows:
        print("No flows captured.")
        return

    print(f"\n{'─' * 90}")
    print(f"{'#':<4} {'METHOD':<7} {'STATUS':<7} {'HOST':<30} {'PATH'}")
    print(f"{'─' * 90}")

    for i, f in enumerate(flows, 1):
        status = str(f.get("response_status") or "---")
        path = f.get("path", "")
        if len(path) > 45:
            path = path[:42] + "..."

        if sys.stdout.isatty():
            reset = "\033[0m"
            if f.get("response_status") and f["response_status"] < 300:
                color = "\033[0;32m"
            elif f.get("response_status") and f["response_status"] < 500:
                color = "\033[0;33m"
            else:
                color = "\033[0;31m"
            print(f"{i:<4} {f['method']:<7} {color}{status:<7}{reset} {f.get('host', ''):<30} {path}")
        else:
            print(f"{i:<4} {f['method']:<7} {status:<7} {f.get('host', ''):<30} {path}")

    print(f"{'─' * 90}")
    print(f"Total: {len(flows)} request(s)\n")


def print_full(flows: list[dict]) -> None:
    if not flows:
        print("No flows captured.")
        return

    for i, f in enumerate(flows, 1):
        print(f"\n{'═' * 80}")
        print(f"  REQUEST #{i}")
        print(f"{'═' * 80}")
        print(f"  {f['method']} {f['url']}")
        print(f"  Host: {f['host']}")
        print(f"\n  Request Headers:")
        for k, v in f.get("request_headers", {}).items():
            if isinstance(v, list):
                print(f"    {k}: {', '.join(str(x) for x in v)}")
            else:
                print(f"    {k}: {v}")

        if f.get("request_body"):
            print(f"\n  Request Body:")
            for line in f["request_body"].splitlines():
                print(f"    {line}")

        if f.get("response_status"):
            print(f"\n  Response: {f['response_status']}")
            print(f"  Response Headers:")
            for k, v in f.get("response_headers", {}).items():
                if isinstance(v, list):
                    print(f"    {k}: {', '.join(str(x) for x in v)}")
                else:
                    print(f"    {k}: {v}")

            if f.get("response_body"):
                print(f"\n  Response Body:")
                body = f["response_body"]
                if len(body) > 5000:
                    body = body[:5000] + "\n    ... [truncated]"
                for line in body.splitlines():
                    print(f"    {line}")

    print(f"\n{'═' * 80}")
    print(f"  Total: {len(flows)} request(s)")
    print(f"{'═' * 80}\n")


def print_json(flows: list[dict]) -> None:
    print(json.dumps(flows, indent=2, ensure_ascii=False))


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Parse mitmproxy .flow files and print request/response details.",
    )
    parser.add_argument(
        "flow_file",
        help="Path to .flow file (or .jsonl if --jsonl is used)",
    )
    parser.add_argument(
        "--summary", "-s",
        action="store_true",
        help="Print summary only (one line per request)",
    )
    parser.add_argument(
        "--json", "-j",
        action="store_true",
        help="Output as JSON",
    )
    parser.add_argument(
        "--jsonl",
        action="store_true",
        help="Input is already a JSONL file (skip mitmdump conversion)",
    )
    parser.add_argument(
        "--no-mask",
        action="store_true",
        help="Disable token/PII masking (show raw values)",
    )
    parser.add_argument(
        "--host",
        help="Filter flows by hostname",
    )
    parser.add_argument(
        "--method", "-m",
        help="Filter flows by HTTP method",
    )

    args = parser.parse_args()

    # Load flows
    if args.jsonl:
        flows = jsonl_to_flows(args.flow_file)
    else:
        flows = flow_to_jsonl(args.flow_file)

    # Apply filters
    if args.host:
        flows = [f for f in flows if args.host in f.get("host", "")]
    if args.method:
        flows = [f for f in flows if f.get("method", "").upper() == args.method.upper()]

    # Apply masking
    if not args.no_mask:
        for f in flows:
            f["request_headers"] = mask_headers(f.get("request_headers", {}))
            f["response_headers"] = mask_headers(f.get("response_headers", {}))
            ct = f.get("request_headers", {}).get("content-type", "")
            if isinstance(ct, list):
                ct = ct[0] if ct else ""
            f["request_body"] = mask_body(f.get("request_body", ""), str(ct))
            resp_ct = f.get("response_headers", {}).get("content-type", "")
            if isinstance(resp_ct, list):
                resp_ct = resp_ct[0] if resp_ct else ""
            f["response_body"] = mask_body(f.get("response_body", ""), str(resp_ct))

    # Output
    if args.json:
        print_json(flows)
    elif args.summary:
        print_summary(flows)
    else:
        print_full(flows)


if __name__ == "__main__":
    main()
