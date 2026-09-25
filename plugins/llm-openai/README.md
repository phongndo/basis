# @basis/plugin-llm-openai

Registers the `openai` provider on the OpenAI Responses API. Requires `Llm` and `Credentials`.

## Use

No config is needed. Models are addressed as `openai/<model>`, e.g. `openai/gpt-5`. The API key is `Credentials.resolve("openai")`, so `OPENAI_API_KEY` in the environment or an `openai` entry in `auth.json`; without one, every request fails with `LlmError` reason `Auth` before anything is sent.

```jsonc
{
  "plugins": {
    "llm-openai": {
      "config": { "baseUrl": "https://gateway.example/openai/v1" }   // optional; default https://api.openai.com/v1
    }
  }
}
```

## Catalog

`catalog` (src/catalog.ts) is a static list of reasoning-capable Responses API models with context, output, and pricing taken from models.dev on 2026-09-25. Every entry is marked `toolCall` and `reasoning`. When the llm plugin gains a models.dev helper, live data should overlay these entries instead of being maintained by hand.

## Wire mapping

- `POST <baseUrl>/responses` with `stream: true`, `store: false`, and `include: ["reasoning.encrypted_content"]`, so reasoning survives across turns without server-side storage.
- `system` becomes `instructions`. Message parts become input items in order: user text and images are `message` items with `input_text`/`input_image`; assistant text is a `message` item with `output_text`; a `ThinkingPart` whose `state` carries `{ id, encrypted_content }` is replayed as a `reasoning` item (thinking without that state is dropped, since the server accepts nothing else); `ToolCallPart` is `function_call`; `ToolResultPart` is `function_call_output` with the text, images following as a user message.
- Tools are `{ type: "function", name, description, parameters, strict: false }`.
- `LlmRequest.effort` becomes `reasoning: { effort }`; `max` is sent as `high`. Absent effort leaves the server default.
- Events: `response.output_text.delta` → `text-delta`; `response.reasoning_summary_text.delta` → `thinking-delta`; `response.function_call_arguments.delta` → `tool-call-delta` (id is the `call_id`); `response.output_item.done` for a `function_call` → `tool-call`; `response.completed`/`response.incomplete` → `usage` (`input_tokens`, `output_tokens`, `input_tokens_details.cached_tokens` as `cacheRead`) then `finish`. The finish message keeps items in output order, and each reasoning item becomes a `ThinkingPart` with its summary text and the encrypted state to echo back.
- Finish reason: any function call → `tool-calls`; `incomplete_details.reason` `max_output_tokens` → `length`, `content_filter` or a refusal part → `refusal`; else `stop`.
- Tool call arguments that are not valid JSON are passed through as the raw string so the tools plugin can reject them and the model can retry.

## Errors

| Condition | `reason` | `retryable` |
| --- | --- | --- |
| 401, 403 | `Auth` | no |
| 429 | `RateLimit` | yes |
| 4xx with `context_length_exceeded` or a context-length message | `ContextTooLong` | no |
| other 4xx | `InvalidRequest` | no |
| 408, 5xx, transport failure, body cut off before `response.completed` | `Network` | yes |
| `error` event or `response.failed` | by its `code`, else `Unknown` | as above |

## Not included

ChatGPT/Codex subscription OAuth is future work; only API keys (and a stored `oauth` access token, sent as a bearer token) are supported.

## Testing

The HTTP client is `FetchHttpClient`, which reads `FetchHttpClient.Fetch` from the calling fiber's context. Tests provide a recording `fetch` there and answer with fixture bodies under `tests/fixtures`, so the plugin is exercised end to end through a core without a network.
