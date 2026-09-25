import { Cause, Context, Data, Deferred, Duration, Effect, Either, Exit, Fiber, Layer, Option, PubSub, Schedule, Scope, Stream, Tracer } from "effect";
import type { Core, CoreSnapshot, PluginSnapshot, PluginState } from "../core.ts";
import { CapabilityMismatch, CompositionError, CoreClosed, DeadlineExceeded, Diagnostic, PluginFault, ReloadError } from "../errors.ts";
import { Events } from "../events.ts";
import { Hooks, PluginContext } from "../hooks.ts";
import type { PluginIdentity } from "../hooks.ts";
import type { ReloadReport } from "../loader.ts";
import type { Deadlines, Plugin } from "../plugin.ts";
import { EventBus } from "./events.ts";
import type { ObserverHandle } from "./events.ts";
import { plan } from "./graph.ts";
import { attributes, HookRegistry } from "./hooks.ts";
import type { OwnerHandle } from "./hooks.ts";

/** A plugin and its raw (undecoded) config. */
export interface Member {
  readonly plugin: Plugin;
  readonly config?: unknown;
}

/** Planning found problems; nothing was activated. */
export class PlanError extends Data.TaggedError("PlanError")<{
  readonly errors: readonly [CompositionError, ...CompositionError[]];
}> {}

export type ApplyError = PlanError | PluginFault;

export interface Runtime {
  readonly core: Core<any>;
  readonly members: Effect.Effect<readonly Member[]>;
  /** Transactional change to the running composition; see docs/kernel.md. */
  readonly apply: (members: readonly Member[]) => Effect.Effect<ReloadReport, ApplyError>;
  /** Close everything now rather than when the owning scope ends. */
  readonly shutdown: Effect.Effect<void>;
}

const DEFAULTS = { activate: Duration.seconds(30), dispose: Duration.seconds(10) };

interface Instance {
  readonly id: string;
  readonly plugin: Plugin;
  readonly rawConfig: unknown;
  readonly identity: PluginIdentity;
  readonly scope: Scope.CloseableScope;
  readonly hooks: OwnerHandle;
  readonly observers: ObserverHandle;
  output: Context.Context<never>;
  state: PluginState;
  fault?: PluginFault;
  haltedBy?: string;
}

/** One published composition. In-flight work keeps the environment it entered with. */
interface Revision {
  readonly environment: Context.Context<never>;
  readonly fibers: Set<Fiber.RuntimeFiber<unknown, unknown>>;
  /** Admitted work whose fiber is not registered yet. */
  pending: number;
  readonly drained: Deferred.Deferred<void>;
  retired: boolean;
}

