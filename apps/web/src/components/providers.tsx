import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import type { ProviderInfo } from "@basis/contracts";
import { allModels, loadAllModels, login, logout, openDialog, state } from "../store.ts";
import { Dialog } from "./dialog.tsx";
import { ChevronDownIcon, MoreIcon, SearchIcon, Spinner, XIcon } from "./icons.tsx";
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

export function ProvidersDialog() {
  const [query, setQuery] = createSignal("");
  // Every known model, usable or not, as `basis models --all` lists them.
  onMount(() => {
    if (allModels() === undefined) void loadAllModels();
  });
  const matching = createMemo(() => {
    const q = query().trim().toLowerCase();
    return state.providers.filter((provider) => q === "" || provider.name.toLowerCase().includes(q) || provider.id.includes(q));
  });
  const sections = createMemo(() =>
    [
      {
        title: "Connected",
        providers: matching()
          .filter((p) => p.configured)
          .sort(byName),
      },
      {
        title: "Subscriptions",
        providers: matching()
          .filter((p) => !p.configured && hasOAuth(p))
          .sort(byName),
      },
      {
        title: "API keys",
        providers: matching()
          .filter((p) => !p.configured && !hasOAuth(p))
          .sort(byName),
      },
    ].filter((section) => section.providers.length > 0),
  );

  return (
    <Dialog label="Providers" onClose={() => openDialog(undefined)} class="providers-dialog">
      <div class="dialog-search">
        <SearchIcon />
        <input
          data-autofocus
          placeholder="Search providers"
          aria-label="Search providers"
          autocomplete="off"
          spellcheck={false}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <button class="icon-button" aria-label="Close" onClick={() => openDialog(undefined)}>
          <XIcon />
        </button>
      </div>
      <div class="provider-scroll">
        <Show when={!state.providersLoaded}>
          <p class="provider-empty">
            <Spinner /> Loading providers…
          </p>
        </Show>
        <Show when={state.providersLoaded && state.providers.length === 0}>
          <p class="provider-empty">No provider plugins are loaded. Check Plugins in the settings menu.</p>
        </Show>
        <Show when={state.providersLoaded && state.providers.length > 0 && sections().length === 0}>
          <p class="provider-empty">No providers match “{query().trim()}”</p>
        </Show>
        <For each={sections()}>
          {(section) => (
            <section class="provider-section">
              <h3 class="provider-section-title">
                {section.title}
                <span class="provider-count">{section.providers.length}</span>
              </h3>
              <ul class="provider-list">
                <For each={section.providers}>{(provider) => <ProviderRow provider={provider} />}</For>
              </ul>
            </section>
          )}
        </For>
      </div>
    </Dialog>
  );
}

function ProviderRow(props: { provider: ProviderInfo }) {
  const busy = () => state.loggingIn === props.provider.id;
  const locked = () => state.loggingIn !== undefined;
  const methods = () => props.provider.auth;
  const [showModels, setShowModels] = createSignal(false);
  const models = () => (allModels() ?? []).filter((model) => model.provider === props.provider.id);
  return (
    <li class="provider" classList={{ configured: props.provider.configured }}>
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
    </li>
  );
}
