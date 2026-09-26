import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Stream } from "effect";
import { Message } from "@basis/contracts";
import { parseSse, toStreamEvents } from "../src/index.ts";
import { chunked, fixture, llmFailure, mapped } from "./support.ts";

const encode = (text: string) => new TextEncoder().encode(text);

describe("SSE parsing", () => {
  test("groups event/data lines across chunk boundaries, ignores comments, and flushes a final event without a blank line", async () => {
    const events = Chunk.toArray(await Effect.runPromise(Stream.runCollect(chunked(fixture("text"), 3).pipe(parseSse))));
    expect(events.map((event) => event.event)).toEqual([
      "message_start", "content_block_start", "ping", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop",
    ]);
    expect(JSON.parse(events[3]!.data)).toEqual({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } });

    const tail = Chunk.toArray(await Effect.runPromise(Stream.runCollect(Stream.make(encode(": keep-alive\r\nevent: ping\r\ndata: {\"type\":\"ping\"}")).pipe(parseSse))));
    expect(tail).toEqual([{ event: "ping", data: '{"type":"ping"}' }]);
    const multiline = Chunk.toArray(await Effect.runPromise(Stream.runCollect(Stream.make(encode("data: a\ndata: b\n\n")).pipe(parseSse))));
    expect(multiline).toEqual([{ event: "message", data: "a\nb" }]);
  });
});

describe("event mapping", () => {
  test("text: deltas, usage with cache counts, and a finish carrying the assembled message", async () => {
    const events = await Effect.runPromise(mapped("text"));
    expect(events).toEqual([
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: ", world!" },
      { type: "usage", usage: expect.objectContaining({ input: 25, output: 15, cacheRead: 300, cacheWrite: 12 }) },
      { type: "finish", reason: "stop", message: new Message({ role: "assistant", parts: [{ type: "text", text: "Hello, world!" }] }) },
    ]);
  });

  test("thinking: deltas stream, the signed block is kept whole in state, redacted blocks are kept too", async () => {
    const events = await Effect.runPromise(mapped("thinking"));
    expect(events.slice(0, 2)).toEqual([{ type: "thinking-delta", text: "Let me consider" }, { type: "thinking-delta", text: " the question." }]);
    const finish = events.at(-1);
    if (finish?.type !== "finish") throw new Error("expected finish");
    expect(finish.message.parts).toEqual([
      { type: "thinking", text: "Let me consider the question.", state: { type: "thinking", thinking: "Let me consider the question.", signature: "EqQBCgIYAhIM1t1qkA==" } },
      { type: "thinking", text: "", state: { type: "redacted_thinking", data: "EmwKAhgBEgy3va" } },
      { type: "text", text: "The answer is 42." },
    ]);
  });

  test("parallel tool calls: deltas while accumulating, parsed input on stop, empty input becomes {}", async () => {
    const events = await Effect.runPromise(mapped("tools"));
    const deltas = events.filter((event) => event.type === "tool-call-delta");
    expect(deltas).toEqual([
      { type: "tool-call-delta", id: "toolu_01A", name: "read", inputDelta: "" },
      { type: "tool-call-delta", id: "toolu_01A", name: "read", inputDelta: '{"path": "a.' },
      { type: "tool-call-delta", id: "toolu_01A", name: "read", inputDelta: 'txt"}' },
      { type: "tool-call-delta", id: "toolu_01B", name: "read", inputDelta: '{"path": "b.txt", "lines": [1, 2]}' },
    ]);
    const calls = events.filter((event) => event.type === "tool-call");
    expect(calls).toEqual([
      { type: "tool-call", id: "toolu_01A", name: "read", input: { path: "a.txt" } },
      { type: "tool-call", id: "toolu_01B", name: "read", input: { path: "b.txt", lines: [1, 2] } },
      { type: "tool-call", id: "toolu_01C", name: "list", input: {} },
    ]);
    const finish = events.at(-1);
    if (finish?.type !== "finish") throw new Error("expected finish");
    expect(finish.reason).toBe("tool-calls");
    expect(finish.message.parts).toEqual([{ type: "text", text: "Checking both files." }, ...calls]);
    // Ordering: every tool-call precedes usage, which precedes finish.
    expect(events.map((event) => event.type).slice(-2)).toEqual(["usage", "finish"]);
  });

  test("refusal maps to finish reason refusal with the text so far", async () => {
    const events = await Effect.runPromise(mapped("refusal"));
    const finish = events.at(-1);
    if (finish?.type !== "finish") throw new Error("expected finish");
    expect(finish.reason).toBe("refusal");
    expect(finish.message.parts).toEqual([{ type: "text", text: "I can't help with that." }]);
  });

  test("a mid-stream error event fails the stream after the earlier deltas were delivered", async () => {
    const seen: string[] = [];
    const exit = await Effect.runPromiseExit(Stream.runForEach(chunked(fixture("error")).pipe(parseSse, toStreamEvents), (event) => Effect.sync(() => { seen.push(event.type); })));
    const error = llmFailure(exit);
    expect(seen).toEqual(["text-delta"]);
    expect(error.reason).toBe("RateLimit");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("Overloaded");
  });

  test("a stream that ends without message_stop is a retryable Network error, and invalid tool JSON fails", async () => {
    const whole = new TextDecoder().decode(fixture("text"));
    const truncated = encode(whole.slice(0, whole.indexOf("event: message_delta")));
    const cut = llmFailure(await Effect.runPromiseExit(Stream.runDrain(Stream.make(truncated).pipe(parseSse, toStreamEvents))));
    expect(cut.reason).toBe("Network");
    expect(cut.retryable).toBe(true);

    const badJson = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"bash","input":{}}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\": \\"ls"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":5}}',
      'data: {"type":"message_stop"}',
    ].join("\n\n");
    const invalid = llmFailure(await Effect.runPromiseExit(Stream.runDrain(Stream.make(encode(badJson)).pipe(parseSse, toStreamEvents))));
    expect(invalid.message).toContain('"bash"');
    expect(invalid.message).toContain("invalid JSON");
  });
});
