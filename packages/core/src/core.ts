import { Cause, Context, Deferred, Effect, Either, Exit, Fiber, Layer, ParseResult, Schema, Scope, Stream, Tracer } from "effect";
import { ActivationError, CapabilityMismatch, CompositionError, CoreClosed } from "./errors.ts";
import type { PluginFault } from "./errors.ts";
import { Events } from "./events.ts";
import { Hooks, PluginContext } from "./hooks.ts";
import { plan } from "./internal/graph.ts";
import { attributes, HookRegistry, notImplemented } from "./internal/hooks.ts";
import type { HookSnapshot } from "./internal/hooks.ts";
import type { Deadlines, Identifiers, Plugin } from "./plugin.ts";

/**
 * Lifecycle, distinct from health. "draining" no longer admits work while
 * in-flight work finishes; "failed" is stopped after a runtime fault and stays
 * so until restarted by policy or explicitly.
 */
export type PluginState = "pending" | "activating" | "active" | "draining" | "closed" | "failed";

export interface PluginSnapshot {
  readonly id: string;
  readonly version?: string;
  readonly state: PluginState;
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  /** The most recent fault, retained while the plugin is failed. */
  readonly fault?: PluginFault;
}

export interface CoreOptions {
  /** Config per plugin id, decoded with each plugin's schema before any activation. */
  readonly configs?: Readonly<Record<string, unknown>>;
  /** Applied to plugins that declare none. Contract only: not enforced yet. */
  readonly deadlines?: Deadlines;
}

export interface CoreSnapshot {
  readonly state: "starting" | "active" | "closing" | "closed";
  /** Dependency order; independent plugins use code-unit id order. */
  readonly plugins: readonly PluginSnapshot[];
  readonly hooks: readonly HookSnapshot[];
}

export interface Core<Capabilities = never> {
  /**
   * Provide the composition to an Effect, preserving other caller requirements.
   * Work is interrupted and awaited before plugins are disposed. Caller interruption
   * also interrupts this work. No additional Effect runtime is created.
   */
  readonly run: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | CoreClosed, Exclude<R, Capabilities | Hooks>>;
  readonly inspect: Effect.Effect<CoreSnapshot>;
  /** Every attributed plugin failure, in order. Contract only: emits nothing yet. */
  readonly faults: Stream.Stream<PluginFault>;
}

type State = CoreSnapshot["state"];
type MutablePlugin = { -readonly [K in keyof PluginSnapshot]: PluginSnapshot[K] };

/**
 * Mount a fixed composition in the caller's Scope. Validation precedes activation;
 * failed/interrupted activation unwinds immediately, even if the caller catches it.
 * Close the owning scope to interrupt work, then dispose plugins in reverse order.
 */
