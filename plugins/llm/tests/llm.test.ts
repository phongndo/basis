import { describe, expect, test } from "bun:test";
import { Cause, Chunk, Effect, Exit, Layer, Option, Scope, Stream } from "effect";
import { definePlugin, makeCore, PluginContext } from "@basis/core";
import { Llm, LlmError, LlmRequest, LlmRequestHook, Message, ModelInfo } from "@basis/contracts";
import type { LlmProvider, StreamEvent } from "@basis/contracts";
import { catalogFor } from "@basis/models";
import llm, { providerOf } from "../src/index.ts";

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect));

const reply = (text: string): readonly StreamEvent[] => [
  { type: "text-delta", text },
  { type: "finish", reason: "stop", message: new Message({ role: "assistant", parts: [{ type: "text", text }] }) },
];

function fakeProvider(id: string, options: { models?: readonly string[]; events?: readonly StreamEvent[]; onModels?: () => void } = {}): LlmProvider {
  return {
    id, name: `Fake ${id}`,
    models: Effect.sync(() => {
      options.onModels?.();
      return (options.models ?? []).map((model) => new ModelInfo({ id: `${id}/${model}`, provider: id, name: model, contextWindow: 1000, toolCall: true, reasoning: false }));
    }),
    stream: () => Stream.fromIterable(options.events ?? reply(`from ${id}`)),
  };
}

const providerPlugin = (provider: LlmProvider, pluginId = `provider-${provider.id}`) => definePlugin({
  id: pluginId,
  requires: [Llm],
  layer: Layer.scopedDiscard(Effect.flatMap(Llm, (service) => service.registerProvider(provider))),
});

const request = (model: string) => new LlmRequest({ model, messages: [new Message({ role: "user", parts: [{ type: "text", text: "hi" }] })] });
const collect = (model: string) => Effect.flatMap(Llm, (service) => Stream.runCollect(service.stream(request(model))).pipe(Effect.map(Chunk.toArray)));

function failure<E>(exit: Exit.Exit<unknown, E>): E {
  if (Exit.isSuccess(exit)) throw new Error("Expected failure");
  return Option.getOrThrow(Cause.failureOption(exit.cause));
}
function llmFailure(exit: Exit.Exit<unknown, unknown>): LlmError {
  const error = failure(exit);
  if (!(error instanceof LlmError)) throw new Error(`Expected LlmError, got ${String(error)}`);
  return error;
}

describe("provider registry", () => {
  test("providers register for their scope and disappear when it closes", async () => {
    await run(Effect.gen(function* () {
      const core = yield* makeCore([llm]);
      const inner = yield* Scope.make();
      yield* core.run(Effect.flatMap(Llm, (service) => service.registerProvider(fakeProvider("a")))).pipe(Scope.extend(inner));
      expect(yield* core.run(Effect.flatMap(Llm, (service) => service.providers))).toEqual([{ id: "a", name: "Fake a" }]);
      yield* Scope.close(inner, Exit.void);
      expect(yield* core.run(Effect.flatMap(Llm, (service) => service.providers))).toEqual([]);
    }));
  });

  test("a duplicate provider id fails the registering plugin's activation", async () => {
    await run(Effect.gen(function* () {
      const fault = failure(yield* Effect.exit(makeCore([llm, providerPlugin(fakeProvider("a")), providerPlugin(fakeProvider("a"), "second")])));
      if (fault._tag !== "PluginFault") throw new Error(`Expected PluginFault, got ${fault._tag}`);
      expect(fault.pluginId).toBe("second");
      expect(fault.phase).toBe("activate");
      expect(Cause.pretty(fault.cause)).toContain('"a" is already registered');
    }));
  });

  test("models concatenates catalogs, caches them, and refreshes when the registry changes", async () => {
    let calls = 0;
    await run(Effect.gen(function* () {
      const core = yield* makeCore([llm, providerPlugin(fakeProvider("a", { models: ["one"], onModels: () => { calls += 1; } })), providerPlugin(fakeProvider("b", { models: ["two", "three"] }))]);
      const models = yield* core.run(Effect.flatMap(Llm, (service) => service.models));
      expect(models.map((model) => model.id)).toEqual(["a/one", "b/two", "b/three"]);
      yield* core.run(Effect.flatMap(Llm, (service) => service.models));
      expect(calls).toBe(1);
      expect(Option.map(yield* core.run(Effect.flatMap(Llm, (service) => service.model("b/three"))), (model) => model.name)).toEqual(Option.some("three"));
      expect(yield* core.run(Effect.flatMap(Llm, (service) => service.model("b/none")))).toEqual(Option.none());

      const inner = yield* Scope.make();
      yield* core.run(Effect.flatMap(Llm, (service) => service.registerProvider(fakeProvider("c", { models: ["four"] })))).pipe(Scope.extend(inner));
      expect((yield* core.run(Effect.flatMap(Llm, (service) => service.models))).map((model) => model.id)).toContain("c/four");
      expect(calls).toBe(2);
      yield* Scope.close(inner, Exit.void);
      expect((yield* core.run(Effect.flatMap(Llm, (service) => service.models))).map((model) => model.id)).not.toContain("c/four");
    }));
  });
});

