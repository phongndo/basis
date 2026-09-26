import { ModelInfo } from "@basis/contracts";

/**
 * Reasoning-capable models the Responses API serves, with context, output,
 * and USD-per-million pricing taken from models.dev on 2026-09-25. This is a
 * static fallback; when the llm plugin exposes a models.dev helper the entries
 * here should be overlaid by live data rather than maintained by hand.
 */
const entries: readonly [id: string, name: string, contextWindow: number, maxOutput: number, input: number, output: number, cacheRead?: number][] = [
  ["gpt-6-astra", "GPT-6 Astra", 1050000, 128000, 10, 50, 1],
  ["gpt-6-sol", "GPT-6 Sol", 1050000, 128000, 2, 10, 0.2],
  ["gpt-6-luna", "GPT-6 Luna", 1050000, 128000, 0.1, 0.5, 0.01],
  ["gpt-5.6", "GPT-5.6", 1050000, 128000, 4, 20, 0.4],
  ["gpt-5.6-sol", "GPT-5.6 Sol", 1050000, 128000, 4, 20, 0.4],
  ["gpt-5.6-terra", "GPT-5.6 Terra", 1050000, 128000, 2, 12, 0.2],
  ["gpt-5.6-luna", "GPT-5.6 Luna", 1050000, 128000, 0.2, 1.2, 0.02],
  ["gpt-5.5", "GPT-5.5", 1050000, 128000, 5, 30, 0.5],
  ["gpt-5.5-pro", "GPT-5.5 Pro", 1050000, 128000, 30, 180],
  ["gpt-5.4", "GPT-5.4", 1050000, 128000, 2.5, 15, 0.25],
  ["gpt-5.4-mini", "GPT-5.4 mini", 400000, 128000, 0.75, 4.5, 0.075],
  ["gpt-5.4-nano", "GPT-5.4 nano", 400000, 128000, 0.2, 1.25, 0.02],
  ["gpt-5.3-codex", "GPT-5.3 Codex", 400000, 128000, 1.75, 14, 0.175],
  ["gpt-5.2", "GPT-5.2", 400000, 128000, 1.75, 14, 0.175],
  ["gpt-5.1", "GPT-5.1", 400000, 128000, 1.25, 10, 0.125],
  ["gpt-5", "GPT-5", 400000, 128000, 1.25, 10, 0.125],
  ["gpt-5-mini", "GPT-5 Mini", 400000, 128000, 0.25, 2, 0.025],
  ["gpt-5-nano", "GPT-5 Nano", 400000, 128000, 0.05, 0.4, 0.005],
  ["o3", "o3", 200000, 100000, 2, 8, 0.5],
  ["o4-mini", "o4-mini", 200000, 100000, 1.1, 4.4, 0.275],
];

export const catalog: readonly ModelInfo[] = entries.map(([id, name, contextWindow, maxOutput, input, output, cacheRead]) => new ModelInfo({
  id: `openai/${id}`,
  provider: "openai",
  name,
  contextWindow,
  maxOutput,
  toolCall: true,
  reasoning: true,
  cost: { input, output, ...(cacheRead === undefined ? {} : { cacheRead }) },
}));
