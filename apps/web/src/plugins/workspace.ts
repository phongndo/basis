import { createEffect, createMemo, createSignal, on } from "solid-js";
import type { WorkspaceStatus } from "@lemma/contracts";
import { load, loadJson, save } from "../lib/storage.ts";
import { branchSlug } from "../model/format.ts";
import { knownProjects } from "../model/prefs.ts";
import { Client, Notify, Sessions, Workspace } from "../ui/contracts.ts";
import type { WorktreeDraft } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

const PROJECTS_KEY = "lemma.projects";
const WORKTREE_KEY = "lemma.newWorktree";

/**
 * Projects and the directory the composer works in: its git status, kept
 * fresh while connected (a turn or a command may commit or switch branches),
 * and whether a new chat starts in its own worktree.
 */
export default defineUiPlugin({
  id: "workspace",
  requires: { client: Client, notify: Notify, sessions: Sessions },
  provides: { workspace: Workspace },
  setup: ({ client, notify, sessions }, plugin) => {
    const api = client.host.workspace;
    const [added, setAdded] = createSignal<readonly string[]>(loadJson(PROJECTS_KEY, []));
    const [status, setStatus] = createSignal<WorkspaceStatus>();
    const [worktree, setWorktreeDraft] = createSignal<WorktreeDraft>({ enabled: load(WORKTREE_KEY) === "1" });

    const workingDir = createMemo(() => sessions.active()?.cwd ?? sessions.pendingCwd() ?? client.info()?.cwd);
    const projects = createMemo(() => knownProjects(client.info()?.cwd, sessions.list(), added()));
    const setWorktreeBase = (base: string | undefined) =>
      setWorktreeDraft((draft) => (base === undefined ? { enabled: draft.enabled } : { enabled: draft.enabled, base }));

    const refresh = async () => {
      const path = workingDir();
      if (path === undefined || !client.connected()) return;
      try {
        const next = await api.status(path);
        if (workingDir() === path) setStatus(next);
      } catch {
        /* keep the last known status */
      }
    };
    createEffect(
      on([workingDir, client.connected], () => {
        if (status()?.path !== workingDir()) {
          setStatus(undefined);
          // A base branch belongs to the project it was picked in.
          setWorktreeBase(undefined);
        }
        void refresh();
      }),
    );
    // A turn may have committed or switched branches.
    createEffect(
      on(
        () => sessions.running().length,
        () => void refresh(),
        { defer: true },
      ),
    );
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    plugin.onCleanup(() => window.removeEventListener("focus", onFocus));

    const add = (path: string) => {
      if (added().includes(path)) return;
      const next = [...added(), path];
      setAdded(next);
      save(PROJECTS_KEY, JSON.stringify(next));
    };

    return {
      workspace: {
        api,
        projects,
        added,
        add,
        remove: (path: string) => {
          const next = added().filter((project) => project !== path);
          setAdded(next);
          save(PROJECTS_KEY, JSON.stringify(next));
        },
        open: async (input: string) => {
          if (input.trim() === "") return false;
          try {
            const found = await api.status(input.trim());
            if (!found.exists) {
              notify.toast({ level: "error", message: `No folder at ${found.path} on the host` });
              return false;
            }
            add(found.path);
            sessions.newChat(found.path === client.info()?.cwd ? undefined : found.path);
            return true;
          } catch (error) {
            notify.report(error, "Could not open the folder");
            return false;
          }
        },
        workingDir,
        status,
        setStatus,
        refresh,
        worktree,
        setWorktree: (enabled: boolean) => {
          save(WORKTREE_KEY, enabled ? "1" : undefined);
          setWorktreeDraft({ enabled });
        },
        setWorktreeBase,
        newChatDir: async (text: string) => {
          const current = status();
          const draft = worktree();
          if (!draft.enabled || current?.git === undefined || current.path !== workingDir()) return undefined;
          const created = await api.createWorktree(current.path, { branch: branchSlug(text), ...(draft.base === undefined ? {} : { base: draft.base }) });
          setWorktreeBase(undefined);
          return created.path;
        },
      },
    };
  },
});
