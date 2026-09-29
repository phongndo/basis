import { Context, Schema } from "effect";
import type { Effect } from "effect";
import { Event } from "@lemma/core";
import type { CoreClosed, PluginFault, PluginState, ReloadError, ReloadReport, RestartOptions } from "@lemma/core";

/**
 * Locations the host resolves once. Plugins never compute paths themselves.
 * Defaults: `~/.lemma` for user data; `<cwd>/.lemma` for project data.
 */
export class Paths extends Context.Tag("lemma/Paths")<
  Paths,
  {
    /** `~/.lemma` (or `$LEMMA_HOME`). */
    readonly home: string;
    /** `<home>/config.jsonc` */
    readonly userConfig: string;
    /** `<cwd>/.lemma/config.jsonc` */
    readonly projectConfig: string;
    /** `<home>/auth.json` */
    readonly auth: string;
    /** `<home>/sessions` */
    readonly sessions: string;
    /** Working directory the host was started in; the default for new sessions. */
    readonly cwd: string;
  }
>() {}

/** One plugin's row in a config file: whether it runs, and with what config. */
export const PluginRow = Schema.Struct({ enabled: Schema.optional(Schema.Boolean), config: Schema.optional(Schema.Unknown) });
export type PluginRow = typeof PluginRow.Type;

/** Which config file a change is written to. The project file needs the project to be trusted. */
export const ConfigScope = Schema.Literal("user", "project");
export type ConfigScope = typeof ConfigScope.Type;

/**
 * Composition file (JSONC). User and project files merge: project rows override
 * user rows by plugin id; `config` objects are replaced, not deep-merged.
 * A project's file and plugins load only when the user file trusts the project.
 */
export const ConfigFile = Schema.Struct({
  /** User file only: absolute directories whose projects (and their subdirectories) may configure the host and load plugins. */
  trustedProjects: Schema.optional(Schema.Array(Schema.String)),
  plugins: Schema.optional(Schema.Record({ key: Schema.String, value: PluginRow })),
});
export type ConfigFile = typeof ConfigFile.Type;

/** Where a plugin's definition came from: the app, `<home>/plugins`, or a trusted project's `.lemma/plugins`. */
export const PluginSource = Schema.Literal("bundled", "user", "project");
export type PluginSource = typeof PluginSource.Type;

/**
 * One plugin the host knows, running or not. `enabled` is the config files'
 * choice; `state` is the core's, absent when the plugin is not loaded. A plugin
 * can be enabled yet unloaded when a capability it requires comes from a plugin
 * that is off: `haltedBy` then names that plugin.
 */
export interface PluginInfo {
  readonly id: string;
  readonly version?: string;
  readonly source: PluginSource;
  /** A local plugin with a bundled plugin's id runs instead of it. */
  readonly shadows?: boolean;
  readonly enabled: boolean;
  /** The config file whose row sets `enabled`; absent when neither does. */
  readonly scope?: ConfigScope;
  /** Why this plugin cannot be turned off: it is pinned by the app, or a pinned plugin needs what it provides. */
  readonly locked?: string;
  /** Capability keys. */
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  readonly state?: PluginState;
  readonly fault?: PluginFault;
  readonly haltedBy?: string;
}

/** Identifies the running plugin set, so a logged request can name what produced it. */
export const CompositionInfo = Schema.Struct({
  /** Stable hash of plugin ids, versions, and configs. Changes on every applied reload that changes any of them. */
  id: Schema.String,
  plugins: Schema.Array(Schema.Struct({ id: Schema.String, version: Schema.optional(Schema.String) })),
});
export type CompositionInfo = typeof CompositionInfo.Type;

/**
 * A message for the user that is not tied to a session: login progress, a
 * device code to enter, a URL to open, a plugin fault, a reload outcome.
 */
export const NoticePayload = Schema.Struct({
  level: Schema.Literal("info", "warning", "error"),
  message: Schema.String,
  source: Schema.optional(Schema.String),
  links: Schema.optional(Schema.Array(Schema.Struct({ url: Schema.String, label: Schema.optional(Schema.String) }))),
  /** A code the user types elsewhere (device login). */
  code: Schema.optional(Schema.String),
});
export type NoticePayload = typeof NoticePayload.Type;
export const Notice = Event.make<NoticePayload>("lemma/notice");

/**
 * Handle on the loader, provided by the host application (which owns it) so
 * transports and UIs can inspect and change the running composition without
 * reaching into the kernel.
 */
export class HostControl extends Context.Tag("lemma/HostControl")<
  HostControl,
  {
    /** Every known plugin, enabled or not. */
    readonly plugins: Effect.Effect<readonly PluginInfo[]>;
    readonly composition: Effect.Effect<CompositionInfo>;
    /** A failed plugin and what it halted; with `force`, a running one too, unless the app depends on it (a `ReloadError` says so). */
    readonly restart: (pluginId: string, options?: RestartOptions) => Effect.Effect<void, ReloadError | CoreClosed>;
    /** Re-read the config files and apply the resulting composition. */
    readonly reload: Effect.Effect<ReloadReport, ReloadError>;
    /**
     * Write plugin rows into a config file (the user's by default) and apply the
     * result. A change the host rejects is undone in the file, so a bad row never
     * outlives the call; the diagnostics say why.
     */
    readonly configure: (plugins: Readonly<Record<string, PluginRow>>, options?: { readonly scope?: ConfigScope }) => Effect.Effect<ReloadReport, ReloadError>;
  }
>() {}

/** Emitted after any composition change or plugin fault so clients can refresh plugin views. */
export const PluginsChanged = Event.make<{ readonly plugins: readonly PluginInfo[] }>("lemma/plugins.changed");
