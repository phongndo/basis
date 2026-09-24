import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Tracer } from "effect";
import { ActivationError, CapabilityMismatch, CoreClosed } from "./errors.ts";
import type { CompositionError } from "./errors.ts";
import { Hooks, PluginContext } from "./hooks.ts";
import { plan } from "./internal/graph.ts";
import { attributes, HookRegistry } from "./internal/hooks.ts";
import type { HookSnapshot } from "./internal/hooks.ts";
import type { Identifiers, Plugin } from "./plugin.ts";

export interface PluginSnapshot {
  readonly id: string;
  readonly version?: string;
  readonly state: "pending" | "activating" | "active" | "closed";
  readonly provides: readonly string[];
  readonly requires: readonly string[];
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
): Effect.Effect<Core<Identifiers<Plugins[number]["provides"]>>, CompositionError | ActivationError, Scope.Scope> {
  return Effect.gen(function* () {
    const ordered = yield* plan(plugins);
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
            [Hooks.key, registry], [PluginContext.key, owner],
          ]);
          for (const tag of plugin.requires) {
            if (!inputs.has(tag.key)) inputs.set(tag.key, environment.unsafeMap.get(tag.key));
          }
          const build = Layer.buildWithScope(plugin.layer, scope).pipe(
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
        };
        return core;
      });
      return yield* activate.pipe(Effect.onExit((exit) => Exit.isFailure(exit) ? shutdown(exit) : Effect.void));
    }));
  });
}
