import type { PluginStatus } from "@lemma/contracts";

type Source = PluginStatus["source"];

const SOURCE_ORDER: readonly Source[] = ["bundled", "user", "project"];
export const SOURCE_TITLES: Readonly<Record<Source, string>> = { bundled: "Bundled", user: "Your plugins", project: "Project plugins" };

export interface PluginGroup {
  readonly source: Source;
  readonly title: string;
  readonly plugins: readonly PluginStatus[];
}

/** By where they come from, keeping the host's order within each group; empty groups are dropped. */
export const pluginGroups = (plugins: readonly PluginStatus[]): PluginGroup[] =>
  SOURCE_ORDER.map((source) => ({ source, title: SOURCE_TITLES[source], plugins: plugins.filter((plugin) => plugin.source === source) })).filter(
    (group) => group.plugins.length > 0,
  );

/** What a search over plugins matches. */
export const pluginText = (plugin: PluginStatus): string =>
  [
    plugin.id,
    plugin.version,
    plugin.state,
    plugin.source,
    plugin.enabled ? "on enabled" : "off disabled",
    plugin.fault?.message,
    plugin.haltedBy,
    plugin.locked,
    ...plugin.provides.map(capabilityName),
    ...plugin.requires.map(capabilityName),
  ]
    .filter(Boolean)
    .join(" ");

/** `lemma/Llm` reads as `Llm`. */
export const capabilityName = (key: string): string => key.slice(key.lastIndexOf("/") + 1);

const loaded = (plugin: PluginStatus) => plugin.enabled && plugin.state !== "disabled";

/** Running plugins that stop when `id` is turned off: those requiring a capability it provides, transitively, nearest first. */
export function dependentsOf(plugins: readonly PluginStatus[], id: string): string[] {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const found: string[] = [];
  const queue = [id];
  while (queue.length) {
    const current = byId.get(queue.shift()!);
    if (current === undefined) continue;
    for (const plugin of plugins) {
      if (plugin.id === id || found.includes(plugin.id) || !loaded(plugin)) continue;
      if (plugin.requires.some((key) => current.provides.includes(key))) {
        found.push(plugin.id);
        queue.push(plugin.id);
      }
    }
  }
  return found;
}

/** Enabled plugins that are not loaded because `id` is off, directly or through another one waiting on it. */
export function waitingOn(plugins: readonly PluginStatus[], id: string): string[] {
  const found: string[] = [];
  const queue = [id];
  while (queue.length) {
    const current = queue.shift()!;
    for (const plugin of plugins) {
      if (found.includes(plugin.id) || !plugin.enabled || plugin.state !== "disabled" || plugin.haltedBy !== current) continue;
      found.push(plugin.id);
      queue.push(plugin.id);
    }
  }
  return found;
}

/** The row's one-phrase status: the core's state, or why the plugin is not running. */
export function describeState(plugin: PluginStatus): string {
  if (!plugin.enabled) return "Off";
  switch (plugin.state) {
    case "active":
      return "Running";
    case "failed":
      return "Failed";
    case "activating":
      return "Starting";
    case "draining":
      return "Stopping";
    case "pending":
      return "Waiting";
    case "closed":
      return plugin.haltedBy === undefined ? "Stopped" : `Halted by ${plugin.haltedBy}`;
    case "disabled":
      return plugin.haltedBy === undefined ? "Not loaded" : `Needs ${plugin.haltedBy}`;
  }
}

/** Whether a restart would do anything without `force`: the plugin failed, or a failed dependency halted it. */
export const recoverable = (plugin: PluginStatus): boolean => plugin.state === "failed" || (plugin.state === "closed" && plugin.haltedBy !== undefined);

const providesOf = (plugins: readonly PluginStatus[], id: string): readonly string[] => plugins.find((plugin) => plugin.id === id)?.provides ?? [];

/** Every plugin requiring a capability `id` provides, directly, running or not: what the details panel lists. Compare `dependentsOf`. */
export const requiredBy = (plugins: readonly PluginStatus[], id: string): string[] => {
  const provides = providesOf(plugins, id);
  return plugins.filter((plugin) => plugin.id !== id && plugin.requires.some((key) => provides.includes(key))).map((plugin) => plugin.id);
};

/** Enabled plugins providing a capability `id` also provides: the host turns them off when `id` is turned on. */
export const replaces = (plugins: readonly PluginStatus[], id: string): string[] => {
  const provides = providesOf(plugins, id);
  return plugins.filter((plugin) => plugin.id !== id && plugin.enabled && plugin.provides.some((key) => provides.includes(key))).map((plugin) => plugin.id);
};
