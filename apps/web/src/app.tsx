import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { AddProjectDialog } from "./components/add-project.tsx";
import { ConnectionBanner } from "./components/connection.tsx";
import { focusPrompt } from "./components/composer.tsx";
import { InteractionModal } from "./components/interaction.tsx";
import { EventsDialog } from "./components/events.tsx";
import { Palette } from "./components/palette.tsx";
import { SessionView } from "./components/session-view.tsx";
import { SettingsView, focusSettingsSearch } from "./components/settings.tsx";
import { Sidebar } from "./components/sidebar.tsx";
import { Toasts } from "./components/toasts.tsx";
import { TooltipLayer } from "./components/tooltip.tsx";
import { modKey } from "./lib/keys.ts";
import { load, save } from "./lib/storage.ts";
import { cancel, isBusy, newChat, openDialog, openSettings, state } from "./store.ts";

const WIDTH_KEY = "lemma.sidebar.width";
const COLLAPSED_KEY = "lemma.sidebar.collapsed";
const DEFAULT_WIDTH = 264;
const MIN_WIDTH = 208;
const MAX_WIDTH = 400;
/** The conversation keeps at least this much room. */
const MIN_MAIN = 560;
const NARROW = "(max-width: 820px)";

const clampWidth = (width: number) => Math.round(Math.max(MIN_WIDTH, Math.min(width, MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - MIN_MAIN))));

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function App() {
  const [drawer, setDrawer] = createSignal(false);
  // The chosen width survives a narrower window; only the displayed width is clamped.
  const [chosen, setChosen] = createSignal(Number(load(WIDTH_KEY)) || DEFAULT_WIDTH);
  const [viewport, setViewport] = createSignal(window.innerWidth);
  const width = () => {
    viewport();
    return clampWidth(chosen());
  };
  const [collapsed, setCollapsed] = createSignal(load(COLLAPSED_KEY) === "1");
  const [resizing, setResizing] = createSignal(false);
  const setCollapsedSaved = (value: boolean) => {
    setCollapsed(value);
    save(COLLAPSED_KEY, value ? "1" : undefined);
  };
  /** On narrow screens the sidebar is a drawer; otherwise it collapses in place. */
  const toggleSidebar = () => (window.matchMedia(NARROW).matches ? setDrawer(!drawer()) : setCollapsedSaved(!collapsed()));

  const startResize = (event: PointerEvent) => {
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = width();
    setResizing(true);
    const move = (next: PointerEvent) => setChosen(clampWidth(startWidth + next.clientX - startX));
    const end = () => {
      setResizing(false);
      save(WIDTH_KEY, String(chosen()));
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const resetWidth = () => {
    setChosen(DEFAULT_WIDTH);
    save(WIDTH_KEY, undefined);
  };
  const onResize = () => setViewport(window.innerWidth);

  const startChat = () => {
    newChat();
    setDrawer(false);
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const mod = modKey(event) && !event.altKey;
    const palette = state.dialog === "palette";
    const modal = state.dialog !== undefined || state.interactions.length > 0;
    const settings = state.settings !== undefined;
    if (mod && !event.shiftKey && event.key.toLowerCase() === "k" && (palette || state.interactions.length === 0)) {
      // Opens over any other dialog; a question the host asks keeps the screen until answered.
      event.preventDefault();
      openDialog(palette ? undefined : "palette");
    } else if (mod && !event.shiftKey && event.key === "," && !modal) {
      event.preventDefault();
      openSettings(settings ? undefined : "general");
    } else if (event.key === "Escape" && settings && !modal) {
      event.preventDefault();
      openSettings(undefined);
    } else if (mod && !event.shiftKey && event.key.toLowerCase() === "b" && !modal && !settings) {
      event.preventDefault();
      toggleSidebar();
    } else if (mod && event.shiftKey && event.key.toLowerCase() === "o") {
      event.preventDefault();
      startChat();
    } else if (event.key === "/" && !mod && !typing(event.target) && !modal) {
      event.preventDefault();
      if (settings) focusSettingsSearch();
      else focusPrompt();
    } else if (event.key === "Escape" && !modal && isBusy() && !typing(event.target)) {
      event.preventDefault();
      cancel();
    } else if (event.key === "Escape" && drawer()) setDrawer(false);
  };
  onMount(() => {
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
  });
  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onResize);
  });

  return (
    <div class="app" classList={{ "drawer-open": drawer(), "sidebar-collapsed": collapsed(), resizing: resizing() }} style={{ "--sidebar": `${width()}px` }}>
      <Sidebar onPick={() => setDrawer(false)} />
      <div
        class="sidebar-rail"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        data-tip="Drag to resize · double-click to reset"
        onPointerDown={startResize}
        onDblClick={resetWidth}
      />
      <Show when={drawer()}>
        <div class="scrim" onClick={() => setDrawer(false)} />
      </Show>
      <div class="main-col">
        <ConnectionBanner />
        <SessionView onToggleSidebar={toggleSidebar} />
      </div>
      <Show when={state.dialog === "palette"}>
        <Palette onToggleSidebar={toggleSidebar} onNewChat={startChat} />
      </Show>
      <Show when={state.settings !== undefined}>
        <SettingsView />
      </Show>
      <Show when={state.dialog === "events"}>
        <EventsDialog />
      </Show>
      <Show when={state.dialog === "add-project"}>
        <AddProjectDialog />
      </Show>
      <InteractionModal />
      <Toasts />
      <TooltipLayer />
    </div>
  );
}
