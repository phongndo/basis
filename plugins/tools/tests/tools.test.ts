import { describe, expect, test } from "bun:test";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Schema, Scope, Stream, Tracer } from "effect";
import { definePlugin, Events, makeCore, PluginContext } from "@basis/core";
import type { Handler } from "@basis/core";
import { ToolError, ToolExecuteHook, ToolExecuted, ToolInvocation, ToolResult, Tools } from "@basis/contracts";
import type { Tool, ToolContext } from "@basis/contracts";
import tools from "../src/index.ts";

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect));
const text = (value: string) => new ToolResult({ content: [{ type: "text", text: value }] });
const invocation = (name: string, input: unknown) => new ToolInvocation({ sessionId: "s", toolCallId: "c", name, input, cwd: "/" });

const Echo = Schema.Struct({ value: Schema.String, times: Schema.optional(Schema.Int) });
const echo: Tool<typeof Echo.Type> = {
  name: "echo", description: "Repeats the value.", input: Echo,
  execute: async ({ value, times }) => text(value.repeat(times ?? 1)),
};

function failure<E>(exit: Exit.Exit<unknown, E>): E {
  if (Exit.isSuccess(exit)) throw new Error("Expected failure");
  return Option.getOrThrow(Cause.failureOption(exit.cause));
}

/** A plugin that registers the given tools for the plugin's lifetime. */
const registering = (id: string, ...list: Tool<any>[]) => definePlugin({
  id, requires: [Tools],
  layer: Layer.scopedDiscard(Effect.flatMap(Tools, (registry) => Effect.forEach(list, (tool) => registry.register(tool)))),
});

const gate = (id: string, handler: Handler<ToolInvocation, ToolResult, ToolError>, order = 0) => definePlugin({
  id, layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.on(ToolExecuteHook, handler, { order }))),
});

const configured = (maxResultChars?: number) => ({ configs: maxResultChars === undefined ? {} : { tools: { maxResultChars } } });

describe("registry", () => {
  test("lists definitions sorted by name with a closed JSON Schema", async () => {
    const nested: Tool<any> = {
      name: "alpha", description: "First.", input: Schema.Struct({ where: Schema.Struct({ path: Schema.String }) }),
      execute: async () => text(""),
    };
    await run(Effect.gen(function* () {
      const core = yield* makeCore([tools, registering("provider", echo, nested)]);
      const list = yield* core.run(Effect.flatMap(Tools, (registry) => registry.list));
      expect(list.map((definition) => definition.name)).toEqual(["alpha", "echo"]);
      expect(list[1]?.inputSchema).toEqual({
        type: "object", required: ["value"],
        properties: { value: { type: "string" }, times: { $ref: "#/$defs/Int" } },
        additionalProperties: false,
        $defs: { Int: { type: "integer", description: "an integer", title: "int" } },
      });
      expect(list[0]?.inputSchema["$schema"]).toBeUndefined();
      expect((list[0]?.inputSchema["properties"] as any).where.additionalProperties).toBe(false);
    }));
  });

  test("rejects duplicate names and removes tools when the registering scope closes", async () => {
    await run(Effect.gen(function* () {
      const core = yield* makeCore([tools]);
      const registry = yield* core.run(Tools);
      const scope = yield* Scope.make();
      yield* registry.register(echo).pipe(Scope.extend(scope));
      const duplicate = yield* Effect.exit(registry.register({ ...echo, description: "Again." }).pipe(Scope.extend(scope)));
      expect(failure(duplicate)).toMatchObject({ _tag: "ToolError", tool: "echo", message: expect.stringContaining("already registered") });
      expect((yield* registry.list).length).toBe(1);
      yield* Scope.close(scope, Exit.void);
      expect(yield* registry.list).toEqual([]);
      const gone = yield* Effect.exit(registry.execute(invocation("echo", { value: "x" })));
      expect(failure(gone)).toMatchObject({ reason: "NotFound" });
    }));
  });
});

