import { ModelInfo } from "@basis/contracts";
import { generated } from "./models.generated.ts";

/**
 * Bundled models.dev entries for one provider (`scripts/generate-models.ts`
 * refreshes them). Provider plugins own the truth about ids and limits; this
 * is the source for names and prices they overlay.
 */
export function catalogFor(providerId: string): readonly ModelInfo[] {
  return (generated[providerId] ?? []).map((model) => new ModelInfo(model));
}
