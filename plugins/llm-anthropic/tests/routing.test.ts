import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Layer, Option, Scope, Stream } from "effect";
import type { Context } from "effect";
import { definePlugin, makeCore, PluginContext } from "@basis/core";
import { Credentials, Llm, LlmRequest, LlmRequestHook, Message } from "@basis/contracts";
import type { Credential } from "@basis/contracts";
import llm from "@basis/plugin-llm";
import anthropic, { makeAnthropicProvider, API_VERSION } from "../src/index.ts";
import { fakeClient, llmFailure, sseResponse } from "./support.ts";

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect));
const unused = Effect.die("not used by these tests");

const credentialsPlugin = (credential: Option.Option<Credential>) => definePlugin({
  id: "credentials",
  provides: [Credentials],
  layer: Layer.succeed(Credentials, {
    resolve: () => Effect.succeed(credential),
    set: () => unused, remove: () => unused, list: unused, registerMethod: () => unused, methods: Effect.succeed([]), login: () => unused,
  } satisfies Context.Tag.Service<Credentials>),
});

const request = (model = "anthropic/claude-opus-5") => new LlmRequest({ model, messages: [new Message({ role: "user", parts: [{ type: "text", text: "hi" }] })] });
const collect = (model?: string) => Effect.flatMap(Llm, (service) => Stream.runCollect(service.stream(request(model))).pipe(Effect.map(Chunk.toArray)));

describe("the plugin in a composition", () => {
  test("registers the anthropic provider with its bundled catalog and models.dev prices", async () => {
    await run(Effect.gen(function* () {
      const core = yield* makeCore([llm, credentialsPlugin(Option.none()), anthropic]);
      expect(yield* core.run(Effect.flatMap(Llm, (service) => service.providers))).toEqual([{ id: "anthropic", name: "Anthropic" }]);
      const models = yield* core.run(Effect.flatMap(Llm, (service) => service.models));
      const opus = models.find((model) => model.id === "anthropic/claude-opus-5");
      expect(opus).toMatchObject({ provider: "anthropic", contextWindow: 1_000_000, maxOutput: 128_000, reasoning: true, toolCall: true, cost: { input: 5, output: 25 } });
      const haiku = Option.getOrThrow(yield* core.run(Effect.flatMap(Llm, (service) => service.model("anthropic/claude-haiku-4-5"))));
      expect(haiku).toMatchObject({ contextWindow: 200_000, maxOutput: 64_000 });
      expect(models.map((model) => model.id)).toContain("anthropic/claude-fable-5-1");
    }));
  });

  test("without credentials a request fails Auth before any HTTP call, telling the user what to do", async () => {
    await run(Effect.gen(function* () {
      const core = yield* makeCore([llm, credentialsPlugin(Option.none()), anthropic], { configs: { "llm-anthropic": { baseUrl: "http://127.0.0.1:9" } } });
      const error = llmFailure(yield* Effect.exit(core.run(collect())));
      expect(error.reason).toBe("Auth");
      expect(error.message).toContain("ANTHROPIC_API_KEY");
    }));
  });
});

describe("routing through Llm", () => {
  const providerPlugin = (client: ReturnType<typeof fakeClient>["client"], credential: Credential) => definePlugin({
    id: "anthropic-fake",
    requires: [Llm],
    layer: Layer.scopedDiscard(Effect.flatMap(Llm, (service) =>
      service.registerProvider(makeAnthropicProvider({ baseUrl: "https://gateway.test/", client, credential: Effect.succeed(credential) })))),
  });

  test("Llm.stream reaches the Messages API with the right headers and body, wrapped by LlmRequestHook", async () => {
    const http = fakeClient(() => sseResponse("tools"));
    const seen: string[] = [];
    const hook = definePlugin({
      id: "hook",
      layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.on(LlmRequestHook, (input, next) => Effect.gen(function* () {
        seen.push(input.model);
        const stream = yield* next(new LlmRequest({ ...input, system: "Injected by hook." }));
        return Stream.tap(stream, (event) => Effect.sync(() => { seen.push(event.type); }));
      })))),
    });
    await run(Effect.gen(function* () {
      const core = yield* makeCore([llm, hook, providerPlugin(http.client, { type: "api-key", key: "sk-test" })]);
      const events = yield* core.run(collect());
      expect(events.filter((event) => event.type === "tool-call")).toHaveLength(3);
      expect(events.at(-1)?.type).toBe("finish");
      expect(seen[0]).toBe("anthropic/claude-opus-5");
      expect(seen.filter((type) => type === "tool-call")).toHaveLength(3);

      const sent = http.requests[0]!;
      expect(sent.url).toBe("https://gateway.test/v1/messages");
      expect(sent.headers).toMatchObject({ "x-api-key": "sk-test", "anthropic-version": API_VERSION, "content-type": "application/json" });
      expect(sent.body).toMatchObject({ model: "claude-opus-5", stream: true, thinking: { type: "adaptive" }, system: [{ type: "text", text: "Injected by hook.", cache_control: { type: "ephemeral" } }] });
    }));
  });

  test("OAuth credentials use a bearer token", async () => {
    const http = fakeClient(() => sseResponse("text"));
    await run(Effect.gen(function* () {
      const core = yield* makeCore([llm, providerPlugin(http.client, { type: "oauth", access: "tok", refresh: "r", expiresAt: 0 })]);
      const events = yield* core.run(collect());
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
      expect(http.requests[0]!.headers).toMatchObject({ authorization: "Bearer tok", "anthropic-beta": "oauth-2025-04-20" });
      expect(http.requests[0]!.headers).not.toHaveProperty("x-api-key");
    }));
  });
});
