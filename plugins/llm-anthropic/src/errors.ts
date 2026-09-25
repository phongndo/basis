import { LlmError } from "@basis/contracts";
import type { HttpClientError } from "@effect/platform";
import { PROVIDER_ID } from "./catalog.ts";

type Reason = LlmError["reason"];

const make = (reason: Reason, message: string, retryable: boolean, cause?: unknown) =>
  new LlmError({ provider: PROVIDER_ID, reason, message, retryable, ...(cause === undefined ? {} : { cause }) });

/** The `{ type: "error", error: { type, message } }` envelope the API uses in bodies and SSE `error` events. */
export function parseErrorBody(body: string): { readonly type?: string; readonly message: string } {
  try {
    const parsed = JSON.parse(body) as { error?: { type?: string; message?: string } };
    if (typeof parsed?.error?.message === "string") return { ...(parsed.error.type === undefined ? {} : { type: parsed.error.type }), message: parsed.error.message };
  } catch { /* not JSON; fall through */ }
  return { message: body.trim().slice(0, 500) || "(empty response body)" };
}

const contextTooLong = (message: string) => /prompt is too long/i.test(message);

/** Maps a non-2xx response to an `LlmError`, keeping the API's own message. */
export function fromStatus(status: number, body: string): LlmError {
  const error = parseErrorBody(body);
  const message = `Anthropic API ${status}${error.type === undefined ? "" : ` ${error.type}`}: ${error.message}`;
  if (status === 401 || status === 403) return make("Auth", message, false);
  if (status === 429 || status === 529) return make("RateLimit", message, true);
  if (status === 413) return make("ContextTooLong", message, false);
  if (status === 400) return make(contextTooLong(error.message) ? "ContextTooLong" : "InvalidRequest", message, false);
  if (status >= 500) return make("Network", message, true);
  if (status === 404) return make("InvalidRequest", message, false);
  return make("Unknown", message, false);
}

/** Maps a mid-stream `error` event by its type; the connection is already open, so status codes do not apply. */
export function fromErrorEvent(error: { readonly type?: string; readonly message: string }): LlmError {
  const message = `Anthropic stream error${error.type === undefined ? "" : ` ${error.type}`}: ${error.message}`;
  switch (error.type) {
    case "authentication_error": case "permission_error": return make("Auth", message, false);
    case "rate_limit_error": case "overloaded_error": return make("RateLimit", message, true);
    case "invalid_request_error": return make(contextTooLong(error.message) ? "ContextTooLong" : "InvalidRequest", message, false);
    case "request_too_large": return make("ContextTooLong", message, false);
    case "api_error": return make("Network", message, true);
    default: return make("Unknown", message, false);
  }
}

/** Transport failures and body-read failures; the request never got a usable answer. */
export function fromHttpClientError(error: HttpClientError.HttpClientError): LlmError {
  const detail = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return make("Network", `Anthropic request failed: ${error.message}${detail}`, true, error);
}

export function missingCredential(): LlmError {
  return make("Auth", `No credentials for "${PROVIDER_ID}". Run login for the anthropic provider or set ANTHROPIC_API_KEY.`, false);
}
