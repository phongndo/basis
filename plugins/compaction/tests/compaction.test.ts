import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Fiber, Layer, Option, Stream } from "effect";
import type { Scope } from "effect";
import { definePlugin, Events, Hooks, makeCore } from "@basis/core";
import {
  AgentRequestHook, Llm, LlmError, LlmRequest, Message, ModelInfo, Notice, SessionEntry, SessionError, SessionInfo, Sessions,
  ToolDefinition, TurnEnded, TurnStarted, Usage,
} from "@basis/contracts";
import type { EntryPayload, StreamEvent } from "@basis/contracts";
import compaction, { estimateTokens, rebuildMessages, SUMMARY_MARKER } from "../src/index.ts";

const MODEL = new ModelInfo({ id: "fake/m", provider: "fake", name: "m", contextWindow: 1000, toolCall: true, reasoning: false });

/** A scripted model: records every request, answers with the configured events, or fails. */
class FakeLlm {
  requests: LlmRequest[] = [];
  reply: StreamEvent[] = [{ type: "text-delta", text: "SUM" }, { type: "text-delta", text: "MARY" }];
  failure: LlmError | undefined;
  plugin = definePlugin({
    id: "llm", provides: [Llm],
    layer: Layer.succeed(Llm, {
      registerProvider: () => Effect.void,
      providers: Effect.succeed([]),
      models: Effect.succeed([MODEL]),
      model: (id) => Effect.succeed(id === MODEL.id ? Option.some(MODEL) : Option.none()),
      stream: (request) => {
        this.requests.push(request);
        return this.failure ? Stream.fail(this.failure) : Stream.fromIterable(this.reply);
      },
    }),
  });
}

/** Sessions in memory: a linear chain per session is enough for the hook's append + context. */
class FakeSessions {
  entries = new Map<string, SessionEntry[]>();
  plugin = definePlugin({
    id: "sessions", provides: [Sessions],
    layer: Layer.succeed(Sessions, {
      create: (cwd) => Effect.sync(() => {
        const id = `s${this.entries.size + 1}`;
        this.entries.set(id, []);
        return new SessionInfo({ id, cwd, createdAt: DateTime.unsafeNow(), updatedAt: DateTime.unsafeNow() });
      }),
      append: (sessionId, payload: EntryPayload) => Effect.sync(() => {
        const chain = this.entries.get(sessionId)!;
        const entry = new SessionEntry({ id: `${sessionId}-${chain.length}`, parent: chain.at(-1)?.id ?? null, at: DateTime.unsafeNow(), payload });
        chain.push(entry);
        return entry;
      }),
      context: (sessionId) => Effect.sync(() => {
        const chain = this.entries.get(sessionId)!;
        let last = 0;
        chain.forEach((entry, index) => { if (entry.payload.type === "compaction") last = index; });
        return chain.slice(last);
      }),
      get: (sessionId) => Effect.fail(new SessionError({ sessionId, reason: "NotFound", message: "not needed" })),
      list: () => Effect.succeed([]),
      entries: () => Stream.empty,
      checkout: (sessionId) => Effect.fail(new SessionError({ sessionId, reason: "NotFound", message: "not needed" })),
      setTitle: (sessionId) => Effect.fail(new SessionError({ sessionId, reason: "NotFound", message: "not needed" })),
    }),
  });
}

const user = (text: string) => new Message({ role: "user", parts: [{ type: "text", text }] });
const assistant = (text: string) => new Message({ role: "assistant", parts: [{ type: "text", text }] });
const request = (messages: Message[], model = MODEL.id) =>
  new LlmRequest({ model, system: "be brief", messages, tools: [new ToolDefinition({ name: "read", description: "read a file", inputSchema: { type: "object" } })] });

