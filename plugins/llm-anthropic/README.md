# @basis/plugin-llm-anthropic

Registers the `anthropic` provider with `Llm`. Talks to the Messages API directly over `@effect/platform`'s `HttpClient` (`FetchHttpClient`); no SDK. Requires `Llm` and `Credentials`.

## Use

```ts
import llm from "@basis/plugin-llm";
import anthropic from "@basis/plugin-llm-anthropic";
// makeCore([llm, credentials, anthropic], { configs: { "llm-anthropic": { baseUrl: "https://gateway.example" } } })
```

Model ids are `anthropic/<model>`; the default is `anthropic/claude-opus-5`. Bundled: `claude-opus-5`, `claude-fable-5-1`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-4-5` (1M context and 128K output, except Haiku at 200K/64K). Prices come from the `llm` plugin's models.dev catalog when it knows the id. An id outside the table is sent as-is with the adaptive defaults.

Config (optional): `{ baseUrl?: string }` for a proxy or gateway; requests go to `<baseUrl>/v1/messages`.

Credentials: `Credentials.resolve("anthropic")` per request, so a login takes effect without a restart. An `api-key` credential is sent as `x-api-key`; an `oauth` credential as a bearer token with the `oauth-2025-04-20` beta. Missing credentials fail `Auth` with instructions to log in or set `ANTHROPIC_API_KEY`. This plugin registers no `AuthMethod`; key entry is expected to be the credentials plugin's generic flow.

## Request shape

- Every request streams. `max_tokens` defaults to 64000 (bounded by the model's output cap); set `LlmRequest.maxTokens` to change it.
- Thinking: `thinking: { type: "adaptive" }` plus `output_config.effort` (default `high`) for every model except Haiku 4.5, which only understands a fixed budget: `{ type: "enabled", budget_tokens: 4096 }` when `effort` is set, nothing otherwise. `budget_tokens` on a current model is a 400.
- `temperature` is dropped for models that reject sampling parameters (Opus 5 / 4.8 / 4.7, Fable 5.1, Sonnet 5).
- Tools are sent with `eager_input_streaming: true`, so the API does not validate the streamed JSON; the tools plugin validates input. A tool input that is not valid JSON fails the stream rather than producing a half-parsed call.
- `cache_control: { type: "ephemeral" }` goes on the system block and on the last block of the last user message.
- Tool results are `tool_result` blocks inside the user message. Assistant thinking parts are replayed from `ThinkingPart.state` verbatim (it holds the whole block, signature included); a thinking part without state is dropped, as is an empty text part or a message left with no content.

## Stream mapping

| API | `StreamEvent` |
| --- | --- |
| `text_delta` | `text-delta` |
| `thinking_delta` | `thinking-delta` (`signature_delta` is accumulated into the part's `state`) |
| `input_json_delta` | `tool-call-delta`; `tool-call` with the parsed input when the block stops |
| `message_delta` | `usage` (input, output, cache read, cache write) |
| `message_stop` | `finish` with the assembled message; `end_turn` → `stop`, `max_tokens` → `length`, `tool_use` → `tool-calls`, `refusal` → `refusal` |
| `error` | the stream fails with the mapped `LlmError` |

A stream that ends without `message_stop` fails `Network` (retryable) instead of ending silently.

## Errors

401/403 → `Auth`; 429 and 529 → `RateLimit` (retryable); 400 → `InvalidRequest`, or `ContextTooLong` when the message says the prompt is too long; 413 → `ContextTooLong`; other 5xx and transport failures → `Network` (retryable). The API's own message is kept.

## Scripts

`scripts/smoke.ts` streams one real request when `ANTHROPIC_API_KEY` is set; it is not part of the tests.
