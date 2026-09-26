import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import { definePlugin } from "@basis/core";
import { Tools } from "@basis/contracts";
import type { Tool, ToolContext, ToolResult } from "@basis/contracts";

/** An in-memory stand-in for the tools plugin: records registrations and forgets them when their scope closes. */
export const fakeTools = (registered: Map<string, Tool<any>>) => definePlugin({
  id: "fake-tools",
  provides: [Tools],
  layer: Layer.succeed(Tools, {
    register: (tool) => Effect.acquireRelease(
      Effect.sync(() => { registered.set(tool.name, tool); }),
      () => Effect.sync(() => { registered.delete(tool.name); }),
    ),
    list: Effect.succeed([]),
    execute: () => Effect.die("not used by these tests"),
  }),
});

export const context = (cwd: string, signal: AbortSignal = new AbortController().signal): ToolContext =>
  ({ sessionId: "s", toolCallId: "c", cwd, signal });

/** Calls a tool the way the registry would, whichever shape `execute` returns. */
export const call = async <I>(tool: Tool<I>, input: I, ctx: ToolContext): Promise<ToolResult> => {
  const output = tool.execute(input, ctx);
  return Effect.isEffect(output) ? Effect.runPromise(output as Effect.Effect<ToolResult, never>) : output;
};

export const textOf = (result: ToolResult): string =>
  result.content.map((part) => part.type === "text" ? part.text : `<image ${part.mediaType}>`).join("");

export const withTempDir = async <A>(body: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "basis-tools-"));
  try {
    return await body(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};
