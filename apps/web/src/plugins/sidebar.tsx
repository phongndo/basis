import { For, Show, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { formatKeys } from "../lib/keys.ts";
import { relativeTime, tildePath } from "../model/format.ts";
import { groupSessions, sessionTitle } from "../model/sessions.ts";
import { ActionIds, Actions, Client, Sessions, SidebarActions, SidebarFooter, SidebarRegion, SidebarRowPart, Slots } from "../ui/contracts.ts";
import type { ClientService, SessionsService, SidebarRowProps } from "../ui/contracts.ts";
import { DEFAULT_PART_ORDER } from "../ui/slots.ts";
import type { SlotsService } from "../ui/slots.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { CheckIcon, CommandIcon, FolderIcon, FolderPlusIcon, PenSquareIcon, PlusIcon, Popover, SearchIcon, SidebarRow, XIcon } from "../ui/parts.tsx";

interface Deps {
  readonly client: ClientService;
  readonly sessions: SessionsService;
  readonly slots: SlotsService;
  readonly now: () => number;
  /** The project the list is narrowed to, or all when undefined; the filter and new-chat buttons share it. */
  readonly scope: () => string | undefined;
  readonly allGroups: () => ReturnType<typeof groupSessions>;
  readonly newChatIn: (cwd?: string) => void;
}

/** The default `sidebar.row` part: title, running dot, and time; double-click renames. */
function SessionRow(props: SidebarRowProps) {
  const [editing, setEditing] = createSignal(false);
  const commit = (value: string) => {
    setEditing(false);
    if (value.trim() !== "" && value.trim() !== props.session.title) props.rename(value);
  };
  return (
    <Show
      when={editing()}
      fallback={
        <button
          class="session-row"
          data-session-row
          classList={{ active: props.active }}
          aria-current={props.active ? "page" : undefined}
          onClick={() => props.select()}
          onDblClick={() => setEditing(true)}
        >
          <Show when={props.running}>
            <span class="running-dot" data-tip="Running" />
          </Show>
          <span class="session-title" classList={{ untitled: props.session.title === undefined }}>
            {sessionTitle(props.session)}
          </span>
          <span class="session-time">{relativeTime(props.session.updatedAt, props.now)}</span>
        </button>
      }
    >
      <input
        class="session-rename"
        value={props.session.title ?? ""}
        aria-label="Session title"
        ref={(el) =>
          queueMicrotask(() => {
            el.focus();
            el.select();
          })
        }
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(event.currentTarget.value);
          else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setEditing(false);
          }
        }}
        onBlur={(event) => commit(event.currentTarget.value)}
      />
    </Show>
  );
}

/** A folder's name and where it is, as the sidebar shows it: `lemma` in `~/code/`. */
const cwdLabel = (cwd: string, home: string | undefined) => {
  const path = tildePath(cwd, home);
  const slash = path.lastIndexOf("/");
  return { name: slash === -1 ? path : path.slice(slash + 1) || path, parent: slash <= 0 ? "" : path.slice(0, slash + 1) };
};

function Sidebar(props: { deps: Deps; onPick: () => void }) {
  const { client, sessions, slots } = props.deps;
  const [query, setQuery] = createSignal("");
  const { scope, allGroups } = props.deps;
  const groups = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return allGroups()
      .filter((group) => scope() === undefined || group.cwd === scope())
      .map((group) => ({
        ...group,
        sessions: needle === "" ? group.sessions : group.sessions.filter((session) => sessionTitle(session).toLowerCase().includes(needle)),
      }))
      .filter((group) => group.sessions.length > 0);
  });
  const home = () => client.info()?.home;
  const newChatIn = (cwd?: string) => {
    props.deps.newChatIn(cwd);
    props.onPick();
  };
  const onKey = (event: KeyboardEvent) => {
    // Arrow keys move between session rows.
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-session-row]")];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;
    event.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };
  return (
    <nav class="sidebar" aria-label="Sessions" onKeyDown={onKey}>
      <div class="sidebar-head">
        <label class="sidebar-search">
          <SearchIcon />
          <input
            type="search"
            placeholder="Search"
            aria-label="Search sessions"
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
          <Show when={query() !== ""}>
            <button class="icon-button search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
              <XIcon />
            </button>
          </Show>
        </label>
        <div class="sidebar-actions">
          <For each={slots.list(SidebarActions)}>{(item) => <Dynamic component={item.component} onPick={props.onPick} />}</For>
        </div>
      </div>
      <div class="session-groups">
        <Show when={sessions.loaded() && sessions.list().length === 0}>
          <p class="sidebar-empty">No sessions yet. Your conversations will appear here.</p>
        </Show>
        <Show when={sessions.list().length > 0 && groups().length === 0}>
          <p class="sidebar-empty">No matching sessions.</p>
        </Show>
        <For each={groups()}>
          {(group) => (
            <section class="session-group">
              <div class="group-head" data-tip={group.cwd}>
                <FolderIcon />
                <span class="group-name">{cwdLabel(group.cwd, home()).name}</span>
                <span class="group-parent">{cwdLabel(group.cwd, home()).parent}</span>
                <button
                  class="icon-button group-new"
                  classList={{ active: sessions.activeId() === undefined && sessions.pendingCwd() === group.cwd }}
                  aria-label={`New chat in ${group.cwd}`}
                  data-tip={`New chat in ${tildePath(group.cwd, home())}`}
                  onClick={() => newChatIn(group.cwd)}
                >
                  <PlusIcon />
                </button>
              </div>
              <ul class="session-list">
                <For each={group.sessions}>
                  {(session) => (
                    <li>
                      <SidebarRow
                        session={session}
                        active={sessions.activeId() === session.id}
                        running={sessions.running().includes(session.id)}
                        now={props.deps.now()}
                        select={() => {
                          void sessions.select(session.id);
                          props.onPick();
                        }}
                        rename={(title) => void sessions.rename(session.id, title)}
                      />
                    </li>
                  )}
                </For>
              </ul>
            </section>
          )}
        </For>
      </div>
      <div class="sidebar-foot">
        <For each={slots.list(SidebarFooter)}>{(item) => <Dynamic component={item.component} onPick={props.onPick} />}</For>
      </div>
    </nav>
  );
}

