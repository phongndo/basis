import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { Dynamic } from "solid-js/web";
import { formatKeys } from "../lib/keys.ts";
import { filterGroups } from "../model/settings.ts";
import type { EntryGroup } from "../model/settings.ts";
import { ArrowLeftIcon, GearIcon, SearchIcon, SlidersIcon, XIcon } from "../components/icons.tsx";
import { Actions, Sessions, Settings, SettingsGroups, SettingsSections, SidebarFooter, Slots, Layers } from "../ui/contracts.ts";
import type { SettingsEntry, SettingsSection } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import type { SlotItem, SlotsService } from "../ui/slots.ts";

type Section = SlotItem<SettingsSection>;

/** A section's groups from every plugin, in order; groups with the same title merge. */
const groupsOf = (slots: SlotsService, section: string): EntryGroup<SettingsEntry>[] => {
  const merged: { title?: string; entries: SettingsEntry[] }[] = [];
  for (const group of slots.list(SettingsGroups)) {
    if (group.section !== section) continue;
    const same = merged.find((candidate) => candidate.title === group.title);
    if (same === undefined) merged.push({ ...(group.title === undefined ? {} : { title: group.title }), entries: [...group.entries()] });
    else same.entries.push(...group.entries());
  }
  return merged.filter((group) => group.entries.length > 0);
};