export function makeRuntime(options: { readonly deadlines?: Deadlines } = {}): Effect.Effect<Runtime, never, Scope.Scope> {
  return Effect.gen(function* () {
    const defaults = {
      activate: Duration.decode(options.deadlines?.activate ?? DEFAULTS.activate),
      dispose: Duration.decode(options.deadlines?.dispose ?? DEFAULTS.dispose),
    };
    const faults = yield* PubSub.unbounded<PluginFault>();
    const report = (fault: PluginFault): Effect.Effect<void> => PubSub.publish(faults, fault).pipe(Effect.asVoid);
    const registry = new HookRegistry();
    const bus = new EventBus(report);
    const base = Context.empty().pipe(Context.add(Hooks, registry), Context.add(Events, bus)) as Context.Context<never>;
    /** Owns lifecycle fibers: apply bodies, restart loops, background watchers. Closed first on shutdown. */
    const supervisor = yield* Scope.make();
    /** Owns core.run fibers. */
    const work = yield* Scope.make();
    const lock = yield* Effect.makeSemaphore(1);
    const closed = yield* Deferred.make<void, unknown>();
    let state: CoreSnapshot["state"] = "active";
    const instances = new Map<string, Instance>();
    let order: readonly string[] = [];
    let providers: ReadonlyMap<string, string> = new Map();
    let revision: Revision = { environment: base, fibers: new Set(), pending: 0, drained: yield* Deferred.make<void>(), retired: false };

    const environmentOf = (): Context.Context<never> => {
      let environment = base;
      for (const id of order) {
        const instance = instances.get(id);
        if (instance?.state === "active") environment = Context.merge(environment, instance.output);
      }
      return environment;
    };

    const publishRevision = Effect.gen(function* () {
      const previous = revision;
      revision = { environment: environmentOf(), fibers: new Set(), pending: 0, drained: yield* Deferred.make<void>(), retired: false };
      previous.retired = true;
      if (previous.fibers.size === 0 && previous.pending === 0) yield* Deferred.succeed(previous.drained, undefined);
      return previous;
    });

    /** Wait for work admitted under a retired revision; interrupt what outlives the dispose deadline. */
    const drain = (previous: Revision): Effect.Effect<number> =>
      withDeadline(Deferred.await(previous.drained), defaults.dispose, "abandon").pipe(
        Effect.flatMap((finished) => Option.isSome(finished) ? Effect.succeed(0) : Effect.gen(function* () {
          const stale = [...previous.fibers];
          yield* Fiber.interruptAll(stale);
          return stale.length;
        })),
      );

    const retire = (instance: Instance) => {
      if (instance.state !== "active") return;
      instance.state = "draining";
      instance.hooks.retire();
      instance.observers.retire();
    };

    const create = (plugin: Plugin, rawConfig: unknown): Effect.Effect<Instance> => Effect.gen(function* () {
      const scope = yield* Scope.make();
      const identity: PluginIdentity = { id: plugin.id, ...(plugin.version === undefined ? {} : { version: plugin.version }) };
      return {
        id: plugin.id, plugin, rawConfig, identity, scope,
        hooks: registry.owner(identity, scope, false),
        observers: bus.owner(identity, scope, false),
        output: Context.empty(),
        state: "pending",
      };
    });

    const background = (instance: Instance, name: string, task: Effect.Effect<unknown, unknown, unknown>, required: boolean) =>
      Effect.gen(function* () {
        if (state !== "active" || instance.state === "closed" || instance.state === "failed") return yield* new CoreClosed();
        // Forked fibers inherit interruptibility; owned work must stop when its scope closes.
        const fiber = yield* Effect.forkIn(Effect.interruptible(task.pipe(
          Effect.withSpan("core.background", { attributes: { ...attributes(instance.identity), "task.name": name } }),
        )), instance.scope);
        const watch = Fiber.await(fiber).pipe(Effect.flatMap((exit) => {
          if (Exit.isSuccess(exit) || Cause.isInterruptedOnly(exit.cause)) return Effect.void;
          const fault = new PluginFault({ pluginId: instance.id, phase: "background", operation: name, cause: exit.cause });
          instance.fault = fault;
          return report(fault).pipe(Effect.zipRight(required ? fail(instance, fault) : Effect.void));
        }));
        yield* Effect.forkIn(Effect.interruptible(watch), supervisor);
      }).pipe(Effect.asVoid);

    const activate = (instance: Instance, config: unknown, environment: Context.Context<never>): Effect.Effect<void, PluginFault> =>
      Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        instance.state = "activating";
        const context: Context.Tag.Service<PluginContext> = {
          ...instance.identity,
          on: instance.hooks.on,
          observe: instance.observers.observe,
          background: <R>(name: string, task: Effect.Effect<unknown, unknown, R>, options?: { readonly required?: boolean }) =>
            background(instance, name, task, options?.required ?? false) as Effect.Effect<void, CoreClosed, R>,
          trace: (name, effect) => effect.pipe(Effect.withSpan(name, { attributes: attributes(instance.identity) })),
        };
        // Only declared dependencies are visible during activation, not the entire graph.
        const inputs = new Map<string, unknown>([
          [Hooks.key, registry], [PluginContext.key, context], [Events.key, bus],
        ]);
        for (const tag of instance.plugin.requires) {
          if (!inputs.has(tag.key)) inputs.set(tag.key, environment.unsafeMap.get(tag.key));
        }
        const limit = Duration.decode(instance.plugin.deadlines?.activate ?? defaults.activate);
        const build = Layer.buildWithScope(instance.plugin.layer(config), instance.scope).pipe(
          Effect.mapInputContext((caller: Context.Context<never>) => {
            const provided = new Map(inputs);
            if (caller.unsafeMap.has(Tracer.ParentSpan.key)) {
              provided.set(Tracer.ParentSpan.key, caller.unsafeMap.get(Tracer.ParentSpan.key));
            }
            return Context.unsafeMake<unknown>(provided);
          }),
          Effect.flatMap((output) => {
            const declared = new Set(instance.plugin.provides.map((tag) => tag.key));
            const missing = [...declared].filter((key) => !output.unsafeMap.has(key));
            const undeclared = [...output.unsafeMap.keys()].filter((key) => !declared.has(key));
            if (missing.length || undeclared.length) {
              return Effect.fail(new CapabilityMismatch({ pluginId: instance.id, missing, undeclared }));
            }
            return Effect.succeed(output);
          }),
          Effect.disconnect,
          Effect.timeoutFail({ duration: limit, onTimeout: () => new DeadlineExceeded({ pluginId: instance.id, phase: "activate", limit }) }),
          Effect.catchAllCause((cause) => Cause.isInterruptedOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.fail(new PluginFault({ pluginId: instance.id, phase: "activate", cause, deadline: isDeadline(cause) }))),
          Effect.withSpan("core.activate", { attributes: attributes(instance.identity) }),
        );
        // Resource bookkeeping is masked; plugin initialization remains interruptible.
        const fiber = yield* Effect.forkIn(restore(build), instance.scope);
        const exit = yield* Effect.exit(restore(Fiber.join(fiber)).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber))));
        if (Exit.isSuccess(exit)) {
          instance.output = exit.value;
          instance.state = "active";
          return;
        }
        if (Cause.isInterruptedOnly(exit.cause)) {
          yield* dispose(instance, exit, "closed");
          return yield* Effect.failCause(exit.cause as Cause.Cause<never>);
        }
        const fault = Option.getOrThrow(Cause.failureOption(exit.cause));
        instance.fault = fault;
        yield* report(fault);
        yield* dispose(instance, exit, "failed");
        return yield* Effect.fail(fault);
      }));

    const dispose = (instance: Instance, exit: Exit.Exit<unknown, unknown>, final: "closed" | "failed"): Effect.Effect<void> =>
      Effect.uninterruptible(Effect.gen(function* () {
        instance.hooks.stop();
        instance.observers.retire();
        const limit = Duration.decode(instance.plugin.deadlines?.dispose ?? defaults.dispose);
        const result = yield* withDeadline(Scope.close(instance.scope, exit), limit, "continue").pipe(
          Effect.map(Option.getOrElse((): Exit.Exit<void, unknown> => Exit.fail(new DeadlineExceeded({ pluginId: instance.id, phase: "dispose", limit })))),
          Effect.withSpan("core.dispose", { attributes: attributes(instance.identity) }),
        );
        if (Exit.isFailure(result) && !Cause.isInterruptedOnly(result.cause)) {
          const fault = new PluginFault({ pluginId: instance.id, phase: "dispose", cause: result.cause, deadline: isDeadline(result.cause) });
          instance.fault = fault;
          yield* report(fault);
        }
        if (instance.state !== "failed") instance.state = final;
      }));

    /** Dependents of `id` in the current composition, transitively, in dependency order. */
    const dependentsOf = (id: string): string[] => {
      const found = new Set<string>([id]);
      for (const candidate of order) {
        const instance = instances.get(candidate);
        if (!instance || found.has(candidate)) continue;
        if (instance.plugin.requires.some((tag) => { const provider = providers.get(tag.key); return provider !== undefined && found.has(provider); })) {
          found.add(candidate);
        }
      }
      found.delete(id);
      return [...found];
    };

    /** Stop a failed plugin and everything that depends on it; nothing else is touched. */
    const fail = (instance: Instance, fault: PluginFault): Effect.Effect<void> =>
      lock.withPermits(1)(Effect.uninterruptible(Effect.gen(function* () {
        if (state !== "active" || instances.get(instance.id) !== instance || instance.state !== "active") return;
        const halted = dependentsOf(instance.id).map((id) => instances.get(id)!);
        retire(instance);
        for (const dependent of halted) retire(dependent);
        const previous = yield* publishRevision;
        yield* drain(previous);
        for (const dependent of [...halted].reverse()) {
          const wasActive = dependent.state === "draining";
          yield* dispose(dependent, Exit.fail(fault), "closed");
          if (wasActive) dependent.haltedBy = instance.id;
        }
        yield* dispose(instance, Exit.fail(fault), "failed");
        instance.state = "failed";
        instance.fault = fault;
        if (instance.plugin.restart) yield* Effect.forkIn(Effect.interruptible(restartLoop(instance.id, instance.plugin.restart, fault)), supervisor);
      })));

    /**
     * One schedule driver per plugin id, kept across failures: a plugin that keeps
     * failing exhausts its schedule instead of restarting forever. An explicit
     * restart resets it.
     */
    const drivers = new Map<string, Schedule.ScheduleDriver<unknown, PluginFault, never>>();
    const restartLoop = (id: string, schedule: Schedule.Schedule<unknown, PluginFault>, fault: PluginFault): Effect.Effect<void> =>
      Effect.gen(function* () {
        const driver = drivers.get(id) ?? (yield* Schedule.driver(schedule));
        drivers.set(id, driver);
        let last = fault;
        while (true) {
          const step = yield* Effect.either(driver.next(last));
          if (Either.isLeft(step)) return;
          const result = yield* Effect.either(applyLocked(currentMembers(), new Set([id]), true));
          if (Either.isRight(result)) return;
          last = instances.get(id)?.fault ?? last;
        }
      });

    const currentMembers = (): Member[] => order.map((id) => {
      const instance = instances.get(id)!;
      return { plugin: instance.plugin, ...(instance.rawConfig === undefined ? {} : { config: instance.rawConfig }) };
    });

    /**
     * `lenient` (restart): the forced plugin must activate; a dependent that cannot
     * is left failed, and its own dependents halted, without aborting the change.
     * A loader apply is never lenient: the whole composition applies or nothing does.
     */
    const applyLocked = (members: readonly Member[], force: ReadonlySet<string>, lenient = false): Effect.Effect<ReloadReport, ApplyError> =>
      lock.withPermits(1)(Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        if (state !== "active") {
          return yield* new PlanError({ errors: [new CompositionError({ reason: "CoreClosed", message: "The core is closing or has closed", plugins: [] })] });
        }
        const raw = new Map(members.map((member) => [member.plugin.id, member.config]));
        const planned = plan(members.map((member) => member.plugin), (id) => raw.get(id));
        if (Either.isLeft(planned)) return yield* new PlanError({ errors: planned.left });
        const { ordered, configs, providers: nextProviders } = planned.right;

        // Changed: new, different definition or config, forced, or depending on a changed provider.
        const changed = new Set<string>();
        const errors: CompositionError[] = [];
        for (const plugin of ordered) {
          const instance = instances.get(plugin.id);
          const dependsOnChanged = plugin.requires.some((tag) => { const provider = nextProviders.get(tag.key); return provider !== undefined && changed.has(provider); });
          if (!instance || instance.plugin !== plugin || !deepEqual(instance.rawConfig, raw.get(plugin.id)) || force.has(plugin.id) || dependsOnChanged) {
            changed.add(plugin.id);
            for (const tag of plugin.requires) {
              const provider = nextProviders.get(tag.key);
              if (provider !== undefined && !changed.has(provider) && instances.get(provider)?.state !== "active") {
                errors.push(new CompositionError({
                  reason: "InactiveDependency", capability: tag.key, plugins: [plugin.id, provider],
                  message: `Plugin "${plugin.id}" requires "${tag.key}" from "${provider}", which is not active; restart "${provider}" first`,
                }));
              }
            }
          }
        }
        if (errors.length) return yield* new PlanError({ errors: errors as [CompositionError, ...CompositionError[]] });
        const nextIds = ordered.map((plugin) => plugin.id);
        const stops = order.filter((id) => !raw.has(id));
        const previousOrder = order;
        let interrupted = 0;
        const reloadFaults: PluginFault[] = [];

        // Exclusive plugins cannot coexist with their replacement: stop them (and their dependents) first.
        const gapped = new Set<string>();
        for (const id of changed) {
          const instance = instances.get(id);
          if (instance?.state === "active" && instance.plugin.exclusive) {
            gapped.add(id);
            for (const dependent of dependentsOf(id)) if (instances.get(dependent)?.state === "active") gapped.add(dependent);
          }
        }
        if (gapped.size) {
          for (const id of gapped) retire(instances.get(id)!);
          const previous = yield* publishRevision;
          interrupted += yield* drain(previous);
          for (const id of [...previousOrder].reverse()) if (gapped.has(id)) yield* dispose(instances.get(id)!, Exit.void, "closed");
        }

        // Stage replacements while unchanged instances keep serving.
        const staged: Instance[] = [];
        const inactive = new Set<string>();
        let environment = base;
        const staging = Effect.gen(function* () {
          for (const plugin of ordered) {
            if (changed.has(plugin.id)) {
              const instance = yield* create(plugin, raw.get(plugin.id));
              staged.push(instance);
              const blocked = plugin.requires.map((tag) => nextProviders.get(tag.key)).find((provider) => provider !== undefined && inactive.has(provider));
              if (blocked !== undefined) {
                instance.state = "closed";
                instance.haltedBy = blocked;
                inactive.add(plugin.id);
                continue;
              }
              const exit = yield* Effect.exit(restore(activate(instance, configs.get(plugin.id), environment)));
              if (Exit.isFailure(exit)) {
                if (!lenient || force.has(plugin.id) || Cause.isInterruptedOnly(exit.cause)) return yield* Effect.failCause(exit.cause);
                inactive.add(plugin.id);
                continue;
              }
              environment = Context.merge(environment, instance.output);
            } else {
              const instance = instances.get(plugin.id);
              if (instance?.state === "active") environment = Context.merge(environment, instance.output);
            }
          }
        });
        const outcome = yield* Effect.exit(staging);
        if (Exit.isFailure(outcome)) {
          for (const instance of [...staged].reverse()) {
            if (instance.state !== "failed") yield* dispose(instance, outcome, "closed");
          }
          const fault = Option.getOrNull(Cause.failureOption(outcome.cause));
          // The explicit gap cannot be undone here: stopped exclusive plugins stay down, attributed to this failure.
          for (const id of gapped) {
            const instance = instances.get(id)!;
            instance.state = "failed";
            instance.fault = fault ?? new PluginFault({ pluginId: id, phase: "activate", cause: outcome.cause });
          }
          if (gapped.size) yield* publishRevision;
          return yield* Effect.failCause(outcome.cause);
        }

        // Swap: one atomic step for callers and hook/event dispatch.
        const old = [...changed, ...stops].flatMap((id) => { const instance = instances.get(id); return instance && !gapped.has(id) ? [instance] : []; });
        for (const instance of old) retire(instance);
        for (const instance of staged) {
          instance.hooks.publish();
          instance.observers.publish();
          instances.set(instance.id, instance);
        }
        for (const id of stops) instances.delete(id);
        order = nextIds;
        providers = nextProviders;
        const previous = yield* publishRevision;

        // Drain, then dispose old instances in reverse dependency order.
        interrupted += yield* drain(previous);
        const oldById = new Map(old.map((instance) => [instance.id, instance]));
        for (const id of [...previousOrder].reverse()) {
          const instance = oldById.get(id);
          if (!instance) continue;
          yield* dispose(instance, Exit.void, "closed");
          if (instance.fault?.phase === "dispose") reloadFaults.push(instance.fault);
        }
        const activated = staged.filter((instance) => instance.state === "active");
        return {
          started: activated.filter((instance) => !previousOrder.includes(instance.id)).map((instance) => instance.id),
          restarted: activated.filter((instance) => previousOrder.includes(instance.id)).map((instance) => instance.id),
          failed: staged.filter((instance) => instance.state !== "active").map((instance) => instance.id),
          stopped: stops,
          unchanged: nextIds.filter((id) => !changed.has(id)),
          interrupted,
          faults: reloadFaults,
        };
      })));

    /** Lifecycle changes run on supervisor-owned fibers so shutdown can interrupt them. */
    const supervised = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.uninterruptibleMask((resume) => Effect.gen(function* () {
        const fiber = yield* Effect.forkIn(resume(effect), supervisor);
        return yield* resume(Fiber.join(fiber)).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)));
      }));

    const shutdown: Effect.Effect<void> = Effect.uninterruptible(Effect.suspend(() => {
      if (state !== "active") return Deferred.await(closed).pipe(Effect.orDie);
      state = "closing";
      return Effect.gen(function* () {
        yield* Scope.close(work, Exit.void);
        yield* Scope.close(supervisor, Exit.void);
        registry.close();
        bus.close();
        let cause: Cause.Cause<unknown> | undefined;
        for (const id of [...order].reverse()) {
          const instance = instances.get(id)!;
          if (instance.state === "closed" || instance.state === "failed") continue;
          yield* dispose(instance, Exit.void, "closed");
          const fault = instance.fault;
          if (fault?.phase === "dispose") cause = cause ? Cause.sequential(cause, fault.cause) : fault.cause;
        }
        yield* PubSub.shutdown(faults);
        state = "closed";
        const result: Exit.Exit<void, unknown> = cause ? Exit.failCause(cause) : Exit.void;
        yield* Deferred.done(closed, result);
        return yield* result;
      }).pipe(Effect.orDie);
    }));
    yield* Effect.addFinalizer(() => shutdown);

    const core: Core<any> = {
      run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.uninterruptibleMask((resume) => Effect.gen(function* () {
          if (state !== "active") return yield* new CoreClosed();
          const admitted = revision;
          admitted.pending++;
          const fiber = yield* Effect.forkIn(resume(Effect.provide(effect, admitted.environment as Context.Context<any>)), work);
          admitted.fibers.add(fiber);
          admitted.pending--;
          return yield* resume(Fiber.join(fiber)).pipe(
            Effect.onInterrupt(() => Fiber.interrupt(fiber)),
            Effect.ensuring(Effect.sync(() => {
              admitted.fibers.delete(fiber);
              if (admitted.retired && admitted.fibers.size === 0 && admitted.pending === 0) Deferred.unsafeDone(admitted.drained, Effect.void);
            })),
          );
        })),
      inspect: Effect.sync((): CoreSnapshot => ({
        state,
        plugins: order.map((id) => snapshot(instances.get(id)!)),
        hooks: registry.inspect(),
        events: bus.inspect(),
      })),
      faults: Stream.fromPubSub(faults),
      restart: (id) => Effect.suspend((): Effect.Effect<void, ReloadError | CoreClosed> => {
        if (state !== "active") return Effect.fail(new CoreClosed());
        const instance = instances.get(id);
        if (!instance) {
          return Effect.fail(new ReloadError({ diagnostics: [new Diagnostic({ severity: "error", pluginId: id, message: `No plugin "${id}" is loaded` })] }));
        }
        if (instance.state === "active") return Effect.void;
        drivers.delete(id);
        return supervised(applyLocked(currentMembers(), new Set([id]), true)).pipe(Effect.mapError(toReloadError), Effect.asVoid);
      }),
    };

    return {
      core,
      members: Effect.sync(currentMembers),
      apply: (members) => supervised(applyLocked(members, new Set())),
      shutdown,
    };
  });
}

