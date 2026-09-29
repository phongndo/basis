import { Context, Effect, Layer } from "effect";
import type { Schema } from "effect";
import { createRoot } from "solid-js";
import { definePlugin } from "@lemma/core";
import type { Capability, Plugin } from "@lemma/core";
import { Slots } from "./contracts.ts";
import type { SlotsService } from "./slots.ts";

/** Named capabilities: a plugin's `requires` or `provides`. */
export type Capabilities = Readonly<Record<string, Capability>>;
/** The services behind named capabilities. */
export type Services<C extends Capabilities> = { readonly [K in keyof C]: Context.Tag.Service<C[K]> };

export interface UiPluginContext<Config> {
  readonly id: string;
  /** Decoded from the plugin's `config` Schema; the `ui` row in config.jsonc sets it. */
  readonly config: Config;
  /** Runs when the plugin stops: turned off, replaced, or restarted with a dependency. */
  readonly onCleanup: (fn: () => void) => void;
}

export interface UiPluginDefinition<Requires extends Capabilities, Provides extends Capabilities, Config> {
  readonly id: string;
  readonly version?: string;
  readonly config?: Schema.Schema<Config, any, never>;
  readonly requires?: Requires;
  readonly provides?: Provides;
  /**
   * Runs once when the plugin starts, inside its own Solid root: signals,
   * memos, and effects created here live until the plugin stops. Returns the
   * services it provides, by the names in `provides`. Throwing fails this
   * plugin (and halts what requires it) without touching the others.
   */
  readonly setup: (use: Services<Requires>, plugin: UiPluginContext<Config>) => keyof Provides extends never ? void : Services<Provides>;
}

/**
 * A web app plugin, written as plain TypeScript over the kernel's
 * `definePlugin`: dependencies and exports are named records of capability
 * tags, and resources are released through `onCleanup` rather than Effect
 * scopes. The kernel still plans, orders, replaces, and supervises it like
 * any host plugin.
 */
export function defineUiPlugin<const Requires extends Capabilities = {}, const Provides extends Capabilities = {}, Config = void>(
  definition: UiPluginDefinition<Requires, Provides, Config>,
): Plugin {
  const requires = Object.entries(definition.requires ?? {});
  const provides = Object.entries(definition.provides ?? {});
  const layer = (config: Config) =>
    Layer.scopedContext(
      Effect.gen(function* () {
        const use: Record<string, unknown> = {};
        for (const [name, tag] of requires) {
          const service: unknown = yield* tag;
          // Its own view of the registry, so what it adds is attributed to it.
          use[name] =
            tag.key === Slots.key && typeof (service as Partial<SlotsService>).as === "function" ? (service as SlotsService).as(definition.id) : service;
        }
        const cleanups: (() => void)[] = [];
        const stop = () => {
          for (const fn of cleanups.splice(0).reverse()) {
            try {
              fn();
            } catch (error) {
              console.error(`${definition.id}: cleanup failed`, error);
            }
          }
        };
        const services = yield* Effect.acquireRelease(
          Effect.sync(() => {
            try {
              return createRoot((dispose) => {
                cleanups.push(dispose);
                return definition.setup(use as Services<Requires>, { id: definition.id, config, onCleanup: (fn) => void cleanups.push(fn) });
              });
            } catch (error) {
              stop();
              throw error;
            }
          }),
          () => Effect.sync(stop),
        );
        let context = Context.empty() as Context.Context<unknown>;
        for (const [name, tag] of provides) context = Context.add(context, tag, (services as Record<string, unknown>)[name]);
        return context;
      }),
    );
  return definePlugin({
    id: definition.id,
    ...(definition.version === undefined ? {} : { version: definition.version }),
    ...(definition.config === undefined ? {} : { config: definition.config }),
    provides: provides.map(([, tag]) => tag),
    requires: requires.map(([, tag]) => tag),
    // The capability tuple is dynamic here, so the typed Layer check of definePlugin cannot apply; the core checks exports at activation.
    layer: layer as never,
  });
}
