import { Effect, Layer, Schema } from "effect";
import { definePlugin } from "@basis/core";
import { Tools } from "@basis/contracts";
import type { Tool } from "@basis/contracts";
import { bashTool, DEFAULT_BASH_OPTIONS } from "./bash.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

const Positive = Schema.Int.pipe(Schema.positive());

const Fields = Schema.Struct({
  bash: Schema.optionalWith(Schema.Struct({
    /** Default timeout for a command that gives none. */
    timeoutMs: Schema.optionalWith(Positive, { default: () => DEFAULT_BASH_OPTIONS.timeoutMs }),
    /** Captured output beyond this keeps head and tail around a marker. */
    maxOutputChars: Schema.optionalWith(Positive, { default: () => DEFAULT_BASH_OPTIONS.maxOutputChars }),
  }), { default: () => ({ ...DEFAULT_BASH_OPTIONS }) }),
});

/** Absent config means defaults: the host passes nothing for plugins the user has not configured. */
export const BuiltinToolsConfig = Schema.transform(Schema.UndefinedOr(Fields), Schema.typeSchema(Fields), {
  strict: true,
  decode: (value) => value ?? Schema.decodeSync(Fields)({}),
  encode: (value) => value,
});
export type BuiltinToolsConfig = typeof BuiltinToolsConfig.Type;

export { bashTool, BashInput, DEFAULT_BASH_OPTIONS, OutputBuffer } from "./bash.ts";
export type { BashOptions } from "./bash.ts";
export { editTool, EditInput } from "./edit.ts";
export { DEFAULT_READ_LIMIT, readTool, ReadInput } from "./read.ts";
export { writeTool, WriteInput } from "./write.ts";

export default definePlugin({
  id: "tools-builtin",
  version: "0.1.0",
  config: BuiltinToolsConfig,
  requires: [Tools],
  layer: (config) => Layer.scopedDiscard(Effect.gen(function* () {
    const registry = yield* Tools;
    const all: readonly Tool<any>[] = [readTool, writeTool, editTool, bashTool(config.bash)];
    for (const tool of all) yield* registry.register(tool);
  })),
});
