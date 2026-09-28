import { Cause, Effect, ParseResult, Schema } from "effect";
import type { Context } from "effect";
import { Events, Hooks, PluginContext } from "@basis/core";
import { ToolError, ToolExecuteHook, ToolExecuted, ToolResult } from "@basis/contracts";
import type { Guard, Tool, ToolContext, ToolContribution, ToolInvocation, Tools } from "@basis/contracts";
import { capResult } from "./content.ts";
import { toolParameters } from "./schema.ts";

type Service = Context.Tag.Service<typeof Tools>;

export interface RegistryOptions {
  /** Total text characters a result may carry to the model before it is truncated. */
  readonly maxResultChars: number;
}

/** A registered tool: schema converted and decoder built once. */
interface Entry {
  readonly tool: Tool<any>;
  readonly contribution: ToolContribution;
  readonly decode: (input: unknown) => Effect.Effect<unknown, ToolError>;
}

interface GuardEntry {
  /** A tool name, or `*` for every tool. */
  readonly name: string;
  readonly source: string;
  readonly guard: Guard;
}

const message = (cause: unknown): string => cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

export const errorResult = (text: string, details?: unknown): ToolResult =>
  new ToolResult({ content: [{ type: "text", text }], isError: true, ...(details === undefined ? {} : { details }) });

const decodeResult = Schema.decodeUnknownEither(ToolResult);

/**
 * Runs a tool's `execute`, whichever shape it returns. A promise tool gets a
 * signal that aborts when the caller's signal does or when this fiber is
 * interrupted; an Effect tool is interrupted. Throws, rejections, failures,
 * defects, and malformed results become error results; interruption stays
 * interruption.
 */
function runTool(tool: Tool<any>, input: unknown, base: Omit<ToolContext, "signal">, outer: AbortSignal): Effect.Effect<ToolResult> {
  return Effect.suspend(() => {
    const controller = new AbortController();
    const forward = () => controller.abort(outer.reason);
    outer.addEventListener("abort", forward, { once: true });
    const context: ToolContext = { ...base, signal: controller.signal };
    let output: Promise<ToolResult> | Effect.Effect<ToolResult, unknown>;
    try {
      output = tool.execute(input, context);
    } catch (cause) {
      return Effect.succeed(errorResult(message(cause)));
    }
    const running: Effect.Effect<unknown, unknown> = Effect.isEffect(output)
      ? output
      : Effect.tryPromise({ try: () => output as Promise<ToolResult>, catch: (cause) => cause });
    return running.pipe(
      Effect.map((value) => {
        const decoded = decodeResult(value);
        return decoded._tag === "Right" ? decoded.right : errorResult(`Tool "${tool.name}" returned an invalid result: ${decoded.left.message}`);
      }),
      Effect.catchAllCause((cause) => Cause.isInterruptedOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.succeed(errorResult(message(Cause.squash(cause))))),
      Effect.onInterrupt(() => Effect.sync(() => controller.abort("interrupted"))),
      Effect.ensuring(Effect.sync(() => outer.removeEventListener("abort", forward))),
    );
  });
}

/** Fails with `Cancelled` once the signal aborts. */
const aborted = (tool: string, signal: AbortSignal) => Effect.async<never, ToolError>((resume) => {
  const cancel = () => resume(Effect.fail(new ToolError({ tool, reason: "Cancelled", message: `Tool "${tool}" was cancelled` })));
  if (signal.aborted) {
    cancel();
    return;
  }
  signal.addEventListener("abort", cancel, { once: true });
  return Effect.sync(() => signal.removeEventListener("abort", cancel));
});

