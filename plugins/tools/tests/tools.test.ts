import { Chunk, Effect, Fiber, Layer, Schema, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { definePlugin, Events, makeCore, PluginContext } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { ToolExecuted, ToolExecuteHook, ToolInvocation, ToolResult, Tools } from "@lemma/contracts";
import type { Guard, Tool } from "@lemma/contracts";
import tools, { toolParameters } from "../src/index.ts";

const ok = (text: string) => new ToolResult({ content: [{ type: "text", text }] });
const textOf = (result: ToolResult) => result.content.map((part) => (part.type === "text" ? part.text : "<image>")).join("");

const echo: Tool<{ readonly text: string }> = {
  name: "echo",
  description: "Echoes text.",
  input: Schema.Struct({ text: Schema.String.annotations({ description: "What to say" }) }),
  execute: async ({ text }) => ok(text),
};

const contributor = (id: string, contributed: readonly Tool<any>[], guards: readonly [string, Guard][] = []) =>
  definePlugin({
    id,
    requires: [Tools],
    layer: Layer.scopedDiscard(
      Effect.gen(function* () {
        const registry = yield* Tools;
        for (const tool of contributed) yield* registry.register(tool);
        for (const [name, guard] of guards) yield* registry.guard(name, guard);
      }),
    ),
  });

const call = (name: string, input: unknown, signal = new AbortController().signal) =>
  Effect.flatMap(Tools, (registry) => registry.execute(new ToolInvocation({ sessionId: "s", toolCallId: "c1", name, input, cwd: "/tmp" }), signal));

const run = <A, E>(plugins: readonly Plugin[], body: Effect.Effect<A, E, Tools | Events>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([tools, ...plugins]);
        return yield* core.run(body);
      }),
    ),
  );

describe("registry", () => {
  it("lists tools by name with the registering plugin as source and clean schemas", async () => {
    const Point = Schema.Struct({ x: Schema.Number }).annotations({ identifier: "Point" });
    const shapes: Tool<any> = {
      name: "shapes",
      description: "d",
      input: Schema.Struct({
        count: Schema.optional(Schema.Int.pipe(Schema.positive()).annotations({ description: "How many" })),
        points: Schema.Array(Point),
      }),
      execute: async () => ok(""),
    };
    const listed = await run(
      [contributor("mine", [shapes, echo])],
      Effect.flatMap(Tools, (registry) => registry.list),
    );
    expect(listed.map((tool) => [tool.spec.name, tool.source])).toEqual([
      ["echo", "mine"],
      ["shapes", "mine"],
    ]);
    const parameters = listed[1]!.spec.parameters;
    expect(JSON.stringify(parameters)).not.toMatch(/\$schema|\$ref|\$defs|"title"/);
    expect(parameters).toEqual({
      type: "object",
      required: ["points"],
      properties: {
        count: { type: "integer", description: "How many", exclusiveMinimum: 0 },
        points: { type: "array", items: { type: "object", required: ["x"], properties: { x: { type: "number" } }, additionalProperties: false } },
      },
      additionalProperties: false,
    });
  });

  it("gives non-object inputs an object root", () => {
    expect(toolParameters(Schema.Unknown)).toEqual({ type: "object", properties: {} });
  });

  it("rejects a duplicate name, failing the second contributor", async () => {
    const failure = await Effect.runPromise(Effect.scoped(Effect.flip(makeCore([tools, contributor("a", [echo]), contributor("b", [echo])]))));
    expect(String(JSON.stringify(failure))).toContain("already registered by a");
  });

  it("removes a tool when its registering scope closes", async () => {
    await run(
      [],
      Effect.gen(function* () {
        const registry = yield* Tools;
        const scope = yield* Scope.make();
        const identity = { id: "temp" } as unknown as PluginContext["Type"];
        yield* registry.register(echo).pipe(Effect.provideService(PluginContext, identity), Scope.extend(scope));
        expect((yield* registry.list).map((tool) => tool.source)).toEqual(["temp"]);
        yield* Scope.close(scope, { _tag: "Success", value: undefined } as never);
        expect(yield* registry.list).toEqual([]);
      }),
    );
  });
});

