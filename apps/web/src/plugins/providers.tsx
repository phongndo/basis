import { For, Show, createEffect, createSignal, on, onMount } from "solid-js";
import type { AuthType, ProviderInfo } from "@lemma/contracts";
import { ChevronDownIcon, KeyIcon, MoreIcon, Spinner } from "../components/icons.tsx";
import { Popover } from "../components/popover.tsx";
import { Actions, ComposerNotices, Models, Settings, SettingsGroups, SettingsSections, Slots } from "../ui/contracts.ts";
import type { ModelsService } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

const SECTION = "providers";

type Method = ProviderInfo["auth"][number];

const byName = (a: ProviderInfo, b: ProviderInfo) => a.name.localeCompare(b.name);
const hasOAuth = (provider: ProviderInfo) => provider.auth.some((method) => method.type === "oauth");
/** An environment variable name, as opposed to a stored credential the host can remove. */
const fromEnv = (source: string | undefined) => source !== undefined && /^[A-Z0-9_]+$/.test(source);

/** How a provider is connected, or how it can be. */
const describe = (provider: ProviderInfo): string => {
  if (provider.configured) {
    if (fromEnv(provider.source)) return `From $${provider.source}`;
    if (provider.source === "OAuth") return "Signed in with your subscription";
    if (provider.source === "stored credential") return "API key saved on the host";
    return provider.source === undefined ? "Connected" : `Connected · ${provider.source}`;
  }
  const oauth = hasOAuth(provider);
  const key = provider.auth.some((method) => method.type === "api_key");
  return oauth && key ? "Subscription or API key" : oauth ? "Sign in with your subscription" : "API key";
};

const methodLabel = (method: Method) => (method.type === "oauth" ? method.name : "Enter an API key");

/** Providers in the order to offer them: connected, then subscriptions, then API keys. */
const providerGroups = (providers: readonly ProviderInfo[]): { title: string; providers: ProviderInfo[] }[] =>
  [
    { title: "Connected", providers: providers.filter((p) => p.configured).sort(byName) },
    { title: "Subscriptions", providers: providers.filter((p) => !p.configured && hasOAuth(p)).sort(byName) },
    { title: "API keys", providers: providers.filter((p) => !p.configured && !hasOAuth(p)).sort(byName) },
  ].filter((group) => group.providers.length > 0);

/** What a search over providers matches. */
const providerText = (provider: ProviderInfo): string => `${provider.name} ${provider.id} ${describe(provider)}`;

