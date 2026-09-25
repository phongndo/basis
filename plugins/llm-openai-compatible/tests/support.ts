import { Effect, Layer, Option, Stream } from "effect";
import { FetchHttpClient } from "@effect/platform";
import { definePlugin } from "@basis/core";
import { Credentials, Llm, LlmError } from "@basis/contracts";
import type { Credential, LlmProvider, ModelInfo } from "@basis/contracts";

/** Records registered providers and routes by `<provider>/` prefix, as the real registry would. */
export function fakeLlm() {
  const providers: LlmProvider[] = [];
  const plugin = definePlugin({
    id: "llm",
    provides: [Llm],
    layer: Layer.succeed(Llm, {
      registerProvider: (provider) => Effect.acquireRelease(
        Effect.sync(() => { providers.push(provider); }),
        () => Effect.sync(() => { providers.splice(providers.indexOf(provider), 1); }),
      ),
      providers: Effect.sync(() => providers.map(({ id, name }) => ({ id, name }))),
      models: Effect.forEach(providers, (provider) => provider.models).pipe(Effect.map((all) => all.flat())),
      model: (id) => Effect.map(Effect.forEach(providers, (provider) => provider.models), (all) =>
        Option.fromNullable(all.flat().find((model: ModelInfo) => model.id === id))),
      stream: (request) => {
        const provider = providers.find((candidate) => request.model.startsWith(`${candidate.id}/`));
        return provider === undefined
          ? Stream.fail(new LlmError({ provider: "?", reason: "InvalidRequest", message: `No provider for ${request.model}`, retryable: false }))
          : provider.stream(request);
      },
    }),
  });
  return { plugin, providers };
}

export function fakeCredentials(store: Record<string, Credential>) {
  const unsupported = new Error("not used in these tests");
  return definePlugin({
    id: "credentials",
    provides: [Credentials],
    layer: Layer.succeed(Credentials, {
      resolve: (provider) => Effect.succeed(Option.fromNullable(store[provider])),
      set: () => Effect.die(unsupported),
      remove: () => Effect.die(unsupported),
      list: Effect.die(unsupported),
      registerMethod: () => Effect.void,
      methods: Effect.succeed([]),
      login: () => Effect.die(unsupported),
    }),
  });
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RecordedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** A `fetch` that answers every request with one recorded response and keeps what was sent. */
export function fakeFetch(response: { readonly status?: number; readonly body: string; readonly contentType?: string }) {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const raw = init?.body;
    const text = typeof raw === "string" ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : "null";
    requests.push({ url: String(input), headers, body: JSON.parse(text) });
    return new Response(response.body, {
      status: response.status ?? 200,
      headers: { "content-type": response.contentType ?? "text/event-stream" },
    });
  };
  return { requests, fetch };
}

export const withFetch = (fetch: FetchLike) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, FetchHttpClient.Fetch, fetch as typeof globalThis.fetch);

export const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();