/** Mount the fakes with the plugin under test and run a body that can invoke the hook. */
const withCore = <A, E>(
  fakes: { llm: FakeLlm; sessions: FakeSessions },
  body: (invoke: (sessionId: string, request: LlmRequest) => Effect.Effect<LlmRequest, unknown>) => Effect.Effect<A, E, Scope.Scope | Events | Sessions>,
  config?: { reserveTokens?: number },
) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const core = yield* makeCore([fakes.llm.plugin, fakes.sessions.plugin, compaction], config === undefined ? {} : { configs: { compaction: config } });
  const hooks = yield* core.run(Hooks);
  return yield* core.run(body((sessionId, request) => hooks.invoke(AgentRequestHook, { sessionId, request }, (input) => Effect.succeed(input.request))));
})));

const fakes = () => ({ llm: new FakeLlm(), sessions: new FakeSessions() });

describe("compaction", () => {
  test("estimates by characters and rebuilds messages from a context", () => {
    expect(estimateTokens(new LlmRequest({ model: "x", messages: [user("a".repeat(400))] }))).toBe(100);
    expect(estimateTokens(new LlmRequest({ model: "x", system: "s".repeat(8), messages: [] }))).toBe(2);
    const at = DateTime.unsafeNow();
    const entry = (payload: EntryPayload, id: string) => new SessionEntry({ id, parent: null, at, payload });
    const rebuilt = rebuildMessages([
      entry({ type: "compaction", summary: "before", tokensBefore: 1 }, "c"),
      entry({ type: "title", title: "ignored" }, "t"),
      entry({ type: "message", message: user("next") }, "u"),
      entry({ type: "custom", kind: "x/y", data: null }, "x"),
    ]);
    expect(rebuilt.map((message) => message.role)).toEqual(["user", "user"]);
    expect(rebuilt[0]!.parts).toEqual([{ type: "text", text: `${SUMMARY_MARKER}\n\nbefore` }]);
    expect(rebuilt[1]).toEqual(user("next"));
  });

  test("passes a request under the threshold through untouched", async () => {
    const f = fakes();
    await withCore(f, (invoke) => Effect.gen(function* () {
      const session = yield* Effect.flatMap(Sessions, (sessions) => sessions.create("/work"));
      const small = request([user("hello"), assistant("hi")]);
      // contextWindow 1000 - reserve 100 = 900 tokens; this is far below.
      expect(yield* invoke(session.id, small)).toBe(small);
      expect(f.llm.requests).toEqual([]);
      expect(f.sessions.entries.get(session.id)).toEqual([]);
    }), { reserveTokens: 100 });
  });

  test("summarizes, appends a compaction entry, and rebuilds the request when characters exceed the window", async () => {
    const f = fakes();
    await withCore(f, (invoke) => Effect.gen(function* () {
      const events = yield* Events;
      const notices = yield* Effect.fork(Stream.runHead(events.stream(Notice)));
      yield* Effect.sleep("2 millis");
      const sessions = yield* Sessions;
      const session = yield* sessions.create("/work");
      const history = [user("x".repeat(2000)), assistant("y".repeat(2000)), user("what next?")];
      for (const message of history) yield* sessions.append(session.id, { type: "message", message });
      const big = request(history);
      const estimate = estimateTokens(big);
      expect(estimate).toBeGreaterThan(900);

      const rebuilt = yield* invoke(session.id, big);
      // The summary was requested from the same model with the conversation plus an instruction.
      expect(f.llm.requests.length).toBe(1);
      expect(f.llm.requests[0]!.model).toBe(MODEL.id);
      expect(f.llm.requests[0]!.messages.slice(0, 3)).toEqual(history);
      expect(f.llm.requests[0]!.messages.at(-1)!.role).toBe("user");
      // The compaction entry is durable in the session and the request is rebuilt from the session's context.
      const chain = f.sessions.entries.get(session.id)!;
      expect(chain.at(-1)!.payload).toEqual({ type: "compaction", summary: "SUMMARY", tokensBefore: estimate });
      expect(rebuilt.messages).toEqual([user(`${SUMMARY_MARKER}\n\nSUMMARY`)]);
      expect(rebuilt.system).toBe(big.system);
      expect(rebuilt.tools).toEqual(big.tools);
      expect(rebuilt.model).toBe(big.model);
      const notice = yield* Fiber.join(notices);
      expect(notice._tag === "Some" && notice.value).toMatchObject({ level: "info", source: "compaction" });
    }), { reserveTokens: 100 });
  });

  test("uses the last turn's usage, compacts once per turn, and resets at turn boundaries", async () => {
    const f = fakes();
    await withCore(f, (invoke) => Effect.gen(function* () {
      const events = yield* Events;
      const sessions = yield* Sessions;
      const session = yield* sessions.create("/work");
      yield* sessions.append(session.id, { type: "message", message: user("short") });
      const small = request([user("short")]);

      yield* events.publish(TurnStarted, { sessionId: session.id, turnId: "t1" });
      yield* events.publish(TurnEnded, { sessionId: session.id, turnId: "t1", usage: new Usage({ input: 800, output: 50, cacheRead: 100 }), reason: "done" as const });
      yield* events.publish(TurnStarted, { sessionId: session.id, turnId: "t2" });
      // Observers run asynchronously; keep invoking (pass-through has no side effects) until the usage has landed.
      const first = yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt++) {
          const result = yield* invoke(session.id, small);
          if (result !== small) return result;
          yield* Effect.sleep("2 millis");
        }
        throw new Error("usage never triggered compaction");
      });
      expect(first.messages[0]!.parts[0]).toEqual({ type: "text", text: `${SUMMARY_MARKER}\n\nSUMMARY` });
      expect(f.llm.requests.length).toBe(1);

      // Same turn: the stale usage is forgotten and a second oversize request is left alone.
      const oversize = request([user("z".repeat(5000))]);
      expect(yield* invoke(session.id, oversize)).toBe(oversize);
      expect(f.llm.requests.length).toBe(1);

      // Next turn: compaction is allowed again.
      yield* events.publish(TurnEnded, { sessionId: session.id, turnId: "t2", usage: new Usage({ input: 10, output: 5 }), reason: "done" as const });
      yield* events.publish(TurnStarted, { sessionId: session.id, turnId: "t3" });
      const second = yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt++) {
          const result = yield* invoke(session.id, oversize);
          if (result !== oversize) return result;
          yield* Effect.sleep("2 millis");
        }
        throw new Error("next turn never compacted");
      });
      expect(f.llm.requests.length).toBe(2);
      expect(f.sessions.entries.get(session.id)!.filter((entry) => entry.payload.type === "compaction").length).toBe(2);
      expect(second.messages.length).toBe(1);
    }), { reserveTokens: 100 });
  });

  test("leaves the request alone for an unknown model and when the summary fails, with an error notice", async () => {
    const f = fakes();
    await withCore(f, (invoke) => Effect.gen(function* () {
      const events = yield* Events;
      const notices = yield* Effect.fork(Stream.runHead(events.stream(Notice)));
      yield* Effect.sleep("2 millis");
      const session = yield* Effect.flatMap(Sessions, (sessions) => sessions.create("/work"));
      const oversize = request([user("z".repeat(5000))], "fake/unknown");
      expect(yield* invoke(session.id, oversize)).toBe(oversize);
      expect(f.llm.requests).toEqual([]);

      f.llm.failure = new LlmError({ provider: "fake", reason: "Network", message: "down", retryable: true });
      const known = request([user("z".repeat(5000))]);
      expect(yield* invoke(session.id, known)).toBe(known);
      expect(f.llm.requests.length).toBe(1);
      expect(f.sessions.entries.get(session.id)).toEqual([]);
      const notice = yield* Fiber.join(notices);
      expect(notice._tag === "Some" && notice.value).toMatchObject({ level: "error", source: "compaction", message: expect.stringContaining("down") });
    }), { reserveTokens: 100 });
  });

  test("works without config and uses the default reserve", async () => {
    const f = fakes();
    await withCore(f, (invoke) => Effect.gen(function* () {
      const session = yield* Effect.flatMap(Sessions, (sessions) => sessions.create("/work"));
      // 1000 - 16384 < 0: with the default reserve every request on this tiny model compacts.
      const tiny = request([user("hi")]);
      const rebuilt = yield* invoke(session.id, tiny);
      expect(rebuilt).not.toBe(tiny);
      expect(f.llm.requests.length).toBe(1);
    }));
  });
});
