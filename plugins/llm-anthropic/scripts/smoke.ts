/**
 * Streams one real request. Not a test: needs ANTHROPIC_API_KEY and spends tokens.
 *
 *   ANTHROPIC_API_KEY=... nix develop -c bun run --cwd plugins/llm-anthropic smoke [model] [prompt]
 */
import { Effect, Layer, Option, Stream } from "effect";
import { definePlugin, makeCore } from "@basis/core";
import { Credentials, Llm, LlmRequest, Message } from "@basis/contracts";
import llm from "@basis/plugin-llm";
import anthropic, { DEFAULT_MODEL } from "../src/index.ts";

const key = process.env["ANTHROPIC_API_KEY"];
if (key === undefined || key === "") {
  console.error("Set ANTHROPIC_API_KEY to run the smoke test.");
  process.exit(1);
}
const model = `anthropic/${process.argv[2] ?? DEFAULT_MODEL}`;
const prompt = process.argv[3] ?? "In one sentence, what is a plugin kernel?";

const unused = Effect.die("smoke test does not use this");
const credentials = definePlugin({
  id: "credentials",
  provides: [Credentials],
  layer: Layer.succeed(Credentials, {
    resolve: () => Effect.succeed(Option.some({ type: "api-key", key })),
    set: () => unused, remove: () => unused, list: unused, registerMethod: () => unused, methods: Effect.succeed([]), login: () => unused,
  }),
});

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const core = yield* makeCore([llm, credentials, anthropic]);
  const request = new LlmRequest({ model, effort: "low", maxTokens: 1024, messages: [new Message({ role: "user", parts: [{ type: "text", text: prompt }] })] });
  yield* core.run(Effect.flatMap(Llm, (service) => Stream.runForEach(service.stream(request), (event) => Effect.sync(() => {
    switch (event.type) {
      case "text-delta": process.stdout.write(event.text); break;
      case "thinking-delta": process.stderr.write(event.text); break;
      case "usage": console.log(`\n[usage] ${JSON.stringify(event.usage)}`); break;
      case "finish": console.log(`[finish] ${event.reason}; ${event.message.parts.length} part(s)`); break;
      default: console.log(`[${event.type}]`);
    }
  }))));
})));
