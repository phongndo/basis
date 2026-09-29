import { Context, Schema } from "effect";
import type { Effect } from "effect";
import { Event } from "@lemma/core";
import type { CoreClosed, PluginSnapshot, ReloadError, ReloadReport } from "@lemma/core";

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

/**
 * Composition file (JSONC). User and project files merge: project rows override
 * user rows by plugin id; `config` objects are replaced, not deep-merged.
 * A project's file and plugins load only when the user file trusts the project.
 */
export const ConfigFile = Schema.Struct({
  /** User file only: absolute directories whose projects (and their subdirectories) may configure the host and load plugins. */
  trustedProjects: Schema.optional(Schema.Array(Schema.String)),
  plugins: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.Struct({ enabled: Schema.optional(Schema.Boolean), config: Schema.optional(Schema.Unknown) }),
    }),
  ),
});
export type ConfigFile = typeof ConfigFile.Type;

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
    readonly plugins: Effect.Effect<readonly PluginSnapshot[]>;
    readonly composition: Effect.Effect<CompositionInfo>;
    readonly restart: (pluginId: string) => Effect.Effect<void, ReloadError | CoreClosed>;
    /** Re-read the config files and apply the resulting composition. */
    readonly reload: Effect.Effect<ReloadReport, ReloadError>;
  }
>() {}

/** Emitted after any composition change or plugin fault so clients can refresh plugin views. */
export const PluginsChanged = Event.make<{ readonly plugins: readonly PluginSnapshot[] }>("lemma/plugins.changed");
