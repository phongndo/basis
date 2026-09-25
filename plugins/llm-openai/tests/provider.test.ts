import { describe, expect, test } from "bun:test";
import { Cause, Chunk, Effect, Exit, Option, Stream } from "effect";
import { makeCore } from "@basis/core";
import { Llm, LlmError, LlmRequest, Message, ToolDefinition } from "@basis/contracts";
import type { Credential, StreamEvent } from "@basis/contracts";
import plugin, { catalog } from "../src/index.ts";
import { fakeCredentials, fakeFetch, fakeLlm, fixture, withFetch } from "./support.ts";
import type { FetchLike } from "./support.ts";

const apiKey: Credential = { type: "api-key", key: "sk-test" };

const request = (overrides: Partial<ConstructorParameters<typeof LlmRequest>[0]> = {}) => new LlmRequest({
  model: "openai/gpt-5",
  messages: [new Message({ role: "user", parts: [{ type: "text", text: "hi" }] })],
  ...overrides,
});

/** Runs the plugin under a core with fakes and the recorded response, returning the stream's exit and what was sent. */
async function stream(
  llmRequest: LlmRequest,
  response: { status?: number; body: string },
  credentials: Record<string, Credential> = { openai: apiKey },
  options: { config?: { baseUrl?: string }; fetch?: FetchLike } = {},
) {
  const llm = fakeLlm();
  const recorded = fakeFetch(response);
  const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
    const core = yield* makeCore([llm.plugin, fakeCredentials(credentials), plugin], options.config === undefined ? {} : { configs: { "llm-openai": options.config } });
    return yield* core.run(Effect.flatMap(Llm, (service) => Stream.runCollect(service.stream(llmRequest))).pipe(
      Effect.map(Chunk.toReadonlyArray),
      withFetch(options.fetch ?? recorded.fetch),
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
  test("registers the openai provider with the bundled catalog, without config", async () => {
    const llm = fakeLlm();
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const core = yield* makeCore([llm.plugin, fakeCredentials({}), plugin]);
      const models = yield* core.run(Effect.flatMap(Llm, (service) => service.models));
      expect(llm.providers.map((provider) => [provider.id, provider.name])).toEqual([["openai", "OpenAI"]]);
      expect(models).toEqual(catalog);
      expect(models.map((model) => model.id)).toContain("openai/gpt-5");
      expect(models.map((model) => model.id)).toContain("openai/o4-mini");
      expect(models.every((model) => model.provider === "openai" && model.reasoning && model.toolCall && model.contextWindow > 0)).toBe(true);
    })));
    expect(llm.providers).toHaveLength(0);
  });
});

describe("request shaping", () => {
  test("posts a streaming Responses request with input items, function tools, reasoning effort, and encrypted reasoning", async () => {
    const tools = [new ToolDefinition({ name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } })];
    const messages = [
      new Message({ role: "user", parts: [{ type: "text", text: "Look at this" }, { type: "image", mediaType: "image/png", source: { kind: "base64", data: "AAAA" } }] }),
      new Message({ role: "assistant", parts: [
        { type: "thinking", text: "Plan", state: { id: "rs_0", encrypted_content: "enc-0" } },
        { type: "thinking", text: "no state, dropped" },
        { type: "text", text: "Reading." },
        { type: "tool-call", id: "call_1", name: "read", input: { path: "a.txt" } },
      ] }),
      new Message({ role: "user", parts: [
        { type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: "contents" }, { type: "image", mediaType: "image/jpeg", source: { kind: "url", url: "https://x/y.jpg" } }] },
        { type: "text", text: "Now what?" },
      ] }),
    ];
    const { requests } = await stream(request({ system: "Be brief", messages, tools, maxTokens: 100, effort: "max" }), { body: await fixture("text.sse") });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0]?.headers.authorization).toBe("Bearer sk-test");
    expect(requests[0]?.body).toEqual({
      model: "gpt-5",
      instructions: "Be brief",
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "high" },
      max_output_tokens: 100,
      tools: [{ type: "function", name: "read", description: "Read a file", parameters: tools[0]?.inputSchema, strict: false }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Look at this" }, { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" }] },
        { type: "reasoning", id: "rs_0", summary: [{ type: "summary_text", text: "Plan" }], encrypted_content: "enc-0" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading." }] },
        { type: "function_call", call_id: "call_1", name: "read", arguments: "{\"path\":\"a.txt\"}" },
        { type: "function_call_output", call_id: "call_1", output: "contents" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Images from tool call call_1:" }, { type: "input_image", image_url: "https://x/y.jpg", detail: "auto" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Now what?" }] },
      ],
    });
  });

  test("effort levels pass through and a configured baseUrl replaces the default", async () => {
    const { requests } = await stream(request({ effort: "low" }), { body: await fixture("text.sse") }, { openai: apiKey }, { config: { baseUrl: "https://gateway.example/openai/v1/" } });
    expect(requests[0]?.url).toBe("https://gateway.example/openai/v1/responses");
    expect(requests[0]?.body).toEqual({
      model: "gpt-5", stream: true, store: false, include: ["reasoning.encrypted_content"], reasoning: { effort: "low" },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
  });
});

