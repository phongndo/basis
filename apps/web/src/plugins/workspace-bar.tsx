import { For, Show, createMemo, createSignal } from "solid-js";
import type { GitBranch, WorkspaceStatus } from "@lemma/contracts";
import { CheckIcon, ChevronDownIcon, FolderIcon, FolderPlusIcon, GitBranchIcon, LaptopIcon, PlusIcon, WorktreeIcon } from "../components/icons.tsx";
import { Popover } from "../components/popover.tsx";
import { SettingRow } from "../components/setting-row.tsx";
import { Toggle } from "../components/toggle.tsx";
import { Actions, Client, ComposerFooter, Notify, Sessions, SettingsGroups, Slots, Workspace } from "../ui/contracts.ts";
import type { ClientService, NotifyService, SessionsService, WorkspaceService } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import type { SlotsService } from "../ui/slots.ts";

const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

interface Deps {
  readonly client: ClientService;
  readonly sessions: SessionsService;
  readonly workspace: WorkspaceService;
  readonly notify: NotifyService;
  readonly slots: SlotsService;
}

/**
 * The strip under the composer: which project the chat works in, and that
 * project's git branch. A session's directory is fixed once it exists, so the
 * project is only choosable for a new chat.
 */
function WorkspaceBar(props: { deps: Deps }) {
  const { workspace } = props.deps;
  const status = workspace.status;
  return (
    <Show when={workspace.workingDir() !== undefined}>
      <div class="workspace-bar">
        <ProjectPicker deps={props.deps} />
        <Show when={status()?.git}>
          {(git) => (
            <>
              <span class="strip-sep" aria-hidden="true" />
              <ModePicker deps={props.deps} git={git()} />
            </>
          )}
        </Show>
        <Show when={status()?.exists === false}>
          <span class="workspace-warning">Folder not found on the host</span>
        </Show>
        <span class="spacer" />
        <Show when={status()?.git}>{(git) => <BranchPicker deps={props.deps} git={git()} onChanged={workspace.setStatus} />}</Show>
      </div>
    </Show>
  );
}

/** Local checkout or a new worktree; fixed once the chat exists. */
function ModePicker(props: { deps: Deps; git: NonNullable<WorkspaceStatus["git"]> }) {
  const { sessions, workspace } = props.deps;
  const isNew = () => sessions.activeId() === undefined;
  const worktree = () => workspace.worktree().enabled;
  const workingDir = workspace.workingDir;
  const setNewWorktree = workspace.setWorktree;
  return (
    <Show
      when={isNew()}
      fallback={
        <Show when={props.git.worktreeOf}>
          {(main) => (
            <span class="strip-chip static" data-tip={`Worktree of ${main()}`}>
              <WorktreeIcon />
              <span class="strip-label">Worktree</span>
            </span>
          )}
        </Show>
      }
    >
      <Popover
        label="Where to work"
        tip={worktree() ? "A new worktree on its own branch" : "Directly in the project folder"}
        triggerClass="strip-chip"
        placement="top-start"
        menuClass="mode-menu"
        trigger={
          <>
            {worktree() ? <WorktreeIcon /> : <LaptopIcon />}
            <span class="strip-label">{worktree() ? "New worktree" : "Local"}</span>
            <ChevronDownIcon />
          </>
        }
      >
        {(close) => (
          <>
            <button
              class="menu-item menu-item-tall"
              role="menuitemradio"
              aria-checked={!worktree()}
              onClick={() => {
                setNewWorktree(false);
                close();
              }}
            >
              <span class="menu-check">
                <Show when={!worktree()}>
                  <CheckIcon />
                </Show>
              </span>
              <span class="menu-stack">
                <span class="menu-label">Local</span>
                <span class="menu-desc">
                  Work directly in {baseName(workingDir() ?? "")} on {props.git.branch ?? "the current commit"}
                </span>
              </span>
            </button>
            <button
              class="menu-item menu-item-tall"
              role="menuitemradio"
              aria-checked={worktree()}
              onClick={() => {
                setNewWorktree(true);
                close();
              }}
            >
              <span class="menu-check">
                <Show when={worktree()}>
                  <CheckIcon />
                </Show>
              </span>
              <span class="menu-stack">
                <span class="menu-label">New worktree</span>
                <span class="menu-desc">A separate checkout on a new branch in ~/.lemma/worktrees, so this chat's changes stay apart</span>
              </span>
            </button>
          </>
        )}
      </Popover>
    </Show>
  );
}

