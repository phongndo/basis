import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Effect, Either } from "effect";
import { SkillInfo } from "@basis/contracts";
import { parse as parseYaml } from "yaml";

/** A skill that was skipped, with the file and the reason so the user can fix it. */
export interface SkillProblem {
  readonly file: string;
  readonly message: string;
}

export interface Discovered {
  readonly skills: readonly SkillInfo[];
  readonly problems: readonly SkillProblem[];
}

/** Frontmatter fields the Agent Skills specification defines; unknown keys are ignored. */
export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly allowedTools?: readonly string[];
  /** `disable-model-invocation`: the skill is only for the user to invoke. */
  readonly userOnly: boolean;
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Split a SKILL.md into its YAML frontmatter and Markdown body; undefined when no frontmatter block opens the file. */
export function splitFrontmatter(text: string): { readonly frontmatter: string; readonly body: string } | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return undefined;
  return { frontmatter: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n").replace(/^\n+/, "") };
}

/** Validate frontmatter against the specification; the directory name must equal the skill name. */
export function parseFrontmatter(text: string, directoryName: string): Either.Either<SkillFrontmatter, string> {
  const split = splitFrontmatter(text);
  if (!split) return Either.left("missing YAML frontmatter (a file must open with a --- block)");
  let raw: unknown;
  try {
    raw = parseYaml(split.frontmatter);
  } catch (error) {
    return Either.left(`invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return Either.left("frontmatter must be a YAML mapping");
  const fields = raw as Record<string, unknown>;

  const name = fields["name"];
  if (typeof name !== "string" || name.length === 0) return Either.left("frontmatter needs a non-empty string field \"name\"");
  if (name.length > 64) return Either.left(`name "${name}" exceeds 64 characters`);
  if (!NAME.test(name)) return Either.left(`name "${name}" must be lowercase letters, digits, and single hyphens`);
  if (name !== directoryName) return Either.left(`name "${name}" does not match its directory "${directoryName}"`);
  const description = fields["description"];
  if (typeof description !== "string" || description.trim().length === 0) return Either.left("frontmatter needs a non-empty string field \"description\"");
  if (description.length > 1024) return Either.left("description exceeds 1024 characters");

  const optionalString = (key: string): string | undefined | Error => {
    const value = fields[key];
    return value === undefined || typeof value === "string" ? value : new Error(`field "${key}" must be a string`);
  };
  const license = optionalString("license");
  if (license instanceof Error) return Either.left(license.message);
  const compatibility = optionalString("compatibility");
  if (compatibility instanceof Error) return Either.left(compatibility.message);
  const metadata = fields["metadata"];
  if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)
    || Object.values(metadata).some((value) => typeof value !== "string"))) {
    return Either.left("field \"metadata\" must be a mapping of strings");
  }
  const allowed = fields["allowed-tools"];
  if (allowed !== undefined && typeof allowed !== "string" && !(Array.isArray(allowed) && allowed.every((tool) => typeof tool === "string"))) {
    return Either.left("field \"allowed-tools\" must be a space-separated string or a list of strings");
  }
  const userOnly = fields["disable-model-invocation"];
  if (userOnly !== undefined && typeof userOnly !== "boolean") return Either.left("field \"disable-model-invocation\" must be a boolean");

  return Either.right({
    name,
    description: description.trim(),
    ...(license === undefined ? {} : { license }),
    ...(compatibility === undefined ? {} : { compatibility }),
    ...(metadata === undefined ? {} : { metadata: metadata as Record<string, string> }),
    ...(allowed === undefined ? {} : { allowedTools: typeof allowed === "string" ? allowed.split(/\s+/).filter(Boolean) : allowed as string[] }),
    userOnly: userOnly ?? false,
  });
}

/** Immediate subdirectories (symlinks followed) of a directory; empty when it does not exist. */
export const subdirectories = (directory: string): Effect.Effect<readonly string[]> =>
  Effect.tryPromise(async () => {
    const entries = await readdir(directory, { withFileTypes: true });
    const directories: string[] = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && (await stat(path).catch(() => undefined))?.isDirectory());
      if (isDirectory) directories.push(path);
    }
    return directories.sort();
  }).pipe(Effect.orElseSucceed((): readonly string[] => []));

/**
 * Scan sources in precedence order: the first source to define a name wins and
 * later definitions are shadowed silently (their `source` would say why). A
 * directory without SKILL.md is not a skill and is ignored; one whose file is
 * unreadable or invalid is a problem the caller reports.
 */
export const discover = (sources: readonly string[]): Effect.Effect<Discovered> =>
  Effect.gen(function* () {
    const skills: SkillInfo[] = [];
    const problems: SkillProblem[] = [];
    const claimed = new Set<string>();
    for (const source of sources) {
      for (const path of yield* subdirectories(source)) {
        const file = join(path, "SKILL.md");
        const text = yield* Effect.tryPromise({ try: () => readFile(file, "utf8"), catch: (error) => error as NodeJS.ErrnoException }).pipe(Effect.either);
        if (Either.isLeft(text)) {
          if (text.left.code !== "ENOENT" && text.left.code !== "ENOTDIR") problems.push({ file, message: `cannot read: ${text.left.message}` });
          continue;
        }
        const parsed = parseFrontmatter(text.right, basename(path));
        if (Either.isLeft(parsed)) {
          problems.push({ file, message: parsed.left });
          continue;
        }
        if (claimed.has(parsed.right.name)) continue;
        claimed.add(parsed.right.name);
        skills.push(new SkillInfo({ name: parsed.right.name, description: parsed.right.description, path, source, userOnly: parsed.right.userOnly }));
      }
    }
    return { skills, problems };
  });
