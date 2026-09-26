import { Duration, Effect, Option, Stream } from "effect";
import type { Context } from "effect";
import { Hooks, PluginContext } from "@basis/core";
import { LlmError, LlmRequestHook } from "@basis/contracts";
import type { Llm, LlmProvider, LlmRequest, StreamEvent } from "@basis/contracts";

/** How long a concatenated catalog is reused before providers are asked again. */
export const CATALOG_TTL = Duration.seconds(60);

/** The provider id a `<provider>/<model>` id names; empty when there is no prefix. */
export function providerOf(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash === -1 ? "" : modelId.slice(0, slash);
}

/**
 * The registry and router. Providers register for the lifetime of their scope;
 * every request passes through `LlmRequestHook` and the terminal routes by the
 * model's provider prefix, so a handler may also redirect a request to another
 * provider by rewriting `model`.
 */
export const makeLlm: Effect.Effect<Context.Tag.Service<Llm>, never, Hooks | PluginContext> = Effect.gen(function* () {
  const hooks = yield* Hooks;
  const owner = yield* PluginContext;
  // Effect fibers interleave only at yield points, so plain Map mutation inside Effect.sync is race-free.
  const providers = new Map<string, LlmProvider>();

  const [catalog, invalidate] = yield* Effect.cachedInvalidateWithTTL(
    Effect.suspend(() => Effect.forEach([...providers.values()], (provider) => provider.models)).pipe(
      Effect.map((lists) => lists.flat()),
    ),
    CATALOG_TTL,
  );

  const route = (request: LlmRequest): Effect.Effect<Stream.Stream<StreamEvent, LlmError>, LlmError> =>
    Effect.suspend(() => {
      const id = providerOf(request.model);
      const provider = providers.get(id);
      return provider === undefined
        ? Effect.fail(new LlmError({
          provider: id, reason: "InvalidRequest", retryable: false,
          message: `No provider "${id}" for model "${request.model}"; use "<provider>/<model>" with one of: ${[...providers.keys()].join(", ") || "(none registered)"}`,
        }))
        : Effect.succeed(provider.stream(request));
    });

  return {
    registerProvider: (provider) => Effect.acquireRelease(
      Effect.suspend(() => {
        // A duplicate or malformed id is a composition mistake, so it fails the registering plugin's activation.
        if (provider.id === "" || provider.id.includes("/")) return Effect.dieMessage(`LLM provider id "${provider.id}" must be non-empty and contain no "/"`);
        if (providers.has(provider.id)) return Effect.dieMessage(`LLM provider "${provider.id}" is already registered`);
        providers.set(provider.id, provider);
        return invalidate;
      }),
      () => Effect.sync(() => { providers.delete(provider.id); }).pipe(Effect.zipRight(invalidate)),
    ),
    providers: Effect.sync(() => [...providers.values()].map(({ id, name }) => ({ id, name }))),
    models: catalog,
    model: (id) => Effect.map(catalog, (models) => Option.fromNullable(models.find((model) => model.id === id))),
    stream: (request) => Stream.unwrap(
      owner.trace("llm.stream", hooks.invoke(LlmRequestHook, request, route)).pipe(
        Effect.mapError((error) => error._tag === "LlmError" ? error : new LlmError({
          provider: providerOf(request.model), reason: "Unknown", message: error.message, retryable: false, cause: error,
        })),
      ),
    ),
  } satisfies Context.Tag.Service<Llm>;
});
