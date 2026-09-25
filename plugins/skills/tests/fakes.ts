import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect, JSONSchema, Layer, Schema } from "effect";
import { definePlugin, PluginContext } from "@basis/core";
import { Notice, Paths, ToolDefinition, ToolError, ToolResult, Tools } from "@basis/contracts";
import type { Tool, ToolContext } from "@basis/contracts";

/** In-memory Tools: enough of the contract to register, list, and execute (no hook, no gate). */
export const fakeTools = definePlugin({
  id: "tools",
  provides: [Tools],
  layer: Layer.sync(Tools, () => {
    const registry = new Map<string, Tool<any>>();
    return {
      register: (tool) => Effect.acquireRelease(
        Effect.gen(function* () {
          if (registry.has(tool.name)) return yield* new ToolError({ tool: tool.name, reason: "Failed", message: `duplicate tool "${tool.name}"` });
          registry.set(tool.name, tool);
        }),
        () => Effect.sync(() => { registry.delete(tool.name); }),
      ),
      list: Effect.sync(() => [...registry.values()].map((tool) =>
        new ToolDefinition({ name: tool.name, description: tool.description, inputSchema: JSONSchema.make(tool.input) as unknown as Record<string, unknown> }))),
      execute: (invocation) => Effect.gen(function* () {
        const tool = registry.get(invocation.name);
        if (!tool) return yield* new ToolError({ tool: invocation.name, reason: "NotFound", message: "no such tool" });
        const input = yield* Schema.decodeUnknown(tool.input)(invocation.input).pipe(
          Effect.mapError((cause) => new ToolError({ tool: invocation.name, reason: "InvalidInput", message: String(cause), cause })));
        const context: ToolContext = { sessionId: invocation.sessionId, toolCallId: invocation.toolCallId, cwd: invocation.cwd, signal: new AbortController().signal };
        const outcome = tool.execute(input, context);
        const result = yield* (outcome instanceof Promise ? Effect.promise(() => outcome) : outcome).pipe(
          Effect.mapError((cause) => cause instanceof ToolError ? cause : new ToolError({ tool: invocation.name, reason: "Failed", message: String(cause), cause })));
        return result as ToolResult;
      }),
    };
  }),
});

export const fakePaths = (cwd: string, home: string) => definePlugin({
  id: "host",
  provides: [Paths],
  layer: Layer.succeed(Paths, {
    home, cwd,
    userConfig: join(home, "config.jsonc"), projectConfig: join(cwd, ".basis", "config.jsonc"),
    auth: join(home, "auth.json"), sessions: join(home, "sessions"),
  }),
});

/** Collects notices so tests can assert on what the user would have been told. */
export const noticeCollector = (sink: { level: string; message: string; source?: string }[]) => definePlugin({
  id: "notices",
  layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.observe(Notice, (notice) => Effect.sync(() => { sink.push(notice); })))),
});

/** A throwaway project + home tree; `skill` writes a SKILL.md under a source root. */
export class Fixture {
  readonly root = mkdtempSync(join(tmpdir(), "basis-skills-"));
  readonly cwd = join(this.root, "project");
  readonly home = join(this.root, "home", ".basis");
  readonly userHome = join(this.root, "home");
  constructor() {
    mkdirSync(this.cwd, { recursive: true });
    mkdirSync(this.home, { recursive: true });
  }
  skill(sourceDir: string, name: string, frontmatter: string, body = `Body of ${name}.`, directory = name): string {
    const path = join(sourceDir, directory);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
    return path;
  }
  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

export function waitFor<A, E, R>(effect: Effect.Effect<A, E, R>, predicate: (value: A) => boolean): Effect.Effect<A, E, R> {
  const poll: Effect.Effect<A, E, R> = Effect.flatMap(effect, (value) =>
    predicate(value) ? Effect.succeed(value) : Effect.sleep(Duration.millis(10)).pipe(Effect.zipRight(poll)));
  return poll.pipe(Effect.timeout(Duration.seconds(5)), Effect.orDie);
}