/**
 * Wait for `effect` up to `limit`, from any fiber, including an uninterruptible or
 * already-interrupted one where Effect's timeout races cannot fire. On timeout the
 * effect either keeps running ("continue": cleanup must finish) or is abandoned.
 */
function withDeadline<A, E>(
  effect: Effect.Effect<A, E>,
  limit: Duration.Duration,
  onTimeout: "continue" | "abandon",
): Effect.Effect<Option.Option<Exit.Exit<A, E>>> {
  return Effect.gen(function* () {
    const done = yield* Deferred.make<Option.Option<Exit.Exit<A, E>>>();
    const body = onTimeout === "continue" ? Effect.uninterruptible(effect) : Effect.interruptible(effect);
    const worker = yield* Effect.forkDaemon(body.pipe(Effect.exit, Effect.flatMap((exit) => Deferred.succeed(done, Option.some(exit)))));
    const timer = yield* Effect.forkDaemon(Effect.interruptible(Effect.sleep(limit)).pipe(Effect.zipRight(Deferred.succeed(done, Option.none()))));
    const result = yield* Deferred.await(done);
    yield* Fiber.interruptFork(timer);
    if (Option.isNone(result) && onTimeout === "abandon") yield* Fiber.interruptFork(worker);
    return result;
  });
}