/** Sessions by project, with search, a project filter, and new-chat buttons. Its foot is a slot (settings, connection). */
export default defineUiPlugin({
  id: "sidebar",
  requires: { client: Client, sessions: Sessions, slots: Slots },
  setup: (use, plugin) => {
    // Relative times refresh once a minute.
    const [now, setNow] = createSignal(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    plugin.onCleanup(() => window.clearInterval(timer));
    const { client, sessions, slots } = use;
    const [scope, setScope] = createSignal<string | undefined>();
    const allGroups = createMemo(() => groupSessions(sessions.list()));
    const home = () => client.info()?.home;
    const newChatIn = (cwd?: string) => sessions.newChat(cwd === client.info()?.cwd ? undefined : cwd);
    const deps: Deps = { ...use, now, scope, allGroups, newChatIn };
    plugin.onCleanup(slots.add(SidebarRegion, { id: "sidebar", component: (props) => <Sidebar deps={deps} onPick={props.onPick} /> }));
    plugin.onCleanup(slots.add(SidebarRowPart, { id: "sidebar.row", order: DEFAULT_PART_ORDER, component: SessionRow }));

    // Its head's buttons go through the slot other plugins add theirs to.
    type ActionProps = { readonly onPick: () => void };
    const action = (id: string, order: number, component: (props: ActionProps) => JSX.Element) =>
      plugin.onCleanup(slots.add(SidebarActions, { id, order, component }));
    /** Another plugin's action, when one is running: the sidebar offers it without knowing who provides it. */
    const runAction = (id: string, props: ActionProps) => {
      slots.get(Actions, id)?.run();
      props.onPick();
    };
    action("sidebar.palette", 0, (props) => (
      <Show when={slots.get(Actions, ActionIds.palette)}>
        {(palette) => (
          <button
            class="icon-button"
            aria-label="Command palette"
            data-tip={`Commands, sessions, projects · ${formatKeys(String(palette().keys ?? "mod+k"))}`}
            onClick={() => runAction(ActionIds.palette, props)}
          >
            <CommandIcon />
          </button>
        )}
      </Show>
    ));
    action("sidebar.projects", 10, () => (
      <Popover
        label={scope() === undefined ? "Projects" : `Project: ${tildePath(scope()!, home())}`}
        trigger={<FolderIcon />}
        triggerClass={scope() === undefined ? "icon-button" : "icon-button active"}
      >
        {(close) => (
          <>
            <button
              class="menu-item"
              role="menuitemradio"
              aria-checked={scope() === undefined}
              onClick={() => {
                setScope(undefined);
                close();
              }}
            >
              <span class="menu-check">
                <Show when={scope() === undefined}>
                  <CheckIcon />
                </Show>
              </span>
              All projects
            </button>
            <For each={allGroups()}>
              {(group) => (
                <button
                  class="menu-item"
                  role="menuitemradio"
                  aria-checked={scope() === group.cwd}
                  data-tip={group.cwd}
                  onClick={() => {
                    setScope(group.cwd);
                    close();
                  }}
                >
                  <span class="menu-check">
                    <Show when={scope() === group.cwd}>
                      <CheckIcon />
                    </Show>
                  </span>
                  <span class="menu-label">{cwdLabel(group.cwd, home()).name}</span>
                  <span class="menu-hint">{cwdLabel(group.cwd, home()).parent}</span>
                </button>
              )}
            </For>
          </>
        )}
      </Popover>
    ));
    action("sidebar.add-project", 20, (props) => (
      <Show when={slots.get(Actions, ActionIds.addProject)}>
        <button class="icon-button" aria-label="Add project" data-tip="Add project" onClick={() => runAction(ActionIds.addProject, props)}>
          <FolderPlusIcon />
        </button>
      </Show>
    ));
    action("sidebar.new-chat", 30, (props) => (
      <button
        class="icon-button"
        classList={{ active: sessions.activeId() === undefined }}
        data-tip="New chat"
        aria-label="New chat"
        onClick={() => {
          newChatIn(scope());
          props.onPick();
        }}
      >
        <PenSquareIcon />
      </button>
    ));
  },
});
