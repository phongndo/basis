import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Effect, Either, ParseResult, Schema } from "effect";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import { ConfigFile } from "@basis/contracts";
import { Diagnostic } from "@basis/core";
import type { Composition, PluginEntry } from "@basis/core";
import type { PathsService } from "./paths.ts";

export const HOST_PLUGIN_ID = "host";

export interface LoadedComposition {
  /** Always contains the `host` row carrying `paths`; the host plugin cannot be disabled by a file. */
  readonly composition: Composition;
  /** Errors (unreadable or invalid files) and warnings. Every message names the file. */
  readonly diagnostics: readonly Diagnostic[];
  /** The files consulted, in merge order (user first), and whether each existed. */
  readonly files: readonly { readonly path: string; readonly found: boolean }[];
  /** Whether the user file's `trustedProjects` covers `paths.cwd`. Only a trusted project's file and plugins load. */
  readonly trusted: boolean;
}

/** `<cwd>/.basis/plugins`: plugin files that load only in a trusted project. */
export const projectPluginsDir = (paths: PathsService): string => join(dirname(paths.projectConfig), "plugins");

/** A directory is trusted when it is, or is inside, an absolute entry of `trustedProjects`. */
export function isTrusted(cwd: string, trustedProjects: readonly string[]): boolean {
  return trustedProjects.some((entry) => {
    if (!isAbsolute(entry)) return false;
    const inside = relative(resolve(entry), cwd);
    return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
  });
}

/**
 * Reads and merges the user and project config files. The project file is read
 * only when the user file trusts the project: a cloned repository must not be
 * able to run plugins, rebind the transport, or redirect provider keys just by
 * being the working directory. Project rows override
 * user rows by plugin id: `enabled` and `config` are each taken from the project
 * row when present, and a `config` object replaces the user's whole object.
 * Missing files are normal; malformed ones are reported and skipped, so the
 * result is usable for diagnostics even when it must not be applied.
 */
export function loadComposition(paths: PathsService): Effect.Effect<LoadedComposition> {
  return Effect.gen(function* () {
    const user = yield* readConfig(paths.userConfig);
    const trusted = isTrusted(paths.cwd, user.trustedProjects);
    const project = trusted ? yield* readConfig(paths.projectConfig) : yield* skipConfig(paths.projectConfig);
    const diagnostics = [...user.diagnostics, ...project.diagnostics];
    if (!trusted && (project.found || (yield* exists(projectPluginsDir(paths))))) {
      diagnostics.push(
        new Diagnostic({
          severity: "warning",
          message: `${dirname(paths.projectConfig)}: project config and plugins are ignored because ${paths.cwd} is not trusted`,
          suggestion: `If you trust this project, add "${paths.cwd}" to "trustedProjects" in ${paths.userConfig}`,
        }),
      );
    }
    if (project.trustedProjects.length > 0) {
      diagnostics.push(
        new Diagnostic({
          severity: "warning",
          message: `${paths.projectConfig}: "trustedProjects" is ignored; only ${paths.userConfig} can grant trust`,
          suggestion: `Remove "trustedProjects" from the project file`,
        }),
      );
    }
    const plugins: Record<string, PluginEntry> = {};
    for (const file of [user, project]) {
      for (const [id, row] of Object.entries(file.plugins)) {
        if (id === HOST_PLUGIN_ID) {
          diagnostics.push(
            new Diagnostic({
              severity: "warning",
              pluginId: id,
              message: `${file.path}: the "${HOST_PLUGIN_ID}" row is ignored; the host plugin is always loaded with the resolved paths`,
              suggestion: `Remove the "${HOST_PLUGIN_ID}" row`,
            }),
          );
          continue;
        }
        // JSON cannot express undefined, so decoded rows only carry the keys the file wrote.
        plugins[id] = { ...plugins[id], ...row } as PluginEntry;
      }
    }
    plugins[HOST_PLUGIN_ID] = { config: paths };
    return {
      composition: { plugins },
      diagnostics,
      files: [
        { path: user.path, found: user.found },
        { path: project.path, found: project.found },
      ],
      trusted,
    };
  });
}

interface ReadConfig {
  readonly path: string;
  readonly found: boolean;
  readonly plugins: NonNullable<ConfigFile["plugins"]>;
  readonly trustedProjects: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

const exists = (path: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    access(path).then(
      () => true,
      () => false,
    ),
  );

/** An untrusted project's file: only whether it exists, never its contents. */
const skipConfig = (path: string): Effect.Effect<ReadConfig> =>
  Effect.map(exists(path), (found) => ({ path, found, plugins: {}, trustedProjects: [], diagnostics: [] }));

const readConfig = (path: string): Effect.Effect<ReadConfig> =>
  Effect.gen(function* () {
    const empty = (found: boolean, diagnostics: readonly Diagnostic[] = []): ReadConfig => ({ path, found, plugins: {}, trustedProjects: [], diagnostics });
    const text = yield* Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (cause) => cause as NodeJS.ErrnoException }).pipe(Effect.either);
    if (Either.isLeft(text)) {
      if (text.left.code === "ENOENT") return empty(false);
      return empty(true, [
        new Diagnostic({
          severity: "error",
          message: `${path}: cannot read config: ${text.left.message}`,
          suggestion: "Fix the file's permissions or remove it",
        }),
      ]);
    }
    const parsed = parseConfig(path, text.right);
    if (Either.isLeft(parsed)) return empty(true, [parsed.left]);
    return { path, found: true, plugins: parsed.right.plugins ?? {}, trustedProjects: parsed.right.trustedProjects ?? [], diagnostics: [] };
  });

/** JSONC with comments and trailing commas; anything else the parser recovers from is still an error here. */
function parseConfig(path: string, text: string): Either.Either<ConfigFile, Diagnostic> {
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const first = errors[0]!;
    const { line, column } = position(text, first.offset);
    return Either.left(
      new Diagnostic({
        severity: "error",
        message: `${path}:${line}:${column}: ${printParseErrorCode(first.error)}`,
        suggestion: "Fix the JSONC syntax (comments and trailing commas are allowed)",
      }),
    );
  }
  const decoded = Schema.decodeUnknownEither(ConfigFile)(value);
  if (Either.isLeft(decoded)) {
    const issue = ParseResult.ArrayFormatter.formatErrorSync(decoded.left)[0];
    const at = issue?.path.filter((segment): segment is string | number => typeof segment !== "symbol") ?? [];
    return Either.left(
      new Diagnostic({
        severity: "error",
        ...(typeof at[1] === "string" ? { pluginId: at[1] } : {}),
        path: at,
        message: `${path}: invalid config at ${at.length ? at.join(".") : "root"}: ${issue?.message ?? ParseResult.TreeFormatter.formatErrorSync(decoded.left)}`,
        suggestion: `Expected { "trustedProjects"?: string[], "plugins"?: { "<id>": { "enabled"?: boolean, "config"?: unknown } } }`,
      }),
    );
  }
  return Either.right(decoded.right);
}

function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return { line, column };
}
