# codex-chat-bridge

[English](README.md) | **简体中文**

让 **OpenAI Codex CLI** 可以接上**任何** OpenAI 兼容的 `/v1/chat/completions` 后端 —— Ollama、vLLM、llama.cpp、LM Studio、LiteLLM、one-api，或者你自己搭的网关。

```
Codex CLI  --(Responses API)-->  codex-chat-bridge  --(Chat Completions API)-->  你的后端
```

零依赖。Node ≥ 18。单文件。

已明确测试支持 **WorkBuddy2API** 反代网关 —— 见下方
[WorkBuddy2API 反代接入 Codex](#workbuddy2api-反代--codex) 一节。

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
| **WorkBuddy2API 反代网关** | ✅ 见[下方](#workbuddy2api-反代--codex) |
| 工具调用（多轮 `tool_calls` ↔ `function_call` 配对） | ✅ |
| 流式推理（`reasoning_content` → `reasoning_summary_text.delta`） | ✅ |
| `apply_patch` 这类 freeform `custom` 工具 | ✅ |
| Codex 的 `namespace` 工具组（`multi_agent_v1`） | ✅ 摊平处理 |
| `response.completed` 里的 token 用量 | ✅ |
| 非流式（`stream: false`）请求 | ✅ |

理论上任何实现了 Chat Completions + SSE 流式的后端都能用。如果不行，请带上后端名字提 issue。

## WorkBuddy2API 反代 → Codex

WorkBuddy2API 把一个 WorkBuddy/CodeBuddy
账号池包装成 OpenAI 兼容接口。它**只**实现了 `/v1/chat/completions`，`/v1/responses`
直接返回 `404`，所以 Codex 没法直连。这个桥接器就是补上这一环的，而且本项目最初
就是为了这个场景写的。

```
Codex CLI  --(Responses)-->  codex-chat-bridge :7864  --(Chat)-->  WorkBuddy2API :7863  -->  账号池
```

### 接入步骤

1. 先启动 WorkBuddy2API 网关（默认监听 `:7863`，面板在 `/panel/`）。确认它健康：

   ```bash
   curl http://127.0.0.1:7863/healthz
   # {"healthy":8,"realm_servable":{"cn":true,"global":true},...}
   ```

2. 启动桥接器，指向网关的 `/v1`，并复用网关的 API key：

   ```bash
   CCB_UPSTREAM=http://127.0.0.1:7863/v1 \
   CCB_API_KEY=<网关 config.json 里的 api_key> \
   CCB_CONVERSATION_ID=auto \
   node bin/codex-chat-bridge.mjs --port 7864
   ```

3. 在 `~/.codex/config.toml` 里让 Codex 指向桥接器：

   ```toml
   model = "global:gpt-5.3-codex"
   model_provider = "wb"

   [model_providers.wb]
   name = "workbuddy"
   base_url = "http://127.0.0.1:7864/v1"
   wire_api = "responses"
   experimental_bearer_token = "<同一个 api_key>"
   request_max_retries = 2
   stream_max_retries = 2
   ```

### 两个必须注意的设置

**`CCB_CONVERSATION_ID=auto` 在这个场景下不是可选项。** 上游（尤其是国际版
`global` 域）会校验 `X-Conversation-ID`、`X-Conversation-Request-ID`、
`X-Conversation-Message-ID` 三个头，缺任意一个就返回
`HTTP 400 {"code":"11-128","msg":"request illegal"}`，而网关把 11-128 归类成
**账号级故障，直接把账号禁用** —— 所以少量没带 conversation id 的请求就能把
整个账号池打挂。`auto` 会从 Codex 的 `prompt_cache_key` 派生这个 id，会话内
稳定不变，因此第一个请求起就带上了，顺带让上游 prompt cache 按会话粒度对齐。

**把 `CCB_MODEL_ALLOWLIST` 设成你账号档位真正能用的模型。** 有些模型 id 受账号
类型限制，会返回 `{"code":11158,"msg":"model [...] is not allowed for user type [...]"}`。
网关同样把它当账号故障处理，所以一个不可用的模型就可能把池里所有账号全禁用。
设了白名单之后，桥接器会在本地直接返回 `400 model_not_allowed`，不再往上转发。
**模型可用性是 WorkBuddy 账号档位的属性，不是桥接器的问题。**

```bash
CCB_MODEL_ALLOWLIST=global:gpt-5.3-codex,global:glm-5.3,global:deepseek-v4.1-flash \
node bin/codex-chat-bridge.mjs --port 7864
```

如果请求突然开始返回 `503` 且带 `no_healthy_account`，去网关的 `/status` 看一眼
账号池状态；被禁用的账号可以在 `/panel/` 面板里重新启用。

### Codex 侧的模型元数据

对于 Codex 自带目录里没有的模型 id，它会打印 `Model metadata not found`，并且在
选择器里不显示上下文窗口信息。要消掉这个警告，往 `~/.codex/models.json` 里加条目
即可 —— 复制一条已有条目，覆盖 `slug`、`display_name`、`context_window`、
`max_context_window`、`priority`，保留它的 `model_messages` / `base_instructions`
块不要动。

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
