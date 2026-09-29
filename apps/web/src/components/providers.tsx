import { For, Show, createSignal } from "solid-js";
import type { ProviderInfo } from "@basis/contracts";
import { allModels, login, logout, state } from "../store.ts";
import { ChevronDownIcon, MoreIcon, Spinner } from "./icons.tsx";
import { Popover } from "./popover.tsx";

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
export const providerGroups = (providers: readonly ProviderInfo[]): { title: string; providers: ProviderInfo[] }[] =>
  [
    { title: "Connected", providers: providers.filter((p) => p.configured).sort(byName) },
    { title: "Subscriptions", providers: providers.filter((p) => !p.configured && hasOAuth(p)).sort(byName) },
    { title: "API keys", providers: providers.filter((p) => !p.configured && !hasOAuth(p)).sort(byName) },
  ].filter((group) => group.providers.length > 0);

/** What a search over providers matches. */
export const providerText = (provider: ProviderInfo): string => `${provider.name} ${provider.id} ${describe(provider)}`;

export function ProviderRow(props: { provider: ProviderInfo }) {
  const busy = () => state.loggingIn === props.provider.id;
  const locked = () => state.loggingIn !== undefined;
  const methods = () => props.provider.auth;
  const [showModels, setShowModels] = createSignal(false);
  const models = () => (allModels() ?? []).filter((model) => model.provider === props.provider.id);
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
                  if (method) void login(props.provider, method.type);
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
                        void login(props.provider, method.type);
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
                      void login(props.provider, method.type);
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
                    void logout(props.provider);
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