describe("streamed events", () => {
  test("text deltas, usage with cached tokens, and a stop finish carrying the encrypted reasoning state", async () => {
    const { exit } = await stream(request(), { body: await fixture("text.sse") });
    expect(events(exit)).toEqual([
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: ", world" },
      { type: "usage", usage: { input: 20, output: 5, cacheRead: 8 } },
      { type: "finish", reason: "stop", message: { role: "assistant", parts: [
        { type: "thinking", text: "", state: { id: "rs_1", encrypted_content: "gAAAAABo-enc-1" } },
        { type: "text", text: "Hello, world" },
      ] } },
    ]);
  });

  test("reasoning summary deltas and parallel function calls complete per item", async () => {
    const { exit } = await stream(request(), { body: await fixture("tools.sse") });
    const read = { type: "tool-call", id: "call_a1", name: "read", input: { path: "a.txt" } } as const;
    const bash = { type: "tool-call", id: "call_b2", name: "bash", input: { command: "ls" } } as const;
    expect(events(exit)).toEqual([
      { type: "thinking-delta", text: "**Planning**\n\nI should read" },
      { type: "thinking-delta", text: " the file and list the directory." },
      { type: "tool-call-delta", id: "call_a1", name: "read", inputDelta: "{\"path\":" },
      { type: "tool-call-delta", id: "call_a1", name: "read", inputDelta: "\"a.txt\"}" },
      read,
      { type: "tool-call-delta", id: "call_b2", name: "bash", inputDelta: "{\"command\":\"ls\"}" },
      bash,
      { type: "usage", usage: { input: 60, output: 42, cacheRead: 0 } },
      { type: "finish", reason: "tool-calls", message: { role: "assistant", parts: [
        { type: "thinking", text: "**Planning**\n\nI should read the file and list the directory.", state: { id: "rs_2", encrypted_content: "gAAAAABo-enc-2" } },
        read,
        bash,
      ] } },
    ]);
  });

  test("an error event mid-stream fails the stream after the deltas already delivered", async () => {
    const llm = fakeLlm();
    const recorded = fakeFetch({ body: await fixture("error-mid-stream.sse") });
    const seen: StreamEvent[] = [];
    const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
      const core = yield* makeCore([llm.plugin, fakeCredentials({ openai: apiKey }), plugin]);
      yield* core.run(Effect.flatMap(Llm, (service) => Stream.runForEach(service.stream(request()), (event) => Effect.sync(() => { seen.push(event); }))).pipe(withFetch(recorded.fetch)));
    })));
    expect(seen).toEqual([{ type: "text-delta", text: "Partial" }]);
    const error = failure(exit);
    expect(error.reason).toBe("Network");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("server had an error");
  });

  test("an incomplete response for max_output_tokens finishes with length", async () => {
    const body = [
      "event: response.output_item.added",
      "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"msg_9\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}",
      "",
      "event: response.output_text.delta",
      "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_9\",\"delta\":\"Once upon\"}",
      "",
      "event: response.incomplete",
      "data: {\"type\":\"response.incomplete\",\"response\":{\"id\":\"resp_9\",\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"usage\":{\"input_tokens\":5,\"output_tokens\":2}}}",
      "",
    ].join("\n");
    const { exit } = await stream(request(), { body });
    expect(events(exit)).toEqual([
      { type: "text-delta", text: "Once upon" },
      { type: "usage", usage: { input: 5, output: 2 } },
      { type: "finish", reason: "length", message: { role: "assistant", parts: [{ type: "text", text: "Once upon" }] } },
    ]);
  });

  test("a response.failed event maps its error", async () => {
    const body = "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"id\":\"resp_8\",\"status\":\"failed\",\"error\":{\"code\":\"rate_limit_exceeded\",\"message\":\"Rate limit reached\"}}}\n\n";
    const error = failure((await stream(request(), { body })).exit);
    expect(error.reason).toBe("RateLimit");
    expect(error.retryable).toBe(true);
  });

  test("a body that ends without a terminal event is a retryable network error", async () => {
    const { exit } = await stream(request(), { body: "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_7\"}}\n\n" });
    const error = failure(exit);
    expect(error.reason).toBe("Network");
    expect(error.retryable).toBe(true);
  });
});

