# codex-chat-bridge

[English](README.md) | **简体中文**

让 **OpenAI Codex CLI** 可以接上**任何** OpenAI 兼容的 `/v1/chat/completions` 后端 —— Ollama、vLLM、llama.cpp、LM Studio、LiteLLM、one-api，或者你自己搭的网关。

```
Codex CLI  --(Responses API)-->  codex-chat-bridge  --(Chat Completions API)-->  你的后端
```

零依赖。Node ≥ 18。单文件。

---

## 要解决什么问题

新版 `codex-cli` **移除了** `wire_api = "chat"`。Codex 现在只会说 OpenAI 的 **Responses** 协议（`POST /v1/responses`，SSE 事件流）：

```
$ codex
Error loading config.toml: `wire_api = "chat"` is no longer supported.
How to fix: set `wire_api = "responses"`
```

但绝大多数自建 / 第三方后端仍然只实现 **Chat Completions**（`POST /v1/chat/completions`），对 `/v1/responses` 直接返回 `404`。

这个桥接器做双向翻译：请求体、流式响应、工具调用、推理内容（reasoning）、token 用量统计。

## 快速开始

```bash
git clone https://github.com/kangjiazhen/codex-chat-bridge.git
cd codex-chat-bridge

# 指向你的后端
node bin/codex-chat-bridge.mjs --upstream http://127.0.0.1:11434/v1 --port 7864
```

或者用环境变量：

```bash
CCB_UPSTREAM=http://127.0.0.1:8080/v1 \
CCB_API_KEY=sk-... \
node bin/codex-chat-bridge.mjs
```

然后在 `~/.codex/config.toml` 里加上：

```toml
model = "your-model-name"
model_provider = "bridge"

[model_providers.bridge]
name = "bridge"
base_url = "http://127.0.0.1:7864/v1"
wire_api = "responses"
experimental_bearer_token = "anything"
```

重启 Codex，就能用了。

> `experimental_bearer_token` 是 Codex 配置 schema 强制要求的字段，随便填。
> 如果后端需要真 key，把它写在桥的 `CCB_API_KEY` 里 —— 桥会以
> `Authorization: Bearer …` 发给上游。

## 已验证可用

| 能力 | 状态 |
|---|---|
| 支持 `/v1/chat/completions` + SSE 的 OpenAI 兼容网关 | ✅ |
| 工具调用（多轮 `tool_calls` ↔ `function_call` 配对） | ✅ |
| 流式推理（`reasoning_content` → `reasoning_summary_text.delta`） | ✅ |
| `apply_patch` 这类 freeform `custom` 工具 | ✅ |
| Codex 的 `namespace` 工具组（`multi_agent_v1`） | ✅ 摊平处理 |
| `response.completed` 里的 token 用量 | ✅ |
| 非流式（`stream: false`）请求 | ✅ |

理论上任何实现了 Chat Completions + SSE 流式的后端都能用。如果不行，请带上后端名字提 issue。

## 工作原理

**请求方向**（`Responses` → `Chat`）：

| Responses | Chat Completions |
|---|---|
| `instructions` | `system` 消息 |
| `input[]` 里的 `message` 项 | `messages[]` |
| `function_call` 项 | `assistant.tool_calls[]` |
| `function_call_output` 项 | `role: "tool"` 消息（按 `call_id` 配对） |
| `tools[]` 扁平 `{type, name, parameters}` | 嵌套 `{type, function: {...}}` |
| `custom` 工具（freeform） | 包装成单 `input: string` 参数 |
| `namespace` 工具组 | 摊平成 `group__tool` |
| `tool_choice` 扁平 | 嵌套 |
| `max_output_tokens` | `max_tokens` |

**响应方向**（`Chat` SSE → `Responses` SSE），按 Codex 解析器期望的顺序发事件：

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
  └─ response.output_item.added          (function_call，每个调用一个)
     response.function_call_arguments.delta × N
     response.output_item.done
response.completed                        (带 usage)
```

## 配置

### 命令行参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--port <n>` | `7864` | 监听端口 |
| `--host <addr>` | `127.0.0.1` | 监听地址 |
| `--upstream <url>` | `http://127.0.0.1:8080` | 后端基础 URL；缺少 `/v1` 会自动补上 |
| `--help` / `-h` | | 显示帮助 |
| `--version` / `-v` | | 显示版本 |

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CCB_UPSTREAM` | `http://127.0.0.1:8080` | 后端基础 URL |
| `CCB_API_KEY` | `$OPENAI_API_KEY` | 发给后端的 Bearer token |
| `CCB_HOST` / `CCB_PORT` | `127.0.0.1` / `7864` | 监听地址 |
| `CCB_MODEL_ALLOWLIST` | *（空 = 全部放行）* | 逗号分隔的白名单，其余模型直接返回 `400` |
| `CCB_MODEL_MAP` | *（空）* | 模型重写，如 `codex=gpt-5.3-codex,fast=haiku` |
| `CCB_CONVERSATION_ID` | *（空 = 关闭）* | 设为 `auto` 时，用 Codex 的 `prompt_cache_key` 生成会话级 `metadata.conversation_id`；也可填固定值 |
| `CCB_INCLUDE_USAGE` | `1` | 设为 `0` 则不发送 `stream_options.include_usage` |
| `CCB_CAPTURE` | *（空）* | 指定目录，把每个入站请求体存成 `req-001.json` |
| `CCB_TIMEOUT_MS` | `600000` | 上游请求超时 |

`CCB_CONVERSATION_ID=auto` 是给那些**强制要求会话关联 ID** 的网关用的。
用 Codex 的 `prompt_cache_key` 能保证同一会话内 ID 稳定，顺带让上游的
prompt cache 按真实会话粒度生效。

## 调试

抓出 Codex 到底发了什么：

```bash
CCB_CAPTURE=./capture node bin/codex-chat-bridge.mjs --upstream ...
# 然后看 ./capture/req-001.json
```

桥会为每个请求打一行日志，包含模型名、消息数、工具数、是否流式；上游报错时会把错误体截取前 400 字符打出来。

## 已知限制

- **托管工具会被丢弃。** `local_shell`、`web_search`、`file_search` 在 Chat Completions 里没有对应物。Codex 本来就用自己本地的 shell，所以这只影响服务端工具。
- **推理内容是单向的。** 后端的 `reasoning_content` 会作为 summary 转给 Codex；Codex 历史里的 reasoning 项不会再回传给上游。
- **没有 `/v1/responses/{id}` 检索接口。** 只实现了 `POST /v1/responses`，Codex 的 `store: true` 续跑流程不支持。
- **图片**会以 `image_url` 形式透传，但没有针对每个后端逐一验证。

## 相关项目

- [LiteLLM](https://github.com/BerriAI/litellm) —— 功能齐全的代理，自带 Responses API 支持；想要开箱即用的路由器就用它。
- [one-api](https://github.com/songquanpeng/one-api) / [new-api](https://github.com/Calcium-Ion/new-api) —— 暴露 Chat Completions 的多供应商网关。

本项目刻意做得很小、只干一件事：只做这一层协议翻译，别的不碰。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
