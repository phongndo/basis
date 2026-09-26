import { describe, expect, test } from "bun:test";
import { Cause, Chunk, Effect, Exit, Option, Stream } from "effect";
import { makeCore } from "@basis/core";
import { Llm, LlmError, LlmRequest, Message, ToolDefinition } from "@basis/contracts";
import type { Credential, StreamEvent } from "@basis/contracts";
import plugin from "../src/index.ts";
import { fakeCredentials, fakeFetch, fakeLlm, fixture, withFetch } from "./support.ts";
import type { FetchLike } from "./support.ts";

const groq = {
  id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1",
  models: [{ id: "llama-3.3-70b", name: "Llama 3.3 70B", contextWindow: 131072, maxOutput: 32768 }],
};
const ollama = { id: "ollama", baseUrl: "http://localhost:11434/v1", models: [{ id: "qwen3", contextWindow: 32768, reasoning: true, toolCall: false }] };
const config = { providers: [groq, ollama] };
const apiKey: Credential = { type: "api-key", key: "gsk_test" };

const request = (overrides: Partial<ConstructorParameters<typeof LlmRequest>[0]> = {}) => new LlmRequest({
  model: "groq/llama-3.3-70b",
  messages: [new Message({ role: "user", parts: [{ type: "text", text: "hi" }] })],
  ...overrides,
});

/** Runs the plugin under a core with fakes and the recorded response, returning the stream's exit and what was sent. */
async function stream(
  llmRequest: LlmRequest,
  response: { status?: number; body: string },
  credentials: Record<string, Credential> = { groq: apiKey },
  fetchOverride?: FetchLike,
) {
  const llm = fakeLlm();
  const recorded = fakeFetch(response);
  const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
    const core = yield* makeCore([llm.plugin, fakeCredentials(credentials), plugin], { configs: { "llm-openai-compatible": config } });
    return yield* core.run(Effect.flatMap(Llm, (service) => Stream.runCollect(service.stream(llmRequest))).pipe(
      Effect.map(Chunk.toReadonlyArray),
      withFetch(fetchOverride ?? recorded.fetch),
    ));
  })));
  return { exit, requests: recorded.requests, providers: llm.providers };
}

function events(exit: Exit.Exit<readonly StreamEvent[], unknown>): readonly StreamEvent[] {
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause));
  return exit.value;
}

function failure(exit: Exit.Exit<unknown, unknown>): LlmError {
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  const error = Cause.failureOption(exit.cause);
  if (Option.isNone(error) || !(error.value instanceof LlmError)) throw new Error(Cause.pretty(exit.cause));
  return error.value;
}

describe("registration", () => {
  test("registers one provider per configured endpoint with its model catalog", async () => {
    const llm = fakeLlm();
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const core = yield* makeCore([llm.plugin, fakeCredentials({}), plugin], { configs: { "llm-openai-compatible": config } });
      const models = yield* core.run(Effect.flatMap(Llm, (service) => service.models));
      expect(llm.providers.map((provider) => [provider.id, provider.name])).toEqual([["groq", "Groq"], ["ollama", "ollama"]]);
      expect(models.map((model) => ({ id: model.id, name: model.name, toolCall: model.toolCall, reasoning: model.reasoning, maxOutput: model.maxOutput }))).toEqual([
        { id: "groq/llama-3.3-70b", name: "Llama 3.3 70B", toolCall: true, reasoning: false, maxOutput: 32768 },
        { id: "ollama/qwen3", name: "qwen3", toolCall: false, reasoning: true, maxOutput: undefined },
      ]);
    })));
    expect(llm.providers).toHaveLength(0);
  });
});