export function toReloadError(error: ApplyError): ReloadError {
  return new ReloadError({ diagnostics: error._tag === "PlanError" ? error.errors.map(toDiagnostic) : [faultDiagnostic(error)] });
}

function toDiagnostic(error: CompositionError): Diagnostic {
  const suggestion = suggestionFor(error);
  return new Diagnostic({
    severity: "error",
    ...(error.plugins[0] === undefined ? {} : { pluginId: error.plugins[0] }),
    ...(error.path === undefined ? {} : { path: error.path }),
    message: error.message,
    ...(suggestion === undefined ? {} : { suggestion }),
  });
}

function suggestionFor(error: CompositionError): string | undefined {
  switch (error.reason) {
    case "MissingCapability": return `Add a plugin that provides "${error.capability}" or remove "${error.plugins[0]}"`;
    case "DuplicateCapability": return `Keep one of ${error.plugins.map((id) => `"${id}"`).join(", ")}`;
    case "InactiveDependency": return `Restart "${error.plugins[1]}"`;
    case "InvalidConfig": return `Fix the config for "${error.plugins[0]}"`;
    default: return undefined;
  }
}

function faultDiagnostic(fault: PluginFault): Diagnostic {
  return new Diagnostic({ severity: "error", pluginId: fault.pluginId, message: `${fault.message}\n${Cause.pretty(fault.cause)}` });
}

function isDeadline(cause: Cause.Cause<unknown>): boolean {
  return Option.exists(Cause.failureOption(cause), (failure) => failure instanceof DeadlineExceeded);
}

function snapshot(instance: Instance): PluginSnapshot {
  return {
    id: instance.id,
    ...(instance.identity.version === undefined ? {} : { version: instance.identity.version }),
    state: instance.state,
    provides: instance.plugin.provides.map((tag) => tag.key),
    requires: instance.plugin.requires.map((tag) => tag.key),
    ...(instance.fault === undefined ? {} : { fault: instance.fault }),
    ...(instance.haltedBy === undefined ? {} : { haltedBy: instance.haltedBy }),
  };
}

/** Structural equality for config data (JSON-like values); other objects compare by reference. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((value, index) => deepEqual(value, (b as unknown[])[index]));
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

