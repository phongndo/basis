import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "@effect/platform";
import { definePlugin } from "@basis/core";
import { Credentials, Llm } from "@basis/contracts";
import { catalog } from "./catalog.ts";
import { makeProvider } from "./provider.ts";

export const defaultBaseUrl = "https://api.openai.com/v1";

/** Config is optional; `baseUrl` points the provider at a gateway that speaks the Responses API. */
export const Config = Schema.UndefinedOr(Schema.Struct({
  baseUrl: Schema.optional(Schema.String),
}));

/**
 * Registers the `openai` provider on the Responses API. The HTTP client is
 * constructed privately; tests substitute `FetchHttpClient.Fetch`.
 */
export default definePlugin({
  id: "llm-openai",
  config: Config,
  requires: [Llm, Credentials],
  layer: (config) => Layer.scopedDiscard(Effect.gen(function* () {
    const llm = yield* Llm;
    const credentials = yield* Credentials;
    const http = yield* HttpClient.HttpClient;
    yield* llm.registerProvider(makeProvider({ http, credentials, baseUrl: config?.baseUrl ?? defaultBaseUrl, models: catalog }));
  })).pipe(Layer.provide(FetchHttpClient.layer)),
});

export { catalog } from "./catalog.ts";
export { makeProvider, providerId, toResponsesRequest } from "./provider.ts";
export type { ProviderDeps, ReasoningState } from "./provider.ts";
