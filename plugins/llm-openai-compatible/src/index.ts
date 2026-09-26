import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "@effect/platform";
import { definePlugin } from "@basis/core";
import { Credentials, Llm } from "@basis/contracts";
import { makeProvider } from "./provider.ts";

export const ModelConfig = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  contextWindow: Schema.Number,
  maxOutput: Schema.optional(Schema.Number),
  /** Default true. */
  toolCall: Schema.optional(Schema.Boolean),
  /** Default false. */
  reasoning: Schema.optional(Schema.Boolean),
});

export const ProviderConfig = Schema.Struct({
  /** Registry id and credential name; the API key is read from `<ID>_API_KEY` or the store. */
  id: Schema.String,
  name: Schema.optional(Schema.String),
  /** Up to and including the API version segment, e.g. `https://api.groq.com/openai/v1`. */
  baseUrl: Schema.String,
  models: Schema.Array(ModelConfig),
});

export const Config = Schema.Struct({ providers: Schema.Array(ProviderConfig) });

/**
 * Registers one Chat Completions provider per configured endpoint. The HTTP
 * client is constructed privately; tests substitute `FetchHttpClient.Fetch`.
 */
export default definePlugin({
  id: "llm-openai-compatible",
  config: Config,
  requires: [Llm, Credentials],
  layer: (config) => Layer.scopedDiscard(Effect.gen(function* () {
    const llm = yield* Llm;
    const credentials = yield* Credentials;
    const http = yield* HttpClient.HttpClient;
    for (const provider of config.providers) {
      yield* llm.registerProvider(makeProvider(provider, { http, credentials }));
    }
  })).pipe(Layer.provide(FetchHttpClient.layer)),
});

export { makeProvider, toChatRequest } from "./provider.ts";
export type { ProviderConfig as ProviderSettings, ProviderDeps } from "./provider.ts";
export { isLocal, resolveApiKey, serverEvents, statusError } from "./http.ts";