describe("credentials", () => {
  test("a missing credential fails with Auth naming OPENAI_API_KEY before sending anything", async () => {
    const { exit, requests } = await stream(request(), { body: "" }, {});
    const error = failure(exit);
    expect(error.reason).toBe("Auth");
    expect(error.message).toContain("OPENAI_API_KEY");
    expect(requests).toHaveLength(0);
  });

  test("an oauth credential is sent as its access token", async () => {
    const { requests } = await stream(request(), { body: await fixture("text.sse") }, { openai: { type: "oauth", access: "at", refresh: "rt", expiresAt: 0 } });
    expect(requests[0]?.headers.authorization).toBe("Bearer at");
  });
});

describe("error mapping", () => {
  const cases: [number, string, LlmError["reason"], boolean][] = [
    [401, "{\"error\":{\"message\":\"Incorrect API key provided\",\"type\":\"invalid_request_error\",\"code\":\"invalid_api_key\"}}", "Auth", false],
    [429, "{\"error\":{\"message\":\"Rate limit reached\",\"type\":\"tokens\",\"code\":\"rate_limit_exceeded\"}}", "RateLimit", true],
    [400, "{\"error\":{\"message\":\"Your input exceeds the context window of this model.\",\"type\":\"invalid_request_error\",\"code\":\"context_length_exceeded\"}}", "ContextTooLong", false],
    [400, "{\"error\":{\"message\":\"Unsupported parameter: 'foo'\",\"type\":\"invalid_request_error\",\"code\":null}}", "InvalidRequest", false],
    [500, "{\"error\":{\"message\":\"The server had an error\",\"type\":\"server_error\"}}", "Network", true],
  ];
  for (const [status, body, reason, retryable] of cases) {
    test(`HTTP ${status} -> ${reason}`, async () => {
      const error = failure((await stream(request(), { status, body })).exit);
      expect(error.reason).toBe(reason);
      expect(error.retryable).toBe(retryable);
      expect(error.provider).toBe("openai");
      expect(error.message).toBe(JSON.parse(body).error.message);
    });
  }

  test("a transport failure is a retryable network error", async () => {
    const { exit } = await stream(request(), { body: "" }, { openai: apiKey }, { fetch: async () => { throw new TypeError("fetch failed"); } });
    const error = failure(exit);
    expect(error.reason).toBe("Network");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("fetch failed");
  });
});