function ProjectPicker(props: { deps: Deps }) {
  const { client, sessions, workspace, slots } = props.deps;
  const isNew = () => sessions.activeId() === undefined;
  const projects = workspace.projects;
  const current = () => workspace.workingDir() ?? "";
  const addProject = () => slots.get(Actions, "add-project.open");
  const label = () => (
    <>
      <FolderIcon />
      <span class="strip-label">{baseName(current())}</span>
    </>
  );
  return (
    <Show
      when={isNew()}
      fallback={
        <span class="strip-chip static" data-tip={current()}>
          {label()}
        </span>
      }
    >
      <Popover
        label="Project"
        tip={current()}
        trigger={
          <>
            {label()}
            <ChevronDownIcon />
          </>
        }
        triggerClass="strip-chip"
        placement="top-start"
        menuClass="project-menu"
      >
        {(close) => (
          <>
            <div class="menu-section">Start in</div>
            <For each={projects()}>
              {(path) => (
                <button
                  class="menu-item"
                  role="menuitemradio"
                  aria-checked={path === current()}
                  onClick={() => {
                    sessions.newChat(path === client.info()?.cwd ? undefined : path);
                    close();
                  }}
                >
                  <span class="menu-check">
                    <Show when={path === current()}>
                      <CheckIcon />
                    </Show>
                  </span>
                  <span class="menu-label">{baseName(path)}</span>
                  <span class="menu-hint">{path.slice(0, path.length - baseName(path).length - 1)}</span>
                </button>
              )}
            </For>
            <Show when={addProject()}>
              {(action) => (
                <>
                  <div class="menu-sep" />
                  <button
                    class="menu-item"
                    role="menuitem"
                    onClick={() => {
                      close();
                      action().run();
                    }}
                  >
                    <span class="menu-check">
                      <FolderPlusIcon />
                    </span>
                    <span class="menu-label">Add project…</span>
                  </button>
                </>
              )}
            </Show>
          </>
        )}
      </Popover>
    </Show>
  );
}

