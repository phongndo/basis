# @basis/plugin-llm-openai-compatible

Registers an `LlmProvider` for every configured endpoint that speaks the OpenAI Chat Completions API: Groq, Together, DeepSeek, Mistral, OpenRouter, Ollama, LM Studio, vLLM, and so on. Requires `Llm` and `Credentials`.

## Config

```jsonc
{
  "plugins": {
    "llm-openai-compatible": {
      "config": {
        "providers": [
          {
            "id": "groq",                                  // registry id and credential name
            "name": "Groq",                                // optional display name
            "baseUrl": "https://api.groq.com/openai/v1",   // up to the version segment
            "models": [
              { "id": "llama-3.3-70b-versatile", "contextWindow": 131072, "maxOutput": 32768 }
            ]
          },
          {
            "id": "ollama",
            "baseUrl": "http://localhost:11434/v1",
            "models": [{ "id": "qwen3", "contextWindow": 32768, "reasoning": true }]
          }
        ]
      }
    }
  }
}
```

Model fields: `id`, `contextWindow` (required); `name`, `maxOutput`, `toolCall` (default true), `reasoning` (default false). Models are registered as `<provider id>/<model id>`; the prefix is stripped before the request is sent.

## Credentials

The API key is `Credentials.resolve(<provider id>)`, so by convention `<ID>_API_KEY` in the environment (`GROQ_API_KEY`) or an entry in `auth.json`. `api-key` and `oauth` credentials are sent as a bearer token. A provider whose `baseUrl` points at the local machine (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`) may run without a credential; any other provider fails with `LlmError` reason `Auth` before a request is made.

## Wire mapping

- `POST <baseUrl>/chat/completions` with `stream: true` and `stream_options: { include_usage: true }`.
- `system` becomes a `system` message. Images are `image_url` parts (base64 as a data URL). Assistant tool calls become `tool_calls`; each tool result becomes a `tool` message, and images inside a tool result follow as a `user` message because the `tool` role only carries text. Thinking parts are not echoed: servers disagree on the field name and many reject unknown ones.
- Tools are `{ type: "function", function: { name, description, parameters } }`.
- `content` deltas → `text-delta`; `reasoning_content` or `reasoning` deltas → `thinking-delta`; `tool_calls` deltas accumulate by `index` and are emitted as `tool-call-delta` immediately and as complete `tool-call` events when the choice reports a finish reason (or when the body ends, whichever comes first); `usage` → `usage` (`prompt_tokens_details.cached_tokens` as `cacheRead`); finish reasons map `stop`, `length`, `tool_calls`/`function_call` → `tool-calls`, `content_filter` → `refusal`.
- Tool call arguments that are not valid JSON are passed through as the raw string so the tools plugin can reject them and the model can retry.

## Errors

| Condition | `reason` | `retryable` |
| --- | --- | --- |
| 401, 403 | `Auth` | no |
| 429 | `RateLimit` | yes |
| 4xx with `context_length_exceeded` or a context-length message | `ContextTooLong` | no |
| other 4xx | `InvalidRequest` | no |
| 408, 5xx, transport failure, body cut off before finishing | `Network` | yes |
| `{ "error": ... }` inside the stream | by its `code`/`type`, else `Unknown` | as above |

## Testing

The HTTP client is `FetchHttpClient`, which reads `FetchHttpClient.Fetch` from the calling fiber's context. Tests provide a recording `fetch` there and answer with fixture bodies under `tests/fixtures`, so the plugin is exercised end to end through a core without a network.
