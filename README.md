# codex-chat-bridge

**English** | [简体中文](README.zh-CN.md)

Run **OpenAI Codex CLI** against **any** OpenAI-compatible `/v1/chat/completions` backend — Ollama, vLLM, llama.cpp, LM Studio, LiteLLM, one-api, or your own gateway.

```
Codex CLI  --(Responses API)-->  codex-chat-bridge  --(Chat Completions API)-->  your backend
```

Zero dependencies. Node ≥ 18. One file.

Explicitly tested against **WorkBuddy2API** reverse-proxy gateways — see the
[WorkBuddy2API section](#workbuddy2api-reverse-proxy--codex) below.

---

## The problem

Recent `codex-cli` releases **removed** `wire_api = "chat"`. Codex now speaks only the OpenAI **Responses** API (`POST /v1/responses`, SSE event stream):

```
$ codex
Error loading config.toml: `wire_api = "chat"` is no longer supported.
How to fix: set `wire_api = "responses"`
```

Meanwhile most self-hosted and third-party backends still implement only **Chat Completions** (`POST /v1/chat/completions`), and return `404` for `/v1/responses`.

This bridge translates both directions: the request body, the streaming response, tool calls, reasoning tokens, and usage accounting.

## Quick start

```bash
git clone https://github.com/kangjiazhen/codex-chat-bridge.git
cd codex-chat-bridge

# point it at your backend
node bin/codex-chat-bridge.mjs --upstream http://127.0.0.1:11434/v1 --port 7864
```

Or via env vars:

```bash
CCB_UPSTREAM=http://127.0.0.1:8080/v1 \
CCB_API_KEY=sk-... \
node bin/codex-chat-bridge.mjs
```

Then in `~/.codex/config.toml`:

```toml
model = "your-model-name"
model_provider = "bridge"

[model_providers.bridge]
name = "bridge"
base_url = "http://127.0.0.1:7864/v1"
wire_api = "responses"
experimental_bearer_token = "anything"
```

Restart Codex, and it works.

> The `experimental_bearer_token` is required by Codex's config schema. If your
> backend needs a real key, put it in `CCB_API_KEY` on the bridge instead — the
> bridge sends it upstream as `Authorization: Bearer …`.

## Verified working

| Backend | Status |
|---|---|
| OpenAI-compatible gateways with `/v1/chat/completions` + SSE | ✅ |
| **WorkBuddy2API reverse proxy** | ✅ see [below](#workbuddy2api-reverse-proxy--codex) |
| Tool calling (multi-turn `tool_calls` ↔ `function_call` pairing) | ✅ |
| Streaming reasoning (`reasoning_content` → `reasoning_summary_text.delta`) | ✅ |
| `apply_patch`-style freeform `custom` tools | ✅ |
| Codex `namespace` tool groups (`multi_agent_v1`) | ✅ flattened |
| Token usage in `response.completed` | ✅ |
| Non-streaming (`stream: false`) requests | ✅ |

Anything that implements the Chat Completions API with SSE streaming should work. If it does not, please open an issue with the backend name.

## WorkBuddy2API reverse proxy → Codex

WorkBuddy2API turns a pool of
WorkBuddy/CodeBuddy accounts into an OpenAI-compatible endpoint. It implements
**only** `/v1/chat/completions` — `/v1/responses` returns `404`, so Codex cannot
talk to it directly. This bridge is the missing piece, and it is the setup this
project was originally built for.

```
Codex CLI  --(Responses)-->  codex-chat-bridge :7864  --(Chat)-->  WorkBuddy2API :7863  -->  account pool
```

### Setup

1. Start the WorkBuddy2API gateway (it listens on `:7863` by default, panel at
   `/panel/`). Verify it is healthy:

   ```bash
   curl http://127.0.0.1:7863/healthz
   # {"healthy":8,"realm_servable":{"cn":true,"global":true},...}
   ```

2. Start the bridge, pointing at the gateway's `/v1` and reusing its API key:

   ```bash
   CCB_UPSTREAM=http://127.0.0.1:7863/v1 \
   CCB_API_KEY=<the api_key from the gateway's config.json> \
   CCB_CONVERSATION_ID=auto \
   node bin/codex-chat-bridge.mjs --port 7864
   ```

3. Point Codex at the bridge in `~/.codex/config.toml`:

   ```toml
   model = "global:gpt-5.3-codex"
   model_provider = "wb"

   [model_providers.wb]
   name = "workbuddy"
   base_url = "http://127.0.0.1:7864/v1"
   wire_api = "responses"
   experimental_bearer_token = "<same api_key>"
   request_max_retries = 2
   stream_max_retries = 2
   ```

### Two settings that matter for WorkBuddy2API

**`CCB_CONVERSATION_ID=auto` is not optional here.** The upstream (the
international/`global` realm in particular) validates `X-Conversation-ID`,
`X-Conversation-Request-ID` and `X-Conversation-Message-ID`. When any of them is
missing it replies `HTTP 400 {"code":"11-128","msg":"request illegal"}`, and the
gateway classifies that as an **account-level fault and disables the account** —
so a handful of requests without a conversation id can take down the whole pool.
`auto` derives the id from Codex's `prompt_cache_key`, which is stable per
session, so the id is present from the very first request and prompt caching
also lines up per conversation.

**Set `CCB_MODEL_ALLOWLIST` to the models your account tier can actually use.**
Some model ids are gated by account type and return
`{"code":11158,"msg":"model [...] is not allowed for user type [...]"}`. The
gateway treats that as an account fault too, so one blocked model can disable
every account in the pool. The allowlist makes the bridge reject the request
locally with `400 model_not_allowed` instead of forwarding it. Model availability
is a property of your WorkBuddy account tier, not of the bridge.

```bash
CCB_MODEL_ALLOWLIST=global:gpt-5.3-codex,global:glm-5.3,global:deepseek-v4.1-flash \
node bin/codex-chat-bridge.mjs --port 7864
```

Check `/status` on the gateway if requests suddenly start returning `503` with
`no_healthy_account`; a pool can be re-enabled from the panel at `/panel/`.

### Model metadata in Codex

Codex prints `Model metadata not found` for model ids it does not ship a catalog
entry for, and such ids show up in the picker without context-window info. To
silence that, add entries to `~/.codex/models.json` — copy an existing entry and
override `slug`, `display_name`, `context_window`, `max_context_window`, and
`priority`, keeping its `model_messages` / `base_instructions` blocks intact.

## How it works

**Request direction** (`Responses` → `Chat`):

| Responses | Chat Completions |
|---|---|
| `instructions` | `system` message |
| `input[]` of `message` items | `messages[]` |
| `function_call` item | `assistant.tool_calls[]` |
| `function_call_output` item | `role: "tool"` message (paired by `call_id`) |
| `tools[]` flat `{type, name, parameters}` | nested `{type, function: {...}}` |
| `custom` tool (freeform) | wrapped as one `input: string` parameter |
| `namespace` tool group | flattened to `group__tool` |
| `tool_choice` flat | nested |
| `max_output_tokens` | `max_tokens` |

**Response direction** (`Chat` SSE → `Responses` SSE), emitting the event order Codex's parser expects:

```
response.created
response.in_progress
  ├─ response.output_item.added          (reasoning)
  │  response.reasoning_summary_part.added
  │  response.reasoning_summary_text.delta × N
  │  response.reasoning_summary_text.done
  │  response.output_item.done
  ├─ response.output_item.added          (message)
  │  response.content_part.added
  │  response.output_text.delta × N
  │  response.output_text.done
  │  response.output_item.done
  └─ response.output_item.added          (function_call, one per call)
     response.function_call_arguments.delta × N
     response.output_item.done
response.completed                        (with usage)
```

## Configuration

### CLI flags

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | `7864` | Listen port |
| `--host <addr>` | `127.0.0.1` | Listen address |
| `--upstream <url>` | `http://127.0.0.1:8080` | Backend base URL; `/v1` is appended if absent |
| `--help` / `-h` | | Show help |
| `--version` / `-v` | | Show version |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `CCB_UPSTREAM` | `http://127.0.0.1:8080` | Backend base URL |
| `CCB_API_KEY` | `$OPENAI_API_KEY` | Bearer token sent to the backend |
| `CCB_HOST` / `CCB_PORT` | `127.0.0.1` / `7864` | Listen address |
| `CCB_MODEL_ALLOWLIST` | *(empty = allow all)* | Comma-separated allowlist; anything else gets a `400` |
| `CCB_MODEL_MAP` | *(empty)* | Rewrite models, e.g. `codex=gpt-5.3-codex,fast=haiku` |
| `CCB_CONVERSATION_ID` | *(empty = off)* | `auto` to send a per-session `metadata.conversation_id` derived from Codex's `prompt_cache_key`; or a literal id |
| `CCB_INCLUDE_USAGE` | `1` | Set `0` to omit `stream_options.include_usage` |
| `CCB_CAPTURE` | *(empty)* | Directory to dump every inbound request body (`req-001.json`, …) |
| `CCB_TIMEOUT_MS` | `600000` | Upstream request timeout |

`CCB_CONVERSATION_ID=auto` is for gateways that require a per-conversation
correlation header. Using Codex's `prompt_cache_key` keeps it stable across a
session, which also makes upstream prompt caching work per session.

## Debugging

Dump exactly what Codex sends:

```bash
CCB_CAPTURE=./capture node bin/codex-chat-bridge.mjs --upstream ...
# then inspect ./capture/req-001.json
```

The bridge logs one line per request with model, message count, tool count, and stream mode, plus any upstream error body (truncated to 400 chars).

## Limitations

- **Hosted tools are dropped.** `local_shell`, `web_search`, `file_search` have no Chat Completions equivalent; Codex runs its own shell anyway, so this only matters for server-side tools.
- **Reasoning is one-way.** `reasoning_content` from the backend is forwarded to Codex as a summary; reasoning items from Codex history are not sent back upstream.
- **No `/v1/responses/{id}` retrieval.** Only `POST /v1/responses` is implemented; Codex's `store: true` resume flow is not.
- **Images** are passed through as `image_url` parts but not verified against every backend.

## Related projects

- [LiteLLM](https://github.com/BerriAI/litellm) — full-featured proxy with its own Responses API support; use it if you want a batteries-included router.
- [one-api](https://github.com/songquanpeng/one-api) / [new-api](https://github.com/Calcium-Ion/new-api) — multi-provider gateways exposing Chat Completions.

This bridge is deliberately tiny and single-purpose: it does one translation and nothing else.

## License

MIT — see [LICENSE](LICENSE).
