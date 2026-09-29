import { batch, createMemo, createSignal } from "solid-js";
import type { AuthType, ModelInfo, ProviderInfo, ThinkingLevel } from "@lemma/contracts";
import { load, loadJson, save } from "../lib/storage.ts";
import { DEFAULT_THINKING, clampThinking, resolveModel } from "../model/prefs.ts";
import { Client, Models, Notify } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

const MODEL_KEY = "lemma.model";
const THINKING_KEY = "lemma.thinkingByModel";
const FAVORITES_KEY = "lemma.favoriteModels";

/**
 * Providers and models as the host reports them, and this browser's choices:
 * the preferred model, a reasoning level per model, and favorites.
 */
export default defineUiPlugin({
  id: "models",
  requires: { client: Client, notify: Notify },
  provides: { models: Models },
  setup: ({ client, notify }, plugin) => {
    const host = client.host;
    const [providers, setProviders] = createSignal<readonly ProviderInfo[]>([]);
    const [models, setModels] = createSignal<readonly ModelInfo[]>([]);
    const [loadedAt, setLoadedAt] = createSignal(false);
    const [all, setAll] = createSignal<readonly ModelInfo[]>();
    const [preferred, setPreferred] = createSignal(load(MODEL_KEY));
    const [thinkingByModel, setThinkingByModel] = createSignal<Readonly<Record<string, ThinkingLevel>>>(loadJson(THINKING_KEY, {}));
    const [favorites, setFavorites] = createSignal<readonly string[]>(loadJson(FAVORITES_KEY, []));
    const [loggingIn, setLoggingIn] = createSignal<string>();

    const selected = createMemo(() => resolveModel(models(), preferred()));
    const thinking = createMemo(() => {
      const model = selected();
      return model === undefined ? undefined : clampThinking(model, thinkingByModel()[model.ref] ?? DEFAULT_THINKING);
    });
    const configured = createMemo(() => providers().some((provider) => provider.configured));

    const refresh = async () => {
      const [nextProviders, nextModels] = await Promise.all([host.llm.providers(), host.llm.models(true)]);
      batch(() => {
        setProviders(nextProviders);
        setModels(nextModels);
        setLoadedAt(true);
      });
    };
    const quietly = () => void refresh().catch(() => {});

    plugin.onCleanup(client.onConnect(() => void refresh().catch((error) => notify.report(error, "Sync failed"))));
    plugin.onCleanup(
      client.onEvent((event) => {
        // A login may finish after this page reloaded and lost its own call; provider plugins may come or go.
        if ((event.type === "notice" && event.notice.source === "llm") || event.type === "plugins-changed") quietly();
      }),
    );

    return {
      models: {
        providers,
        providersLoaded: loadedAt,
        models,
        modelsLoaded: loadedAt,
        all,
        loadAll: async () => {
          try {
            setAll(await host.llm.models());
          } catch (error) {
            notify.report(error, "Could not list models");
          }
        },
        configured,
        preferred,
        selected,
        thinking,
        choose: (ref: string | undefined) => {
          save(MODEL_KEY, ref);
          setPreferred(ref);
        },
        chooseThinking: (level: ThinkingLevel) => {
          const model = selected();
          if (model === undefined) return;
          const next = { ...thinkingByModel(), [model.ref]: level };
          setThinkingByModel(next);
          save(THINKING_KEY, JSON.stringify(next));
        },
        favorites,
        toggleFavorite: (ref: string) => {
          const next = favorites().includes(ref) ? favorites().filter((item) => item !== ref) : [...favorites(), ref];
          setFavorites(next);
          save(FAVORITES_KEY, JSON.stringify(next));
        },
        turnOptions: () => {
          const model = selected();
          if (model === undefined) return undefined;
          const level = thinking();
          return { model: model.ref, ...(level === undefined ? {} : { thinking: level }) };
        },
        loggingIn,
        login: async (provider: ProviderInfo, type: AuthType) => {
          if (loggingIn() !== undefined) return false;
          setLoggingIn(provider.id);
          const before = Math.max(0, ...notify.toasts().map((toast) => toast.id));
          try {
            // The host announces success as a notice, which also refreshes providers.
            await host.llm.login(provider.id, type);
            await refresh();
            return true;
          } catch (error) {
            notify.report(error, `Login to ${provider.name} failed`);
            return false;
          } finally {
            setLoggingIn(undefined);
            // Device codes and login links from this attempt are no longer useful.
            notify.dismissWhere((toast) => toast.id > before && (toast.code !== undefined || toast.links !== undefined));
          }
        },
        logout: async (provider: ProviderInfo) => {
          try {
            await host.llm.logout(provider.id);
            notify.toast({ level: "info", message: `Logged out of ${provider.name}` });
            await refresh();
          } catch (error) {
            notify.report(error, "Logout failed");
          }
        },
        refresh,
      },
    };
  },
});
