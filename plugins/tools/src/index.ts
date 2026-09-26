import { Layer, Schema } from "effect";
import { definePlugin } from "@basis/core";
import { Tools } from "@basis/contracts";
import { makeRegistry } from "./registry.ts";

const Fields = Schema.Struct({
  /** Total text characters a tool result may carry to the model; longer results are truncated with a marker. */
  maxResultChars: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), { default: () => 50_000 }),
});

/** Absent config means defaults: the host passes nothing for plugins the user has not configured. */
export const ToolsConfig = Schema.transform(Schema.UndefinedOr(Fields), Schema.typeSchema(Fields), {
  strict: true,
  decode: (value) => value ?? Schema.decodeSync(Fields)({}),
  encode: (value) => value,
});
export type ToolsConfig = typeof ToolsConfig.Type;

export { capResult } from "./content.ts";
export { toolInputSchema } from "./schema.ts";

export default definePlugin({
  id: "tools",
  version: "0.1.0",
  config: ToolsConfig,
  provides: [Tools],
  layer: (config) => Layer.effect(Tools, makeRegistry({ maxResultChars: config.maxResultChars })),
});
