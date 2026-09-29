import type { PluginRow, PluginSource } from "@lemma/contracts";
import type { Composition, Plugin, PluginEntry } from "@lemma/core";
import { resolveComposition } from "@lemma/plugin-host/catalog";
import type { KnownPlugin, Resolved } from "@lemma/plugin-host/catalog";

/** A plugin from a UI file, with where the file is. */
export interface LocalPlugin {
  readonly plugin: Plugin;
  readonly source: Exclude<PluginSource, "bundled">;
}

export interface UiPlan {
  /** Bundled plugins in order, each replaced in place by a local one with its id; other local plugins after them. */
  readonly known: readonly KnownPlugin[];
  /** Every known plugin with its row: the defaults, patched by `ui` rows. */
  readonly composition: Composition;
  /** What runs: `composition` minus plugins whose requirements an off plugin leaves unmet. */
  readonly resolved: Resolved;
  /** Row ids that name no known plugin. */
  readonly unknown: readonly string[];
}

const keys = (plugin: Plugin) => new Set(plugin.provides.map((tag) => tag.key));

/**
 * The web app's composition. Every known plugin runs by default. A local
 * plugin with a bundled plugin's id runs instead of it; one that provides
 * what a bundled plugin provides turns that plugin off unless a row decides,
 * so dropping a file into `~/.lemma/ui` is enough to replace a part of the
 * app. `ui` rows then patch by id, as `plugins` rows do for the host. Plugins
 * in `pinned` always run.
 */
export function planUi(
  bundled: readonly Plugin[],
  local: readonly LocalPlugin[],
  rows: Readonly<Record<string, PluginRow>>,
  pinned: ReadonlySet<string> = new Set(),
): UiPlan {
  const byId = new Map<string, KnownPlugin>();
  for (const plugin of bundled) byId.set(plugin.id, { plugin, source: "bundled" });
  for (const { plugin, source } of local) {
    const previous = byId.get(plugin.id);
    const shadows = previous?.source === "bundled" || previous?.shadows === true;
    byId.set(plugin.id, { plugin, source, ...(shadows ? { shadows } : {}) });
  }
  const known = [...byId.values()];
  const plugins: Record<string, PluginEntry> = Object.fromEntries(known.map(({ plugin }) => [plugin.id, {}]));
  for (const { plugin, source } of known) {
    if (source === "bundled" || rows[plugin.id]?.enabled === false) continue;
    const provides = keys(plugin);
    for (const other of known) {
      if (other.source !== "bundled" || rows[other.plugin.id]?.enabled !== undefined || pinned.has(other.plugin.id)) continue;
      if ([...keys(other.plugin)].some((key) => provides.has(key))) plugins[other.plugin.id] = { enabled: false };
    }
  }
  const unknown: string[] = [];
  for (const [id, row] of Object.entries(rows)) {
    if (plugins[id] === undefined) unknown.push(id);
    else plugins[id] = { ...plugins[id], ...row, ...(pinned.has(id) ? { enabled: true } : {}) } as PluginEntry;
  }
  const composition = { plugins };
  return { known, composition, resolved: resolveComposition(known, composition), unknown };
}
