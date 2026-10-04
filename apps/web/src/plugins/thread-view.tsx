import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { tildePath } from "../model/format.ts";
import { sessionTitle } from "../model/threads.ts";
import { Actions, Client, ComposerRegion, Layout, MainRegion, Notify, ThreadHeader, Threads, Slots, Views, Workspace } from "../ui/contracts.ts";
import type { Action } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import type { SlotItem } from "../ui/slots.ts";
import { CopyIcon, PenSquareIcon, SidebarIcon, Spinner, StopIcon } from "../ui/parts.tsx";
import { copyText } from "../lib/clipboard.ts";
import styles from "./thread-view.css?inline";

/**
 * The main area for one session: a header, the chosen view (chat,
 * trajectory, or any other plugin's), and the composer under views that want
 * it. Views are siblings over the same session log; the choice carries over
 * when switching threads, and a new chat opens in the first.
 */
export default defineUiPlugin({
  id: "thread-view",
  styles,
  requires: { client: Client, threads: Threads, workspace: Workspace, slots: Slots, layout: Layout, notify: Notify },
  setup: ({ client, threads, workspace, slots, layout, notify }, plugin) => {
    const [chosen, setChosen] = createSignal<string>();
    const views = () => slots.list(Views);
    /** The chosen view while it exists; a new chat always shows the first. */
    const view = createMemo(() => {
      const all = views();
      return (threads.activeId() === undefined ? undefined : all.find((candidate) => candidate.id === chosen())) ?? all[0];
    });
    plugin.onCleanup(
      threads.onSelect((sessionId) => {
        if (sessionId === undefined) setChosen(undefined);
      }),
    );

    const add = (...actions: SlotItem<Action>[]) => {
      for (const action of actions) plugin.onCleanup(slots.add(Actions, action));
    };
    add(
      {
        id: "thread.new-chat",
        order: 1,
        title: "New thread",
        category: "Thread",
        icon: PenSquareIcon,
        keys: "mod+shift+o",
        global: true,
        run: () => {
          threads.newThread();
          layout.closeDrawer();
        },
      },
      {
        id: "thread.cancel",
        order: 11,
        title: "Stop the running turn",
        category: "Thread",
        keywords: ["cancel"],
        icon: StopIcon,
        keys: "escape",
        when: threads.busy,
        run: threads.cancel,
      },
      {
        id: "thread.rename",
        order: 13,
        title: "Rename thread…",
        category: "Thread",
        keywords: ["title", "session"],
        keys: "mod+alt+r",
        icon: PenSquareIcon,
        when: () => threads.active() !== undefined,
        input: () => ({ title: `Rename “${sessionTitle(threads.active())}”`, placeholder: sessionTitle(threads.active()) }),
        run: (value) => {
          const session = threads.active();
          if (session !== undefined && value !== undefined) void threads.rename(session.id, value);
        },
      },
      {
        id: "thread.copy-id",
        order: 14,
        title: "Copy thread ID",
        category: "Thread",
        keywords: ["cli", "lemma"],
        icon: CopyIcon,
        when: () => threads.active() !== undefined,
        run: () => {
          const id = threads.activeId();
          if (id === undefined) return;
          void copyText(id).then((ok) =>
            ok ? notify.toast({ level: "info", message: `Copied ${id}` }) : notify.toast({ level: "error", message: "Could not copy to the clipboard" }),
          );
        },
      },
    );
    // One action per view, as views come and go.
    createEffect(() => {
      for (const item of views()) {
        onCleanup(
          slots.add(Actions, {
            id: `thread.view.${item.id}`,
            order: 12,
            title: `Show ${item.title.toLowerCase()}`,
            category: "View",
            icon: item.icon,
            when: () => threads.active() !== undefined && view()?.id !== item.id,
            run: () => setChosen(item.id),
          }),
        );
      }
    });

    // Its header's items go through the slot other plugins add theirs to.
    const header = (id: string, order: number, side: "start" | "end", component: () => JSX.Element) =>
      plugin.onCleanup(slots.add(ThreadHeader, { id, order, side, component }));
    header("thread.sidebar-toggle", 0, "start", () => (
      <button class="icon-button sidebar-toggle" aria-label="Toggle sidebar" data-tip="Toggle sidebar" onClick={() => layout.toggleSidebar()}>
        <SidebarIcon />
      </button>
    ));
    header("thread.title", 10, "start", () => {
      const cwd = () => workspace.workingDir();
      // The project by its folder's name, the full path on hover: `lemma / Fix the build`.
      return (
        <div class="main-title">
          <Show when={!workspace.isStandalone(cwd()) && cwd()}>
            {(dir) => {
              const path = () => tildePath(dir(), client.info()?.home);
              return (
                <>
                  <span class="main-project" data-tip={path()}>
                    {workspace.projectName(dir())}
                  </span>
                  <span class="main-sep" aria-hidden="true">
                    /
                  </span>
                </>
              );
            }}
          </Show>
          <h1>{threads.activeId() === undefined ? "New thread" : sessionTitle(threads.active())}</h1>
        </div>
      );
    });
    header("thread.running", 0, "end", () => (
      <Show when={threads.busy()}>
        <span class="busy-chip">
          <Spinner /> Running
        </span>
      </Show>
    ));
    header("thread.views", 10, "end", () => (
      <Show when={threads.activeId() !== undefined && views().length > 1}>
        <div class="view-tabs" role="tablist" aria-label="Thread view">
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
    ));

    function Main() {
      return (
        <main class="main">
          <header class="main-head">
            <For each={slots.list(ThreadHeader).filter((item) => item.side === "start")}>{(item) => <Dynamic component={item.component} />}</For>
            <span class="spacer" />
            <For each={slots.list(ThreadHeader).filter((item) => item.side === "end")}>{(item) => <Dynamic component={item.component} />}</For>
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
    plugin.onCleanup(slots.add(MainRegion, { id: "thread-view", component: Main }));
  },
});
