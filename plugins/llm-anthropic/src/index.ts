import { Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "@effect/platform";
import { definePlugin } from "@basis/core";
import { Credentials, Llm, LlmError } from "@basis/contracts";
import { PROVIDER_ID } from "./catalog.ts";
import { missingCredential } from "./errors.ts";
import { makeAnthropicProvider } from "./provider.ts";

export { catalog, DEFAULT_MODEL, factsFor, MODELS, PROVIDER_ID } from "./catalog.ts";
export type { ModelFacts } from "./catalog.ts";
export { fromErrorEvent, fromHttpClientError, fromStatus, missingCredential, parseErrorBody } from "./errors.ts";
export { API_VERSION, DEFAULT_BASE_URL, makeAnthropicProvider } from "./provider.ts";
export type { ProviderOptions } from "./provider.ts";
export { DEFAULT_MAX_TOKENS, HAIKU_THINKING_BUDGET, modelName, toWireMessages, toWireRequest } from "./request.ts";
export type { WireBlock, WireMessage, WireRequest } from "./request.ts";
export { parseSse, toStreamEvents } from "./sse.ts";
export type { SseEvent } from "./sse.ts";

/** The whole config may be omitted; `baseUrl` points at a proxy or gateway that speaks the Messages API. */
export const AnthropicConfig = Schema.UndefinedOr(Schema.Struct({ baseUrl: Schema.optional(Schema.String) }));

export default definePlugin({
  id: "llm-anthropic",
  version: "0.1.0",
  config: AnthropicConfig,
  requires: [Llm, Credentials],
  layer: (config) => Layer.scopedDiscard(Effect.gen(function* () {
    const llm = yield* Llm;
    const credentials = yield* Credentials;
    const client = yield* HttpClient.HttpClient;
    const credential = credentials.resolve(PROVIDER_ID).pipe(
      Effect.mapError((error) => new LlmError({
        provider: PROVIDER_ID, reason: "Auth", retryable: false, cause: error,
        message: `Could not resolve credentials for "${PROVIDER_ID}": ${error.message}`,
      })),
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(missingCredential()), onSome: Effect.succeed })),
    );
    yield* llm.registerProvider(makeAnthropicProvider({
      ...(config?.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      client,
      credential,
    }));
  })).pipe(Layer.provide(FetchHttpClient.layer)),
});
