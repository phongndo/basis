import { Cause, Effect, Layer, Stream } from "effect";
import type { Context } from "effect";
import { HostControl, Notice, Paths, PluginsChanged } from "@basis/contracts";
import { definePlugin, Events, PluginContext } from "@basis/core";
import type { Plugin, PluginFault } from "@basis/core";
import { HOST_PLUGIN_ID } from "./config.ts";
import { PathsSchema } from "./paths.ts";

export type HostControlService = Context.Tag.Service<HostControl>;

export interface HostPluginOptions {
  /** The app owns the loader; it hands the plugin a handle rather than the loader itself. */
  readonly control: HostControlService;
  /** `core.faults` of the composition this plugin runs in, so clients hear about failures. */
  readonly faults?: Stream.Stream<PluginFault>;
}

/**
 * Provides `Paths` from its config and `HostControl` from the app's handle, and
 * publishes `PluginsChanged` after every change it can observe: a reload or
 * restart through the handle, and any fault. Faults also become an error
 * `Notice`; the app's log remains the durable record.
 */
export function hostPlugin(options: HostPluginOptions): Plugin<readonly [typeof Paths, typeof HostControl]> {
  return definePlugin({
    id: HOST_PLUGIN_ID,
    config: PathsSchema,
    provides: [Paths, HostControl],
    layer: (paths) => Layer.merge(
      Layer.succeed(Paths, paths),
      Layer.effect(HostControl, Effect.gen(function* () {
        const events = yield* Events;
        const owner = yield* PluginContext;
        const changed = Effect.flatMap(options.control.plugins, (plugins) => events.publish(PluginsChanged, { plugins }));
        if (options.faults) {
          yield* owner.background("faults", Stream.runForEach(options.faults, (fault) =>
            events.publish(Notice, { level: "error", source: fault.pluginId, message: `${fault.message}: ${Cause.pretty(fault.cause)}` })
              .pipe(Effect.zipRight(changed))));
        }
        return {
          plugins: options.control.plugins,
          // A restart can leave dependents failed even when it errors, so publish either way.
          restart: (pluginId) => options.control.restart(pluginId).pipe(Effect.ensuring(changed)),
          // A failed reload leaves the composition untouched; a report may still carry dispose faults.
          reload: options.control.reload.pipe(Effect.tap(() => changed)),
        };
      })),
    ),
  });
}
