import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Ref, Schema } from "effect";
import { definePlugin, Events, PluginContext } from "@basis/core";
import { AgentRequestHook, LlmRequest, Notice, Paths, SkillError, SkillInfo, Skills, ToolError, ToolResult, Tools } from "@basis/contracts";
import { discover, splitFrontmatter } from "./discover.ts";
import { watchSources } from "./watch.ts";

export { discover, parseFrontmatter, splitFrontmatter } from "./discover.ts";
export type { Discovered, SkillFrontmatter, SkillProblem } from "./discover.ts";

const Fields = Schema.Struct({
  /** Extra skill roots, lowest precedence, scanned in the order given. */
  directories: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
});

/** Absent config means no extra directories. */
export const SkillsConfig = Schema.transform(Schema.UndefinedOr(Fields), Schema.typeSchema(Fields), {
  strict: true,
  decode: (config) => config ?? { directories: [] },
  encode: (config) => config,
});
export type SkillsConfig = typeof SkillsConfig.Type;

/** Skill roots in precedence order: project, then user, then configured extras. */
export function sources(paths: { readonly cwd: string; readonly home: string }, config: SkillsConfig): readonly string[] {
  return [...new Set([
    join(paths.cwd, ".basis", "skills"),
    join(paths.cwd, ".agents", "skills"),
    join(paths.home, "skills"),
    join(process.env["HOME"] ?? homedir(), ".agents", "skills"),
    ...config.directories,
  ])];
}

/** The prompt sees only name, description, and path; the body arrives through the `skill` tool. */
export function renderSection(skills: readonly SkillInfo[]): string {
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.path})`);
  return ["# Skills", "Load a skill with the `skill` tool before following it.", ...lines].join("\n");
}

export default definePlugin({
  id: "skills",
  config: SkillsConfig,
  provides: [Skills],
  requires: [Paths, Tools],
  layer: (config) => Layer.scoped(Skills, Effect.gen(function* () {
    const paths = yield* Paths;
    const tools = yield* Tools;
    const events = yield* Events;
    const owner = yield* PluginContext;
    const roots = sources(paths, config);
    const cache = yield* Ref.make<readonly SkillInfo[]>([]);
    const scanning = yield* Effect.makeSemaphore(1);

    // Problems are reported every scan: a broken skill stays broken until fixed, and the notice is losable.
    const refresh = scanning.withPermits(1)(Effect.gen(function* () {
      const { skills, problems } = yield* discover(roots);
      yield* Ref.set(cache, skills);
      for (const problem of problems) {
        yield* events.publish(Notice, { level: "warning", source: "skills", message: `Skipped ${problem.file}: ${problem.message}` });
      }
    }));

    const load = (name: string) => Effect.gen(function* () {
      const info = (yield* Ref.get(cache)).find((skill) => skill.name === name);
      if (!info) return yield* new SkillError({ name, reason: "NotFound", message: `No skill named "${name}"` });
      const file = join(info.path, "SKILL.md");
      const text = yield* Effect.tryPromise({
        try: () => readFile(file, "utf8"),
        catch: (cause) => new SkillError({ name, reason: "Io", message: `Cannot read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`, cause }),
      });
      return { info, body: splitFrontmatter(text)?.body ?? text };
    });

    yield* refresh;

    yield* owner.on(AgentRequestHook, (input, next) => Effect.gen(function* () {
      const offered = (yield* Ref.get(cache)).filter((skill) => !skill.userOnly);
      if (offered.length === 0) return yield* next(input);
      const section = renderSection(offered);
      const system = input.request.system ? `${input.request.system}\n\n${section}` : section;
      return yield* next({ sessionId: input.sessionId, request: new LlmRequest({ ...input.request, system }) });
    }), { order: 10 });

    yield* tools.register({
      name: "skill",
      description: "Load a skill's instructions by name. The result names the skill's directory; read files the instructions reference with the read tool, relative to that directory.",
      input: Schema.Struct({ name: Schema.String }),
      execute: ({ name }) => load(name).pipe(
        Effect.map(({ info, body }) => info.userOnly
          ? new ToolResult({ content: [{ type: "text", text: `Skill "${name}" is user-only and cannot be loaded by the model.` }], isError: true })
          : new ToolResult({ content: [{ type: "text", text: `Skill "${info.name}" (directory: ${info.path})\n\n${body}` }] })),
        Effect.catchTag("SkillError", (error) => error.reason === "NotFound"
          ? Effect.succeed(new ToolResult({ content: [{ type: "text", text: error.message }], isError: true }))
          : Effect.fail(new ToolError({ tool: "skill", reason: "Failed", message: error.message, cause: error }))),
      ),
    });

    yield* owner.background("watch", yield* watchSources(roots, refresh));

    return { list: Ref.get(cache), load, refresh };
  })),
});
