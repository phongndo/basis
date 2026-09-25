# @basis/plugin-llm

Provides `Llm` from `@basis/contracts`: the provider registry, the model catalog, and the router every model call goes through. It knows no API; provider plugins (`llm-anthropic`, `llm-openai`, ...) require `Llm` and register an `LlmProvider`.

## Use

```ts
import llm from "@basis/plugin-llm";
import anthropic from "@basis/plugin-llm-anthropic";
// makeCore([llm, credentials, anthropic, ...])
```

- `Llm.stream(request)` routes by the `<provider>/` prefix of `request.model` and fails `LlmError` `InvalidRequest` when no provider has that id. The request passes through `LlmRequestHook`; the terminal is the provider's `stream`. Providers receive the full `<provider>/<model>` id.
- `Llm.models` concatenates every provider's catalog and caches the result for 60 seconds; registering or unregistering a provider invalidates it. If any provider's catalog fails, `models` fails with that provider's error rather than hiding it.
- `Llm.providers` lists ids and names; `Llm.model(id)` looks one entry up.
- `registerProvider` lasts until the registering scope closes. A duplicate or malformed id (empty, contains `/`) is a defect: it fails the registering plugin's activation, since two plugins claiming one id is a composition mistake, not a runtime condition.

No config.

## Hooks

`LlmRequestHook` wraps every call. A handler can edit the request (including `model`, which re-routes it), wrap the returned stream (logging, retry on `retryable` errors, caching), or short-circuit with its own stream. A failing handler fails the call. Hook-machinery errors (`HookError`, `CoreClosed`) surface as `LlmError` `Unknown` so callers see one error type.

## Model catalog

`catalogFor(providerId)` returns bundled `ModelInfo` entries from `src/models.generated.ts`, produced by `scripts/generate-models.ts` from [models.dev](https://models.dev) for the providers basis ships (`anthropic`, `openai`, `openrouter`; `ollama` is an empty placeholder). Provider plugins own the truth about ids and limits and use this for names and prices. Refresh with:

```sh
nix develop -c bun run --cwd plugins/llm generate-models
```
