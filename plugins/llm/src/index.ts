import { Layer } from "effect";
import { definePlugin } from "@basis/core";
import { Llm } from "@basis/contracts";
import { makeLlm } from "./llm.ts";

export { catalogFor } from "./catalog.ts";
export { CATALOG_TTL, makeLlm, providerOf } from "./llm.ts";
export { generated as generatedModels, generatedAt } from "./models.generated.ts";
export type { GeneratedModel } from "./models.generated.ts";

export default definePlugin({
  id: "llm",
  version: "0.1.0",
  provides: [Llm],
  layer: Layer.effect(Llm, makeLlm),
});
