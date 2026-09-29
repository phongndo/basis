import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { Schema } from "effect";
import type { AuthType, InteractionRequest, ProviderInfo } from "@lemma/contracts";
import { CheckIcon, ExternalIcon, FilterIcon, KeyIcon, PlusIcon, SearchIcon, Spinner } from "../components/icons.tsx";
import { Popover } from "../components/popover.tsx";
import { ProviderLogo } from "../components/provider-logo.tsx";
import {
  CUSTOM_APIS,
  logoProblem,
  logoSource,
  customProviderEntry,
  customProviderProblem,
  describeProvider,
  fromEnv,
  providerBrand,
  providerGroups,
  providerText,
} from "../model/providers.ts";
import type { AuthFilter, CustomProviderDraft } from "../model/providers.ts";
import {
  Actions,
  ComposerNotices,
  HostPlugins,
  Interactions,
  Models,
  Notify,
  Settings,
  SettingsGroups,
  SettingsSections,
  Slots,
  UiPlugins,
} from "../ui/contracts.ts";
import type { InteractionsService, ModelsService } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

const SECTION = "providers";
const GROUPS = ["Results", "Connected", "Popular", "All providers"];

type Login = (provider: ProviderInfo, type: AuthType) => void;
type Method = ProviderInfo["auth"][number];

/** A way in, as a menu item says it: the host's name for a sign-in (`Sign in with ChatGPT`, `GitHub Copilot`). */
const methodLabel = (method: Method) =>
  method.type === "api_key" ? "Paste an API key" : /^sign in/i.test(method.name) ? method.name : `Sign in with ${method.name}`;

const FILTERS: readonly { value: AuthFilter; label: string }[] = [
  { value: "all", label: "All providers" },
  { value: "oauth", label: "Sign in with a subscription" },
  { value: "api_key", label: "Paste an API key" },
];

/** The question a login for `provider` is waiting on, from this page or any other client. */
const loginQuestion = (interactions: InteractionsService, provider: ProviderInfo) =>
  interactions.open().find((request) => request.origin === `login:${provider.id}`);

/** A login's question inside the provider's row: the API key to paste, the way to sign in. */
function InlineQuestion(props: { interactions: InteractionsService; provider: ProviderInfo; request: InteractionRequest }) {
  const [value, setValue] = createSignal("");
  const keyUrl = () => providerBrand(props.provider.id).keyUrl;
  const dismiss = () => props.interactions.dismiss(props.request.id);
  const submit = () => {
    if (value() !== "") props.interactions.answer(props.request.id, { type: "ask", value: value() });
  };
  return (
    <div class="provider-question" onKeyDown={(event) => event.key === "Escape" && (event.stopPropagation(), dismiss())}>
      <Switch>
        <Match when={props.request.type === "ask" && props.request}>
          {(request) => (
            <form
              class="provider-key"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <input
                class="field"
                ref={(input) => queueMicrotask(() => input.focus())}
                type={request().secret ? "password" : "text"}
                autocomplete="off"
                aria-label={request().title}
                placeholder={request().secret ? `Paste your ${request().title}` : (request().placeholder ?? request().title)}
                value={value()}
                onInput={(event) => setValue(event.currentTarget.value)}
              />
              <button type="submit" class="button button-primary small" disabled={value() === ""}>
                Save
              </button>
              <button type="button" class="button small" onClick={dismiss}>
                Cancel
              </button>
            </form>
          )}
        </Match>
        <Match when={props.request.type === "select" && props.request}>
          {(request) => (
            <div class="provider-choices" role="group" aria-label={request().title}>
              <span class="provider-question-title">{request().title}</span>
              <For each={request().options}>
                {(option, index) => (
                  <button
                    class="button small"
                    classList={{ "button-primary": index() === 0 }}
                    data-tip={option.description}
                    ref={(button) => index() === 0 && queueMicrotask(() => button.focus())}
                    onClick={() => props.interactions.answer(request().id, { type: "select", value: option.value })}
                  >
                    {option.label}
                  </button>
                )}
              </For>
              <button class="button small" onClick={dismiss}>
                Cancel
              </button>
            </div>
          )}
        </Match>
        <Match when={props.request.type === "confirm" && props.request}>
          {(request) => (
            <div class="provider-choices">
              <span class="provider-question-title">{request().title}</span>
              <button class="button button-primary small" onClick={() => props.interactions.answer(request().id, { type: "confirm", value: true })}>
                Yes
              </button>
              <button class="button small" onClick={() => props.interactions.answer(request().id, { type: "confirm", value: false })}>
                No
              </button>
            </div>
          )}
        </Match>
      </Switch>
      <Show when={props.request.type === "ask" && props.request.secret}>
        <p class="provider-question-note">
          Stored in the host's credential store and never shown again.
          <Show when={keyUrl()}>
            {(url) => (
              <>
                {" "}
                <a class="link-button" href={url()} target="_blank" rel="noreferrer">
                  Get a key <ExternalIcon />
                </a>
              </>
            )}
          </Show>
        </p>
      </Show>
    </div>
  );
}

