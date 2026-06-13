# mitm-proxy — CLI HTTPS Traffic Capture Toolkit

Reusable toolkit for reverse-engineering CLI tool API protocols via mitmproxy.
Works with any CLI tool (Node.js, Go, Python, Rust) — no pip install needed.

## Quick Start

```bash
# 1. Install mitmproxy (macOS)
brew install --cask mitmproxy

# 2. Generate CA cert (first run only, then Ctrl+C)
mitmdump --version

# 3. Capture kiro-cli traffic
KIRO_API_KEY="ksk_..." ./scripts/mitm-proxy/capture.sh \
  kiro-cli chat --no-interactive "hello"

# 4. Analyze captured flows
./scripts/mitm-proxy/parse_flows.py --summary /tmp/mitm_capture.flow
```

## Architecture

```
┌──────────┐    HTTPS (MITM'd)    ┌──────────────┐    real HTTPS    ┌──────────┐
│ CLI tool │ ────────────────────→│   mitmdump    │ ────────────────→│ API      │
│ (any)    │ ←────────────────────│   :8080       │ ←────────────────│ server   │
└──────────┘                      └──────┬───────┘                 └──────────┘
                                         │
                                  -w capture.flow  (binary format)
                                  -s dump_addon.py (live JSONL, optional)
                                         │
                                         ▼
                              parse_flows.py  ───→  human-readable output
                                   │                (summary / full / JSON)
                                   │
                          mitmdump -r capture.flow
                            -s dump_addon.py
                            --no-server
                            (converts binary → JSONL)
```

**No pip install needed.** `parse_flows.py` shells out to `mitmdump` (which has its own embedded Python 3.14) to convert the binary `.flow` format to JSON via `dump_addon.py`. The only dependency is `mitmproxy` itself (`brew install --cask mitmproxy`).

## Scripts

### `capture.sh` — One-shot capture

Starts mitmdump, runs your CLI tool with proxy env vars, stops mitmdump, prints the flow file location.

```bash
# Kiro CLI (KIRO_API_KEY)
KIRO_API_KEY="ksk_..." ./scripts/mitm-proxy/capture.sh \
  kiro-cli chat --no-interactive "讲个笑话"

# Qoder CLI (QODER_PERSONAL_ACCESS_TOKEN)
QODER_PERSONAL_ACCESS_TOKEN="pt-..." ./scripts/mitm-proxy/capture.sh \
  qodercli -p "hi"

# Generic — pass any env vars, any command
MY_TOKEN="xxx" ANOTHER_VAR="yyy" ./scripts/mitm-proxy/capture.sh \
  some-cli-tool arg1 arg2

# With live JSONL output
LIVE_JSONL=1 KIRO_API_KEY="..." ./scripts/mitm-proxy/capture.sh kiro-cli ...

# Keep flow file for later analysis
KEEP_FLOW=1 ./scripts/mitm-proxy/capture.sh ...
```

**Env vars:**
| Var | Default | Purpose |
|-----|---------|---------|
| `PROXY_PORT` | `8080` | mitmdump listen port |
| `FLOW_FILE` | `/tmp/mitm_capture.flow` | Binary flow output |
| `JSONL_FILE` | `/tmp/mitm_capture.jsonl` | Live JSONL output (when `LIVE_JSONL=1`) |
| `LIVE_JSONL` | `0` | Set to `1` for live JSONL alongside binary |
| `MITM_CA_CERT` | `~/.mitmproxy/mitmproxy-ca-cert.pem` | CA cert path |
| `KEEP_FLOW` | `0` | Set to `1` to keep the flow file after exit |
| `VERBOSE` | `0` | Set to `1` to see masked token values |

**What the script sets automatically:**
- `HTTPS_PROXY` / `HTTP_PROXY` → mitmdump
- `NODE_EXTRA_CA_CERTS` → Node.js tools trust the MITM CA
- `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` → Python/curl tools trust the MITM CA
- `no_proxy` → excludes the proxy itself

### `parse_flows.py` — Flow analysis

Reads a `.flow` file and prints request/response details with automatic token/PII masking.

```bash
# Summary (one line per request)
./scripts/mitm-proxy/parse_flows.py --summary /tmp/mitm_capture.flow

# Full dump (URL, headers, body)
./scripts/mitm-proxy/parse_flows.py /tmp/mitm_capture.flow

# JSON output (for jq, scripts)
./scripts/mitm-proxy/parse_flows.py --json /tmp/mitm_capture.flow | jq .

# Filter by host
./scripts/mitm-proxy/parse_flows.py --host openapi.qoder.sh /tmp/mitm_capture.flow

# Filter by HTTP method
./scripts/mitm-proxy/parse_flows.py --method POST /tmp/mitm_capture.flow

# Show raw values (DANGER: tokens in plain text — pipe responsibly)
./scripts/mitm-proxy/parse_flows.py --no-mask /tmp/mitm_capture.flow

# Parse a JSONL file directly
./scripts/mitm-proxy/parse_flows.py --jsonl --summary /tmp/dump.jsonl
```