describe("execute", () => {
  it("returns results, validation errors, and tool failures as results; unknown tools fail", async () => {
    const throwing: Tool<unknown> = {
      name: "throws",
      description: "",
      input: Schema.Unknown,
      execute: () => {
        throw new Error("boom");
      },
    };
    const failing: Tool<unknown> = { name: "fails", description: "", input: Schema.Unknown, execute: () => Effect.fail(new Error("effect failed")) };
    const rejecting: Tool<unknown> = {
      name: "rejects",
      description: "",
      input: Schema.Unknown,
      execute: async () => {
        throw new Error("rejected");
      },
    };
    const malformed: Tool<unknown> = { name: "malformed", description: "", input: Schema.Unknown, execute: async () => ({ nope: 1 }) as never };
    await run(
      [contributor("p", [echo, throwing, failing, rejecting, malformed])],
      Effect.gen(function* () {
        expect(textOf(yield* call("echo", { text: "hi" }))).toBe("hi");
        const invalid = yield* call("echo", { text: 1 });
        expect(invalid.isError).toBe(true);
        expect(textOf(invalid)).toContain('Validation failed for tool "echo"');
        expect(textOf(yield* call("throws", {}))).toBe("boom");
        expect(textOf(yield* call("fails", {}))).toBe("effect failed");
        expect(textOf(yield* call("rejects", {}))).toBe("rejected");
        expect(textOf(yield* call("malformed", {}))).toContain("invalid result");
        const missing = yield* Effect.flip(call("nope", {}));
        expect(missing.reason).toBe("NotFound");
        expect(missing.message).toContain("Available tools: echo");
      }),
    );
  });

  it("runs guards after every hook handler; any deny wins and is scoped by tool name", async () => {
    const seen: string[] = [];
    const rewriter = definePlugin({
      id: "rewriter",
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const owner = yield* PluginContext;
          yield* owner.on(ToolExecuteHook, (invocation, next) => {
            seen.push(`hook:${JSON.stringify(invocation.input)}`);
            return next(new ToolInvocation({ ...invocation, input: { text: "rewritten" } }));
          });
        }),
      ),
    });
    const guards: [string, Guard][] = [
      [
        "*",
        (invocation) =>
          Effect.sync(() => {
            seen.push(`guard:${JSON.stringify(invocation.input)}`);
            return { _tag: "allow" };
          }),
      ],
      [
        "echo",
        (invocation) =>
          Effect.succeed((invocation.input as { text: string }).text === "rewritten" ? { _tag: "deny", reason: "no rewrites" } : { _tag: "allow" }),
      ],
      ["other", () => Effect.succeed({ _tag: "deny", reason: "never applies to echo" })],
    ];
    await run(
      [contributor("p", [echo], guards), rewriter],
      Effect.gen(function* () {
        const result = yield* call("echo", { text: "original" });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe("Tool call denied: no rewrites");
        expect(result.details).toEqual({ deniedBy: "p" });
        expect(seen).toEqual(['hook:{"text":"original"}', 'guard:{"text":"rewritten"}']);
      }),
    );
  });

  it("re-validates input a handler rewrote", async () => {
    const breaker = definePlugin({
      id: "breaker",
      layer: Layer.effectDiscard(
        Effect.flatMap(PluginContext, (owner) =>
          owner.on(ToolExecuteHook, (invocation, next) => next(new ToolInvocation({ ...invocation, input: { text: 42 } }))),
        ),
      ),
    });
    await run(
      [contributor("p", [echo]), breaker],
      Effect.gen(function* () {
        const result = yield* call("echo", { text: "fine" });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("Validation failed");
      }),
    );
  });

  it("aborts a promise tool through its signal and interrupts an Effect tool", async () => {
    let promiseAborted = false;
    let effectInterrupted = false;
    const slowPromise: Tool<unknown> = {
      name: "slow-promise",
      description: "",
      input: Schema.Unknown,
      execute: (_, context) =>
        new Promise<ToolResult>(() => {
          context.signal.addEventListener("abort", () => {
            promiseAborted = true;
          });
        }),
    };
    const slowEffect: Tool<unknown> = {
      name: "slow-effect",
      description: "",
      input: Schema.Unknown,
      execute: () =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              effectInterrupted = true;
            }),
          ),
        ),
    };
    await run(
      [contributor("p", [slowPromise, slowEffect])],
      Effect.gen(function* () {
        for (const name of ["slow-promise", "slow-effect"]) {
          const controller = new AbortController();
          const fiber = yield* Effect.fork(call(name, {}, controller.signal));
          yield* Effect.sleep(10);
          controller.abort();
          const error = yield* Effect.flip(Fiber.join(fiber));
          expect(error.reason).toBe("Cancelled");
        }
        expect(promiseAborted).toBe(true);
        expect(effectInterrupted).toBe(true);
      }),
    );
  });

  it("truncates long text and publishes ToolExecuted", async () => {
    const long: Tool<unknown> = { name: "long", description: "", input: Schema.Unknown, execute: async () => ok("x".repeat(50)) };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* makeCore([tools, contributor("p", [long])], { configs: { tools: { maxResultChars: 10 } } });
          yield* core.run(
            Effect.gen(function* () {
              const events = yield* Events;
              const executed = yield* Effect.fork(Stream.runCollect(Stream.take(events.stream(ToolExecuted), 1)));
              yield* Effect.yieldNow();
              const result = yield* call("long", {});
              expect(textOf(result)).toBe(`${"x".repeat(10)}\n\n[Output truncated: showing 10 of 50 characters]`);
              const [payload] = Chunk.toArray(yield* Fiber.join(executed));
              expect(payload!.invocation.name).toBe("long");
              expect(payload!.result).toEqual(result);
            }),
          );
        }),
      ),
    );
  });
});