/** Asks for an SVG file and hands over its text. */
const pickSvg = (use: (svg: string) => void) => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".svg,image/svg+xml";
  input.onchange = () => void input.files?.[0]?.text().then(use);
  input.click();
};

/** What a custom provider's menus offer besides connecting. */
interface CustomActions {
  readonly logos: Readonly<Record<string, string>>;
  readonly changeLogo: (provider: ProviderInfo) => void;
  readonly removeLogo: (provider: ProviderInfo) => void;
  readonly remove: (provider: ProviderInfo) => void;
}

function CustomItems(props: { provider: ProviderInfo; custom: CustomActions; close: () => void }): JSX.Element {
  const item = (label: string, run: () => void, danger = false) => (
    <button
      class="menu-item"
      classList={{ "menu-danger": danger }}
      role="menuitem"
      onClick={() => {
        props.close();
        run();
      }}
    >
      <span class="menu-label">{label}</span>
    </button>
  );
  return (
    <>
      <div class="menu-sep" />
      {item("Change logo…", () => props.custom.changeLogo(props.provider))}
      <Show when={props.custom.logos[props.provider.id] !== undefined}>{item("Remove logo", () => props.custom.removeLogo(props.provider))}</Show>
      {item("Remove provider", () => props.custom.remove(props.provider), true)}
    </>
  );
}

function ProviderRow(props: { models: ModelsService; interactions: InteractionsService; provider: ProviderInfo; login: Login; custom: CustomActions }) {
  const busy = () => props.models.loggingIn() === props.provider.id;
  const locked = () => props.models.loggingIn() !== undefined;
  const methods = () => props.provider.auth;
  const question = () => loginQuestion(props.interactions, props.provider);
  const [showModels, setShowModels] = createSignal(false);
  const models = () => (props.models.all() ?? []).filter((model) => model.provider === props.provider.id);
  const login = (type: AuthType) => props.login(props.provider, type);
  const logout = () => void props.models.logout(props.provider);
  const oauthOnly = () => methods().every((method) => method.type === "oauth");
  /** Signing in first: it needs nothing pasted. */
  const ways = () => [...methods()].sort((a, b) => (a.type === b.type ? 0 : a.type === "oauth" ? -1 : 1));
  return (
    <div class="provider" classList={{ configured: props.provider.configured, asking: question() !== undefined }}>
      <ProviderLogo id={props.provider.id} name={props.provider.name} custom={props.provider.custom ? props.custom.logos[props.provider.id] : undefined} />
      <span class="provider-info">
        <span class="provider-name">{props.provider.name}</span>
        <span class="provider-desc">
          {describeProvider(props.provider)}
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
            when={!busy()}
            fallback={
              <Show when={question() === undefined}>
                <span class="provider-waiting">
                  <Spinner />
                  {oauthOnly() ? "Finish signing in…" : "Connecting…"}
                </span>
              </Show>
            }
          >
            <Show
              when={methods().length > 1 || props.provider.custom}
              fallback={
                <button class="button small provider-connect" disabled={locked()} onClick={() => methods()[0] && login(methods()[0]!.type)}>
                  Connect
                </button>
              }
            >
              {/* Several ways in (or a custom provider's own options): Connect opens a menu, as Manage does. */}
              <Popover
                label={`Connect ${props.provider.name}`}
                tip="Choose how to connect"
                disabled={locked()}
                triggerClass="button small provider-connect"
                placement="bottom-end"
                trigger="Connect"
              >
                {(close) => (
                  <>
                    <For each={ways()}>
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
                    <Show when={props.provider.custom}>
                      <CustomItems provider={props.provider} custom={props.custom} close={close} />
                    </Show>
                  </>
                )}
              </Popover>
            </Show>
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
          triggerClass="button small provider-connect"
          placement="bottom-end"
          trigger="Manage"
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
              <Show when={!fromEnv(props.provider.source) && props.provider.source !== "no key required"}>
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
              <Show when={props.provider.custom}>
                <CustomItems provider={props.provider} custom={props.custom} close={close} />
              </Show>
            </>
          )}
        </Popover>
      </Show>
      <Show when={question()} keyed>
        {(request) => <InlineQuestion interactions={props.interactions} provider={props.provider} request={request} />}
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

