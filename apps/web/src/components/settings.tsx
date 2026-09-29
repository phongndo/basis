import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { tildePath } from "../model/format.ts";
import { knownProjects } from "../model/prefs.ts";
import { filterGroups } from "../model/settings.ts";
import type { EntryGroup, Searchable } from "../model/settings.ts";
import {
  allModels,
  loadAllModels,
  newChat,
  openDialog,
  openSettings,
  reloadConfig,
  removeProject,
  restartPlugin,
  selectedModel,
  setContentWidth,
  setNewWorktree,
  setTheme,
  state,
  worktreeDraftState,
} from "../store.ts";
import type { ContentWidth, SettingsSection, Theme } from "../store.ts";
import { ModelPicker, ThinkingPicker } from "./composer.tsx";
import { ArrowLeftIcon, FolderIcon, FolderPlusIcon, KeyIcon, PaletteIcon, PuzzleIcon, RefreshIcon, SearchIcon, SlidersIcon, Spinner, XIcon } from "./icons.tsx";
import { HostFacts, PluginRow, pluginText } from "./plugins.tsx";
import { ProviderRow, providerGroups, providerText } from "./providers.tsx";

interface Entry extends Searchable {
  readonly view: () => JSX.Element;
}

interface Section {
  readonly id: SettingsSection;
  readonly title: string;
  readonly icon: () => JSX.Element;
  readonly groups: () => readonly EntryGroup<Entry>[];
  /** Shown above the groups while browsing the section, not in search results. */
  readonly intro?: () => JSX.Element;
  readonly actions?: () => JSX.Element;
  /** Shown while browsing a section with no entries. */
  readonly empty?: () => JSX.Element;
}

/** A setting's name and explanation, with its control on the right. */
function SettingRow(props: { title: string; description: string; children: JSX.Element }) {
  return (
    <div class="setting-row">
      <div class="setting-text">
        <div class="setting-title">{props.title}</div>
        <div class="setting-desc">{props.description}</div>
      </div>
      <div class="setting-control">{props.children}</div>
    </div>
  );
}

