import type { Context, Layer } from "effect";
import type { Hooks, PluginContext } from "./hooks.ts";

// Tags are existential here; their concrete identifiers are retained by definePlugin.
export type Capability = Context.Tag<any, any>;
export type Identifiers<Tags extends readonly Capability[]> = Context.Tag.Identifier<Tags[number]>;

export interface Plugin<Provides extends readonly Capability[] = readonly Capability[]> {
  readonly id: string;
  readonly version?: string;
  readonly provides: Provides;
  readonly requires: readonly Capability[];
  /** Erased only for storage in a heterogeneous composition. */
  readonly layer: Layer.Layer<never, unknown, unknown>;
}

/**
 * The manifest describes runtime wiring; the Layer owns construction and resources.
 * Requirements not listed here (or provided inside the Layer) are a type error.
 * The core also checks actual exports at activation, including undeclared exports.
 */
export function definePlugin<
  const Provides extends readonly Capability[] = readonly [],
  const Requires extends readonly Capability[] = readonly [],
  Error = never,
>(definition: {
  readonly id: string;
  readonly version?: string;
  readonly provides?: Provides;
  readonly requires?: Requires;
  readonly layer: Layer.Layer<
    NoInfer<Identifiers<Provides>>,
    Error,
    NoInfer<Identifiers<Requires>> | PluginContext | Hooks
  >;
}): Plugin<NoInfer<Provides>> {
  return Object.freeze({
    id: definition.id,
    ...(definition.version === undefined ? {} : { version: definition.version }),
    provides: Object.freeze([...(definition.provides ?? [])]) as unknown as Provides,
    requires: Object.freeze([...(definition.requires ?? [])]),
    layer: definition.layer,
  });
}
