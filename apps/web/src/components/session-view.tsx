import { Match, Show, Switch, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { tildePath } from "../model/format.ts";
import { sessionTitle } from "../model/sessions.ts";
import { activeSession, isBusy, pendingChatCwd, sessionLog, state, transcript } from "../store.ts";
import { Composer } from "./composer.tsx";
import { ChevronDownIcon, SidebarIcon, Spinner } from "./icons.tsx";
import { Transcript } from "./transcript.tsx";

/**
 * The main area for one session: header, the active view, and the composer.
 * Views are siblings over the same session log; `state.view` selects one.
 * Add the Trajectory view as another `Match` (and a tab in the header).
 */
export function SessionView(props: { onToggleSidebar: () => void }) {
  const cwd = () => activeSession()?.cwd ?? pendingChatCwd() ?? state.info?.cwd;
  return (
    <main class="main">
      <header class="main-head">
        <button class="icon-button sidebar-toggle" aria-label="Toggle sidebar" data-tip="Toggle sidebar" onClick={() => props.onToggleSidebar()}><SidebarIcon /></button>
        <div class="main-title">
          <h1>{state.activeId === undefined ? "New chat" : sessionTitle(activeSession())}</h1>
          <Show when={cwd()}>{(dir) => <span class="main-cwd" data-tip={dir()}>{tildePath(dir(), state.info?.home)}</span>}</Show>
        </div>
        <span class="spacer" />
        <Show when={isBusy()}><span class="busy-chip"><Spinner /> Running</span></Show>
      </header>
      <Switch>
        <Match when={state.view === "chat"}><ChatView /></Match>
      </Switch>
      <Composer />
    </main>
  );
}

function ChatView() {
  let scroller!: HTMLDivElement;
  let content!: HTMLDivElement;
  const [stuck, setStuck] = createSignal(true);
  const toBottom = (smooth = false) => scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  const onScroll = () => setStuck(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80);

  onMount(() => {
    // Follow new output while the reader is at the bottom; leave them alone once they scroll up.
    const observer = new ResizeObserver(() => { if (stuck()) toBottom(); });
    observer.observe(content);
    onCleanup(() => observer.disconnect());
  });
  createEffect(on(() => state.activeId, () => { setStuck(true); queueMicrotask(() => toBottom()); }));

  const empty = () => transcript().turns.length === 0;
  return (
    <div class="scroller" ref={scroller} onScroll={onScroll}>
      <div class="content" ref={content}>
        <Switch>
          <Match when={state.activeId !== undefined && !sessionLog().loaded}>
            <div class="loading"><Spinner /> Loading session…</div>
          </Match>
          <Match when={empty() && !isBusy()}>
            <div class="empty-state">
              <h2>{state.activeId === undefined ? "What are we working on?" : "This session is empty"}</h2>
              <p class="muted">The agent can read, edit, and run commands in the project below.</p>
            </div>
          </Match>
        </Switch>
        <Transcript turns={transcript().turns} />
        <Show when={sessionLog().error}>
          <div class="callout callout-error">Could not load the full session: {sessionLog().error}</div>
        </Show>
      </div>
      <Show when={!stuck()}>
        <button class="jump" aria-label="Jump to latest" onClick={() => { setStuck(true); toBottom(true); }}><ChevronDownIcon /></button>
      </Show>
    </div>
  );
}
