import { Effect } from "effect";
import type { Scope } from "effect";
import type { Core } from "./core.ts";
import type { Diagnostic, ReloadError } from "./errors.ts";
import type { Deadlines, Plugin } from "./plugin.ts";

/** One row of a composition, keyed by plugin id. Config is validated by the plugin's schema. */
export interface PluginEntry {
  readonly enabled?: boolean;
  readonly config?: unknown;
}

/** Pure data: which plugins run and how they are configured. Reading files is the host's job. */
export interface Composition {
  readonly plugins: Readonly<Record<string, PluginEntry>>;
}

/** Maps ids to definitions. The host decides what an id means: a bundled map, an npm package, a path. */
export interface PluginSource {
  readonly resolve: (id: string) => Effect.Effect<Plugin, Diagnostic>;
}

export interface ReloadReport {
  readonly started: readonly string[];
  readonly stopped: readonly string[];
  readonly restarted: readonly string[];
  readonly unchanged: readonly string[];
}

export interface LoaderOptions {
  readonly source: PluginSource;
  readonly composition: Composition;
  /** Applied to plugins that declare none. */
  readonly deadlines?: Deadlines;
}

/**
 * Runs a composition described by data and changes it at runtime.
 *
 * `apply` plans the whole change first and reports every problem at once. Only
 * plugins whose definition or config changed (and their dependents) are touched.
 * Replacements start in a staging scope while the old instances keep serving;
 * then old instances stop admitting work, in-flight work drains, and they close.
 * `exclusive` plugins stop before their replacement starts. If any step fails,
 * the running composition is unchanged and the failure is returned.
 */
export interface Loader {
  /** Compositions are checked when planned, so the core's capabilities are not statically typed. */
  readonly core: Core<any>;
  readonly composition: Effect.Effect<Composition>;
  readonly apply: (next: Composition) => Effect.Effect<ReloadReport, ReloadError>;
}

export function makeLoader(_options: LoaderOptions): Effect.Effect<Loader, ReloadError, Scope.Scope> {
  return Effect.die(new Error("@basis/core: makeLoader is a contract only; see docs/kernel.md"));
}