export const makeRegistry = (options: RegistryOptions): Effect.Effect<Service, never, Hooks | Events | PluginContext> =>
  Effect.gen(function* () {
    const hooks = yield* Hooks;
    const events = yield* Events;
    const owner = yield* PluginContext;
    const entries = new Map<string, Entry>();
    let guards: readonly GuardEntry[] = [];

    const register: Service["register"] = (tool) => Effect.gen(function* () {
      const { id: source } = yield* PluginContext;
      const decodeInput = Schema.decodeUnknown(tool.input);
      const entry: Entry = {
        tool,
        contribution: { source, spec: { name: tool.name, description: tool.description, parameters: toolParameters(tool.input) } },
        decode: (input) => decodeInput(input, { errors: "all", onExcessProperty: "ignore" }).pipe(Effect.mapError((error) => new ToolError({
          tool: tool.name,
          reason: "InvalidInput",
          message: `Validation failed for tool "${tool.name}":\n${ParseResult.TreeFormatter.formatErrorSync(error)}`,
          cause: error,
        }))),
      };
      yield* Effect.acquireRelease(
        Effect.suspend(() => {
          const existing = entries.get(tool.name);
          if (existing !== undefined) {
            return Effect.fail(new ToolError({
              tool: tool.name, reason: "InvalidInput",
              message: `Tool "${tool.name}" is already registered by ${existing.contribution.source}`,
            }));
          }
          entries.set(tool.name, entry);
          return Effect.void;
        }),
        () => Effect.sync(() => { if (entries.get(tool.name) === entry) entries.delete(tool.name); }),
      );
    });

    const guard: Service["guard"] = (name, check) => Effect.gen(function* () {
      const { id: source } = yield* PluginContext;
      const entry: GuardEntry = { name, source, guard: check };
      yield* Effect.acquireRelease(
        Effect.sync(() => { guards = [...guards, entry]; }),
        () => Effect.sync(() => { guards = guards.filter((candidate) => candidate !== entry); }),
      );
    });

    const list: Service["list"] = Effect.sync(() =>
      [...entries.values()].map((entry) => entry.contribution).sort((a, b) => a.spec.name < b.spec.name ? -1 : a.spec.name > b.spec.name ? 1 : 0));

    const unknown = (name: string) => new ToolError({
      tool: name, reason: "NotFound",
      message: `Tool "${name}" not found. Available tools: ${[...entries.keys()].sort().join(", ") || "(none)"}`,
    });

    /** Guards, then the tool. Runs as the hook's terminal so no handler can route around a guard. */
    const terminal = (original: ToolInvocation, decoded: unknown, signal: AbortSignal) => (call: ToolInvocation): Effect.Effect<ToolResult, ToolError> => Effect.gen(function* () {
      const entry = entries.get(call.name);
      if (entry === undefined) return yield* unknown(call.name);
      // A handler that rewrote the call gets its input validated again.
      const input = call === original ? decoded : yield* entry.decode(call.input);
      for (const candidate of guards) {
        if (candidate.name !== "*" && candidate.name !== call.name) continue;
        const decision = yield* candidate.guard(call);
        if (decision._tag === "deny") return errorResult(`Tool call denied: ${decision.reason}`, { deniedBy: candidate.source });
      }
      return yield* runTool(entry.tool, input, { sessionId: call.sessionId, toolCallId: call.toolCallId, cwd: call.cwd }, signal);
    });

    const execute: Service["execute"] = (invocation, signal) => owner.trace(`tools.execute ${invocation.name}`, Effect.gen(function* () {
      const entry = entries.get(invocation.name);
      if (entry === undefined) return yield* unknown(invocation.name);
      if (signal.aborted) return yield* new ToolError({ tool: invocation.name, reason: "Cancelled", message: `Tool "${invocation.name}" was cancelled` });
      const started = Date.now();
      const settled = yield* entry.decode(invocation.input).pipe(
        Effect.flatMap((decoded) => hooks.invoke(ToolExecuteHook, invocation, terminal(invocation, decoded, signal))),
        Effect.map((result) => capResult(result, options.maxResultChars)),
        // Handler failures, invalid input, and denials are results the model reads and can act on.
        Effect.catchAll((error) => Effect.succeed(errorResult(error.message))),
        Effect.raceFirst(aborted(invocation.name, signal)),
      );
      yield* events.publish(ToolExecuted, { invocation, result: settled, durationMs: Date.now() - started });
      return settled;
    }));

    return { register, guard, list, execute } satisfies Service;
  });
