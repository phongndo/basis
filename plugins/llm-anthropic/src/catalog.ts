import { ModelInfo } from "@basis/contracts";
import { catalogFor } from "@basis/models";

export const PROVIDER_ID = "anthropic";
export const DEFAULT_MODEL = "claude-opus-5";

/**
 * How a model takes a request. `adaptive` models reject `budget_tokens` and
 * sampling parameters; `budget` models (Haiku 4.5) take the older thinking
 * shape and no `effort`.
 */
export interface ModelFacts {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxOutput: number;
  readonly thinking: "adaptive" | "budget";
  readonly sampling: boolean;
}

/** Current ids, exactly as the API takes them (no date suffixes). This table, not models.dev, is the truth for ids and limits. */
export const MODELS: readonly ModelFacts[] = [
  { id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 1_000_000, maxOutput: 128_000, thinking: "adaptive", sampling: false },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", contextWindow: 1_000_000, maxOutput: 128_000, thinking: "adaptive", sampling: false },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", contextWindow: 1_000_000, maxOutput: 128_000, thinking: "adaptive", sampling: false },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", contextWindow: 1_000_000, maxOutput: 128_000, thinking: "adaptive", sampling: false },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", contextWindow: 1_000_000, maxOutput: 128_000, thinking: "adaptive", sampling: true },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextWindow: 1_000_000, maxOutput: 128_000, thinking: "adaptive", sampling: false },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 1_000_000, maxOutput: 128_000, thinking: "adaptive", sampling: true },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000, maxOutput: 64_000, thinking: "budget", sampling: true },
];

export function factsFor(modelId: string): ModelFacts | undefined {
  return MODELS.find((model) => model.id === modelId);
}

/** The bundled table with models.dev prices overlaid where models.dev knows the id. */
export const catalog: readonly ModelInfo[] = (() => {
  const prices = new Map(catalogFor(PROVIDER_ID).map((model) => [model.id, model.cost] as const));
  return MODELS.map((model) => {
    const id = `${PROVIDER_ID}/${model.id}`;
    const cost = prices.get(id);
    return new ModelInfo({
      id, provider: PROVIDER_ID, name: model.name,
      contextWindow: model.contextWindow, maxOutput: model.maxOutput,
      toolCall: true, reasoning: true,
      ...(cost === undefined ? {} : { cost }),
    });
  });
})();
