import { Duration, Effect, JSONSchema, Layer, Schema } from "effect";
import { definePlugin, makeLoader, PluginContext } from "@basis/core";
import type { Loader, Plugin } from "@basis/core";
import { Notice, ToolDefinition, ToolError, ToolResult, Tools } from "@basis/contracts";
import type { Tool, ToolContext } from "@basis/contracts";

/** In-memory Tools: enough of the contract to register, list, and execute (no hook, no gate). */
export const fakeTools = definePlugin({
  id: "tools",
  provides: [Tools],
  layer: Layer.sync(Tools, () => {
    const registry = new Map<string, Tool<any>>();
    return {
      register: (tool) => Effect.acquireRelease(
        Effect.gen(function* () {
          if (registry.has(tool.name)) return yield* new ToolError({ tool: tool.name, reason: "Failed", message: `duplicate tool "${tool.name}"` });
          registry.set(tool.name, tool);
        }),
        () => Effect.sync(() => { registry.delete(tool.name); }),
      ),
      list: Effect.sync(() => [...registry.values()].map((tool) =>
        new ToolDefinition({ name: tool.name, description: tool.description, inputSchema: JSONSchema.make(tool.input) as unknown as Record<string, unknown> }))),
      execute: (invocation) => Effect.gen(function* () {
        const tool = registry.get(invocation.name);
        if (!tool) return yield* new ToolError({ tool: invocation.name, reason: "NotFound", message: "no such tool" });
        const input = yield* Schema.decodeUnknown(tool.input)(invocation.input).pipe(
          Effect.mapError((cause) => new ToolError({ tool: invocation.name, reason: "InvalidInput", message: String(cause), cause })));
        const context: ToolContext = { sessionId: invocation.sessionId, toolCallId: invocation.toolCallId, cwd: invocation.cwd, signal: new AbortController().signal };
        const outcome = tool.execute(input, context);
        const result = yield* (outcome instanceof Promise ? Effect.promise(() => outcome) : outcome).pipe(
          Effect.mapError((cause) => cause instanceof ToolError ? cause : new ToolError({ tool: invocation.name, reason: "Failed", message: String(cause), cause })));
        return result as ToolResult;
      }),
    };
  }),
});

export interface Collected { level: string; message: string; source?: string }

/** Collects notices so tests can assert on what the user would have been told. */
export const noticeCollector = (sink: Collected[]) => definePlugin({
  id: "notices",
  layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.observe(Notice, (notice) => Effect.sync(() => { sink.push(notice); })))),
});

/**
 * Mounts tools and the notice collector first, then adds the plugin under test,
 * so observers are already visible when the plugin starts publishing.
 */
export const mountAfterObservers = (plugin: Plugin, config: unknown, sink: Collected[]) =>
  Effect.gen(function* () {
    const definitions = new Map<string, Plugin>([["tools", fakeTools], ["notices", noticeCollector(sink)], [plugin.id, plugin]]);
    const loader: Loader = yield* makeLoader({
      source: { resolve: (id) => Effect.succeed(definitions.get(id)!) },
      composition: { plugins: { tools: {}, notices: {} } },
    });
    yield* loader.apply({ plugins: { tools: {}, notices: {}, [plugin.id]: { config } } });
    return loader.core;
  });

export function waitFor<A, E, R>(effect: Effect.Effect<A, E, R>, predicate: (value: A) => boolean, seconds = 5): Effect.Effect<A, E, R> {
  const poll: Effect.Effect<A, E, R> = Effect.flatMap(effect, (value) =>
    predicate(value) ? Effect.succeed(value) : Effect.sleep(Duration.millis(10)).pipe(Effect.zipRight(poll)));
  return poll.pipe(Effect.timeout(Duration.seconds(seconds)), Effect.orDie);
}