/** The last row: any endpoint that speaks a known wire API, such as Ollama or a company gateway. */
function CustomProviderRow(props: { add: (draft: CustomProviderDraft, key: string, logo: string | undefined) => Promise<boolean> }) {
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [name, setName] = createSignal("");
  const [baseUrl, setBaseUrl] = createSignal("");
  const [api, setApi] = createSignal<CustomProviderDraft["api"]>("openai-completions");
  const [modelIds, setModelIds] = createSignal("");
  const [key, setKey] = createSignal("");
  const [logo, setLogo] = createSignal<string>();
  const [logoError, setLogoError] = createSignal<string>();
  const chooseLogo = () =>
    pickSvg((svg) => {
      const problem = logoProblem(svg);
      setLogoError(problem);
      if (problem === undefined) setLogo(svg);
    });
  const draft = (): CustomProviderDraft => ({ name: name(), baseUrl: baseUrl(), api: api(), models: modelIds(), hasKey: key() !== "" });
  const problem = () => customProviderProblem(draft());
  const submit = async () => {
    if (problem() !== undefined || busy()) return;
    setBusy(true);
    const ok = await props.add(draft(), key(), logo()).finally(() => setBusy(false));
    if (!ok) return;
    setOpen(false);
    setName("");
    setBaseUrl("");
    setModelIds("");
    setKey("");
    setLogo(undefined);
  };
  return (
    <div class="provider">
      <span class="provider-mark" aria-hidden="true">
        <Show when={logo()} fallback={<PlusIcon />}>
          {(svg) => <img class="provider-logo" src={logoSource(svg())} alt="" />}
        </Show>
      </span>
      <span class="provider-info">
        <span class="provider-name">Custom provider</span>
        <span class="provider-desc">Any OpenAI-, Anthropic-, or Gemini-compatible endpoint, like Ollama or a gateway</span>
      </span>
      <Show when={!open()}>
        <button class="button small provider-connect" onClick={() => setOpen(true)}>
          Add
        </button>
      </Show>
      <Show when={open()}>
        <form
          class="provider-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onKeyDown={(event) => event.key === "Escape" && (event.stopPropagation(), setOpen(false))}
        >
          <label>
            <span>Name</span>
            <input
              class="field"
              ref={(input) => queueMicrotask(() => input.focus())}
              placeholder="Ollama"
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Base URL</span>
            <input class="field" placeholder="http://localhost:11434/v1" value={baseUrl()} onInput={(event) => setBaseUrl(event.currentTarget.value)} />
          </label>
          <label>
            <span>API</span>
            <select class="field" value={api()} onChange={(event) => setApi(event.currentTarget.value as CustomProviderDraft["api"])}>
              <For each={CUSTOM_APIS}>{(option) => <option value={option.value}>{option.label}</option>}</For>
            </select>
          </label>
          <label>
            <span>Models</span>
            <input class="field" placeholder="qwen3:8b, llama3.2" value={modelIds()} onInput={(event) => setModelIds(event.currentTarget.value)} />
          </label>
          <label>
            <span>API key</span>
            <input
              class="field"
              type="password"
              autocomplete="off"
              placeholder="Optional; local servers need none"
              value={key()}
              onInput={(event) => setKey(event.currentTarget.value)}
            />
          </label>
          <div class="provider-form-row">
            <span>Logo</span>
            <span class="provider-logo-pick">
              <button type="button" class="button small" onClick={chooseLogo}>
                {logo() === undefined ? "Choose SVG…" : "Change…"}
              </button>
              <Show when={logo() !== undefined}>
                <button type="button" class="link-button" onClick={() => setLogo(undefined)}>
                  Remove
                </button>
              </Show>
              <span class="provider-question-note">{logoError() ?? "Optional; shown beside its name"}</span>
            </span>
          </div>
          <div class="provider-form-actions">
            <span class="provider-question-note">
              {name() === "" && baseUrl() === "" ? "The key is stored on the host, not in config." : (problem() ?? "")}
            </span>
            <button type="button" class="button small" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" class="button button-primary small" disabled={problem() !== undefined || busy()}>
              <Show when={busy()} fallback="Add provider">
                <Spinner />
              </Show>
            </button>
          </div>
        </form>
      </Show>
    </div>
  );
}

/**
 * Model providers: sign in with a subscription or paste an API key, in the
 * provider's row. A search at the top narrows the list; popular ways to start
 * come first. On a first run with nothing set up, the section opens by itself
 * and closes once a provider is connected.
 */
