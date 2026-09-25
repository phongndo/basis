import { Context, Schema } from "effect";
import { Event } from "@basis/core";

/**
 * Locations the host resolves once. Plugins never compute paths themselves.
 * Defaults: `~/.basis` for user data; `.basis` in the project for project data.
 */
export class Paths extends Context.Tag("basis/Paths")<Paths, {
  /** `~/.basis` (or `$BASIS_HOME`). */
  readonly home: string;
  /** `<home>/config.jsonc` */
  readonly userConfig: string;
  /** `<cwd>/.basis/config.jsonc` */
  readonly projectConfig: string;
  /** `<home>/auth.json` */
  readonly auth: string;
  /** `<home>/sessions` */
  readonly sessions: string;
  /** Working directory the host was started in. */
  readonly cwd: string;
}>() {}

/**
 * Composition file (JSONC). User and project files merge: project rows override
 * user rows by plugin id; `config` objects are replaced, not deep-merged.
 */
export const ConfigFile = Schema.Struct({
  plugins: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.Struct({ enabled: Schema.optional(Schema.Boolean), config: Schema.optional(Schema.Unknown) }),
  })),
});
export type ConfigFile = typeof ConfigFile.Type;

/** A message for the user that is not tied to a session (login result, plugin fault, reload outcome). */
export const Notice = Event.make<{ readonly level: "info" | "warning" | "error"; readonly message: string; readonly source?: string }>("basis/notice");
