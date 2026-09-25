import { Context, Data, Schema } from "effect";
import type { Effect } from "effect";

/**
 * Agent Skills (agentskills.io): a directory with SKILL.md whose frontmatter
 * carries name and description. Only name, description, and path enter the
 * prompt; the body loads on demand. Sources: `.basis/skills`, `.agents/skills`,
 * `~/.basis/skills`, `~/.agents/skills`, plus configured directories.
 */
export class SkillInfo extends Schema.Class<SkillInfo>("basis/SkillInfo")({
  name: Schema.String,
  description: Schema.String,
  path: Schema.String,
  /** Where it was found, for diagnostics and shadowing rules (project beats user). */
  source: Schema.String,
  /** Frontmatter flag: not offered to the model, only invokable by the user. */
  userOnly: Schema.Boolean,
}) {}

export class SkillError extends Data.TaggedError("SkillError")<{
  readonly name?: string;
  readonly reason: "NotFound" | "Invalid" | "Io";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class Skills extends Context.Tag("basis/Skills")<Skills, {
  readonly list: Effect.Effect<readonly SkillInfo[], SkillError>;
  /** SKILL.md body (frontmatter stripped) with the skill's directory for relative references. */
  readonly load: (name: string) => Effect.Effect<{ readonly info: SkillInfo; readonly body: string }, SkillError>;
  readonly refresh: Effect.Effect<void, SkillError>;
}>() {}
