import { Cause, Clock, Effect, ParseResult, Schema } from "effect";
import type { Context } from "effect";
import { Events, Hooks, PluginContext } from "@basis/core";
import { ToolDefinition, ToolError, ToolExecuteHook, ToolExecuted, ToolResult } from "@basis/contracts";
import type { Tool, ToolContext, ToolInvocation, Tools } from "@basis/contracts";
import { capResult } from "./content.ts";
import { toolInputSchema } from "./schema.ts";

export interface RegistryOptions {
  /** Total text characters a result may carry to the model before it is truncated. */
  readonly maxResultChars: number;
}

type Service = Context.Tag.Service<typeof Tools>;

/** A tool after registration: schema converted once, execute wrapped once. */
interface Entry {
  readonly definition: ToolDefinition;
  readonly decode: (input: unknown) => Effect.Effect<unknown, ToolError>;
  readonly run: (input: unknown, context: Omit<ToolContext, "signal">) => Effect.Effect<ToolResult, ToolError>;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

const failed = (tool: string, cause: unknown): ToolError =>
  cause instanceof ToolError ? cause : new ToolError({ tool, reason: "Failed", message: message(cause), cause });

/**
 * Wraps a registered tool's `execute` once. A promise-returning function runs
 * under `Effect.tryPromise`, whose signal aborts on interruption; an Effect runs
 * directly. Both see the same `ToolContext.signal`, so a promise tool that
 * checks its signal and an Effect tool that hands it to `fetch` behave alike.
 * Thrown errors, rejections, and defects become `ToolError` Failed so a broken
 * tool never takes down the agent loop; interruption stays interruption.
 */
function wrapExecute<I>(tool: Tool<I>): Entry["run"] {
  return (input, base) => Effect.suspend(() => {
    const controller = new AbortController();
    const context: ToolContext = { ...base, signal: controller.signal };
    let output: Promise<ToolResult> | Effect.Effect<ToolResult, unknown>;
    try {
      output = tool.execute(input as I, context);
    } catch (cause) {
      return Effect.fail(failed(tool.name, cause));
    }
    const run: Effect.Effect<ToolResult, unknown> = Effect.isEffect(output)
      ? output
      : Effect.tryPromise({
        try: (signal) => {
          signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
          return output as Promise<ToolResult>;
        },
        catch: (cause) => cause,
      });
    return run.pipe(
      Effect.onInterrupt(() => Effect.sync(() => controller.abort("interrupted"))),
      Effect.catchAllCause((cause) => Cause.isInterruptedOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(failed(tool.name, Cause.squash(cause)))),
    );
  });
}

function makeEntry<I>(tool: Tool<I>): Entry {
  const decodeInput = Schema.decodeUnknown(tool.input);
  return {
    definition: new ToolDefinition({ name: tool.name, description: tool.description, inputSchema: toolInputSchema(tool.input) }),
    decode: (input) => decodeInput(input).pipe(Effect.mapError((error) => new ToolError({
      tool: tool.name, reason: "InvalidInput",
      message: `Invalid input for tool "${tool.name}":\n${ParseResult.TreeFormatter.formatErrorSync(error)}`,
      cause: error,
    }))),
    run: wrapExecute(tool),
  };
}

export const makeRegistry = (options: RegistryOptions): Effect.Effect<Service, never, Hooks | Events | PluginContext> =>
  Effect.gen(function* () {
    const hooks = yield* Hooks;
    const events = yield* Events;
    const owner = yield* PluginContext;
    const entries = new Map<string, Entry>();

    const register: Service["register"] = (tool) => Effect.acquireRelease(
      Effect.suspend(() => {
        if (entries.has(tool.name)) {
          return Effect.fail(new ToolError({ tool: tool.name, reason: "Failed", message: `Tool "${tool.name}" is already registered` }));
        }
        const entry = makeEntry(tool);
        entries.set(tool.name, entry);
        return Effect.succeed(entry);
      }),
      (entry) => Effect.sync(() => { if (entries.get(tool.name) === entry) entries.delete(tool.name); }),
    ).pipe(Effect.asVoid);

    const list: Service["list"] = Effect.sync(() =>
      [...entries.values()].map((entry) => entry.definition).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const lookup = (name: string) => Effect.suspend(() => {
      const entry = entries.get(name);
      return entry ? Effect.succeed(entry) : Effect.fail(new ToolError({ tool: name, reason: "NotFound", message: `Unknown tool "${name}"` }));
    });

    // Validation precedes the hook so gates only ever see well-formed calls; the terminal
    // decodes again only when a handler substituted a different invocation.
    const execute: Service["execute"] = (invocation) => owner.trace(`tools.execute ${invocation.name}`, Effect.gen(function* () {
      const entry = yield* lookup(invocation.name);
      const decoded = yield* entry.decode(invocation.input);
      const terminal = (call: ToolInvocation) => Effect.gen(function* () {
        const input = call === invocation ? decoded : yield* entry.decode(call.input);
        const started = yield* Clock.currentTimeMillis;
        const result = capResult(yield* entry.run(input, { sessionId: call.sessionId, toolCallId: call.toolCallId, cwd: call.cwd }), options.maxResultChars);
        const durationMs = (yield* Clock.currentTimeMillis) - started;
        yield* events.publish(ToolExecuted, { invocation: call, result, durationMs });
        return result;
      });
      return yield* hooks.invoke(ToolExecuteHook, invocation, terminal).pipe(
        Effect.catchTags({
          HookError: (error) => Effect.fail(new ToolError({ tool: invocation.name, reason: "Failed", message: error.message, cause: error })),
          CoreClosed: (error) => Effect.fail(new ToolError({ tool: invocation.name, reason: "Cancelled", message: error.message, cause: error })),
        }),
      );
    }));

    return { register, list, execute };
  });
