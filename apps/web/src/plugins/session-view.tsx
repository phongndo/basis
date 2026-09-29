import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Dynamic } from "solid-js/web";
import { tildePath } from "../model/format.ts";
import { sessionTitle } from "../model/sessions.ts";
import { CopyIcon, PenSquareIcon, SidebarIcon, Spinner, StopIcon } from "../components/icons.tsx";
import { Actions, Client, ComposerRegion, Layout, MainRegion, Notify, Sessions, Slots, Views } from "../ui/contracts.ts";
import type { Action } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import type { SlotItem } from "../ui/slots.ts";

/**
 * The main area for one session: a header, the chosen view (chat,
 * trajectory, or any other plugin's), and the composer under views that want
 * it. Views are siblings over the same session log; the choice carries over
 * when switching sessions, and a new chat opens in the first.
 */
export default defineUiPlugin({
  id: "session-view",
  requires: { client: Client, sessions: Sessions, slots: Slots, layout: Layout, notify: Notify },
  setup: ({ client, sessions, slots, layout, notify }, plugin) => {
    const [chosen, setChosen] = createSignal<string>();
    const views = () => slots.list(Views);
    /** The chosen view while it exists; a new chat always shows the first. */
    const view = createMemo(() => {
      const all = views();
      return (sessions.activeId() === undefined ? undefined : all.find((candidate) => candidate.id === chosen())) ?? all[0];
    });
    plugin.onCleanup(
      sessions.onSelect((sessionId) => {
        if (sessionId === undefined) setChosen(undefined);
      }),
    );

    const add = (...actions: SlotItem<Action>[]) => {
      for (const action of actions) plugin.onCleanup(slots.add(Actions, action));
    };
    add(
      {
        id: "session.new-chat",
        order: 1,
        title: "New chat",
        category: "Chat",
        icon: PenSquareIcon,
        keys: "mod+shift+o",
        global: true,
        run: () => {
          sessions.newChat();
          layout.closeDrawer();
        },
      },
      {
        id: "session.cancel",
        order: 11,
        title: "Stop the running turn",
        category: "Chat",
        keywords: ["cancel"],
        icon: StopIcon,
        keys: "escape",
        when: sessions.busy,
        run: sessions.cancel,
      },
      {
        id: "session.rename",
        order: 13,
        title: "Rename session…",
        category: "Chat",
        keywords: ["title"],
        icon: PenSquareIcon,
        when: () => sessions.active() !== undefined,
        input: () => ({ title: `Rename “${sessionTitle(sessions.active())}”`, placeholder: sessionTitle(sessions.active()) }),
        run: (value) => {
          const session = sessions.active();
          if (session !== undefined && value !== undefined) void sessions.rename(session.id, value);
        },
      },
      {
        id: "session.copy-id",
        order: 14,
        title: "Copy session ID",
        category: "Chat",
        keywords: ["cli", "lemma"],
        icon: CopyIcon,
        when: () => sessions.active() !== undefined,
        run: () => {
          const id = sessions.activeId();
          if (id === undefined) return;
          void navigator.clipboard.writeText(id).then(
            () => notify.toast({ level: "info", message: `Copied ${id}` }),
            () => notify.toast({ level: "error", message: "Could not copy to the clipboard" }),
          );
        },
      },
    );
    // One action per view, as views come and go.
    createEffect(() => {
      for (const item of views()) {
        onCleanup(
          slots.add(Actions, {
            id: `session.view.${item.id}`,
            order: 12,
            title: `Show ${item.title.toLowerCase()}`,
            category: "View",
            icon: item.icon,
            when: () => sessions.active() !== undefined && view()?.id !== item.id,
            run: () => setChosen(item.id),
          }),
        );
      }
    });

    function Main() {
      const cwd = () => sessions.active()?.cwd ?? sessions.pendingCwd() ?? client.info()?.cwd;
      return (
        <main class="main">
          <header class="main-head">
            <button class="icon-button sidebar-toggle" aria-label="Toggle sidebar" data-tip="Toggle sidebar" onClick={() => layout.toggleSidebar()}>
              <SidebarIcon />
            </button>
            <div class="main-title">
              <h1>{sessions.activeId() === undefined ? "New chat" : sessionTitle(sessions.active())}</h1>
              <Show when={cwd()}>
                {(dir) => (
                  <span class="main-cwd" data-tip={dir()}>
                    {tildePath(dir(), client.info()?.home)}
                  </span>
                )}
              </Show>
            </div>
            <span class="spacer" />
            <Show when={sessions.busy()}>
              <span class="busy-chip">
                <Spinner /> Running
              </span>
            </Show>
            <Show when={sessions.activeId() !== undefined && views().length > 1}>
              <div class="view-tabs" role="tablist" aria-label="Session view">
                <For each={views()}>
                  {(item) => (
                    <button
                      role="tab"
                      class="view-tab"
                      aria-label={item.title}
                      data-tip={item.title}
                      aria-selected={view()?.id === item.id}
                      onClick={() => setChosen(item.id)}
                    >
                      <Dynamic component={item.icon} />
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </header>
          <Show when={view()} keyed fallback={<div class="scroller" />}>
            {(item) => <Dynamic component={item.component} />}
          </Show>
          <Show when={view()?.composer === true}>
            <Show when={slots.first(ComposerRegion)} keyed>
              {(composer) => <Dynamic component={composer.component} />}
            </Show>
          </Show>
        </main>
      );
    }
    plugin.onCleanup(slots.add(MainRegion, { id: "session-view", component: Main }));
  },
});