describe("execute", () => {
  test("unknown tools and invalid input fail before any handler runs", async () => {
    let handlerCalls = 0;
    await run(Effect.gen(function* () {
      const core = yield* makeCore([tools, registering("provider", echo), gate("counter", (input, next) => { handlerCalls++; return next(input); })]);
      const registry = yield* core.run(Tools);
      expect(failure(yield* Effect.exit(registry.execute(invocation("nope", {}))))).toMatchObject({ reason: "NotFound", tool: "nope" });
      const invalid = failure(yield* Effect.exit(registry.execute(invocation("echo", { value: 3 }))));
      expect(invalid).toMatchObject({ reason: "InvalidInput", tool: "echo" });
      expect(invalid.message).toContain("Expected string, actual 3");
      expect(handlerCalls).toBe(0);
      expect(yield* registry.execute(invocation("echo", { value: "ab", times: 2 }))).toEqual(text("abab"));
      expect(handlerCalls).toBe(1);
    }));
  });

  test("handlers run in order, may rewrite the call, and block by not calling next", async () => {
    const seen: string[] = [];
    const rewrite = gate("rewrite", (input, next) => {
      seen.push("rewrite");
      return next(new ToolInvocation({ ...input, input: { value: "rewritten" } }));
    }, 1);
    const observe = gate("observe", (input, next) => Effect.tap(next(input), () => Effect.sync(() => { seen.push("observe"); })), 2);
    const block = gate("block", (input, next) => input.name === "echo" && (input.input as any).value === "secret"
      ? Effect.succeed(new ToolResult({ content: [{ type: "text", text: "blocked by policy" }], isError: true }))
      : next(input), 0);
    const deny = gate("deny", (input, next) => (input.input as any).value === "denied"
      ? Effect.fail(new ToolError({ tool: input.name, reason: "Blocked", message: "denied" }))
      : next(input), 0);
    await run(Effect.gen(function* () {
      const core = yield* makeCore([tools, registering("provider", echo), observe, rewrite, block, deny]);
      const registry = yield* core.run(Tools);
      expect(yield* registry.execute(invocation("echo", { value: "original" }))).toEqual(text("rewritten"));
      expect(seen).toEqual(["rewrite", "observe"]);
      const blocked = yield* registry.execute(invocation("echo", { value: "secret" }));
      expect(blocked).toMatchObject({ isError: true, content: [{ type: "text", text: "blocked by policy" }] });
      expect(failure(yield* Effect.exit(registry.execute(invocation("echo", { value: "denied" }))))).toMatchObject({ reason: "Blocked" });
      expect(seen).toEqual(["rewrite", "observe"]);
    }));
  });

  test("rewritten invocations are validated by the terminal", async () => {
    const bad = gate("bad", (input, next) => next(new ToolInvocation({ ...input, input: { value: 1 } })));
    await run(Effect.gen(function* () {
      const core = yield* makeCore([tools, registering("provider", echo), bad]);
      const registry = yield* core.run(Tools);
      expect(failure(yield* Effect.exit(registry.execute(invocation("echo", { value: "fine" }))))).toMatchObject({ reason: "InvalidInput" });
    }));
  });

  test("publishes ToolExecuted with the result and duration", async () => {
    await run(Effect.gen(function* () {
      const core = yield* makeCore([tools, registering("provider", echo)]);
      const events = yield* core.run(Events);
      const published = yield* Effect.fork(Stream.runHead(events.stream(ToolExecuted)));
      yield* Effect.sleep(Duration.millis(5));
      const registry = yield* core.run(Tools);
      yield* registry.execute(invocation("echo", { value: "hi" }));
      const payload = Option.getOrThrow(yield* Fiber.join(published));
      expect(payload.invocation.name).toBe("echo");
      expect(payload.result).toEqual(text("hi"));
      expect(payload.durationMs).toBeGreaterThanOrEqual(0);
    }));
  });

  test("thrown errors, rejections, Effect failures, and defects become ToolError Failed", async () => {
    const throwing: Tool<any> = { name: "throwing", description: "", input: Schema.Struct({}), execute: () => { throw new Error("sync boom"); } };
    const rejecting: Tool<any> = { name: "rejecting", description: "", input: Schema.Struct({}), execute: async () => { throw new Error("async boom"); } };
    const failing: Tool<any> = { name: "failing", description: "", input: Schema.Struct({}), execute: () => Effect.fail("effect boom") };
    const dying: Tool<any> = { name: "dying", description: "", input: Schema.Struct({}), execute: () => Effect.die(new Error("defect boom")) };
    const typed: Tool<any> = {
      name: "typed", description: "", input: Schema.Struct({}),
      execute: () => Effect.fail(new ToolError({ tool: "typed", reason: "Cancelled", message: "kept as is" })),
    };
    await run(Effect.gen(function* () {
      const core = yield* makeCore([tools, registering("provider", throwing, rejecting, failing, dying, typed)]);
      const registry = yield* core.run(Tools);
      for (const [name, message] of [["throwing", "sync boom"], ["rejecting", "async boom"], ["failing", "effect boom"], ["dying", "defect boom"]]) {
        const error = failure(yield* Effect.exit(registry.execute(invocation(name!, {}))));
        expect(error).toMatchObject({ _tag: "ToolError", tool: name, reason: "Failed", message });
      }
      expect(failure(yield* Effect.exit(registry.execute(invocation("typed", {}))))).toMatchObject({ reason: "Cancelled", message: "kept as is" });
    }));
  });

  test("interrupting a promise tool aborts its signal; an Effect tool is interrupted", async () => {
    let promiseSignal: AbortSignal | undefined;
    let effectSignal: AbortSignal | undefined;
    const started = await Effect.runPromise(Deferred.make<void>());
    const waiting: Tool<any> = {
      name: "waiting", description: "", input: Schema.Struct({}),
      execute: (_input, context: ToolContext) => {
        promiseSignal = context.signal;
        Effect.runSync(Deferred.succeed(started, undefined));
        return new Promise<ToolResult>((resolve) => context.signal.addEventListener("abort", () => resolve(text("aborted"))));
      },
    };
    const effectful: Tool<any> = {
      name: "effectful", description: "", input: Schema.Struct({}),
      execute: (_input, context: ToolContext) => { effectSignal = context.signal; return Effect.never; },
    };
    await run(Effect.gen(function* () {
      const core = yield* makeCore([tools, registering("provider", waiting, effectful)]);
      const registry = yield* core.run(Tools);
      const fiber = yield* Effect.fork(registry.execute(invocation("waiting", {})));
      yield* Deferred.await(started);
      expect(promiseSignal?.aborted).toBe(false);
      const exit = yield* Fiber.interrupt(fiber);
      expect(Exit.isInterrupted(exit)).toBe(true);
      expect(promiseSignal?.aborted).toBe(true);

      const other = yield* Effect.fork(registry.execute(invocation("effectful", {})));
      yield* Effect.sleep(Duration.millis(5));
      expect(Exit.isInterrupted(yield* Fiber.interrupt(other))).toBe(true);
      expect(effectSignal?.aborted).toBe(true);
    }));
  });

  test("each execution is a span attributed to the tools plugin", async () => {
    const spans: Tracer.Span[] = [];
    await Effect.runPromise(Tracer.tracerWith((base) => {
      const tracer = Tracer.make({
        context: (evaluate, fiber) => base.context(evaluate, fiber),
        span: (...args) => { const span = base.span(...args); spans.push(span); return span; },
      });
      return Effect.scoped(Effect.gen(function* () {
        const core = yield* makeCore([tools, registering("provider", echo)]);
        yield* core.run(Effect.flatMap(Tools, (registry) => registry.execute(invocation("echo", { value: "x" }))));
      })).pipe(Effect.withTracer(tracer));
    }));
    const span = spans.find((candidate) => candidate.name === "tools.execute echo");
    expect(span?.attributes.get("plugin.id")).toBe("tools");
    expect(span?.status._tag).toBe("Ended");
  });

  test("caps result text at the configured limit and keeps images", async () => {
    const big: Tool<any> = {
      name: "big", description: "", input: Schema.Struct({}),
      execute: async () => new ToolResult({ content: [
        { type: "text", text: "a".repeat(60) },
        { type: "image", mediaType: "image/png", source: { kind: "base64", data: "AAAA" } },
        { type: "text", text: "b".repeat(60) },
      ] }),
    };
    await run(Effect.gen(function* () {
      const core = yield* makeCore([tools, registering("provider", big)], configured(100));
      const registry = yield* core.run(Tools);
      const result = yield* registry.execute(invocation("big", {}));
      expect(result.content.length).toBe(3);
      expect(result.content[0]).toEqual({ type: "text", text: "a".repeat(60) });
      expect(result.content[1]).toMatchObject({ type: "image" });
      const last = result.content[2];
      expect(last?.type === "text" && last.text).toBe("b".repeat(40) + "\n\n[output truncated: showing 100 of 120 characters]");

      const loose = yield* makeCore([tools, registering("provider", big)], configured());
      const untouched = yield* (yield* loose.run(Tools)).execute(invocation("big", {}));
      expect(untouched.content.length).toBe(3);
    }));
  });
});
