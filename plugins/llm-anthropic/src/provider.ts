import { Effect, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { LlmError } from "@basis/contracts";
import type { Credential, LlmProvider, LlmRequest, StreamEvent } from "@basis/contracts";
import { catalog, PROVIDER_ID } from "./catalog.ts";
import { fromHttpClientError, fromStatus } from "./errors.ts";
import { toWireRequest } from "./request.ts";
import { parseSse, toStreamEvents } from "./sse.ts";

export const DEFAULT_BASE_URL = "https://api.anthropic.com";
export const API_VERSION = "2023-06-01";

export interface ProviderOptions {
  readonly baseUrl?: string;
  readonly client: HttpClient.HttpClient;
  /** Resolved per request, so a login or key change takes effect without a restart. */
  readonly credential: Effect.Effect<Credential, LlmError>;
}

function authHeaders(credential: Credential): Effect.Effect<Record<string, string>, LlmError> {
  switch (credential.type) {
    case "api-key": return Effect.succeed({ "x-api-key": credential.key });
    case "oauth": return Effect.succeed({ authorization: `Bearer ${credential.access}`, "anthropic-beta": "oauth-2025-04-20" });
    case "command": return Effect.fail(new LlmError({
      provider: PROVIDER_ID, reason: "Auth", retryable: false,
      message: "Received an unresolved command credential; the credentials plugin must run it before handing it to a provider",
    }));
  }
}

/** The Messages API over `HttpClient`; always streams. The request lives in the stream's scope, so cancelling the stream aborts it. */
export function makeAnthropicProvider(options: ProviderOptions): LlmProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const client = HttpClient.withScope(options.client);
  const stream = (request: LlmRequest): Stream.Stream<StreamEvent, LlmError> => Stream.unwrapScoped(Effect.gen(function* () {
    const headers = yield* Effect.flatMap(options.credential, authHeaders);
    const http = HttpClientRequest.post(`${baseUrl}/v1/messages`).pipe(
      HttpClientRequest.setHeaders({ ...headers, "anthropic-version": API_VERSION, "content-type": "application/json", accept: "text/event-stream" }),
      HttpClientRequest.bodyUnsafeJson(toWireRequest(request)),
    );
    const response = yield* client.execute(http).pipe(Effect.mapError(fromHttpClientError));
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* Effect.fail(fromStatus(response.status, body));
    }
    return response.stream.pipe(Stream.mapError(fromHttpClientError), parseSse, toStreamEvents);
  }));
  return { id: PROVIDER_ID, name: "Anthropic", models: Effect.succeed(catalog), stream };
}
