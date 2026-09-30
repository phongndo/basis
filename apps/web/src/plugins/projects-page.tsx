import { Show } from "solid-js";
import { tildePath } from "../model/format.ts";
import { ActionIds, Actions, Client, Sessions, Settings, SettingsGroups, SettingsSections, Slots, Workspace } from "../ui/contracts.ts";
import type { ClientService, SessionsService, WorkspaceService } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { FolderIcon, FolderPlusIcon, XIcon } from "../ui/parts.tsx";
import styles from "./projects-page.css?inline";

const SECTION = "projects";

function ProjectRow(props: { client: ClientService; sessions: SessionsService; workspace: WorkspaceService; cwd: string; path: string }) {
  const count = () => props.sessions.list().filter((session) => session.cwd === props.cwd).length;
  const isHost = () => props.cwd === props.client.info()?.cwd;
  // Only a project added by hand can be forgotten; the others are listed through the host or their sessions.
  const removable = () => !isHost() && count() === 0 && props.workspace.added().includes(props.cwd);
  const slash = () => props.path.lastIndexOf("/");
  return (
    <div class="setting-row project-row">
      <FolderIcon />
      <div class="setting-text">
        <div class="setting-title">{props.path.slice(slash() + 1) || props.path}</div>
        <div class="setting-desc" data-tip={props.cwd}>
          {props.path}
          {" · "}
          {count() === 0 ? "no sessions" : `${count()} session${count() === 1 ? "" : "s"}`}
          {isHost() ? " · host directory" : ""}
        </div>
      </div>
      <div class="setting-control">
        <button class="button small" onClick={() => props.sessions.newChat(isHost() ? undefined : props.cwd)}>
          New chat
        </button>
        <Show when={removable()}>
          <button class="icon-button" aria-label={`Remove ${props.path}`} data-tip="Remove from projects" onClick={() => props.workspace.remove(props.cwd)}>
            <XIcon />
          </button>
        </Show>
      </div>
    </div>
  );
}

/** The projects chats can start in, as a settings section. */
export default defineUiPlugin({
  id: "projects-page",
  styles,
  requires: { client: Client, sessions: Sessions, workspace: Workspace, settings: Settings, slots: Slots },
  setup: ({ client, sessions, workspace, settings, slots }, plugin) => {
    plugin.onCleanup(
      slots.add(SettingsSections, {
        id: SECTION,
        order: 40,
        title: "Projects",
        icon: FolderIcon,
        actions: () => (
          <Show when={slots.get(Actions, ActionIds.addProject)}>
            {(action) => (
              <button class="button small" onClick={() => action().run()}>
                <FolderPlusIcon /> Add project
              </button>
            )}
          </Show>
        ),
        empty: () => <p class="settings-empty">No projects yet.</p>,
      }),
    );
    plugin.onCleanup(
      slots.add(SettingsGroups, {
        id: SECTION,
        section: SECTION,
        entries: () =>
          workspace.projects().map((cwd) => {
            const path = tildePath(cwd, client.info()?.home);
            return { text: `project ${path}`, view: () => <ProjectRow client={client} sessions={sessions} workspace={workspace} cwd={cwd} path={path} /> };
          }),
      }),
    );
    plugin.onCleanup(
      slots.add(Actions, {
        id: "projects-page.open",
        order: 9,
        title: "Manage projects",
        category: "Projects",
        keywords: ["folders", "directories", "settings"],
        icon: FolderIcon,
        run: () => settings.open(SECTION),
      }),
    );
  },
});
