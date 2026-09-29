import type { Api, Model, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";

/**
 * Live catalogs for built-in providers. pi-ai ships each provider's models as
 * of its release; providers add and retire models faster than that. On
 * refresh (at startup and after a login) a provider's list becomes the models
 * it serves now, when models.dev knows the provider:
 *
 * - models.dev decides what is current. pi-ai's catalog is generated from it,
 *   so a model models.dev no longer lists has been retired and is hidden,
 *   even where the provider's own `/models` still names it (OpenCode's lists
 *   models it answers "deprecated" or "unavailable" for).
 * - Current models pi-ai does not know are added: the ones the provider's
 *   OpenAI-style `/models` lists, or all of models.dev's when it has no such
 *   list. models.dev describes them (limits, prices, inputs, reasoning, wire
 *   API); pi-ai's own entries always win, as they carry request settings tuned
 *   per model.
 */

/** The parts of a models.dev model this reads. */
export interface DevModel {
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly modalities?: { readonly input?: readonly string[] };
  readonly limit?: { readonly context?: number; readonly output?: number };
  readonly cost?: { readonly input?: number; readonly output?: number; readonly cache_read?: number; readonly cache_write?: number };
  /** Per-model override of the provider's SDK package, which names its wire API. */
  readonly provider?: { readonly npm?: string };
}

/** The parts of a models.dev provider this reads. */
export interface DevProvider {
  readonly npm?: string;
  /** Base URL of an OpenAI-compatible API, when the provider has one. */
  readonly api?: string;
  readonly models: Readonly<Record<string, DevModel>>;
}

export type DevCatalog = Readonly<Record<string, DevProvider>>;

/** models.dev names a model's wire API by the AI SDK package that speaks it. */
const API_OF_NPM: Readonly<Record<string, Api>> = {
  "@ai-sdk/anthropic": "anthropic-messages",
  "@ai-sdk/openai": "openai-responses",
  "@ai-sdk/openai-compatible": "openai-completions",
  "@ai-sdk/google": "google-generative-ai",
  "@ai-sdk/mistral": "mistral-conversations",
};

const commonPrefix = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

/**
 * Models `ids` adds to `known` (the provider's pi-ai list), in `ids` order.
 * Each is served like a known model on the same wire API (its base URL and
 * headers). Its request settings come from the same model at another
 * provider when pi-ai has one there (`siblings`), else from the known model
 * whose id shares the longest prefix; its limits, prices, and inputs come from
 * models.dev, then from that donor. A model on a wire API the provider serves
 * nothing on is left out, as pi-ai could not call it.
 */
export function discoveredModels(
  providerId: string,
  known: readonly Model<Api>[],
  ids: readonly string[],
  dev: DevProvider | undefined,
  siblings: readonly Model<Api>[],
): Model<Api>[] {
  const have = new Set(known.map((model) => model.id));
  const apis = new Set(known.map((model) => model.api));
  const out: Model<Api>[] = [];
  for (const id of new Set(ids)) {
    if (have.has(id)) continue;
    const info = dev?.models[id];
    const sibling = siblings.find((model) => model.id === id && apis.has(model.api));
    const named = API_OF_NPM[info?.provider?.npm ?? dev?.npm ?? ""];
    const api = sibling?.api ?? (named !== undefined && apis.has(named) ? named : undefined) ?? (apis.size === 1 ? [...apis][0] : undefined);
    if (api === undefined) continue;
    const onApi = known.filter((model) => model.api === api);
    const nearest = onApi.reduce((best, model) => (commonPrefix(model.id, id) > commonPrefix(best.id, id) ? model : best), onApi[0]!);
    const donor = sibling ?? nearest;
    const input = info?.modalities?.input;
    out.push({
      ...donor,
      id,
      name: info?.name ?? sibling?.name ?? id,
      api,
      provider: providerId,
      baseUrl: nearest.baseUrl,
      ...(nearest.headers === undefined ? {} : { headers: nearest.headers }),
      reasoning: info?.reasoning ?? donor.reasoning,
      input: input === undefined ? donor.input : input.includes("image") ? ["text", "image"] : ["text"],
      contextWindow: info?.limit?.context ?? donor.contextWindow,
      maxTokens: info?.limit?.output ?? donor.maxTokens,
      cost:
        info?.cost === undefined
          ? sibling === undefined
            ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            : donor.cost
          : { input: info.cost.input ?? 0, output: info.cost.output ?? 0, cacheRead: info.cost.cache_read ?? 0, cacheWrite: info.cost.cache_write ?? 0 },
    } as Model<Api>);
  }
  return out;
}

export interface CatalogSources {
  /** models.dev's catalog, or undefined when it cannot be read. */
  readonly dev: (signal: AbortSignal) => Promise<DevCatalog | undefined>;
  /** The ids an OpenAI-style `GET <baseUrl>/models` lists, or undefined when it cannot be read. */
  readonly list: (baseUrl: string, apiKey: string | undefined, signal: AbortSignal) => Promise<readonly string[] | undefined>;
  /** Every built-in provider's pi-ai models, where a missing model may already be described. */
  readonly siblings: () => readonly Model<Api>[];
}

/**
 * `provider` with its list extended on refresh. A provider with its own
 * refresh (Radius) keeps it and is left alone.
 */
export function withLiveCatalog(provider: Provider, sources: CatalogSources): Provider {
  if (provider.refreshModels !== undefined) return provider;
  let found: readonly Model<Api>[] = [];
  let retired: ReadonlySet<string> = new Set();
  return {
    ...provider,
    getModels: () => [...provider.getModels().filter((model) => !retired.has(model.id)), ...found],
    refreshModels: async (context: RefreshModelsContext) => {
      if (!context.allowNetwork || context.signal.aborted) return;
      const dev = (await sources.dev(context.signal))?.[provider.id];
      const credential = context.credential;
      const key = credential?.type === "api_key" ? credential.key : credential?.type === "oauth" ? credential.access : undefined;
      // Without models.dev there is no telling a current model from a retired one: pi-ai's list stands.
      if (dev === undefined || Object.keys(dev.models).length === 0) return;
      const listed = dev.api === undefined ? undefined : await sources.list(dev.api, key, context.signal);
      if (context.signal.aborted) return;
      const current = (id: string) => dev.models[id] !== undefined;
      const ids = (listed ?? Object.keys(dev.models)).filter(current);
      const known = provider.getModels();
      const next = discoveredModels(provider.id, known, ids, dev, sources.siblings());
      const gone = new Set(known.filter((model) => !current(model.id)).map((model) => model.id));
      await context.publish({
        update: () => {
          found = next;
          retired = gone;
        },
      });
    },
  };
}

const MODELS_DEV = "https://models.dev/api.json";
/** How long one read of models.dev serves every provider's refresh. */
const DEV_TTL = 60 * 60 * 1000;

/** Sources over the network: models.dev read once an hour for every provider, and each provider's own list. */
export function networkSources(fetchImpl: typeof fetch, siblings: () => readonly Model<Api>[]): CatalogSources {
  let cached: { at: number; catalog: Promise<DevCatalog | undefined> } | undefined;
  const readJson = async (url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> => {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  };
  return {
    dev: (signal) => {
      if (cached === undefined || Date.now() - cached.at > DEV_TTL) {
        const catalog = readJson(MODELS_DEV, {}, signal).then(
          (value) => value as DevCatalog,
          () => undefined,
        );
        cached = { at: Date.now(), catalog };
        // A failed read is tried again on the next refresh.
        void catalog.then((value) => {
          if (value === undefined && cached?.catalog === catalog) cached = undefined;
        });
      }
      return cached.catalog;
    },
    list: async (baseUrl, apiKey, signal) => {
      const url = `${baseUrl.replace(/\/+$/, "")}/models`;
      const ids = async (headers: Record<string, string>) => {
        const body = (await readJson(url, headers, signal)) as { data?: readonly { id?: unknown }[] };
        const found = (body.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === "string");
        return found.length === 0 ? undefined : found;
      };
      // Some lists refuse a chat key (OpenCode's answer "Invalid credential" to one) but are public.
      const attempts = apiKey === undefined ? [{}] : [{ authorization: `Bearer ${apiKey}` }, {}];
      for (const headers of attempts) {
        const found = await ids(headers).catch(() => undefined);
        if (found !== undefined || signal.aborted) return found;
      }
      return undefined;
    },
    siblings,
  };
}