function SettingsView(props: {
  slots: SlotsService;
  section: () => string;
  /** Changes on every `open`, even of the open section: the search clears, so a result that navigates lands there. */
  visits: () => number;
  open: (section: string | undefined) => void;
  setFocus: (focus: (() => void) | undefined) => void;
}) {
  const { slots } = props;
  const [query, setQuery] = createSignal("");
  const searching = () => query().trim() !== "";
  const sections = () => slots.list(SettingsSections);
  let main!: HTMLDivElement;
  let search!: HTMLInputElement;
  const previous = document.activeElement as HTMLElement | null;
  onMount(() => queueMicrotask(() => search.focus()));
  props.setFocus(() => {
    search.focus();
    search.select();
  });
  onCleanup(() => {
    props.setFocus(undefined);
    previous?.focus?.();
  });
  createEffect(on([props.section, searching], () => main.scrollTo({ top: 0 }), { defer: true }));
  createEffect(on(props.visits, () => setQuery(""), { defer: true }));

  const current = (): Section | undefined => sections().find((candidate) => candidate.id === props.section()) ?? sections()[0];
  const groups = createMemo(() => {
    const section = current();
    return section === undefined ? [] : groupsOf(slots, section.id);
  });
  const results = createMemo(() =>
    searching()
      ? sections()
          .map((section) => ({ section, groups: filterGroups(groupsOf(slots, section.id), query()) }))
          .filter((found) => found.groups.length > 0)
      : [],
  );
  const count = (id: string) =>
    results()
      .find((found) => found.section.id === id)
      ?.groups.reduce((sum, group) => sum + group.entries.length, 0) ?? 0;
  const go = (id: string) => {
    setQuery("");
    props.open(id);
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
          <For each={sections()}>
            {(item) => (
              <button
                class="settings-nav-item"
                classList={{ active: !searching() && current()?.id === item.id, dim: searching() && count(item.id) === 0 }}
                aria-current={!searching() && current()?.id === item.id ? "page" : undefined}
                onClick={() => go(item.id)}
              >
                <Dynamic component={item.icon} />
                <span class="settings-nav-label">{item.title}</span>
                <Show when={searching() && count(item.id) > 0}>
                  <span class="settings-nav-count">{count(item.id)}</span>
                </Show>
                <Show when={!searching() && item.badge?.()}>{(badge) => <span class="settings-nav-count err">{badge()}</span>}</Show>
              </button>
            )}
          </For>
        </div>
        <span class="spacer" />
        <button class="settings-nav-item" onClick={() => props.open(undefined)} data-tip="Back to chats · Esc">
          <ArrowLeftIcon />
          <span class="settings-nav-label">Back</span>
        </button>
      </nav>
      <div class="settings-main" ref={main}>
        <header class="settings-head">
          <span class="muted">Settings</span>
          <span class="settings-crumb-sep">/</span>
          <span>{searching() ? "Search" : current()?.title}</span>
          <span class="spacer" />
          <Show when={!searching() && current()?.actions}>{(actions) => <Dynamic component={actions()} />}</Show>
          <button class="icon-button" aria-label="Close settings" data-tip="Close · Esc" onClick={() => props.open(undefined)}>
            <XIcon />
          </button>
        </header>
        <div class="settings-content" classList={{ wide: !searching() && current()?.body !== undefined }}>
          <Show
            when={searching()}
            fallback={
              <Show when={current()}>
                {(section) => (
                  <>
                    <Show when={section().intro}>{(intro) => <Dynamic component={intro()} />}</Show>
                    <Show
                      when={section().body}
                      keyed
                      fallback={
                        <Show
                          when={groups().some((group) => group.entries.length > 0)}
                          fallback={<Show when={section().empty}>{(empty) => <Dynamic component={empty()} />}</Show>}
                        >
                          <Groups groups={groups()} />
                        </Show>
                      }
                    >
                      {(body) => <Dynamic component={body} />}
                    </Show>
                  </>
                )}
              </Show>
            }
          >
            <Show when={results().length > 0} fallback={<p class="settings-empty">No settings match “{query().trim()}”</p>}>
              <For each={results()}>
                {(found) => (
                  <section class="settings-result">
                    <button class="settings-result-title" onClick={() => go(found.section.id)} data-tip={`Open ${found.section.title}`}>
                      <Dynamic component={found.section.icon} />
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

function Groups(props: { groups: readonly EntryGroup<SettingsEntry>[] }) {
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

/**
 * Settings, covering the app while open. Plugins add sections and the
 * entries in them; the search runs across every section, and clearing it
 * returns to the section being browsed. Going to a chat closes it.
 */
export default defineUiPlugin({
  id: "settings",
  requires: { slots: Slots, sessions: Sessions },
  provides: { settings: Settings },
  setup: ({ slots, sessions }, plugin) => {
    const [section, setSection] = createSignal<string>();
    const [visits, setVisits] = createSignal(0);
    const [focus, setFocus] = createSignal<() => void>();
    const open = (next: string | undefined) => {
      setSection(next);
      setVisits((count) => count + 1);
    };
    plugin.onCleanup(sessions.onSelect(() => open(undefined)));

    const add = (remove: () => void) => plugin.onCleanup(remove);
    add(slots.add(SettingsSections, { id: "general", order: 0, title: "General", icon: SlidersIcon }));
    add(
      slots.add(Layers, {
        id: "settings",
        order: -10,
        component: () => (
          <Show when={section() !== undefined}>
            <SettingsView slots={slots} section={() => section() ?? "general"} visits={visits} open={open} setFocus={(next) => setFocus(() => next)} />
          </Show>
        ),
      }),
    );
    add(
      slots.add(Actions, {
        id: "settings.open",
        order: 8,
        title: "Open settings",
        category: "Settings",
        keywords: ["preferences", "theme", "appearance", "general"],
        icon: GearIcon,
        keys: "mod+,",
        when: () => section() === undefined,
        run: () => open("general"),
      }),
    );
    add(
      slots.add(Actions, {
        id: "settings.close",
        title: "Close settings",
        category: "Settings",
        icon: ArrowLeftIcon,
        keys: ["escape", "mod+,"],
        whileTyping: true,
        order: -10,
        when: () => section() !== undefined,
        run: () => open(undefined),
      }),
    );
    add(
      slots.add(Actions, {
        id: "settings.search",
        title: "Search settings",
        hidden: true,
        keys: "/",
        order: -10,
        when: () => section() !== undefined && focus() !== undefined,
        run: () => focus()?.(),
      }),
    );
    // A section needing attention is the likeliest reason to open settings, so the button goes straight to it.
    const attention = () => slots.list(SettingsSections).find((candidate) => candidate.badge?.() !== undefined);
    add(
      slots.add(SidebarFooter, {
        id: "settings",
        component: (props) => (
          <button
            class="icon-button with-badge"
            aria-label="Settings"
            data-tip={attention() === undefined ? `Settings · ${formatKeys("mod+,")}` : `Settings · ${attention()!.title}: ${attention()!.badge!()}`}
            onClick={() => {
              open(attention()?.id ?? "general");
              props.onPick();
            }}
          >
            <GearIcon />
            <Show when={attention()?.badge?.()}>{(badge) => <span class="count-badge">{Number.parseInt(badge(), 10) || "!"}</span>}</Show>
          </button>
        ),
      }),
    );
    return { settings: { section, open } };
  },
});
