import { describe, expect, test } from "bun:test";
import { LlmRequest, Message, ToolDefinition } from "@basis/contracts";
import { DEFAULT_MAX_TOKENS, HAIKU_THINKING_BUDGET, MODELS, modelName, toWireRequest } from "../src/index.ts";

const user = (text: string) => new Message({ role: "user", parts: [{ type: "text", text }] });
const request = (fields: Partial<ConstructorParameters<typeof LlmRequest>[0]> = {}) =>
  new LlmRequest({ model: "anthropic/claude-opus-5", messages: [user("hi")], ...fields });

describe("request body", () => {
  test("adaptive thinking and effort for current models; the routing prefix is stripped; always streams", () => {
    const body = toWireRequest(request());
    expect(body.model).toBe("claude-opus-5");
    expect(body.stream).toBe(true);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(body).not.toHaveProperty("temperature");
    expect(toWireRequest(request({ effort: "max" })).output_config).toEqual({ effort: "max" });
    expect(toWireRequest(request({ effort: "low", maxTokens: 2000 })).max_tokens).toBe(2000);
    expect(modelName("claude-sonnet-5")).toBe("claude-sonnet-5");
    for (const model of MODELS.filter((facts) => facts.thinking === "adaptive")) {
      expect(toWireRequest(request({ model: `anthropic/${model.id}` })).thinking).toEqual({ type: "adaptive" });
    }
  });

  test("haiku: a fixed budget only when effort is set, never output_config, sampling allowed", () => {
    const plain = toWireRequest(request({ model: "anthropic/claude-haiku-4-5", temperature: 0.2 }));
    expect(plain).not.toHaveProperty("thinking");
    expect(plain).not.toHaveProperty("output_config");
    expect(plain.temperature).toBe(0.2);
    const thinking = toWireRequest(request({ model: "anthropic/claude-haiku-4-5", effort: "medium" }));
    expect(thinking.thinking).toEqual({ type: "enabled", budget_tokens: HAIKU_THINKING_BUDGET });
    expect(thinking).not.toHaveProperty("output_config");
    // Models that reject sampling parameters never see them.
    expect(toWireRequest(request({ temperature: 0.5 }))).not.toHaveProperty("temperature");
    expect(toWireRequest(request({ model: "anthropic/claude-opus-4-6", temperature: 0.5 })).temperature).toBe(0.5);
  });

  test("cache_control goes on the system block and the last block of the last user message", () => {
    const body = toWireRequest(request({
      system: "Be brief.",
      messages: [
        user("first"),
        new Message({ role: "assistant", parts: [{ type: "text", text: "ok" }] }),
        new Message({ role: "user", parts: [{ type: "text", text: "second" }, { type: "text", text: "third" }] }),
      ],
    }));
    expect(body.system).toEqual([{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }]);
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "second" }, { type: "text", text: "third", cache_control: { type: "ephemeral" } }] },
    ]);
    expect(toWireRequest(request())).not.toHaveProperty("system");
  });

  test("tools carry eager input streaming; tool results sit inside the user message; images map by source", () => {
    const body = toWireRequest(request({
      tools: [new ToolDefinition({ name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } })],
      messages: [
        user("go"),
        new Message({ role: "assistant", parts: [{ type: "text", text: "Reading." }, { type: "tool-call", id: "toolu_1", name: "read", input: { path: "a" } }] }),
        new Message({ role: "user", parts: [
          { type: "tool-result", toolCallId: "toolu_1", content: [{ type: "text", text: "contents" }], isError: true },
          { type: "image", mediaType: "image/png", source: { kind: "base64", data: "AAAA" } },
          { type: "image", mediaType: "image/jpeg", source: { kind: "url", url: "https://example.com/x.jpg" } },
        ] }),
      ],
    }));
    expect(body.tools).toEqual([{ name: "read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } }, eager_input_streaming: true }]);
    expect(body.messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "Reading." }, { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a" } }] });
    expect(body.messages[2]).toEqual({ role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "contents" }], is_error: true },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "image", source: { type: "url", url: "https://example.com/x.jpg" }, cache_control: { type: "ephemeral" } },
    ] });
  });

  test("thinking parts are echoed from state verbatim and dropped without it; empty text and empty messages are dropped", () => {
    const signed = { type: "thinking", thinking: "hmm", signature: "sig==" };
    const body = toWireRequest(request({
      messages: [
        user("q"),
        new Message({ role: "assistant", parts: [
          { type: "thinking", text: "hmm", state: signed },
          { type: "thinking", text: "lost" },
          { type: "text", text: "" },
          { type: "text", text: "a" },
        ] }),
        new Message({ role: "assistant", parts: [{ type: "thinking", text: "nothing to send" }] }),
        user("r"),
      ],
    }));
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [signed, { type: "text", text: "a" }] },
      { role: "user", content: [{ type: "text", text: "r", cache_control: { type: "ephemeral" } }] },
    ]);
  });
});
