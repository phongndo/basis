import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { GitBranch, WorkspaceStatus } from "@basis/contracts";
import { knownProjects } from "../model/prefs.ts";
import {
  connected, newChat, openDialog, reportError, setNewWorktree, setWorkspaceStatus, setWorktreeBase, state, toast,
  workingDir, workspaceApi, workspaceStatus, worktreeDraftState,
} from "../store.ts";
import { CheckIcon, ChevronDownIcon, FolderIcon, FolderPlusIcon, GitBranchIcon, LaptopIcon, PlusIcon, WorktreeIcon } from "./icons.tsx";
import { Popover } from "./popover.tsx";

const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/**
 * The strip under the composer: which project the chat works in, and that
 * project's git branch. A session's directory is fixed once it exists, so the
 * project is only choosable for a new chat.
 */
export function WorkspaceBar() {
  const status = workspaceStatus;
  const setStatus = setWorkspaceStatus;
  const refresh = async () => {
    const path = workingDir();
    if (path === undefined || !connected()) return;
    try {
      const next = await workspaceApi().status(path);
      if (workingDir() === path) setStatus(next);
    } catch { /* keep the last known status */ }
  };

  createEffect(on([workingDir, connected], () => {
    if (status()?.path !== workingDir()) {
      setStatus(undefined);
      // A base branch belongs to the project it was picked in.
      setWorktreeBase(undefined);
    }
    void refresh();
  }));
  // A turn may have committed or switched branches.
  createEffect(on(() => state.running.length, () => void refresh(), { defer: true }));
  const onFocus = () => void refresh();
  onMount(() => window.addEventListener("focus", onFocus));
  onCleanup(() => window.removeEventListener("focus", onFocus));

  return (
    <Show when={workingDir() !== undefined}>
      <div class="workspace-bar">
        <ProjectPicker />
        <Show when={status()?.git}>
          {(git) => <><span class="strip-sep" aria-hidden="true" /><ModePicker git={git()} /></>}
        </Show>
        <Show when={status()?.exists === false}>
          <span class="workspace-warning">Folder not found on the host</span>
        </Show>
        <span class="spacer" />
        <Show when={status()?.git}>
          {(git) => <BranchPicker git={git()} onChanged={setStatus} />}
        </Show>
      </div>
    </Show>
  );
}

/** Local checkout or a new worktree; fixed once the chat exists. */
function ModePicker(props: { git: NonNullable<WorkspaceStatus["git"]> }) {
  const isNew = () => state.activeId === undefined;
  const worktree = () => worktreeDraftState().enabled;
  return (
    <Show
      when={isNew()}
      fallback={
        <Show when={props.git.worktreeOf}>
          {(main) => <span class="strip-chip static" data-tip={`Worktree of ${main()}`}><WorktreeIcon /><span class="strip-label">Worktree</span></span>}
        </Show>
      }
    >
      <Popover
        label="Where to work"
        tip={worktree() ? "A new worktree on its own branch" : "Directly in the project folder"}
        triggerClass="strip-chip"
        placement="top-start"
        menuClass="mode-menu"
        trigger={<>{worktree() ? <WorktreeIcon /> : <LaptopIcon />}<span class="strip-label">{worktree() ? "New worktree" : "Local"}</span><ChevronDownIcon /></>}
      >
        {(close) => (
          <>
            <button class="menu-item menu-item-tall" role="menuitemradio" aria-checked={!worktree()} onClick={() => { setNewWorktree(false); close(); }}>
              <span class="menu-check"><Show when={!worktree()}><CheckIcon /></Show></span>
              <span class="menu-stack">
                <span class="menu-label">Local</span>
                <span class="menu-desc">Work directly in {baseName(workingDir() ?? "")} on {props.git.branch ?? "the current commit"}</span>
              </span>
            </button>
            <button class="menu-item menu-item-tall" role="menuitemradio" aria-checked={worktree()} onClick={() => { setNewWorktree(true); close(); }}>
              <span class="menu-check"><Show when={worktree()}><CheckIcon /></Show></span>
              <span class="menu-stack">
                <span class="menu-label">New worktree</span>
                <span class="menu-desc">A separate checkout on a new branch in ~/.basis/worktrees, so this chat's changes stay apart</span>
              </span>
            </button>
          </>
        )}
      </Popover>
    </Show>
  );
}

