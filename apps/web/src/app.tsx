import { Show, createSignal, onMount } from "solid-js";
import { Chat } from "./components/chat.tsx";
import { Connect } from "./components/connect.tsx";
import { InteractionDialog } from "./components/interaction.tsx";
import { Plugins } from "./components/plugins.tsx";
import { Sessions } from "./components/sessions.tsx";
import { Toasts } from "./components/toasts.tsx";
import { describeError, readSettings } from "./host.ts";
import { connectHost, disconnectHost, state } from "./store.ts";

const STATUS_LABEL = { disconnected: "Disconnected", connecting: "Connecting", connected: "Connected", reconnecting: "Reconnecting" } as const;

export function App() {
  const [error, setError] = createSignal<string>();
  const [sessionsOpen, setSessionsOpen] = createSignal(false);
  const [pluginsOpen, setPluginsOpen] = createSignal(false);

  onMount(() => {
    const settings = readSettings();
    if (settings !== undefined && settings.token) connectHost(settings).catch((cause) => setError(describeError(cause)));
  });

  return (
    <Show when={state.status === "connected" || state.status === "reconnecting"} fallback={<Connect error={error()} onError={setError} />}>
      <div class="app" classList={{ "sessions-open": sessionsOpen(), "plugins-open": pluginsOpen() }}>
        <header class="topbar">
          <button class="ghost narrow-only" aria-expanded={sessionsOpen()} aria-controls="sessions" onClick={() => setSessionsOpen((open) => !open)}>
            Sessions
          </button>
          <h1>basis</h1>
          <span class={`status status-${state.status}`} role="status">
            <span class="dot" aria-hidden="true" />
            {STATUS_LABEL[state.status]}
          </span>
          <span class="spacer" />
          <button class="ghost" aria-expanded={pluginsOpen()} aria-controls="plugins" onClick={() => setPluginsOpen((open) => !open)}>
            Plugins
          </button>
          <button class="ghost" onClick={() => { void disconnectHost(); }}>Disconnect</button>
        </header>
        <Sessions onSelect={() => setSessionsOpen(false)} />
        <Chat />
        <Plugins open={pluginsOpen()} onClose={() => setPluginsOpen(false)} />
        <Show when={sessionsOpen()}>
          <button class="scrim narrow-only" aria-label="Close sessions" onClick={() => setSessionsOpen(false)} />
        </Show>
      </div>
      <InteractionDialog />
      <Toasts />
    </Show>
  );
}