export const ProvidersConfig = Schema.Struct({
  logos: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.String }), { default: () => ({}) }).annotations({
    title: "Custom provider logos",
    description: "SVG files by provider id, set from the Providers page.",
  }),
});

export default defineUiPlugin({
  id: "providers",
  config: ProvidersConfig,
  requires: {
    models: Models,
    settings: Settings,
    slots: Slots,
    interactions: Interactions,
    hostPlugins: HostPlugins,
    uiPlugins: UiPlugins,
    notify: Notify,
  },
  setup: ({ models, settings, slots, interactions, hostPlugins, uiPlugins, notify }, plugin) => {
    const [welcome, setWelcome] = createSignal(false);
    const [query, setQuery] = createSignal("");
    const [filter, setFilter] = createSignal<AuthFilter>("all");
    let greeted = false;
    createEffect(() => {
      if (greeted || !models.providersLoaded()) return;
      greeted = true;
      if (models.configured()) return;
      setWelcome(true);
      settings.open(SECTION);
    });
    createEffect(
      on(
        settings.section,
        (section) => {
          if (section === undefined) setWelcome(false);
          if (section !== SECTION) {
            setQuery("");
            setFilter("all");
          }
        },
        { defer: true },
      ),
    );
    const login = async (provider: ProviderInfo, type: AuthType) => {
      const ok = await models.login(provider, type);
      if (ok && welcome() && models.configured()) settings.open(undefined);
    };
    const open = () => settings.open(SECTION);

    // Custom providers are items of the llm plugin's `providers` config.
    const llmPlugin = () => hostPlugins.list().find((candidate) => candidate.id === "llm");
    /** Keys typed with a new custom provider, answered for it when its login asks. */
    const pendingKeys = new Map<string, string>();
    createEffect(() => {
      for (const request of interactions.open()) {
        const id = request.origin?.startsWith("login:") ? request.origin.slice("login:".length) : undefined;
        const key = id === undefined ? undefined : pendingKeys.get(id);
        if (key === undefined || request.type !== "ask") continue;
        pendingKeys.delete(id!);
        interactions.answer(request.id, { type: "ask", value: key });
      }
    });
    /** Waits for the host to list (or stop listing) a provider after a config change, which may apply after the reply. */
    const settle = async (id: string, present: boolean) => {
      for (let attempt = 0; attempt < 20; attempt++) {
        await models.refresh();
        const found = models.providers().find((provider) => provider.id === id);
        if ((found !== undefined) === present) return found;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return undefined;
    };
    /**
     * Custom logos are this plugin's own config, so changing one restarts the
     * page's plugin: after the rest of a change is done, never before.
     */
    const logos = plugin.config.logos;
    const setLogo = async (id: string, svg: string | undefined) => {
      const self = uiPlugins.list().find((candidate) => candidate.id === plugin.id);
      if (self === undefined) return;
      const { [id]: _old, ...rest } = logos;
      const next = svg === undefined ? rest : { ...rest, [id]: svg };
      await uiPlugins.setConfig(self, { logos: Object.keys(next).length === 0 ? null : next });
    };
    const custom: CustomActions = {
      logos,
      changeLogo: (provider) =>
        pickSvg((svg) => {
          const problem = logoProblem(svg);
          if (problem !== undefined) notify.toast({ level: "error", message: problem });
          else setLogo(provider.id, svg).catch((error) => notify.report(error, "Could not save the logo"));
        }),
      removeLogo: (provider) => void setLogo(provider.id, undefined).catch((error) => notify.report(error, "Could not remove the logo")),
      remove: (provider) => void removeCustom(provider),
    };
    const addCustom = async (draft: CustomProviderDraft, key: string, logo: string | undefined): Promise<boolean> => {
      const llm = llmPlugin();
      if (llm === undefined) return false;
      const entry = customProviderEntry(
        draft,
        models.providers().map((provider) => provider.id),
      );
      try {
        await hostPlugins.edit(llm, { add: { providers: [entry] } });
        const provider = await settle(entry.id, true);
        if (provider === undefined) throw new Error(`The host did not list ${entry.name} after saving it`);
        if (key !== "") {
          pendingKeys.set(entry.id, key);
          await login(provider, "api_key");
        }
        if (logo !== undefined) await setLogo(entry.id, logo);
        return true;
      } catch (error) {
        pendingKeys.delete(entry.id);
        notify.report(error, `Could not add ${entry.name}`);
        return false;
      }
    };
    const removeCustom = async (provider: ProviderInfo) => {
      const llm = llmPlugin();
      if (llm === undefined) return;
      try {
        // A key it stored goes with it.
        if (provider.configured && !fromEnv(provider.source) && provider.source !== "no key required") await models.logout(provider);
        await hostPlugins.edit(llm, { remove: { providers: [provider.id] } });
        await settle(provider.id, false);
        if (logos[provider.id] !== undefined) await setLogo(provider.id, undefined);
      } catch (error) {
        notify.report(error, `Could not remove ${provider.name}`);
      }
    };
    const groups = createMemo(() => providerGroups(models.providers(), query(), filter()));
    const row = (provider: ProviderInfo) => () => (
      <ProviderRow models={models} interactions={interactions} provider={provider} login={(target, type) => void login(target, type)} custom={custom} />
    );

    function Search() {
      let input!: HTMLInputElement;
      // Every known model, usable or not, as `lemma models --all` lists them.
      onMount(() => {
        if (models.all() === undefined) void models.loadAll();
        input.focus();
      });
      // While the page shows, logins' questions appear in their rows rather than a dialog.
      onCleanup(interactions.claim((request) => request.origin?.startsWith("login:") === true));
      /** Enter starts the first match's quickest way in. */
      const connectFirst = () => {
        const provider = groups()
          .flatMap((group) => group.providers)
          .find((candidate) => !candidate.configured);
        const method = provider?.auth.find((candidate) => candidate.type === "oauth") ?? provider?.auth[0];
        if (provider !== undefined && method !== undefined && models.loggingIn() === undefined) void login(provider, method.type);
      };
      return (
        <div class="providers-top">
          <Show when={welcome()}>
            <p class="settings-intro">Connect a provider to start chatting: sign in with a subscription, or paste an API key.</p>
          </Show>
          <div class="providers-search">
            <label class="providers-search-field">
              <SearchIcon />
              <input
                ref={input}
                type="search"
                placeholder={`Search ${models.providers().length} providers`}
                aria-label="Search providers"
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    connectFirst();
                  } else if (event.key === "Escape" && query() !== "") {
                    event.stopPropagation();
                    setQuery("");
                  }
                }}
              />
            </label>
            {/* Which ways in to list. */}
            <Popover
              label={filter() === "all" ? "Filter providers" : `Showing: ${FILTERS.find((option) => option.value === filter())!.label}`}
              trigger={<FilterIcon />}
              triggerClass={filter() === "all" ? "icon-button" : "icon-button active"}
              placement="bottom-end"
            >
              {(close) => (
                <For each={FILTERS}>
                  {(option) => (
                    <button
                      class="menu-item"
                      role="menuitemradio"
                      aria-checked={filter() === option.value}
                      onClick={() => {
                        setFilter(option.value);
                        close();
                      }}
                    >
                      <span class="menu-check">
                        <Show when={filter() === option.value}>
                          <CheckIcon />
                        </Show>
                      </span>
                      {option.label}
                    </button>
                  )}
                </For>
              )}
            </Popover>
          </div>
        </div>
      );
    }

    const add = (remove: () => void) => plugin.onCleanup(remove);
    add(
      slots.add(SettingsSections, {
        id: SECTION,
        order: 20,
        title: "Providers",
        icon: KeyIcon,
        intro: Search,
        empty: () => (
          <Switch fallback={<p class="settings-empty">No provider plugins are loaded. Check Plugins.</p>}>
            <Match when={!models.providersLoaded()}>
              <p class="settings-empty">
                <Spinner /> Loading providers…
              </p>
            </Match>
            <Match when={query().trim() !== "" || filter() !== "all"}>
              <p class="settings-empty">No providers match{query().trim() === "" ? "" : ` “${query().trim()}”`}</p>
            </Match>
          </Switch>
        ),
      }),
    );
    for (const [order, title] of GROUPS.entries()) {
      add(
        slots.add(SettingsGroups, {
          id: `${SECTION}.${order}`,
          order,
          section: SECTION,
          // A search's matches need no heading.
          ...(title === "Results" ? {} : { title }),
          entries: () =>
            (groups().find((group) => group.title === title)?.providers ?? []).map((provider) => ({
              text: `provider login ${providerText(provider)}`,
              view: row(provider),
            })),
        }),
      );
    }
    // Last: adding a custom provider, while browsing (it answers no search).
    add(
      slots.add(SettingsGroups, {
        id: `${SECTION}.custom`,
        order: GROUPS.length,
        section: SECTION,
        // Titled, so it is not merged into the untitled search results.
        title: "Custom",
        entries: () =>
          llmPlugin() !== undefined && query().trim() === "" && filter() !== "oauth"
            ? [{ text: "provider add custom openai compatible ollama gateway", view: () => <CustomProviderRow add={addCustom} /> }]
            : [],
      }),
    );
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
