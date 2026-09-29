import { describe, expect, it } from "vitest";
import type { Api, Model, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import { discoveredModels, networkSources, withLiveCatalog } from "../src/catalog.ts";
import type { CatalogSources, DevProvider } from "../src/catalog.ts";

const model = (id: string, extra: Record<string, unknown> = {}): Model<Api> =>
  ({
    id,
    name: id,
    api: "openai-completions",
    provider: "go",
    baseUrl: "https://go.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
    ...extra,
  }) as Model<Api>;

const known = [
  model("glm-5.1", { compat: { thinkingFormat: "zai" } }),
  model("kimi-k2.6", { compat: { thinkingFormat: "deepseek" } }),
  model("minimax-m3", { api: "anthropic-messages", baseUrl: "https://go.test" }),
];

const dev: DevProvider = {
  npm: "@ai-sdk/openai-compatible",
  api: "https://go.test/v1",
  models: {
    // Still served; kimi-k2.6 is not, so models.dev dropped it.
    "glm-5.1": {},
    "minimax-m3": {},
    "glm-5": { name: "GLM-5", reasoning: true, limit: { context: 200_000, output: 32_000 }, cost: { input: 0.5, output: 1.5, cache_read: 0.1 } },
    "minimax-m2.5": { name: "MiniMax-M2.5", modalities: { input: ["text", "image"] }, provider: { npm: "@ai-sdk/anthropic" } },
    "gpt-x": { name: "GPT X", provider: { npm: "@ai-sdk/openai" } },
  },
};

describe("discoveredModels", () => {
  it("adds the models a provider serves that pi-ai does not know, described by models.dev", () => {
    const found = discoveredModels("go", known, ["glm-5.1", "glm-5", "minimax-m2.5", "brand-new"], dev, []);
    expect(found.map((m) => m.id)).toEqual(["glm-5", "minimax-m2.5", "brand-new"]);
    const [glm, minimax, fresh] = found;
    // The nearest known model on its wire API lends request settings; models.dev its facts.
    expect(glm).toMatchObject({
      name: "GLM-5",
      api: "openai-completions",
      baseUrl: "https://go.test/v1",
      provider: "go",
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 32_000,
      cost: { input: 0.5, output: 1.5, cacheRead: 0.1, cacheWrite: 0 },
      compat: { thinkingFormat: "zai" },
    });
    // A per-model package override picks the wire API, and with it the base URL.
    expect(minimax).toMatchObject({ api: "anthropic-messages", baseUrl: "https://go.test", input: ["text", "image"] });
    // Listed but undescribed: the provider's default API, no price claimed.
    expect(fresh).toMatchObject({ name: "brand-new", api: "openai-completions", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  });

  it("leaves out models on a wire API the provider serves nothing on", () => {
    expect(discoveredModels("go", known, ["gpt-x"], dev, [])).toEqual([]);
  });

  it("takes a model's settings from another provider that pi-ai already describes it for", () => {
    const zen = model("kimi-k2.5", {
      provider: "zen",
      baseUrl: "https://zen.test/v1",
      name: "Kimi K2.5",
      reasoning: true,
      compat: { thinkingFormat: "qwen" },
    });
    const [kimi] = discoveredModels("go", known, ["kimi-k2.5"], undefined, [zen]);
    expect(kimi).toMatchObject({
      name: "Kimi K2.5",
      provider: "go",
      baseUrl: "https://go.test/v1",
      reasoning: true,
      compat: { thinkingFormat: "qwen" },
      cost: zen.cost,
    });
  });
});

describe("withLiveCatalog", () => {
  const provider = { id: "go", name: "Go", auth: {}, getModels: () => known } as unknown as Provider;
  const context = (credential?: RefreshModelsContext["credential"]): RefreshModelsContext => ({
    ...(credential === undefined ? {} : { credential }),
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async ({ update }) => {
      update?.();
      return true;
    },
  });

  it("lists what the provider serves now, asking with its key, without what it retired", async () => {
    const asked: (string | undefined)[] = [];
    const sources: CatalogSources = {
      dev: async () => ({ go: dev }),
      list: async (baseUrl, key) => {
        asked.push(`${baseUrl} ${key}`);
        // The provider's own list also names models it no longer answers for.
        return ["glm-5.1", "glm-5", "ghost"];
      },
      siblings: () => [],
    };
    const live = withLiveCatalog(provider, sources);
    expect(live.getModels().map((m) => m.id)).toEqual(["glm-5.1", "kimi-k2.6", "minimax-m3"]);
    await live.refreshModels!(context({ type: "api_key", key: "sk-go" }));
    expect(asked).toEqual(["https://go.test/v1 sk-go"]);
    expect(live.getModels().map((m) => m.id)).toEqual(["glm-5.1", "minimax-m3", "glm-5"]);
  });

  it("falls back to models.dev's list, and keeps pi-ai's when both are out of reach", async () => {
    const fromDev = withLiveCatalog(provider, { dev: async () => ({ go: dev }), list: async () => undefined, siblings: () => [] });
    await fromDev.refreshModels!(context());
    expect(fromDev.getModels().map((m) => m.id)).toEqual(["glm-5.1", "minimax-m3", "glm-5", "minimax-m2.5"]);
    const offline = withLiveCatalog(provider, { dev: async () => undefined, list: async () => undefined, siblings: () => [] });
    await offline.refreshModels!(context());
    expect(offline.getModels()).toEqual(known);
  });

  it("leaves a provider with its own refresh alone", () => {
    const radius = { ...provider, refreshModels: async () => {} } as Provider;
    expect(withLiveCatalog(radius, { dev: async () => undefined, list: async () => undefined, siblings: () => [] })).toBe(radius);
  });
});

describe("networkSources", () => {
  it("asks for a provider's list with its key, and without when the key is refused", async () => {
    const calls: string[] = [];
    const fake: typeof fetch = async (url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      calls.push(`${String(url)} ${auth ?? "-"}`);
      return auth === null ? Response.json({ data: [{ id: "a" }, { id: "b" }] }) : Response.json({ error: "Invalid credential" }, { status: 401 });
    };
    const sources = networkSources(fake, () => []);
    expect(await sources.list("https://go.test/v1/", "sk", new AbortController().signal)).toEqual(["a", "b"]);
    expect(calls).toEqual(["https://go.test/v1/models Bearer sk", "https://go.test/v1/models -"]);
  });

  it("reads models.dev once for every provider, and again after a failure", async () => {
    let reads = 0;
    let fail = true;
    const fake: typeof fetch = async () => {
      reads++;
      if (fail) throw new Error("offline");
      return Response.json({ go: { models: {} } });
    };
    const sources = networkSources(fake, () => []);
    const signal = new AbortController().signal;
    expect(await sources.dev(signal)).toBeUndefined();
    fail = false;
    expect(await sources.dev(signal)).toEqual({ go: { models: {} } });
    await sources.dev(signal);
    expect(reads).toBe(2);
  });
});