describe("routing", () => {
  test("routes by the provider prefix and fails InvalidRequest for an unknown one", async () => {
    await run(Effect.gen(function* () {
      const core = yield* makeCore([llm, providerPlugin(fakeProvider("a")), providerPlugin(fakeProvider("b"))]);
      expect((yield* core.run(collect("b/model")))[0]).toEqual({ type: "text-delta", text: "from b" });
      const error = llmFailure(yield* Effect.exit(core.run(collect("nope/model"))));
      expect(error).toBeInstanceOf(LlmError);
      expect(error.reason).toBe("InvalidRequest");
      expect(error.provider).toBe("nope");
      expect(llmFailure(yield* Effect.exit(core.run(collect("noprefix")))).message).toContain('No provider ""');
    }));
  });

  test("LlmRequestHook wraps every call: handlers see the request, may rewrite it, and may wrap the stream", async () => {
    const seen: string[] = [];
    const logger = definePlugin({
      id: "logger",
      layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.on(LlmRequestHook, (input, next) => Effect.gen(function* () {
        seen.push(input.model);
        const stream = yield* next(new LlmRequest({ ...input, model: "b/other" }));
        return Stream.map(stream, (event) => event.type === "text-delta" ? { ...event, text: event.text.toUpperCase() } : event);
      })))),
    });
    await run(Effect.gen(function* () {
      const core = yield* makeCore([llm, logger, providerPlugin(fakeProvider("a")), providerPlugin(fakeProvider("b"))]);
      const events = yield* core.run(collect("a/model"));
      expect(seen).toEqual(["a/model"]);
      expect(events[0]).toEqual({ type: "text-delta", text: "FROM B" });
    }));
  });

  test("a failing handler fails the stream with its LlmError", async () => {
    const gate = definePlugin({
      id: "gate",
      layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.on(LlmRequestHook, (input) =>
        Effect.fail(new LlmError({ provider: providerOf(input.model), reason: "RateLimit", message: "budget exhausted", retryable: true }))))),
    });
    await run(Effect.gen(function* () {
      const core = yield* makeCore([llm, gate, providerPlugin(fakeProvider("a"))]);
      const error = llmFailure(yield* Effect.exit(core.run(collect("a/model"))));
      expect(error.reason).toBe("RateLimit");
      expect(error.message).toBe("budget exhausted");
    }));
  });
});

describe("catalog helper", () => {
  test("catalogFor returns bundled ModelInfo entries for shipped providers and nothing for others", () => {
    const anthropic = catalogFor("anthropic");
    expect(anthropic.length).toBeGreaterThan(0);
    expect(anthropic.every((model) => model instanceof ModelInfo && model.provider === "anthropic" && model.id.startsWith("anthropic/"))).toBe(true);
    expect(catalogFor("openai").length).toBeGreaterThan(0);
    expect(catalogFor("ollama")).toEqual([]);
    expect(catalogFor("unknown")).toEqual([]);
  });
});
