import { Layer, Schema } from "effect";
import { definePlugin } from "@lemma/core";
import { Tools } from "@lemma/contracts";
import { makeRegistry } from "./registry.ts";

export const ToolsConfig = Schema.Struct({
  /** Total text characters one result may carry to the model; longer results are cut with a marker. */
  maxResultChars: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), { default: () => 100_000 }),
});
export type ToolsConfig = typeof ToolsConfig.Type;

export { capResult } from "./content.ts";
export { errorResult } from "./registry.ts";
export { toolParameters } from "./schema.ts";

export default definePlugin({
  id: "tools",
  version: "0.1.0",
  config: ToolsConfig,
  provides: [Tools],
  layer: (config) => Layer.effect(Tools, makeRegistry(config)),
});
