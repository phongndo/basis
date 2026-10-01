import type { SessionInfo } from "@lemma/contracts";
import { relativeTime, tildePath } from "../model/format.ts";
import { sessionTitle } from "../model/sessions.ts";
import { Actions, Client, Sessions, Settings, SettingsGroups, SettingsSections, Slots } from "../ui/contracts.ts";
import type { ClientService, SessionsService, SettingsService } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { ArchiveIcon } from "../ui/parts.tsx";
import styles from "./archived-page.css?inline";

const SECTION = "archived";

function ArchivedRow(props: { client: ClientService; sessions: SessionsService; settings: SettingsService; session: SessionInfo }) {
  const open = () => {
    props.settings.open(undefined);
    void props.sessions.select(props.session.id);
  };
  return (
    <div class="setting-row archived-row">
      <div class="setting-text">
        <button class="setting-title archived-title" data-tip="Open" onClick={open}>
          {sessionTitle(props.session)}
        </button>
        <div class="setting-desc" data-tip={props.session.cwd}>
          {tildePath(props.session.cwd, props.client.info()?.home)} · {relativeTime(props.session.updatedAt, Date.now())}
        </div>
      </div>
      <div class="setting-control">
        <button class="button small" onClick={() => void props.sessions.mark(props.session.id, { archived: false })}>
          Unarchive
        </button>
        <button class="button small archived-delete" onClick={() => void props.sessions.remove(props.session.id)}>
          Delete
        </button>
      </div>
    </div>
  );
}

/** Archived sessions, as a settings section: open, unarchive, or delete each. */
export default defineUiPlugin({
  id: "archived-page",
  styles,
  requires: { client: Client, sessions: Sessions, settings: Settings, slots: Slots },
  setup: ({ client, sessions, settings, slots }, plugin) => {
    const archived = () =>
      sessions
        .list()
        .filter((session) => session.archived === true)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    plugin.onCleanup(
      slots.add(SettingsSections, {
        id: SECTION,
        order: 45,
        title: "Archived",
        icon: ArchiveIcon,
        empty: () => <p class="settings-empty">No archived sessions. Archive one from its menu in the sidebar.</p>,
      }),
    );
    plugin.onCleanup(
      slots.add(SettingsGroups, {
        id: SECTION,
        section: SECTION,
        entries: () =>
          archived().map((session) => ({
            text: `archived ${sessionTitle(session)} ${session.cwd}`,
            view: () => <ArchivedRow client={client} sessions={sessions} settings={settings} session={session} />,
          })),
      }),
    );
    plugin.onCleanup(
      slots.add(Actions, {
        id: "archived-page.open",
        order: 10,
        title: "Archived sessions",
        category: "Sessions",
        keywords: ["archive", "hidden", "restore"],
        icon: ArchiveIcon,
        run: () => settings.open(SECTION),
      }),
    );
  },
});