**Automatic masking (on by default):**
| Pattern | Replacement |
|---------|-------------|
| `ksk_...` (KIRO API key) | `ksk_***` |
| `pt-...` (Qoder personal token) | `pt-***` |
| `jt-...` (Qoder job token) | `jt-***` |
| `sk-...` (generic API key) | `sk-***` |
| `AKIA...` (AWS access key) | `AKIA***` |
| `eyJ...` (JWT tokens) | `eyJ***.eyJ***.eyJ***` |
| `Bearer ...` (Authorization) | `Bearer eyJ...***` |
| email addresses | `***@***.***` |
| JSON keys: `access_token`, `refresh_token`, `api_key`, `secret`, `email`, etc. | `***` |

### `analyze.sh` — All-in-one capture + analyze

```bash
# Capture + analyze in one shot
KIRO_API_KEY="ksk_..." ./scripts/mitm-proxy/analyze.sh \
  kiro-cli chat --no-interactive "hello"

# Replay existing flow (auto-detects .flow vs .jsonl)
./scripts/mitm-proxy/analyze.sh --replay /tmp/mitm_capture.flow

# Replay with filters
./scripts/mitm-proxy/analyze.sh --replay /tmp/mitm_capture.flow \
  --host runtime.us-east-1.kiro.dev --method POST
```

### `dump_addon.py` — mitmproxy addon

This is the engine that converts mitmproxy flows to JSON. It's loaded by mitmdump's embedded Python — you don't call it directly.

Two modes controlled by env vars:
- **Replay mode** (`MITM_DUMP_REPLAY=1`): reads a `.flow` file and prints JSON to stdout
- **Live mode** (`MITM_DUMP_OUTPUT=/path/file.jsonl`): appends JSON to a file as flows complete

## Protocol Discovery Patterns

When reverse-engineering a new CLI tool, look for:

1. **Token exchange**: Does the CLI exchange an API key for a session token?
   (e.g., `POST /api/v1/jobToken/exchange` with `{"personal_token":"pt-..."}`)

2. **Identity resolution**: After auth, does it call `/userinfo` or similar?
   This reveals the real user ID needed for subsequent authenticated calls.

3. **Custom signing**: Are requests signed with a custom scheme?
   Headers like `Cosy-Signature`, `Cosy-Timestamp` indicate custom request signing.

4. **Streaming protocol**: Chat requests typically use SSE or chunked transfer.
   Look for `data: {...}\n\n` or JSON lines in response bodies.

## Real-World Example: Qoder CLI

Before this toolkit, manual mitmproxy analysis of qodercli revealed:
1. PAT (`pt-...`) was **not** a direct access token
2. `POST /api/v1/jobToken/exchange` with `{"personal_token":"pt-..."}` → `jt-...` (24h TTL)
3. `GET /userinfo` with `Bearer jt-...` → real user ID
4. Chat calls used `Bearer COSY...` with `Cosy-User: <real_user_id>`
5. The old implementation skipped steps 1-3 and used `pt-` directly → auth errors

## KIRO API KEY Support

KIRO API keys use the format `ksk_...`. The toolkit automatically detects and masks them.

```bash
# The KIRO_API_KEY env var is passed through to the target command:
KIRO_API_KEY="ksk_0fgOnFOD0YhtxrdsDg3qzcP2WyyVs60Z" \
  ./scripts/mitm-proxy/capture.sh \
  kiro-cli chat --no-interactive "讲个笑话"
```

After capture, use `parse_flows.py` to discover:
- How `kiro-cli` exchanges `KIRO_API_KEY` for AWS credentials (if at all)
- Which endpoints it hits for auth vs. inference
- The streaming protocol used for chat responses
- Any custom headers or signing it performs

## Tips

- **Certificate pinning**: Some CLI tools pin their TLS cert. mitmproxy cannot
  intercept these without binary patching.

- **Non-Node.js CLIs**: Go/Rust tools may not need `NODE_EXTRA_CA_CERTS`.
  The capture script also sets `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE`.

- **WebSocket inspection**: mitmproxy captures WebSocket frames in the flow.
  `dump_addon.py` currently only handles HTTP request/response bodies.
  For WebSocket traffic, use mitmproxy's interactive UI.

- **Large response bodies**: `--set stream_large_bodies=10m` sets a 10MB
  threshold before bodies are streamed rather than buffered.

- **Replay for deeper analysis**: Save the `.flow` file (`KEEP_FLOW=1`), then
  reopen in mitmproxy's interactive UI for step-through debugging:
  ```bash
  mitmproxy -r /tmp/mitm_capture.flow
  ```
