# LLM providers

The `filebox-llm` crate (`crates/llm`) provides a protocol-neutral Rust client
for Chat Completions, Responses, and Anthropic Messages. It supports tool
calling across multiple rounds, reasoning/thinking, JSON responses, and model
listing. The Hub uses it for mandatory AI Agents prompt review; the crate can
also be used by other Rust consumers.

## Configure a named provider

Add providers to `llm_providers` in `hub.json`, then refer to one from
`prompt_review`. The API key can be read from an environment variable (shown
below) or stored inline in the private configuration file.

```json
{
  "llm_providers": {
    "deepseek": {
      "protocol": "chat_completions",
      "base_url": "https://api.deepseek.com",
      "model": "deepseek-flash",
      "api_key_env": "DEEPSEEK_API_KEY",
      "timeout_secs": 20
    }
  },
  "prompt_review": {"provider": "deepseek"}
}
```

Provider names must begin with an ASCII letter or digit and contain only
letters, digits, `_`, or `-` (up to 64 characters). A provider reference may
override `model` and `timeout_secs`; prompt review timeouts are capped at 60
seconds. The legacy inline `prompt_review` provider configuration remains
supported.

### Chat Completions

```json
{
  "llm_providers": {
    "deepseek": {
      "protocol": "chat_completions",
      "base_url": "https://api.deepseek.com",
      "model": "deepseek-flash",
      "api_key_env": "DEEPSEEK_API_KEY"
    }
  },
  "prompt_review": {"provider": "deepseek"}
}
```

### Responses

```json
{
  "llm_providers": {
    "deepseek-responses": {
      "protocol": "responses",
      "base_url": "https://api.deepseek.com",
      "model": "deepseek-flash",
      "api_key_env": "DEEPSEEK_API_KEY"
    }
  },
  "prompt_review": {"provider": "deepseek-responses"}
}
```

### Anthropic Messages

For the official Anthropic API, use the Messages endpoint path explicitly:

```json
{
  "llm_providers": {
    "anthropic": {
      "protocol": "messages",
      "base_url": "https://api.anthropic.com",
      "path": "/v1/messages",
      "model": "claude-sonnet-4-20250514",
      "api_key_env": "ANTHROPIC_API_KEY"
    }
  },
  "prompt_review": {"provider": "anthropic"}
}
```

The default Messages path is `/anthropic/v1/messages`, used by DeepSeek's
Anthropic-compatible endpoint. `path` must begin with `/` and cannot contain
a query, fragment, `..`, or whitespace.

## `hub --init-llm` walkthrough

Run `hub --init-llm` after creating a Hub configuration with
`hub --init-config`. The wizard edits the existing config, preserving other
fields. Use `--output <path>` to select a different existing Hub config.

1. Select a preset (DeepSeek Chat Completions, DeepSeek Responses, DeepSeek
   Anthropic Messages, OpenAI Chat Completions, Anthropic Messages, or Custom).
2. Confirm the base URL, optional endpoint path, and provider name.
3. Choose an environment-variable API key (recommended) or an inline key.
   With environment storage, if the variable is not set, the wizard asks for a
   key to run its probes; that testing key is not saved.
4. Choose a model returned by the provider or enter one manually.
5. The wizard probes chat, JSON output, and a thinking-enabled tool call. If a
   probe fails, you can choose whether to save anyway.
6. Choose whether the provider should be used for AI Agents prompt review.
   Saving writes the configuration privately (`0600` on Unix); restart the Hub
   to apply it.

The wizard does not turn off prompt review. In mandatory mode, the Hub fails
closed when review is not configured or the provider is unavailable. The only
opt-out is the startup environment variable
`FILEBOX_HUB_PROMPT_REVIEW_ENABLED=0` (or `false`).

## DeepSeek behavior and requirements

- When sending Chat Completions history that includes tools, the client echoes
  `reasoning_content` on every assistant message, including an empty string
  when reasoning is absent. This preserves DeepSeek's required thinking/tool
  history. Without tools, it strips `reasoning_content`.
- DeepSeek strict function calling requires the `/beta` base URL. Set
  `base_url` accordingly when using strict tools; the client rejects mixing
  strict and non-strict tools in one request.
- DeepSeek JSON mode requires the word `json` in at least one system or user
  message. The client validates this before sending. Messages protocol treats
  JSON mode as prompt-only; Chat Completions and Responses use their JSON
  response-format fields.

## Provider configuration fields

| Field | Description |
|---|---|
| `protocol` | `chat_completions`, `responses`, or `messages` |
| `base_url` | HTTP(S) provider base URL; HTTPS is required except for loopback hosts |
| `path` | Optional endpoint path override |
| `model` | Model identifier |
| `api_key_env` | Environment variable containing the API key |
| `api_key` | Optional key stored directly in the private config; omitted when serializing provider structs |
| `timeout_secs` | Request timeout, clamped to 1–300 seconds (60 seconds maximum for Hub prompt review) |

The client disables redirects and bounds response bodies (1 MiB by default;
Hub prompt review uses 64 KiB). See the
[Herdr compatibility and prompt review guide](herdr-compatibility.md) for
review-specific behavior.