describe("request shaping", () => {
  test("posts a streaming Chat Completions request with the bearer key", async () => {
    const tools = [new ToolDefinition({ name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } })];
    const messages = [
      new Message({ role: "user", parts: [{ type: "text", text: "Look at this" }, { type: "image", mediaType: "image/png", source: { kind: "base64", data: "AAAA" } }] }),
      new Message({ role: "assistant", parts: [{ type: "thinking", text: "hidden" }, { type: "text", text: "Reading." }, { type: "tool-call", id: "call_1", name: "read", input: { path: "a.txt" } }] }),
      new Message({ role: "user", parts: [{ type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: "contents" }, { type: "image", mediaType: "image/jpeg", source: { kind: "url", url: "https://x/y.jpg" } }] }] }),
    ];
    const { requests } = await stream(request({ system: "Be brief", messages, tools, maxTokens: 100, temperature: 0.2 }), { body: await fixture("text.sse") });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(requests[0]?.headers.authorization).toBe("Bearer gsk_test");
    expect(requests[0]?.body).toEqual({
      model: "llama-3.3-70b",
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 100,
      temperature: 0.2,
      tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: tools[0]?.inputSchema } }],
      messages: [
        { role: "system", content: "Be brief" },
        { role: "user", content: [{ type: "text", text: "Look at this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
        { role: "assistant", content: "Reading.", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.txt\"}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "contents" },
        { role: "user", content: [{ type: "text", text: "Images from tool call call_1:" }, { type: "image_url", image_url: { url: "https://x/y.jpg" } }] },
      ],
    });
  });

  test("text-only user messages are sent as a plain string and omit unset options", async () => {
    const { requests } = await stream(request(), { body: await fixture("text.sse") });
    expect(requests[0]?.body).toEqual({
      model: "llama-3.3-70b", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "hi" }],
    });
  });
});

describe("streamed events", () => {
  test("text deltas, usage with cache reads, and a stop finish carrying the assembled message", async () => {
    const { exit } = await stream(request(), { body: await fixture("text.sse") });
    expect(events(exit)).toEqual([
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: ", world" },
      { type: "usage", usage: { input: 12, output: 3, cacheRead: 4 } },
      { type: "finish", reason: "stop", message: { role: "assistant", parts: [{ type: "text", text: "Hello, world" }] } },
    ]);
  });

  test("parallel tool calls accumulate by index and complete when the choice finishes", async () => {
    const { exit } = await stream(request(), { body: await fixture("tools.sse") });
    const calls: Extract<StreamEvent, { type: "tool-call" }>[] = [
      { type: "tool-call", id: "call_a1", name: "read", input: { path: "a.txt" } },
      { type: "tool-call", id: "call_b2", name: "bash", input: { command: "ls" } },
    ];
    expect(events(exit)).toEqual([
      { type: "tool-call-delta", id: "call_a1", name: "read", inputDelta: "" },
      { type: "tool-call-delta", id: "call_a1", name: "read", inputDelta: "{\"path\":" },
      { type: "tool-call-delta", id: "call_b2", name: "bash", inputDelta: "" },
      { type: "tool-call-delta", id: "call_a1", name: "read", inputDelta: "\"a.txt\"}" },
      { type: "tool-call-delta", id: "call_b2", name: "bash", inputDelta: "{\"command\":\"ls\"}" },
      ...calls,
      { type: "usage", usage: { input: 40, output: 18 } },
      { type: "finish", reason: "tool-calls", message: { role: "assistant", parts: calls } },
    ]);
  });

  test("reasoning deltas become thinking and a length finish keeps the thinking in the message", async () => {
    const { exit } = await stream(request({ model: "groq/deepseek-reasoner" }), { body: await fixture("reasoning.sse") });
    expect(events(exit)).toEqual([
      { type: "thinking-delta", text: "The user wants" },
      { type: "thinking-delta", text: " a greeting." },
      { type: "text-delta", text: "Hi" },
      { type: "text-delta", text: " there" },
      { type: "usage", usage: { input: 9, output: 6 } },
      { type: "finish", reason: "length", message: { role: "assistant", parts: [{ type: "thinking", text: "The user wants a greeting." }, { type: "text", text: "Hi there" }] } },
    ]);
  });

  test("an error object mid-stream fails the stream after the deltas already delivered", async () => {
    const llm = fakeLlm();
    const recorded = fakeFetch({ body: await fixture("error-mid-stream.sse") });
    const seen: StreamEvent[] = [];
    const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
      const core = yield* makeCore([llm.plugin, fakeCredentials({ groq: apiKey }), plugin], { configs: { "llm-openai-compatible": config } });
      yield* core.run(Effect.flatMap(Llm, (service) => Stream.runForEach(service.stream(request()), (event) => Effect.sync(() => { seen.push(event); }))).pipe(withFetch(recorded.fetch)));
    })));
    expect(seen).toEqual([{ type: "text-delta", text: "Partial" }]);
    const error = failure(exit);
    expect(error.reason).toBe("Network");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("server had an error");
  });

  test("a body that ends without finishing is a retryable network error", async () => {
    const { exit } = await stream(request(), { body: "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"He\"},\"finish_reason\":null}]}\n\n" });
    const error = failure(exit);
    expect(error.reason).toBe("Network");
    expect(error.retryable).toBe(true);
  });
});