function BranchPicker(props: { deps: Deps; git: NonNullable<WorkspaceStatus["git"]>; onChanged: (status: WorkspaceStatus) => void }) {
  const { sessions, workspace, notify } = props.deps;
  const workingDir = workspace.workingDir;
  const [branches, setBranches] = createSignal<readonly GitBranch[]>([]);
  const [query, setQuery] = createSignal("");
  const [switching, setSwitching] = createSignal(false);
  // Switching branches under a running turn would change files the agent is editing.
  const busyHere = () => sessions.running().some((id) => sessions.list().find((session) => session.id === id)?.cwd === workingDir());

  const load = async () => {
    setQuery("");
    const path = workingDir();
    if (path === undefined) return;
    try {
      setBranches(await workspace.api.branches(path));
    } catch (error) {
      notify.report(error, "Could not list branches");
    }
  };
  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return needle === "" ? branches() : branches().filter((branch) => branch.name.toLowerCase().includes(needle));
  });
  /** A new chat headed for a new worktree: the menu picks the branch it starts from instead of switching. */
  const baseMode = () => sessions.activeId() === undefined && workspace.worktree().enabled;
  const base = () => workspace.worktree().base ?? props.git.branch ?? undefined;
  const canCreate = () => {
    if (baseMode()) return false;
    const name = query().trim();
    // `x` matching a remote `origin/x` checks that out instead of creating a new branch.
    return name !== "" && !branches().some((branch) => branch.name === name || (branch.remote && branch.name.slice(branch.name.indexOf("/") + 1) === name));
  };

  const checkout = async (branch: string, create: boolean, close: () => void) => {
    const path = workingDir();
    if (path === undefined) return;
    close();
    setSwitching(true);
    try {
      props.onChanged(await workspace.api.checkout(path, branch, create ? { create: true } : undefined));
    } catch (error) {
      notify.report(error, `Could not switch to ${branch}`);
    } finally {
      setSwitching(false);
    }
  };

  const here = () => props.git.branch ?? `detached ${props.git.head ?? ""}`.trim();
  const label = () => (baseMode() ? `From ${base() ?? here()}` : here());
  const choose = (branch: GitBranch, close: () => void) => {
    if (baseMode()) {
      workspace.setWorktreeBase(branch.current ? undefined : branch.name);
      close();
      return;
    }
    if (branch.current) {
      close();
      return;
    }
    if (branch.worktree !== undefined) {
      close();
      // git keeps a branch in one worktree at a time; go to where it is instead.
      if (sessions.activeId() === undefined) sessions.newChat(branch.worktree);
      else notify.toast({ level: "info", message: `${branch.name} is checked out in the worktree at ${branch.worktree}` });
      return;
    }
    void checkout(branch.name, false, close);
  };
  const checked = (branch: GitBranch) => (baseMode() ? branch.name === base() : branch.current);
  const title = () =>
    [
      props.git.branch === null ? "Detached HEAD" : `On ${props.git.branch}`,
      props.git.changes > 0 ? `${props.git.changes} uncommitted change${props.git.changes === 1 ? "" : "s"}` : "clean",
      props.git.upstream === undefined ? undefined : `${props.git.ahead} ahead, ${props.git.behind} behind ${props.git.upstream}`,
      busyHere() ? "Branch switching waits for the running turn" : undefined,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <Popover
      label={baseMode() ? "Worktree base branch" : "Git branch"}
      tip={baseMode() ? "The branch the new worktree starts from" : title()}
      disabled={busyHere() || switching()}
      triggerClass="strip-chip"
      placement="top-end"
      menuClass="branch-menu"
      onOpen={() => void load()}
      trigger={
        <>
          <GitBranchIcon />
          <span class="strip-label">{switching() ? "Switching…" : label()}</span>
          <Show when={!baseMode()}>
            <Show when={props.git.changes > 0}>
              <span class="strip-dirty" aria-label={`${props.git.changes} uncommitted changes`}>
                {props.git.changes}
              </span>
            </Show>
            <Show when={props.git.ahead > 0}>
              <span class="strip-count">↑{props.git.ahead}</span>
            </Show>
            <Show when={props.git.behind > 0}>
              <span class="strip-count">↓{props.git.behind}</span>
            </Show>
          </Show>
        </>
      }
    >
      {(close) => (
        <>
          <input
            class="menu-search"
            placeholder={baseMode() ? "Start the worktree from…" : "Find or create a branch"}
            aria-label={baseMode() ? "Base branch" : "Find or create a branch"}
            autocomplete="off"
            spellcheck={false}
            data-autofocus
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <div class="menu-list">
            <Show when={canCreate()}>
              <button class="menu-item" role="menuitem" onClick={() => void checkout(query().trim(), true, close)}>
                <span class="menu-check">
                  <PlusIcon />
                </span>
                <span class="menu-label">Create “{query().trim()}”</span>
                <span class="menu-hint">from {here()}</span>
              </button>
            </Show>
            <For each={filtered()}>
              {(branch) => (
                <button
                  class="menu-item"
                  role="menuitemradio"
                  aria-checked={checked(branch)}
                  data-tip={!baseMode() && branch.worktree !== undefined ? `Checked out in ${branch.worktree}` : undefined}
                  onClick={() => choose(branch, close)}
                >
                  <span class="menu-check">
                    <Show when={checked(branch)}>
                      <CheckIcon />
                    </Show>
                  </span>
                  <span class="menu-label branch-name">{branch.name}</span>
                  <Show when={branch.worktree !== undefined}>
                    <span class="tag">worktree</span>
                  </Show>
                  <Show when={branch.remote}>
                    <span class="tag">remote</span>
                  </Show>
                </button>
              )}
            </For>
            <Show when={filtered().length === 0 && !canCreate()}>
              <div class="picker-empty">No branches</div>
            </Show>
          </div>
          <Show
            when={baseMode()}
            fallback={
              <Show when={props.git.changes > 0}>
                <div class="menu-note">Uncommitted changes move with you; git refuses a switch that would overwrite them.</div>
              </Show>
            }
          >
            <div class="menu-note">The worktree gets its own new branch, named from your first message. Uncommitted changes here stay here.</div>
          </Show>
        </>
      )}
    </Popover>
  );
}

/** The project and branch strip under the composer, and the worktree setting for new chats. */
export default defineUiPlugin({
  id: "workspace-bar",
  requires: { client: Client, sessions: Sessions, workspace: Workspace, notify: Notify, slots: Slots },
  setup: (deps, plugin) => {
    plugin.onCleanup(deps.slots.add(ComposerFooter, { id: "workspace-bar", component: () => <WorkspaceBar deps={deps} /> }));
    plugin.onCleanup(
      deps.slots.add(SettingsGroups, {
        id: "workspace-bar",
        section: "general",
        title: "New chats",
        order: 10,
        entries: () => [
          {
            text: "Start in a new worktree git branch checkout workspace",
            view: () => (
              <SettingRow
                title="Start in a new worktree"
                description="In a git repository, a new chat gets its own checkout on a new branch, so its changes stay apart."
              >
                <Toggle label="Start in a new worktree" checked={deps.workspace.worktree().enabled} onChange={deps.workspace.setWorktree} />
              </SettingRow>
            ),
          },
        ],
      }),
    );
  },
});
