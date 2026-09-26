import { Layer } from "effect";
import { definePlugin } from "@basis/core";
import { Llm } from "@basis/contracts";
import { makeLlm } from "./llm.ts";

export { CATALOG_TTL, makeLlm, providerOf } from "./llm.ts";

export default definePlugin({
  id: "llm",
  version: "0.1.0",
  provides: [Llm],
  layer: Layer.effect(Llm, makeLlm),
});