export function makeCore<const Plugins extends readonly Plugin[]>(
  plugins: Plugins,
  options: CoreOptions = {},
): Effect.Effect<Core<Identifiers<Plugins[number]["provides"]>>, CompositionError | ActivationError, Scope.Scope> {
  return Effect.gen(function* () {
    const ordered = yield* plan(plugins);
    const configs = yield* decodeConfigs(ordered, options.configs ?? {});
    return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const lifetime = yield* Scope.make();
      const startup = yield* Scope.make();
      const closed = yield* Deferred.make<void>();
      const registry = new HookRegistry();
      const records: MutablePlugin[] = ordered.map((plugin) => ({
        id: plugin.id,
        ...(plugin.version === undefined ? {} : { version: plugin.version }),
        state: "pending",
        provides: plugin.provides.map((tag) => tag.key),
        requires: plugin.requires.map((tag) => tag.key),
      }));
      let state: State = "starting";
      let environment: Context.Context<never> = Context.make(Hooks, registry);
      const events: Context.Tag.Service<Events> = {
        publish: () => notImplemented("Events.publish"),
        stream: () => Stream.fromEffect(notImplemented("Events.stream")),
      };

      const shutdown = (exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> =>
        Effect.uninterruptible(Effect.suspend(() => {
          if (state === "closing" || state === "closed") return Deferred.await(closed);
          state = "closing";
          registry.close();
          return Effect.gen(function* () {
            const result = yield* Effect.exit(Scope.close(startup, exit).pipe(
              Effect.ensuring(Scope.close(lifetime, exit)),
            ));
            environment = Context.empty();
            state = "closed";
            yield* Deferred.done(closed, result);
            return yield* result;
          });
        }));
      yield* Effect.addFinalizer(shutdown);
      const isStarting = () => state === "starting";
      if (!isStarting()) return yield* Effect.interrupt;

      const activate = Effect.gen(function* () {
        for (const [index, plugin] of ordered.entries()) {
          const record = records[index]!;
          const scope = yield* Scope.make();
          const owner = registry.owner({
            id: record.id,
            ...(record.version === undefined ? {} : { version: record.version }),
          }, scope);
          yield* Scope.addFinalizerExit(lifetime, (exit) => {
            registry.stopOwner(owner);
            return Scope.close(scope, exit).pipe(
              Effect.ensuring(Effect.sync(() => { record.state = "closed"; })),
              Effect.withSpan("core.dispose", { attributes: attributes(owner) }),
            );
          });
          record.state = "activating";
          // Only declared dependencies are visible during activation, not the entire graph.
          const inputs = new Map<string, unknown>([
            [Hooks.key, registry], [PluginContext.key, owner], [Events.key, events],
          ]);
          for (const tag of plugin.requires) {
            if (!inputs.has(tag.key)) inputs.set(tag.key, environment.unsafeMap.get(tag.key));
          }
          const build = Layer.buildWithScope(plugin.layer(configs.get(plugin.id)), scope).pipe(
            Effect.mapInputContext((caller: Context.Context<never>) => {
              const provided = new Map(inputs);
              if (caller.unsafeMap.has(Tracer.ParentSpan.key)) {
                provided.set(Tracer.ParentSpan.key, caller.unsafeMap.get(Tracer.ParentSpan.key));
              }
              return Context.unsafeMake<unknown>(provided);
            }),
            Effect.flatMap((output) => {
              const declared = new Set(record.provides);
              const missing = record.provides.filter((key) => !output.unsafeMap.has(key));
              const undeclared = [...output.unsafeMap.keys()].filter((key) => !declared.has(key));
              if (missing.length || undeclared.length) {
                return Effect.fail(new CapabilityMismatch({ pluginId: plugin.id, missing, undeclared }));
              }
              return Effect.succeed(output);
            }),
            Effect.catchAllCause((cause) => Cause.isInterruptedOnly(cause)
              ? Effect.failCause(cause as Cause.Cause<never>)
              : Effect.fail(new ActivationError({ pluginId: plugin.id, cause }))),
            Effect.withSpan("core.activate", { attributes: attributes(owner) }),
          );
          // Resource bookkeeping is masked; plugin initialization remains interruptible.
          const initializer = yield* Effect.forkIn(restore(build), startup);
          const output = yield* restore(Fiber.join(initializer)).pipe(
            Effect.onInterrupt(() => Fiber.interrupt(initializer)),
          );
          if (!isStarting()) return yield* Effect.interrupt;
          environment = Context.merge(environment, output);
          record.state = "active";
        }

        // Registered last: in-flight callers stop before any plugin resource closes.
        const work = yield* Scope.make();
        yield* Scope.addFinalizerExit(lifetime, (exit) => Scope.close(work, exit));
        state = "active";

        type Available = Identifiers<Plugins[number]["provides"]> | Hooks;
        const core: Core<Identifiers<Plugins[number]["provides"]>> = {
          run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.uninterruptibleMask((resume) => Effect.gen(function* () {
              if (state !== "active") return yield* new CoreClosed();
              const task = Effect.provide(effect, environment as Context.Context<Available>);
              const fiber = yield* Effect.forkIn(resume(task), work);
              return yield* resume(Fiber.join(fiber)).pipe(
                Effect.onInterrupt(() => Fiber.interrupt(fiber)),
              );
            })),
          inspect: Effect.sync(() => ({
            state,
            plugins: records.map((record) => ({ ...record, provides: [...record.provides], requires: [...record.requires] })),
            hooks: registry.inspect(),
          })),
          faults: Stream.never,
        };
        return core;
      });
      return yield* activate.pipe(Effect.onExit((exit) => Exit.isFailure(exit) ? shutdown(exit) : Effect.void));
    }));
  });
}

/** Config is validated for the whole composition before any plugin code runs. */
function decodeConfigs(
  plugins: readonly Plugin[],
  configs: Readonly<Record<string, unknown>>,
): Effect.Effect<ReadonlyMap<string, unknown>, CompositionError> {
  return Effect.suspend(() => {
    const decoded = new Map<string, unknown>();
    for (const plugin of plugins) {
      if (!plugin.config) continue;
      const result = Schema.decodeUnknownEither(plugin.config)(configs[plugin.id]);
      if (Either.isLeft(result)) {
        return Effect.fail(new CompositionError({
          reason: "InvalidConfig",
          message: `Invalid config for plugin "${plugin.id}":\n${ParseResult.TreeFormatter.formatErrorSync(result.left)}`,
          plugins: [plugin.id],
        }));
      }
      decoded.set(plugin.id, result.right);
    }
    return Effect.succeed(decoded);
  });
}