describe("credentials", () => {
  test("a remote provider without a credential fails with Auth before sending anything", async () => {
    const { exit, requests } = await stream(request(), { body: "" }, {});
    const error = failure(exit);
    expect(error.reason).toBe("Auth");
    expect(error.message).toContain("GROQ_API_KEY");
    expect(requests).toHaveLength(0);
  });

  test("a localhost provider may run without a credential", async () => {
    const { exit, requests } = await stream(request({ model: "ollama/qwen3" }), { body: await fixture("text.sse") }, {});
    expect(events(exit).at(-1)?.type).toBe("finish");
    expect(requests[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(requests[0]?.headers.authorization).toBeUndefined();
  });

  test("an oauth credential is sent as its access token", async () => {
    const { requests } = await stream(request(), { body: await fixture("text.sse") }, { groq: { type: "oauth", access: "at", refresh: "rt", expiresAt: 0 } });
    expect(requests[0]?.headers.authorization).toBe("Bearer at");
  });
});

describe("error mapping", () => {
  const cases: [number, string, LlmError["reason"], boolean][] = [
    [401, "{\"error\":{\"message\":\"Invalid API Key\",\"type\":\"invalid_request_error\",\"code\":\"invalid_api_key\"}}", "Auth", false],
    [429, "{\"error\":{\"message\":\"Rate limit reached\",\"type\":\"tokens\",\"code\":\"rate_limit_exceeded\"}}", "RateLimit", true],
    [400, "{\"error\":{\"message\":\"This model's maximum context length is 131072 tokens.\",\"type\":\"invalid_request_error\",\"code\":\"context_length_exceeded\"}}", "ContextTooLong", false],
    [400, "{\"error\":{\"message\":\"Unsupported parameter: 'foo'\",\"type\":\"invalid_request_error\",\"code\":null}}", "InvalidRequest", false],
    [503, "upstream unavailable", "Network", true],
  ];
  for (const [status, body, reason, retryable] of cases) {
    test(`HTTP ${status} -> ${reason}`, async () => {
      const error = failure((await stream(request(), { status, body })).exit);
      expect(error.reason).toBe(reason);
      expect(error.retryable).toBe(retryable);
      expect(error.provider).toBe("groq");
      expect(error.message).toBe(JSON.parse(body.startsWith("{") ? body : "null")?.error.message ?? body);
    });
  }

  test("a transport failure is a retryable network error", async () => {
    const { exit } = await stream(request(), { body: "" }, { groq: apiKey }, async () => { throw new TypeError("fetch failed"); });
    const error = failure(exit);
    expect(error.reason).toBe("Network");
    expect(error.retryable).toBe(true);
  });
});
