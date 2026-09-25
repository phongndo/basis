import { readFile } from "node:fs/promises";
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
}

/**
 * Reads and merges the user and project config files. Project rows override
 * user rows by plugin id: `enabled` and `config` are each taken from the project
 * row when present, and a `config` object replaces the user's whole object.
 * Missing files are normal; malformed ones are reported and skipped, so the
 * result is usable for diagnostics even when it must not be applied.
 */
export function loadComposition(paths: PathsService): Effect.Effect<LoadedComposition> {
  return Effect.gen(function* () {
    const user = yield* readConfig(paths.userConfig);
    const project = yield* readConfig(paths.projectConfig);
    const diagnostics = [...user.diagnostics, ...project.diagnostics];
    const plugins: Record<string, PluginEntry> = {};
    for (const file of [user, project]) {
      for (const [id, row] of Object.entries(file.plugins)) {
        if (id === HOST_PLUGIN_ID) {
          diagnostics.push(new Diagnostic({
            severity: "warning", pluginId: id,
            message: `${file.path}: the "${HOST_PLUGIN_ID}" row is ignored; the host plugin is always loaded with the resolved paths`,
            suggestion: `Remove the "${HOST_PLUGIN_ID}" row`,
          }));
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
      files: [{ path: user.path, found: user.found }, { path: project.path, found: project.found }],
    };
  });
}

interface ReadConfig {
  readonly path: string;
  readonly found: boolean;
  readonly plugins: NonNullable<ConfigFile["plugins"]>;
  readonly diagnostics: readonly Diagnostic[];
}

const readConfig = (path: string): Effect.Effect<ReadConfig> =>
  Effect.gen(function* () {
    const empty = (found: boolean, diagnostics: readonly Diagnostic[] = []): ReadConfig => ({ path, found, plugins: {}, diagnostics });
    const text = yield* Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (cause) => cause as NodeJS.ErrnoException }).pipe(Effect.either);
    if (Either.isLeft(text)) {
      if (text.left.code === "ENOENT") return empty(false);
      return empty(true, [new Diagnostic({ severity: "error", message: `${path}: cannot read config: ${text.left.message}`, suggestion: "Fix the file's permissions or remove it" })]);
    }
    const parsed = parseConfig(path, text.right);
    if (Either.isLeft(parsed)) return empty(true, [parsed.left]);
    return { path, found: true, plugins: parsed.right.plugins ?? {}, diagnostics: [] };
  });

/** JSONC with comments and trailing commas; anything else the parser recovers from is still an error here. */
function parseConfig(path: string, text: string): Either.Either<ConfigFile, Diagnostic> {
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) {
    const first = errors[0]!;
    const { line, column } = position(text, first.offset);
    return Either.left(new Diagnostic({
      severity: "error",
      message: `${path}:${line}:${column}: ${printParseErrorCode(first.error)}`,
      suggestion: "Fix the JSONC syntax (comments and trailing commas are allowed)",
    }));
  }
  const decoded = Schema.decodeUnknownEither(ConfigFile)(value);
  if (Either.isLeft(decoded)) {
    const issue = ParseResult.ArrayFormatter.formatErrorSync(decoded.left)[0];
    const at = issue?.path.filter((segment): segment is string | number => typeof segment !== "symbol") ?? [];
    return Either.left(new Diagnostic({
      severity: "error",
      ...(typeof at[1] === "string" ? { pluginId: at[1] } : {}),
      path: at,
      message: `${path}: invalid config at ${at.length ? at.join(".") : "root"}: ${issue?.message ?? ParseResult.TreeFormatter.formatErrorSync(decoded.left)}`,
      suggestion: `Expected { "plugins": { "<id>": { "enabled"?: boolean, "config"?: unknown } } }`,
    }));
  }
  return Either.right(decoded.right);
}

function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return { line, column };
}
