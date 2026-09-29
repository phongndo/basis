import { Effect, Layer } from "effect";
import { definePlugin } from "@lemma/core";
import { Tools } from "@lemma/contracts";
import type { Tool } from "@lemma/contracts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

export { bashTool, BashInput } from "./bash.ts";
export type { BashDetails } from "./bash.ts";
export { applyEdits, editTool, EditInput } from "./edit.ts";
export type { EditDetails } from "./edit.ts";
export { readTool, ReadInput, MAX_IMAGE_BYTES } from "./read.ts";
export type { ReadDetails } from "./read.ts";
export { writeTool, WriteInput } from "./write.ts";
export { unifiedPatch } from "./diff.ts";
export { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, truncateTail } from "./truncate.ts";

/**
 * One plugin per tool, with the tool's name as its id, so a composition can
 * disable or replace one (`bash`, say) without touching the others. Exclusive
 * because the registry rejects duplicate names: a reload must unregister the
 * old tool before the new one registers.
 */
const toolPlugin = (tool: Tool<any>) =>
  definePlugin({
    id: tool.name,
    version: "0.1.0",
    requires: [Tools],
    exclusive: true,
    layer: Layer.scopedDiscard(Effect.flatMap(Tools, (registry) => registry.register(tool))),
  });

export const read = toolPlugin(readTool);
export const write = toolPlugin(writeTool);
export const edit = toolPlugin(editTool);
export const bash = toolPlugin(bashTool);

/** All four plugins, for compositions that want the standard set. */
export default [read, write, edit, bash] as const;
