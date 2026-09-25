import { Context, Effect } from "effect";
import type { CoreClosed, HookError } from "./errors.ts";
import type { Event, Observer, ObserveOptions } from "./events.ts";

const HookTypeId: unique symbol = Symbol("@basis/core/Hook");

/**
 * An interception point: around middleware on an operation's critical path.
 * A failing handler fails the operation (fail closed), so a gate that crashes
 * is never skipped. Share this token with contributors; a name may identify
 * only one token per core.
 */
export interface Hook<Input, Output, Error = never> {
  readonly name: string;
  readonly [HookTypeId]: {
    readonly input: (_: Input) => Input;
    readonly output: (_: Output) => Output;
    readonly error: (_: Error) => Error;
  };
}

export const Hook = {
  make<Input, Output, Error = never>(name: string): Hook<Input, Output, Error> {
    return Object.freeze({ name }) as Hook<Input, Output, Error>;
  },
};

export type Next<Input, Output, Error> = (
  input: Input,
) => Effect.Effect<Output, Error | HookError | CoreClosed>;

/** Around middleware: change input, wrap output, or return without calling next. */
export type Handler<Input, Output, Error, Requirements = never> = (
  input: Input,
  next: Next<Input, Output, Error>,
) => Effect.Effect<Output, Error | HookError | CoreClosed, Requirements>;

export interface HookOptions {
  /** Lower values run first; ties use plugin id, then registration order. */
  readonly order?: number;
}

export interface BackgroundOptions {
  /** A required task's failure fails the plugin; an optional task's failure is only reported. Default false. */
  readonly required?: boolean;
}

export interface PluginIdentity {
  readonly id: string;
  readonly version?: string;
}

/** Present during activation and in the environment captured by registered handlers. */
export class PluginContext extends Context.Tag("@basis/core/PluginContext")<
  PluginContext,
  PluginIdentity & {
    /** Captures dependencies now; removes the handler when the plugin's scope closes. */
    readonly on: <I, O, E, R>(
      hook: Hook<I, O, E>,
      handler: Handler<I, O, E, R>,
      options?: HookOptions,
    ) => Effect.Effect<void, HookError | CoreClosed, R>;
    /** Observe an event. Failures are attributed to this plugin and isolated from everything else. */
    readonly observe: <P, R>(
      event: Event<P>,
      observer: Observer<P, R>,
      options?: ObserveOptions,
    ) => Effect.Effect<void, CoreClosed, R>;
    /**
     * Run supervised work owned by this plugin's scope. Its exit is reported as a
     * `PluginFault` (phase "background"); use this rather than a detached fiber so
     * the core can see the failure.
     */
    readonly background: <R>(
      name: string,
      work: Effect.Effect<unknown, unknown, R>,
      options?: BackgroundOptions,
    ) => Effect.Effect<void, CoreClosed, R>;
    /** Attribute custom capability operations without wrapping or proxying their values. */
    readonly trace: <A, E, R>(
      name: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>() {}

/** Plugins define the hook tokens and terminal behavior; the core only dispatches. */
export class Hooks extends Context.Tag("@basis/core/Hooks")<
  Hooks,
  {
    readonly invoke: <I, O, E, R>(
      hook: Hook<I, O, E>,
      input: I,
      terminal: (input: I) => Effect.Effect<O, E, R>,
    ) => Effect.Effect<O, E | HookError | CoreClosed, R>;
  }
>() {}
