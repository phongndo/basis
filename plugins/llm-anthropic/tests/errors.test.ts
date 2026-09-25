import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { HttpClient, HttpClientError } from "@effect/platform";
import { LlmRequest, Message } from "@basis/contracts";
import { fromErrorEvent, fromStatus, makeAnthropicProvider, missingCredential } from "../src/index.ts";
import { fakeClient, llmFailure } from "./support.ts";

const apiError = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } });

describe("error mapping", () => {
  test("status codes map to reasons and keep the API message", () => {
    expect(fromStatus(401, apiError("authentication_error", "invalid x-api-key"))).toMatchObject({ reason: "Auth", retryable: false, message: expect.stringContaining("invalid x-api-key") });
    expect(fromStatus(403, apiError("permission_error", "no access"))).toMatchObject({ reason: "Auth", retryable: false });
    expect(fromStatus(429, apiError("rate_limit_error", "slow down"))).toMatchObject({ reason: "RateLimit", retryable: true });
    expect(fromStatus(529, apiError("overloaded_error", "Overloaded"))).toMatchObject({ reason: "RateLimit", retryable: true, message: expect.stringContaining("Overloaded") });
    expect(fromStatus(400, apiError("invalid_request_error", "max_tokens: must be positive"))).toMatchObject({ reason: "InvalidRequest", retryable: false });
    expect(fromStatus(400, apiError("invalid_request_error", "prompt is too long: 1200000 tokens > 1000000 maximum"))).toMatchObject({ reason: "ContextTooLong", retryable: false });
    expect(fromStatus(404, apiError("not_found_error", "model: nope"))).toMatchObject({ reason: "InvalidRequest" });
    expect(fromStatus(500, apiError("api_error", "boom"))).toMatchObject({ reason: "Network", retryable: true });
    expect(fromStatus(502, "<html>bad gateway</html>")).toMatchObject({ reason: "Network", retryable: true, message: expect.stringContaining("bad gateway") });
    expect(fromStatus(418, "")).toMatchObject({ reason: "Unknown" });
    expect(fromStatus(401, apiError("x", "y")).provider).toBe("anthropic");
  });

  test("stream error events map by type", () => {
    expect(fromErrorEvent({ type: "overloaded_error", message: "Overloaded" })).toMatchObject({ reason: "RateLimit", retryable: true });
    expect(fromErrorEvent({ type: "api_error", message: "internal" })).toMatchObject({ reason: "Network", retryable: true });
    expect(fromErrorEvent({ type: "authentication_error", message: "bad key" })).toMatchObject({ reason: "Auth" });
    expect(fromErrorEvent({ type: "invalid_request_error", message: "prompt is too long" })).toMatchObject({ reason: "ContextTooLong" });
    expect(fromErrorEvent({ message: "??" })).toMatchObject({ reason: "Unknown" });
  });

  test("the missing-credential error tells the user what to do", () => {
    const error = missingCredential();
    expect(error.reason).toBe("Auth");
    expect(error.message).toContain("login");
    expect(error.message).toContain("ANTHROPIC_API_KEY");
  });

  test("the provider maps non-2xx responses and transport failures", async () => {
    const request = new LlmRequest({ model: "anthropic/claude-opus-5", messages: [new Message({ role: "user", parts: [{ type: "text", text: "hi" }] })] });
    const rateLimited = fakeClient(() => new Response(apiError("rate_limit_error", "Too many requests"), { status: 429 }));
    const provider = makeAnthropicProvider({ client: rateLimited.client, credential: Effect.succeed({ type: "api-key", key: "k" }) });
    const error = llmFailure(await Effect.runPromiseExit(Stream.runDrain(provider.stream(request))));
    expect(error).toMatchObject({ reason: "RateLimit", retryable: true, message: expect.stringContaining("Too many requests") });

    const offline = HttpClient.make((http) => Effect.fail(new HttpClientError.RequestError({ request: http, reason: "Transport", cause: new Error("connection refused") })));
    const unreachable = makeAnthropicProvider({ client: offline, credential: Effect.succeed({ type: "api-key", key: "k" }) });
    const transport = llmFailure(await Effect.runPromiseExit(Stream.runDrain(unreachable.stream(request))));
    expect(transport).toMatchObject({ reason: "Network", retryable: true, message: expect.stringContaining("connection refused") });

    const noKey = makeAnthropicProvider({ client: rateLimited.client, credential: Effect.fail(missingCredential()) });
    expect(llmFailure(await Effect.runPromiseExit(Stream.runDrain(noKey.stream(request)))).reason).toBe("Auth");
    expect(rateLimited.requests).toHaveLength(1);
  });
});
