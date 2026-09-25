import { Effect, Option, Stream } from "effect";
import { HttpClientRequest, HttpClientResponse } from "@effect/platform";
import type { HttpClient } from "@effect/platform";
import { LlmError } from "@basis/contracts";
import type { Credentials } from "@basis/contracts";

/** One server-sent event. `event` is absent for plain `data:` streams like Chat Completions. */
export interface ServerEvent {
  readonly event?: string;
  readonly data: string;
}

/**
 * Decodes an SSE body into events. Comment lines and unknown fields are
 * dropped; a message still open when the body ends is dispatched anyway so a
 * server that omits the final blank line is not silently truncated.
 */
export function serverEvents<E, R>(body: Stream.Stream<Uint8Array, E, R>): Stream.Stream<ServerEvent, E, R> {
  type Pending = { event: string | undefined; data: string[] };
  const empty = (): Pending => ({ event: undefined, data: [] });
  return body.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.concat(Stream.make("")),
    Stream.mapAccum(empty(), (pending: Pending, line: string): [Pending, Option.Option<ServerEvent>] => {
      if (line === "") {
        if (pending.data.length === 0) return [empty(), Option.none()];
        const data = pending.data.join("\n");
        return [empty(), Option.some(pending.event === undefined ? { data } : { event: pending.event, data })];
      }
      if (line.startsWith(":")) return [pending, Option.none()];
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") return [{ event: pending.event, data: [...pending.data, value] }, Option.none()];
      if (field === "event") return [{ event: value, data: pending.data }, Option.none()];
      return [pending, Option.none()];
    }),
    Stream.filterMap((event) => event),
  );
}

/** Error envelope shared by OpenAI-style APIs, in either `{ error: {...} }` or bare form. */
export interface ApiError {
  readonly message: string;
  readonly code?: string;
  readonly type?: string;
}

export function parseApiError(body: unknown): ApiError | undefined {
  const raw = typeof body === "string" ? tryJson(body) : body;
  if (typeof raw !== "object" || raw === null) return undefined;
  const error = "error" in raw && typeof raw.error === "object" && raw.error !== null ? raw.error : raw;
  if (!("message" in error) || typeof error.message !== "string") return undefined;
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  const type = "type" in error && typeof error.type === "string" ? error.type : undefined;
  return { message: error.message, ...(code === undefined ? {} : { code }), ...(type === undefined ? {} : { type }) };
}

function tryJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

const contextTooLong = /context[_ ]length|context window|maximum context|too many tokens|prompt is too long|exceeds the limit/i;

/** Maps an HTTP status and error body to the contract's reasons. Anything the server may recover from is retryable. */
export function statusError(provider: string, status: number, body: string): LlmError {
  const error = parseApiError(body);
  const message = error?.message ?? (body.trim() === "" ? `HTTP ${status}` : body.slice(0, 500));
  const detail = { provider, message, cause: error ?? body };
  if (status === 401 || status === 403) return new LlmError({ ...detail, reason: "Auth", retryable: false });
  if (status === 429) return new LlmError({ ...detail, reason: "RateLimit", retryable: true });
  if (status === 408 || status >= 500) return new LlmError({ ...detail, reason: "Network", retryable: true });
  if (status >= 400 && status < 500) {
    const tooLong = error?.code === "context_length_exceeded" || contextTooLong.test(message);
    return new LlmError({ ...detail, reason: tooLong ? "ContextTooLong" : "InvalidRequest", retryable: false });
  }
  return new LlmError({ ...detail, reason: "Unknown", retryable: false });
}

/** An error the server reports inside an otherwise successful stream. */
export function streamError(provider: string, error: ApiError): LlmError {
  const tooLong = error.code === "context_length_exceeded" || contextTooLong.test(error.message);
  const reason = tooLong ? "ContextTooLong" : error.code === "rate_limit_exceeded" ? "RateLimit" : error.type === "server_error" || error.code === "server_error" ? "Network" : "Unknown";
  return new LlmError({ provider, reason, message: error.message, retryable: reason === "RateLimit" || reason === "Network", cause: error });
}

export function transportError(provider: string, cause: unknown): LlmError {
  const inner = cause instanceof Error && cause.cause instanceof Error ? `: ${cause.cause.message}` : "";
  const message = cause instanceof Error ? `${cause.message}${inner}` : String(cause);
  return new LlmError({ provider, reason: "Network", message, retryable: true, cause });
}

/** Sends a streaming request and yields its body as server-sent events; non-2xx responses become `LlmError`s. */
export function streamRequest(
  provider: string,
  http: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
): Stream.Stream<ServerEvent, LlmError> {
  const response = http.execute(request).pipe(
    Effect.mapError((cause) => transportError(provider, cause)),
    Effect.flatMap((response) => response.status >= 200 && response.status < 300
      ? Effect.succeed(response)
      : response.text.pipe(
        Effect.mapError((cause) => transportError(provider, cause)),
        Effect.flatMap((body) => Effect.fail(statusError(provider, response.status, body))),
      )),
  );
  return HttpClientResponse.stream(response).pipe(
    Stream.mapError((cause) => cause instanceof LlmError ? cause : transportError(provider, cause)),
    serverEvents,
  );
}

/**
 * The bearer token for a provider, or none when the caller allows anonymous
 * access. Command credentials are expected to be resolved by the credentials
 * plugin before they reach here.
 */
export function resolveApiKey(
  credentials: typeof Credentials.Service,
  provider: string,
  options: { readonly optional: boolean },
): Effect.Effect<Option.Option<string>, LlmError> {
  return credentials.resolve(provider).pipe(
    Effect.mapError((cause) => new LlmError({ provider, reason: "Auth", message: cause.message, retryable: false, cause })),
    Effect.flatMap((credential) => {
      if (Option.isNone(credential)) {
        return options.optional
          ? Effect.succeed(Option.none())
          : Effect.fail(new LlmError({ provider, reason: "Auth", retryable: false, message: `No credential for "${provider}"; set ${envName(provider)} or log in` }));
      }
      switch (credential.value.type) {
        case "api-key": return Effect.succeed(Option.some(credential.value.key));
        case "oauth": return Effect.succeed(Option.some(credential.value.access));
        case "command": return Effect.fail(new LlmError({ provider, reason: "Auth", retryable: false, message: `Credential for "${provider}" is an unresolved command` }));
      }
    }),
  );
}

export function envName(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

/** Providers on the local machine (Ollama, LM Studio, vLLM) usually run without keys. */
export function isLocal(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "0.0.0.0" || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

export function jsonRequest(url: string, apiKey: Option.Option<string>, body: unknown): HttpClientRequest.HttpClientRequest {
  const request = HttpClientRequest.post(url).pipe(
    HttpClientRequest.setHeaders({ accept: "text/event-stream" }),
    HttpClientRequest.bodyUnsafeJson(body),
  );
  return Option.isSome(apiKey) ? HttpClientRequest.bearerToken(request, apiKey.value) : request;
}