function ProjectPicker() {
  const isNew = () => state.activeId === undefined;
  const projects = createMemo(() => knownProjects(state.info?.cwd, state.sessions, state.projects));
  const current = () => workingDir() ?? "";
  const label = () => (
    <>
      <FolderIcon />
      <span class="strip-label">{baseName(current())}</span>
    </>
  );
  return (
    <Show
      when={isNew()}
      fallback={<span class="strip-chip static" data-tip={current()}>{label()}</span>}
    >
      <Popover
        label="Project"
        tip={current()}
        trigger={<>{label()}<ChevronDownIcon /></>}
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
                  onClick={() => { newChat(path === state.info?.cwd ? undefined : path); close(); }}
                >
                  <span class="menu-check"><Show when={path === current()}><CheckIcon /></Show></span>
                  <span class="menu-label">{baseName(path)}</span>
                  <span class="menu-hint">{path.slice(0, path.length - baseName(path).length - 1)}</span>
                </button>
              )}
            </For>
            <div class="menu-sep" />
            <button class="menu-item" role="menuitem" onClick={() => { close(); openDialog("add-project"); }}>
              <span class="menu-check"><FolderPlusIcon /></span>
              <span class="menu-label">Add project…</span>
            </button>
          </>
        )}
      </Popover>
    </Show>
  );
}

function BranchPicker(props: { git: NonNullable<WorkspaceStatus["git"]>; onChanged: (status: WorkspaceStatus) => void }) {
  const [branches, setBranches] = createSignal<readonly GitBranch[]>([]);
  const [query, setQuery] = createSignal("");
  const [switching, setSwitching] = createSignal(false);
  // Switching branches under a running turn would change files the agent is editing.
  const busyHere = () => state.running.some((id) => state.sessions.find((session) => session.id === id)?.cwd === workingDir());

  const load = async () => {
    setQuery("");
    const path = workingDir();
    if (path === undefined) return;
    try { setBranches(await workspaceApi().branches(path)); } catch (error) { reportError(error, "Could not list branches"); }
  };
  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return needle === "" ? branches() : branches().filter((branch) => branch.name.toLowerCase().includes(needle));
  });
  /** A new chat headed for a new worktree: the menu picks the branch it starts from instead of switching. */
  const baseMode = () => state.activeId === undefined && worktreeDraftState().enabled;
  const base = () => worktreeDraftState().base ?? props.git.branch ?? undefined;
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
      props.onChanged(await workspaceApi().checkout(path, branch, create ? { create: true } : undefined));
    } catch (error) {
      reportError(error, `Could not switch to ${branch}`);
    } finally {
      setSwitching(false);
    }
  };

  const here = () => props.git.branch ?? `detached ${props.git.head ?? ""}`.trim();
  const label = () => (baseMode() ? `From ${base() ?? here()}` : here());
  const choose = (branch: GitBranch, close: () => void) => {
    if (baseMode()) { setWorktreeBase(branch.current ? undefined : branch.name); close(); return; }
    if (branch.current) { close(); return; }
    if (branch.worktree !== undefined) {
      close();
      // git keeps a branch in one worktree at a time; go to where it is instead.
      if (state.activeId === undefined) newChat(branch.worktree);
      else toast({ level: "info", message: `${branch.name} is checked out in the worktree at ${branch.worktree}` });
      return;
    }
    void checkout(branch.name, false, close);
  };
  const checked = (branch: GitBranch) => (baseMode() ? branch.name === base() : branch.current);
  const title = () => [
    props.git.branch === null ? "Detached HEAD" : `On ${props.git.branch}`,
    props.git.changes > 0 ? `${props.git.changes} uncommitted change${props.git.changes === 1 ? "" : "s"}` : "clean",
    props.git.upstream === undefined ? undefined : `${props.git.ahead} ahead, ${props.git.behind} behind ${props.git.upstream}`,
    busyHere() ? "Branch switching waits for the running turn" : undefined,
  ].filter(Boolean).join(" · ");

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
            <Show when={props.git.changes > 0}><span class="strip-dirty" aria-label={`${props.git.changes} uncommitted changes`}>{props.git.changes}</span></Show>
            <Show when={props.git.ahead > 0}><span class="strip-count">↑{props.git.ahead}</span></Show>
            <Show when={props.git.behind > 0}><span class="strip-count">↓{props.git.behind}</span></Show>
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
                <span class="menu-check"><PlusIcon /></span>
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
                  <span class="menu-check"><Show when={checked(branch)}><CheckIcon /></Show></span>
                  <span class="menu-label branch-name">{branch.name}</span>
                  <Show when={branch.worktree !== undefined}><span class="tag">worktree</span></Show>
                  <Show when={branch.remote}><span class="tag">remote</span></Show>
                </button>
              )}
            </For>
            <Show when={filtered().length === 0 && !canCreate()}>
              <div class="picker-empty">No branches</div>
            </Show>
          </div>
          <Show
            when={baseMode()}
            fallback={<Show when={props.git.changes > 0}><div class="menu-note">Uncommitted changes move with you; git refuses a switch that would overwrite them.</div></Show>}
          >
            <div class="menu-note">The worktree gets its own new branch, named from your first message. Uncommitted changes here stay here.</div>
          </Show>
        </>
      )}
    </Popover>
  );
}
