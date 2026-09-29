import type { ConfigScope, PluginInfo, PluginRow, PluginSource } from "@lemma/contracts";
import { Events, Hooks, PluginContext } from "@lemma/core";
import type { Composition, Plugin, PluginSnapshot } from "@lemma/core";

/** A plugin definition the app can load, with where it came from. */
export interface KnownPlugin {
  readonly plugin: Plugin;
  readonly source: PluginSource;
  /** A local plugin whose id a bundled plugin also has; the local one loads. */
  readonly shadows?: boolean;
}

/** Runtime capabilities the core supplies to every plugin; not dependencies between plugins. */
const builtins = new Set<string>([Hooks.key, PluginContext.key, Events.key]);

const isEnabled = (composition: Composition, id: string): boolean => composition.plugins[id]?.enabled !== false;

/** Capability key to the plugin id providing it. An enabled provider wins over a disabled one with the same capability. */
function providersOf(known: readonly KnownPlugin[], composition: Composition): Map<string, string> {
  const providers = new Map<string, string>();
  for (const pass of [true, false]) {
    for (const { plugin } of known) {
      if (isEnabled(composition, plugin.id) !== pass) continue;
      for (const tag of plugin.provides) if (!providers.has(tag.key)) providers.set(tag.key, plugin.id);
    }
  }
  return providers;
}

export interface Resolved {
  /** The composition to load: enabled plugins whose required capabilities all come from loaded plugins. */
  readonly composition: Composition;
  /** Enabled plugins left out, each with the plugin (off or itself left out) that provides a capability it requires. */
  readonly haltedBy: ReadonlyMap<string, string>;
}

/**
 * Turning a plugin off takes its dependents out of the composition rather than
 * failing the whole change on a missing capability; they return when it does.
 * Unknown ids and capabilities nobody provides are left to the planner, which
 * reports them.
 */
export function resolveComposition(known: readonly KnownPlugin[], composition: Composition): Resolved {
  const providers = providersOf(known, composition);
  const haltedBy = new Map<string, string>();
  const loaded = (id: string) => isEnabled(composition, id) && !haltedBy.has(id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { plugin } of known) {
      if (!loaded(plugin.id) || composition.plugins[plugin.id] === undefined) continue;
      for (const tag of plugin.requires) {
        const provider = providers.get(tag.key);
        if (provider === undefined || builtins.has(tag.key) || loaded(provider)) continue;
        haltedBy.set(plugin.id, provider);
        changed = true;
        break;
      }
    }
  }
  const plugins = Object.fromEntries(Object.entries(composition.plugins).filter(([id]) => !haltedBy.has(id)));
  return { composition: { plugins }, haltedBy };
}

/** Every plugin a pinned plugin needs, directly or through other plugins, with the pinned plugin's id. */
function neededBy(known: readonly KnownPlugin[], composition: Composition, pinned: readonly string[]): Map<string, string> {
  const byId = new Map(known.map((entry) => [entry.plugin.id, entry.plugin]));
  const providers = providersOf(known, composition);
  const needed = new Map<string, string>();
  for (const root of pinned) {
    const stack = [root];
    while (stack.length) {
      const plugin = byId.get(stack.pop()!);
      if (!plugin) continue;
      for (const tag of plugin.requires) {
        const provider = providers.get(tag.key);
        if (provider === undefined || needed.has(provider) || pinned.includes(provider)) continue;
        needed.set(provider, root);
        stack.push(provider);
      }
    }
  }
  return needed;
}

export interface CatalogInput {
  readonly known: readonly KnownPlugin[];
  /** As the config files describe it, before resolution: says what is enabled. */
  readonly composition: Composition;
  readonly resolved: Resolved;
  /** `core.inspect` of the running composition. */
  readonly snapshots: readonly PluginSnapshot[];
  readonly enabledIn: Readonly<Record<string, ConfigScope>>;
  /** Plugins the app never turns off, each with the reason shown to the user. */
  readonly pinned: Readonly<Record<string, string>>;
}

/**
 * A capability has one provider, so turning on a plugin that provides what
 * another enabled plugin provides turns that plugin off in the same change:
 * that is how a provider is swapped for another. Rows already in `rows` are
 * left alone, so a caller can still enable both and let the planner refuse.
 */
export function withReplacements(
  known: readonly KnownPlugin[],
  composition: Composition,
  rows: Readonly<Record<string, PluginRow>>,
): Record<string, PluginRow> {
  const result: Record<string, PluginRow> = { ...rows };
  for (const [id, row] of Object.entries(rows)) {
    if (row.enabled !== true) continue;
    const plugin = known.find((entry) => entry.plugin.id === id)?.plugin;
    if (plugin === undefined) continue;
    const keys = new Set(plugin.provides.map((tag) => tag.key));
    for (const { plugin: other } of known) {
      if (other.id === id || result[other.id] !== undefined || !isEnabled(composition, other.id)) continue;
      if (other.provides.some((tag) => keys.has(tag.key))) result[other.id] = { enabled: false };
    }
  }
  return result;
}

/** Every known plugin in `known` order, joined with its config row and its core snapshot. */
export function catalog({ known, composition, resolved, snapshots, enabledIn, pinned }: CatalogInput): PluginInfo[] {
  const running = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const needed = neededBy(known, composition, Object.keys(pinned));
  return known.map(({ plugin, source, shadows }) => {
    const snapshot = running.get(plugin.id);
    const needs = needed.get(plugin.id);
    const locked = pinned[plugin.id] ?? (needs === undefined ? undefined : `Needed by ${needs}`);
    const haltedBy = snapshot?.haltedBy ?? resolved.haltedBy.get(plugin.id);
    const scope = enabledIn[plugin.id];
    return {
      id: plugin.id,
      ...(plugin.version === undefined ? {} : { version: plugin.version }),
      source,
      ...(shadows ? { shadows } : {}),
      enabled: isEnabled(composition, plugin.id),
      ...(scope === undefined ? {} : { scope }),
      ...(locked === undefined ? {} : { locked }),
      provides: plugin.provides.map((tag) => tag.key),
      requires: plugin.requires.map((tag) => tag.key).filter((key) => !builtins.has(key)),
      ...(snapshot === undefined ? {} : { state: snapshot.state }),
      ...(snapshot?.fault === undefined ? {} : { fault: snapshot.fault }),
      ...(haltedBy === undefined ? {} : { haltedBy }),
    };
  });
}
