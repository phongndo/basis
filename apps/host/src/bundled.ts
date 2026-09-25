import { Effect } from "effect";
import { Diagnostic } from "@basis/core";
import type { Plugin, PluginSource } from "@basis/core";
import credentials from "@basis/plugin-credentials";
import interaction from "@basis/plugin-interaction";

/**
 * Shipped plugins by id. The host plugin is built by main.ts with a closure
 * over the loader, so it arrives as an argument. Integration adds the rest
 * (llm, tools, sessions, agent, transport, ...) as they land.
 */
export function bundled(host: Plugin): ReadonlyMap<string, Plugin> {
  return new Map<string, Plugin>([host, interaction, credentials].map((plugin) => [plugin.id, plugin]));
}

export function bundledSource(plugins: ReadonlyMap<string, Plugin>): PluginSource {
  return {
    resolve: (id) => {
      const plugin = plugins.get(id);
      return plugin ? Effect.succeed(plugin) : Effect.fail(new Diagnostic({
        severity: "error", pluginId: id,
        message: `No bundled plugin "${id}"`,
        suggestion: `Remove it from config.jsonc; bundled plugins are: ${[...plugins.keys()].join(", ")}`,
      }));
    },
  };
}
