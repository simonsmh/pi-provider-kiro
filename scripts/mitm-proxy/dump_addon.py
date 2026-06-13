"""
mitmproxy addon: dump flows as structured JSON during capture or replay.

This addon is designed to be loaded by mitmdump directly (uses mitmproxy's
built-in Python — no external pip install needed).

Modes:
  - Live capture:  mitmdump -s dump_addon.py -w capture.flow
    → writes JSON to /tmp/mitm_dump.jsonl as flows complete

  - Replay:        mitmdump -r capture.flow -s dump_addon.py --no-server
    → reads a .flow file and prints JSON to stdout

Output format (one JSON object per flow, newline-delimited / JSONL):
  {
    "method": "POST",
    "url": "https://api.example.com/v1/endpoint",
    "host": "api.example.com",
    "path": "/v1/endpoint",
    "request_headers": {...},
    "request_body": "...",
    "response_status": 200,
    "response_headers": {...},
    "response_body": "..."
  }

Token/PII masking is handled by the separate parse_flows.py wrapper.
"""

import json
import os
import sys

from mitmproxy import http

# Configuration via env vars
DUMP_OUTPUT = os.environ.get("MITM_DUMP_OUTPUT", "")
DUMP_REPLAY_MODE = os.environ.get("MITM_DUMP_REPLAY", "") == "1"


def _headers_to_dict(headers) -> dict:
    """Convert mitmproxy headers to a plain dict."""
    if headers is None:
        return {}
    result = {}
    for k, v in headers.items():
        # Multi-value headers become lists
        if k in result:
            existing = result[k]
            if isinstance(existing, list):
                existing.append(v)
            else:
                result[k] = [existing, v]
        else:
            result[k] = v
    return result


def _decode_content(content) -> str:
    """Try to decode binary content as UTF-8, fall back to repr."""
    if content is None:
        return ""
    try:
        return content.decode("utf-8", errors="replace")
    except Exception:
        return repr(content)[:1000]


def flow_to_dict(flow) -> dict:
    """Convert a mitmproxy flow to a plain dict."""
    req = flow.request
    resp = flow.response

    req_body = _decode_content(req.content) if req.content else ""

    result = {
        "method": req.method,
        "url": f"{req.scheme}://{req.host}:{req.port}{req.path}",
        "host": req.host,
        "path": req.path,
        "request_headers": _headers_to_dict(req.headers),
        "request_body": req_body,
    }

    if resp:
        resp_body = _decode_content(resp.content) if resp.content else ""
        result["response_status"] = resp.status_code
        result["response_headers"] = _headers_to_dict(resp.headers)
        result["response_body"] = resp_body
    else:
        result["response_status"] = None
        result["response_headers"] = {}
        result["response_body"] = ""

    return result


class DumpAddon:
    """mitmproxy addon that dumps completed flows as JSON."""

    def response(self, flow: http.HTTPFlow) -> None:
        """Called when a response has been received."""
        data = flow_to_dict(flow)

        if DUMP_REPLAY_MODE:
            # In replay mode, print to stdout
            print(json.dumps(data, ensure_ascii=False))
            sys.stdout.flush()
        elif DUMP_OUTPUT:
            # In live mode, append to the output file
            with open(DUMP_OUTPUT, "a") as f:
                f.write(json.dumps(data, ensure_ascii=False) + "\n")

    # Also handle flows that error out (no response)
    def error(self, flow: http.HTTPFlow) -> None:
        """Called when a flow errors."""
        data = flow_to_dict(flow)

        if DUMP_REPLAY_MODE:
            print(json.dumps(data, ensure_ascii=False))
            sys.stdout.flush()
        elif DUMP_OUTPUT:
            with open(DUMP_OUTPUT, "a") as f:
                f.write(json.dumps(data, ensure_ascii=False) + "\n")


addons = [DumpAddon()]