function Segmented<T extends string>(props: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div class="segmented" role="radiogroup" aria-label={props.label}>
      <For each={props.options}>
        {(option) => (
          <button role="radio" aria-checked={props.value === option.value} onClick={() => props.onChange(option.value)}>
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <button class="switch" role="switch" aria-label={props.label} aria-checked={props.checked} onClick={() => props.onChange(!props.checked)} />;
}

const THEMES: readonly { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
const WIDTHS: readonly { value: ContentWidth; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full" },
];

let focusSearch: (() => void) | undefined;
/** Puts focus in the settings search (the `/` shortcut); does nothing while settings are closed. */
export const focusSettingsSearch = (): void => focusSearch?.();

/**
 * Settings, covering the app while open. The search runs across every
 * section; clearing it returns to the section being browsed.
 */
export function SettingsView() {
  const [query, setQuery] = createSignal("");
  const [busy, setBusy] = createSignal<string | undefined>();
  const searching = () => query().trim() !== "";
  const section = () => state.settings ?? "general";
  let main!: HTMLDivElement;
  let search!: HTMLInputElement;
  const previous = document.activeElement as HTMLElement | null;
  onMount(() => {
    // Every known model, usable or not, as `lemma models --all` lists them.
    if (allModels() === undefined) void loadAllModels();
    queueMicrotask(() => search.focus());
  });
  focusSearch = () => {
    search.focus();
    search.select();
  };
  onCleanup(() => {
    focusSearch = undefined;
    previous?.focus?.();
  });
  createEffect(on([section, searching], () => main.scrollTo({ top: 0 }), { defer: true }));

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try {
      await action();
    } finally {
      setBusy(undefined);
    }
  };

  const general = createMemo((): EntryGroup<Entry>[] => [
    {
      title: "New chats",
      entries: [
        {
          text: "Model provider llm default",
          view: () => (
            <SettingRow title="Model" description="Used for every prompt until you pick another here or in the composer.">
              <ModelPicker placement="bottom-end" />
            </SettingRow>
          ),
        },
        {
          text: "Reasoning thinking effort level",
          view: () => (
            <SettingRow title="Reasoning" description="How hard the model thinks. Remembered for each model.">
              <Show when={selectedModel()?.reasoning} fallback={<span class="muted small">Not offered by this model</span>}>
                <ThinkingPicker placement="bottom-end" />
              </Show>
            </SettingRow>
          ),
        },
        {
          text: "Start in a new worktree git branch checkout workspace",
          view: () => (
            <SettingRow
              title="Start in a new worktree"
              description="In a git repository, a new chat gets its own checkout on a new branch, so its changes stay apart."
            >
              <Toggle label="Start in a new worktree" checked={worktreeDraftState().enabled} onChange={setNewWorktree} />
            </SettingRow>
          ),
        },
      ],
    },
  ]);

  const appearance = createMemo((): EntryGroup<Entry>[] => [
    {
      entries: [
        {
          text: "Theme color scheme dark light system mode",
          view: () => (
            <SettingRow title="Theme" description="System follows your browser or OS setting.">
              <Segmented label="Theme" value={state.theme} options={THEMES} onChange={setTheme} />
            </SettingRow>
          ),
        },
        {
          text: "Conversation width layout wide full",
          view: () => (
            <SettingRow title="Conversation width" description="How wide the transcript and composer run on large screens.">
              <Segmented label="Conversation width" value={state.contentWidth} options={WIDTHS} onChange={setContentWidth} />
            </SettingRow>
          ),
        },
      ],
    },
  ]);

  const providers = createMemo((): EntryGroup<Entry>[] =>
    providerGroups(state.providers).map((group) => ({
      title: group.title,
      entries: group.providers.map((provider) => ({ text: `provider login ${providerText(provider)}`, view: () => <ProviderRow provider={provider} /> })),
    })),
  );

  const plugins = createMemo((): EntryGroup<Entry>[] => [
    {
      entries: state.plugins.map((plugin) => ({
        text: `plugin ${pluginText(plugin)}`,
        view: () => <PluginRow plugin={plugin} busy={busy()} onRestart={() => void run(plugin.id, () => restartPlugin(plugin.id))} />,
      })),
    },
  ]);

  const hostCwd = () => state.info?.cwd;
  const projects = createMemo((): EntryGroup<Entry>[] => [
    {
      entries: knownProjects(hostCwd(), state.sessions, state.projects).map((cwd) => {
        const path = tildePath(cwd, state.info?.home);
        return { text: `project ${path}`, view: () => <ProjectRow cwd={cwd} path={path} /> };
      }),
    },
  ]);

  const sections: readonly Section[] = [
    { id: "general", title: "General", icon: SlidersIcon, groups: general },
    { id: "appearance", title: "Appearance", icon: PaletteIcon, groups: appearance },
    {
      id: "providers",
      title: "Providers",
      icon: KeyIcon,
      groups: providers,
      intro: () => (
        <Show when={state.welcome}>
          <p class="settings-intro">Connect a provider to start chatting: sign in with a subscription or enter an API key.</p>
        </Show>
      ),
      empty: () => (
        <Show
          when={state.providersLoaded}
          fallback={
            <p class="settings-empty">
              <Spinner /> Loading providers…
            </p>
          }
        >
          <p class="settings-empty">No provider plugins are loaded. Check Plugins.</p>
        </Show>
      ),
    },
    {
      id: "plugins",
      title: "Plugins",
      icon: PuzzleIcon,
      groups: plugins,
      intro: () => <HostFacts />,
      actions: () => (
        <>
          <button class="button small" onClick={() => openDialog("events")} data-tip="Everything the host publishes, as `lemma events` shows it">
            Event log
          </button>
          <button
            class="button small"
            disabled={busy() !== undefined}
            onClick={() => void run("reload", reloadConfig)}
            data-tip="Re-read config files and apply them"
          >
            <Show when={busy() === "reload"} fallback={<RefreshIcon />}>
              <Spinner />
            </Show>
            Reload config
          </button>
        </>
      ),
      empty: () => <p class="settings-empty">No plugins reported.</p>,
    },
    {
      id: "projects",
      title: "Projects",
      icon: FolderIcon,
      groups: projects,
      actions: () => (
        <button class="button small" onClick={() => openDialog("add-project")}>
          <FolderPlusIcon /> Add project
        </button>
      ),
      empty: () => <p class="settings-empty">No projects yet.</p>,
    },
  ];

  const current = () => sections.find((candidate) => candidate.id === section())!;
  const results = createMemo(() =>
    searching()
      ? sections.map((candidate) => ({ section: candidate, groups: filterGroups(candidate.groups(), query()) })).filter((found) => found.groups.length > 0)
      : [],
  );
  const count = (id: SettingsSection) =>
    results()
      .find((found) => found.section.id === id)
      ?.groups.reduce((sum, group) => sum + group.entries.length, 0) ?? 0;
  const failed = () => state.plugins.filter((plugin) => plugin.state === "failed").length;
  const go = (id: SettingsSection) => {
    setQuery("");
    openSettings(id);
  };

  return (
    <div class="settings" role="region" aria-label="Settings">
      <nav class="settings-nav" aria-label="Settings sections">
        <label class="sidebar-search">
          <SearchIcon />
          <input
            ref={search}
            type="search"
            placeholder="Search settings"
            aria-label="Search settings"
            autocomplete="off"
            spellcheck={false}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query() !== "") {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
          <Show when={query() === ""}>
            <span class="search-key" data-tip="Press / to search">
              /
            </span>
          </Show>
          <Show when={query() !== ""}>
            <button class="icon-button search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
              <XIcon />
            </button>
          </Show>
        </label>
        <div class="settings-nav-items">
          <For each={sections}>
            {(item) => (
              <button
                class="settings-nav-item"
                classList={{ active: !searching() && section() === item.id, dim: searching() && count(item.id) === 0 }}
                aria-current={!searching() && section() === item.id ? "page" : undefined}
                onClick={() => go(item.id)}
              >
                <item.icon />
                <span class="settings-nav-label">{item.title}</span>
                <Show when={searching() && count(item.id) > 0}>
                  <span class="settings-nav-count">{count(item.id)}</span>
                </Show>
                <Show when={!searching() && item.id === "plugins" && failed() > 0}>
                  <span class="settings-nav-count err">{failed()} failed</span>
                </Show>
              </button>
            )}
          </For>
        </div>
        <span class="spacer" />
        <button class="settings-nav-item" onClick={() => openSettings(undefined)} data-tip="Back to chats · Esc">
          <ArrowLeftIcon />
          <span class="settings-nav-label">Back</span>
        </button>
      </nav>
      <div class="settings-main" ref={main}>
        <header class="settings-head">
          <span class="muted">Settings</span>
          <span class="settings-crumb-sep">/</span>
          <span>{searching() ? "Search" : current().title}</span>
          <span class="spacer" />
          <button class="icon-button" aria-label="Close settings" data-tip="Close · Esc" onClick={() => openSettings(undefined)}>
            <XIcon />
          </button>
        </header>
        <div class="settings-content">
          <Show
            when={searching()}
            fallback={
              <>
                <div class="settings-title-row">
                  <h1 class="settings-title">{current().title}</h1>
                  <span class="spacer" />
                  {current().actions?.()}
                </div>
                {current().intro?.()}
                <Show
                  when={current()
                    .groups()
                    .some((group) => group.entries.length > 0)}
                  fallback={current().empty?.()}
                >
                  <Groups groups={current().groups()} />
                </Show>
              </>
            }
          >
            <Show when={results().length > 0} fallback={<p class="settings-empty">No settings match “{query().trim()}”</p>}>
              <For each={results()}>
                {(found) => (
                  <section class="settings-result">
                    <button class="settings-result-title" onClick={() => go(found.section.id)} data-tip={`Open ${found.section.title}`}>
                      <found.section.icon />
                      {found.section.title}
                    </button>
                    <Groups groups={found.groups} />
                  </section>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}

function Groups(props: { groups: readonly EntryGroup<Entry>[] }) {
  return (
    <For each={props.groups}>
      {(group) => (
        <section class="settings-group">
          <Show when={group.title}>
            <h2 class="settings-group-title">{group.title}</h2>
          </Show>
          <div class="settings-rows">
            <For each={group.entries}>{(entry) => entry.view()}</For>
          </div>
        </section>
      )}
    </For>
  );
}

function ProjectRow(props: { cwd: string; path: string }) {
  const sessions = () => state.sessions.filter((session) => session.cwd === props.cwd).length;
  const isHost = () => props.cwd === state.info?.cwd;
  // Only a project added by hand can be forgotten; the others are listed through the host or their sessions.
  const removable = () => !isHost() && sessions() === 0 && state.projects.includes(props.cwd);
  const slash = () => props.path.lastIndexOf("/");
  return (
    <div class="setting-row project-row">
      <FolderIcon />
      <div class="setting-text">
        <div class="setting-title">{props.path.slice(slash() + 1) || props.path}</div>
        <div class="setting-desc" data-tip={props.cwd}>
          {props.path}
          {" · "}
          {sessions() === 0 ? "no sessions" : `${sessions()} session${sessions() === 1 ? "" : "s"}`}
          {isHost() ? " · host directory" : ""}
        </div>
      </div>
      <div class="setting-control">
        <button class="button small" onClick={() => newChat(isHost() ? undefined : props.cwd)}>
          New chat
        </button>
        <Show when={removable()}>
          <button class="icon-button" aria-label={`Remove ${props.path}`} data-tip="Remove from projects" onClick={() => removeProject(props.cwd)}>
            <XIcon />
          </button>
        </Show>
      </div>
    </div>
  );
}
