import { Effect, Scope } from "effect";
import { CompositionError } from "../errors.ts";
import { Events } from "../events.ts";
import { Hooks, PluginContext } from "../hooks.ts";
import type { Plugin } from "../plugin.ts";

const builtins = new Set<string>([Hooks.key, PluginContext.key, Events.key]);
const reserved = new Set([...builtins, Scope.Scope.key]);

/** Validate the entire graph before executing any plugin code. */
export function plan(plugins: readonly Plugin[]): Effect.Effect<readonly Plugin[], CompositionError> {
  return Effect.gen(function* () {
    const byId = new Map<string, Plugin>();
    const providers = new Map<string, Plugin>();

    for (const plugin of plugins) {
      if (!plugin.id || plugin.id.trim() !== plugin.id) {
        return yield* new CompositionError({
          reason: "InvalidId", message: "Plugin ids must be nonempty and have no surrounding whitespace", plugins: [plugin.id],
        });
      }
      if (byId.has(plugin.id)) {
        return yield* new CompositionError({
          reason: "DuplicatePlugin", message: `Duplicate plugin id "${plugin.id}"`, plugins: [plugin.id],
        });
      }
      byId.set(plugin.id, plugin);
      for (const tag of plugin.provides) {
        if (reserved.has(tag.key)) {
          return yield* new CompositionError({
            reason: "ReservedCapability", message: `Plugin "${plugin.id}" cannot provide runtime capability "${tag.key}"`,
            plugins: [plugin.id], capability: tag.key,
          });
        }
        const previous = providers.get(tag.key);
        if (previous) {
          return yield* new CompositionError({
            reason: "DuplicateCapability",
            message: `Capability "${tag.key}" is provided by both "${previous.id}" and "${plugin.id}"; select one provider`,
            plugins: [previous.id, plugin.id], capability: tag.key,
          });
        }
        providers.set(tag.key, plugin);
      }
    }

    const dependencies = new Map<Plugin, readonly Plugin[]>();
    for (const plugin of plugins) {
      const required = new Set<Plugin>();
      for (const tag of plugin.requires) {
        if (builtins.has(tag.key)) continue;
        const provider = providers.get(tag.key);
        if (!provider) {
          return yield* new CompositionError({
            reason: "MissingCapability", message: `Plugin "${plugin.id}" requires missing capability "${tag.key}"`,
            plugins: [plugin.id], capability: tag.key,
          });
        }
        required.add(provider);
      }
      dependencies.set(plugin, [...required].sort(byName));
    }

    const ordered: Plugin[] = [];
    const visited = new Set<Plugin>();
    const visiting = new Set<Plugin>();
    // Iterative DFS avoids JS stack depth limits on large compositions.
    for (const start of [...plugins].sort(byName)) {
      if (visited.has(start)) continue;
      const stack: { plugin: Plugin; index: number }[] = [{ plugin: start, index: 0 }];
      visiting.add(start);
      while (stack.length) {
        const frame = stack[stack.length - 1]!;
        const dependency = dependencies.get(frame.plugin)![frame.index++];
        if (dependency) {
          if (visiting.has(dependency)) {
            const first = stack.findIndex((entry) => entry.plugin === dependency);
            const cycle = [...stack.slice(first).map((entry) => entry.plugin.id), dependency.id];
            return yield* new CompositionError({
              reason: "DependencyCycle", message: `Plugin dependency cycle: ${cycle.join(" -> ")}`, plugins: cycle,
            });
          }
          if (!visited.has(dependency)) {
            visiting.add(dependency);
            stack.push({ plugin: dependency, index: 0 });
          }
        } else {
          stack.pop();
          visiting.delete(frame.plugin);
          visited.add(frame.plugin);
          ordered.push(frame.plugin);
        }
      }
    }
    return ordered;
  });
}

function byName(a: Plugin, b: Plugin): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