function ProviderRow(props: { models: ModelsService; provider: ProviderInfo; login: (provider: ProviderInfo, type: AuthType) => void }) {
  const busy = () => props.models.loggingIn() === props.provider.id;
  const locked = () => props.models.loggingIn() !== undefined;
  const methods = () => props.provider.auth;
  const [showModels, setShowModels] = createSignal(false);
  const models = () => (props.models.all() ?? []).filter((model) => model.provider === props.provider.id);
  const login = (type: AuthType) => props.login(props.provider, type);
  const logout = () => void props.models.logout(props.provider);
  return (
    <div class="provider" classList={{ configured: props.provider.configured }}>
      <span class="provider-mark" aria-hidden="true">
        {props.provider.name.slice(0, 1).toUpperCase()}
        <Show when={props.provider.configured}>
          <span class="provider-dot" />
        </Show>
      </span>
      <span class="provider-info">
        <span class="provider-name">{props.provider.name}</span>
        <span class="provider-desc">
          {describe(props.provider)}
          <Show when={models().length > 0}>
            {" · "}
            <button class="link-button provider-models-toggle" aria-expanded={showModels()} onClick={() => setShowModels(!showModels())}>
              {models().length} model{models().length === 1 ? "" : "s"}
            </button>
          </Show>
        </span>
      </span>
      <Show
        when={props.provider.configured}
        fallback={
          <Show
            when={methods().length > 1}
            fallback={
              <button
                class="button small provider-connect"
                disabled={locked()}
                onClick={() => {
                  const method = methods()[0];
                  if (method) login(method.type);
                }}
              >
                <Show when={busy()} fallback="Connect">
                  <Spinner />
                </Show>
              </button>
            }
          >
            <Popover
              label={`Connect ${props.provider.name}`}
              tip="Choose how to connect"
              disabled={locked()}
              triggerClass="button small provider-connect"
              placement="bottom-end"
              trigger={
                <Show
                  when={busy()}
                  fallback={
                    <>
                      Connect
                      <ChevronDownIcon />
                    </>
                  }
                >
                  <Spinner />
                </Show>
              }
            >
              {(close) => (
                <For each={methods()}>
                  {(method) => (
                    <button
                      class="menu-item"
                      role="menuitem"
                      onClick={() => {
                        close();
                        login(method.type);
                      }}
                    >
                      <span class="menu-label">{methodLabel(method)}</span>
                    </button>
                  )}
                </For>
              )}
            </Popover>
          </Show>
        }
      >
        <Show when={busy()}>
          <Spinner />
        </Show>
        <Popover
          label={`${props.provider.name} options`}
          tip="Options"
          disabled={locked()}
          triggerClass="icon-button provider-more"
          placement="bottom-end"
          trigger={<MoreIcon />}
        >
          {(close) => (
            <>
              <For each={methods()}>
                {(method) => (
                  <button
                    class="menu-item"
                    role="menuitem"
                    onClick={() => {
                      close();
                      login(method.type);
                    }}
                  >
                    <span class="menu-label">{method.type === "oauth" ? "Sign in again" : "Replace API key"}</span>
                  </button>
                )}
              </For>
              <Show when={!fromEnv(props.provider.source)}>
                <div class="menu-sep" />
                <button
                  class="menu-item menu-danger"
                  role="menuitem"
                  onClick={() => {
                    close();
                    logout();
                  }}
                >
                  <span class="menu-label">Log out</span>
                </button>
              </Show>
            </>
          )}
        </Popover>
      </Show>
      <Show when={showModels()}>
        <ul class="provider-models">
          <For each={models()}>
            {(model) => (
              <li>
                <span class="provider-model-ref">{model.ref}</span>
                <span class="muted">
                  {Math.round(model.contextWindow / 1000)}k ctx{model.reasoning ? " · thinking" : ""}
                  {model.input.includes("image") ? " · images" : ""}
                </span>
                <Show when={model.cost.input > 0 || model.cost.output > 0}>
                  <span class="muted">
                    ${model.cost.input}/${model.cost.output} per M
                  </span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

/**
 * Model providers: sign in with a subscription or enter an API key. On a
 * first run with nothing set up, the section opens by itself and closes once
 * a provider is connected.
 */
export default defineUiPlugin({
  id: "providers",
  requires: { models: Models, settings: Settings, slots: Slots },
  setup: ({ models, settings, slots }, plugin) => {
    const [welcome, setWelcome] = createSignal(false);
    let greeted = false;
    createEffect(() => {
      if (greeted || !models.providersLoaded()) return;
      greeted = true;
      if (models.configured()) return;
      setWelcome(true);
      settings.open(SECTION);
    });
    createEffect(on(settings.section, (section) => section === undefined && setWelcome(false), { defer: true }));
    const login = async (provider: ProviderInfo, type: AuthType) => {
      const ok = await models.login(provider, type);
      if (ok && welcome() && models.configured()) settings.open(undefined);
    };
    const open = () => settings.open(SECTION);

    const add = (remove: () => void) => plugin.onCleanup(remove);
    add(
      slots.add(SettingsSections, {
        id: SECTION,
        order: 20,
        title: "Providers",
        icon: KeyIcon,
        intro: () => {
          // Every known model, usable or not, as `lemma models --all` lists them.
          onMount(() => {
            if (models.all() === undefined) void models.loadAll();
          });
          return (
            <Show when={welcome()}>
              <p class="settings-intro">Connect a provider to start chatting: sign in with a subscription or enter an API key.</p>
            </Show>
          );
        },
        empty: () => (
          <Show
            when={models.providersLoaded()}
            fallback={
              <p class="settings-empty">
                <Spinner /> Loading providers…
              </p>
            }
          >
            <p class="settings-empty">No provider plugins are loaded. Check Plugins.</p>
          </Show>
        ),
      }),
    );
    // Connected, then subscriptions, then API keys; a group with no providers is left out.
    const GROUPS = ["Connected", "Subscriptions", "API keys"];
    for (const [order, title] of GROUPS.entries()) {
      add(
        slots.add(SettingsGroups, {
          id: `${SECTION}.${order}`,
          order,
          section: SECTION,
          title,
          entries: () =>
            (providerGroups(models.providers()).find((group) => group.title === title)?.providers ?? []).map((provider) => ({
              text: `provider login ${providerText(provider)}`,
              view: () => <ProviderRow models={models} provider={provider} login={(target, type) => void login(target, type)} />,
            })),
        }),
      );
    }
    add(
      slots.add(ComposerNotices, {
        id: SECTION,
        order: 10,
        component: () => (
          <Show when={models.providersLoaded() && !models.configured()}>
            <div class="callout callout-info composer-callout">
              <KeyIcon />
              <span>No model provider is set up yet.</span>
              <button class="button button-primary small" onClick={open}>
                Log in to a provider
              </button>
            </div>
          </Show>
        ),
      }),
    );
    add(
      slots.add(Actions, {
        id: "providers.open",
        order: 5,
        title: "Log in to a provider…",
        category: "Providers",
        keywords: ["sign in", "api key", "credentials"],
        icon: KeyIcon,
        run: open,
      }),
    );
  },
});
