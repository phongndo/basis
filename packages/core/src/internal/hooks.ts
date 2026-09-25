import { Context, Effect, Scope, Tracer } from "effect";
import { CoreClosed, HookError } from "../errors.ts";
import type { Handler, Hook, HookOptions, Hooks, Next, PluginContext, PluginIdentity } from "../hooks.ts";

interface Entry {
  readonly token: object;
  readonly name: string;
  handlers: readonly Registration[];
}

interface Registration {
  readonly owner: PluginIdentity;
  readonly order: number;
  readonly sequence: number;
  readonly handle: Handler<unknown, unknown, unknown>;
  active: boolean;
}

export interface HookSnapshot {
  readonly name: string;
  readonly handlers: readonly {
    readonly pluginId: string;
    readonly order: number;
  }[];
}

/** Registrations change only on activation/disposal; dispatch uses immutable arrays. */
export class HookRegistry implements Context.Tag.Service<Hooks> {
  private readonly entries = new Map<string, Entry>();
  private sequence = 0;
  private closed = false;

  close(): void {
    this.closed = true;
    this.entries.clear();
  }

  inspect(): readonly HookSnapshot[] {
    return [...this.entries.values()]
      .filter((entry) => entry.handlers.length > 0)
      .sort((a, b) => compare(a.name, b.name))
      .map((entry) => ({
        name: entry.name,
        handlers: entry.handlers.map(({ owner, order }) => ({ pluginId: owner.id, order })),
      }));
  }

  owner(identity: PluginIdentity, scope: Scope.Scope): Context.Tag.Service<PluginContext> {
    let active = true;
    // Called by the runtime before closing the plugin scope.
    const on = <I, O, E, R>(hook: Hook<I, O, E>, handler: Handler<I, O, E, R>, options: HookOptions = {}) =>
      Effect.uninterruptible(Effect.gen(this, function* () {
        if (this.closed) return yield* new CoreClosed();
        if (!active) return yield* ownerClosed(hook.name, identity.id);
        const order = options.order ?? 0;
        if (!Number.isFinite(order)) {
          return yield* new HookError({ reason: "InvalidOrder", hook: hook.name, pluginId: identity.id, message: "Hook order must be finite" });
        }
        const entry = yield* this.entry(hook);
        const environment = withoutParent(yield* Effect.context<R>());
        const registration: Registration = {
          owner: identity,
          order,
          sequence: this.sequence++,
          active: true,
          // This erasure is local to the heterogeneous registry. Token identity protects dispatch.
          handle: ((input: I, next: Next<I, O, E>) => Effect.provide(
            Effect.suspend(() => handler(input, next)), environment,
          )) as unknown as Handler<unknown, unknown, unknown>,
        };
        entry.handlers = [...entry.handlers, registration].sort((a, b) =>
          a.order - b.order || compare(a.owner.id, b.owner.id) || a.sequence - b.sequence,
        );
        yield* Scope.addFinalizer(scope, Effect.sync(() => {
          registration.active = false;
          entry.handlers = entry.handlers.filter((candidate) => candidate !== registration);
        }));
      }));

    // Scope closes in reverse registration order. The runtime adds a separate closing guard.
    const context: Context.Tag.Service<PluginContext> = {
      ...identity,
      on,
      observe: () => notImplemented("PluginContext.observe"),
      background: () => notImplemented("PluginContext.background"),
      trace: (name, effect) => effect.pipe(Effect.withSpan(name, { attributes: attributes(identity) })),
    };
    this.deactivate.set(context, () => { active = false; });
    return context;
  }

  private readonly deactivate = new WeakMap<Context.Tag.Service<PluginContext>, () => void>();

  stopOwner(owner: Context.Tag.Service<PluginContext>): void {
    this.deactivate.get(owner)?.();
    this.deactivate.delete(owner);
  }

  readonly invoke = <I, O, E, R>(
    hook: Hook<I, O, E>,
    input: I,
    terminal: (input: I) => Effect.Effect<O, E, R>,
  ): Effect.Effect<O, E | HookError | CoreClosed, R> => {
    return Effect.gen(this, function* () {
      if (this.closed) return yield* new CoreClosed();
      const entry = yield* this.entry(hook);
      const handlers = entry.handlers;
      if (handlers.length === 0) return yield* Effect.suspend(() => terminal(input));
      const caller = withoutParent(yield* Effect.context<R>());
      const dispatch = (index: number, value: I): Effect.Effect<O, E | HookError | CoreClosed> =>
        Effect.suspend(() => {
          if (this.closed) return Effect.fail(new CoreClosed());
          const registration = handlers[index];
          if (!registration) return Effect.provide(Effect.suspend(() => terminal(value)), caller);
          if (!registration.active) return Effect.fail(ownerClosed(hook.name, registration.owner.id));
          let called = false;
          let alive = true;
          const next = (nextInput: I): Effect.Effect<O, E | HookError | CoreClosed> => Effect.suspend(() => {
            if (!alive || called) {
              return Effect.fail(new HookError({
                reason: alive ? "NextAlreadyCalled" : "InvocationEnded",
                hook: hook.name,
                pluginId: registration.owner.id,
                message: alive ? "A hook handler may execute next only once" : "next cannot execute after its handler has finished",
              }));
            }
            called = true;
            return dispatch(index + 1, nextInput);
          });
          const handle = registration.handle as Handler<I, O, E>;
          return Effect.suspend(() => handle(value, next)).pipe(
            Effect.ensuring(Effect.sync(() => { alive = false; })),
            Effect.withSpan("core.hook", {
              // This frame is always the dispatcher, not plugin code. Keep attribution
              // and failure stacks without capturing a redundant stack on every call.
              captureStackTrace: false,
              attributes: { ...attributes(registration.owner), "hook.name": hook.name, "hook.order": registration.order },
            }),
          );
        });
      return yield* dispatch(0, input);
    });
  }

  private entry(hook: { readonly name: string }): Effect.Effect<Entry, HookError> {
    return Effect.suspend(() => {
      const existing = this.entries.get(hook.name);
      if (existing) {
        if (existing.token !== hook) {
          return Effect.fail(new HookError({
            reason: "PointConflict", hook: hook.name,
            message: `Different hook tokens use the name "${hook.name}"; import the shared token instead`,
          }));
        }
        return Effect.succeed(existing);
      }
      const entry: Entry = { token: hook, name: hook.name, handlers: [] };
      this.entries.set(hook.name, entry);
      return Effect.succeed(entry);
    });
  }
}

export function attributes(identity: PluginIdentity): Record<string, string> {
  return {
    "plugin.id": identity.id,
    ...(identity.version === undefined ? {} : { "plugin.version": identity.version }),
  };
}

// Dependencies belong to the registration/caller; trace ancestry belongs to this invocation.
function withoutParent<R>(context: Context.Context<R>): Context.Context<R> {
  if (!context.unsafeMap.has(Tracer.ParentSpan.key)) return context;
  const values = new Map(context.unsafeMap);
  values.delete(Tracer.ParentSpan.key);
  return Context.unsafeMake<R>(values);
}

/** Contract-only until the kernel implements events and supervision; see docs/kernel.md. */
export function notImplemented(name: string): Effect.Effect<never> {
  return Effect.die(new Error(`@basis/core: ${name} is a contract only; see docs/kernel.md`));
}

function ownerClosed(hook: string, pluginId: string): HookError {
  return new HookError({ reason: "OwnerClosed", hook, pluginId, message: `Plugin "${pluginId}" has closed` });
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
