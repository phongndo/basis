import { For, Show, createMemo, createSignal } from "solid-js";
import type { SessionInfo } from "@basis/contracts";
import { relativeTime, tildePath } from "../model/format.ts";
import { groupSessions, sessionTitle } from "../model/sessions.ts";
import { newChat, openDialog, pendingChatCwd, renameSession, selectSession, state } from "../store.ts";
import { ConnectionBadge } from "./connection.tsx";
import { Popover } from "./popover.tsx";
import { CheckIcon, FolderIcon, FolderPlusIcon, GearIcon, KeyIcon, PenSquareIcon, PlusIcon, PuzzleIcon, SearchIcon, XIcon } from "./icons.tsx";

// Relative times refresh once a minute.
const [now, setNow] = createSignal(Date.now());
setInterval(() => setNow(Date.now()), 60_000);

function SessionRow(props: { session: SessionInfo; onPick: () => void }) {
  const [editing, setEditing] = createSignal(false);
  const active = () => state.activeId === props.session.id;
  const running = () => state.running.includes(props.session.id);
  const commit = (value: string) => {
    setEditing(false);
    if (value.trim() !== "" && value.trim() !== props.session.title) void renameSession(props.session.id, value);
  };
  return (
    <li>
      <Show
        when={editing()}
        fallback={
          <button
            class="session-row"
            classList={{ active: active() }}
            aria-current={active() ? "page" : undefined}

            onClick={() => {
              void selectSession(props.session.id);
              props.onPick();
            }}
            onDblClick={() => setEditing(true)}
          >
            <Show when={running()}>
              <span class="running-dot" data-tip="Running" />
            </Show>
            <span class="session-title" classList={{ untitled: props.session.title === undefined }}>
              {sessionTitle(props.session)}
            </span>
            <span class="session-time">{relativeTime(props.session.updatedAt, now())}</span>
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
              event.stopPropagation();
              setEditing(false);
            }
          }}
          onBlur={(event) => commit(event.currentTarget.value)}
        />
      </Show>
    </li>
  );
}

export function Sidebar(props: { onPick: () => void }) {
  const [query, setQuery] = createSignal("");
  /** Show one project's sessions, or all when undefined. */
  const [scope, setScope] = createSignal<string | undefined>();
  const allGroups = createMemo(() => groupSessions(state.sessions));
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
  const failed = () => state.plugins.filter((plugin) => plugin.state === "failed").length;
  const hostCwd = () => state.info?.cwd;
  const home = () => state.info?.home;
  const cwdLabel = (cwd: string) => {
    const path = tildePath(cwd, home());
    const slash = path.lastIndexOf("/");
    return { name: slash === -1 ? path : path.slice(slash + 1) || path, parent: slash <= 0 ? "" : path.slice(0, slash + 1) };
  };
  const newChatIn = (cwd?: string) => {
    newChat(cwd === hostCwd() ? undefined : cwd);
    props.onPick();
  };
  const onKey = (event: KeyboardEvent) => {
    // Arrow keys move between session rows.
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...document.querySelectorAll<HTMLElement>(".session-row")];
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
                      <span class="menu-label">{cwdLabel(group.cwd).name}</span>
                      <span class="menu-hint">{cwdLabel(group.cwd).parent}</span>
                    </button>
                  )}
                </For>
              </>
            )}
          </Popover>
          <button
            class="icon-button"
            aria-label="Add project"
            data-tip="Add project"
            onClick={() => {
              openDialog("add-project");
              props.onPick();
            }}
          >
            <FolderPlusIcon />
          </button>
          <button
            class="icon-button"
            classList={{ active: state.activeId === undefined }}
            data-tip="New chat"
            aria-label="New chat"
            onClick={() => newChatIn(scope())}
          >
            <PenSquareIcon />
          </button>
        </div>
      </div>
      <div class="session-groups">
        <Show when={state.sessionsLoaded && state.sessions.length === 0}>
          <p class="sidebar-empty">No sessions yet. Your conversations will appear here.</p>
        </Show>
        <Show when={state.sessions.length > 0 && groups().length === 0}>
          <p class="sidebar-empty">No matching sessions.</p>
        </Show>
        <For each={groups()}>
          {(group) => (
            <section class="session-group">
              <div class="group-head" data-tip={group.cwd}>
                <FolderIcon />
                <span class="group-name">{cwdLabel(group.cwd).name}</span>
                <span class="group-parent">{cwdLabel(group.cwd).parent}</span>
                <button
                  class="icon-button group-new"
                  classList={{ active: state.activeId === undefined && pendingChatCwd() === group.cwd }}
                  aria-label={`New chat in ${group.cwd}`}
                  data-tip={`New chat in ${tildePath(group.cwd, home())}`}
                  onClick={() => newChatIn(group.cwd)}
                >
                  <PlusIcon />
                </button>
              </div>
              <ul class="session-list">
                <For each={group.sessions}>{(session) => <SessionRow session={session} onPick={props.onPick} />}</For>
              </ul>
            </section>
          )}
        </For>
      </div>
      <div class="sidebar-foot">
        <Popover
          label="Settings"
          trigger={
            <>
              <GearIcon />
              <Show when={failed() > 0}>
                <span class="count-badge">{failed()}</span>
              </Show>
            </>
          }
          triggerClass="icon-button with-badge"
          placement="top-start"
        >
          {(close) => (
            <>
              <button
                class="menu-item"
                role="menuitem"
                onClick={() => {
                  close();
                  openDialog("providers");
                }}
              >
                <KeyIcon /> Providers & login
              </button>
              <button
                class="menu-item"
                role="menuitem"
                onClick={() => {
                  close();
                  openDialog("plugins");
                }}
              >
                <PuzzleIcon /> Plugins
                <Show when={failed() > 0}>
                  <span class="menu-hint menu-hint-err">{failed()} failed</span>
                </Show>
              </button>
            </>
          )}
        </Popover>
        <span class="spacer" />
        <ConnectionBadge />
      </div>
    </nav>
  );
}
