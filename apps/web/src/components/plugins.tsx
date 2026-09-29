import { For, Show, createSignal } from "solid-js";
import { openDialog, reloadConfig, restartPlugin, state } from "../store.ts";
import { tildePath } from "../model/format.ts";
import { Dialog } from "./dialog.tsx";
import { RefreshIcon, Spinner } from "./icons.tsx";

export function PluginsDialog() {
  const [busy, setBusy] = createSignal<string | undefined>();
  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try { await action(); } finally { setBusy(undefined); }
  };
  return (
    <Dialog
      title="Plugins"
      onClose={() => openDialog(undefined)}
      class="plugins-dialog"
      footer={<>
        <button class="button" onClick={() => openDialog("events")} data-tip="Everything the host publishes, as `basis events` shows it">Event log</button>
        <span class="spacer" />
        <button class="button" disabled={busy() !== undefined} onClick={() => void run("reload", reloadConfig)} data-tip="Re-read config files and apply them">
          <Show when={busy() === "reload"} fallback={<RefreshIcon />}><Spinner /></Show> Reload config
        </button>
      </>}
    >
      <Show when={state.info}>
        {(info) => (
          <dl class="host-facts">
            <dt>Host</dt><dd>{location.host} · transport {info().version}</dd>
            <dt>Home</dt><dd>{info().home}</dd>
            <dt>Project</dt><dd>{tildePath(info().cwd, info().home)}</dd>
            <dt>Composition</dt><dd class="mono" data-tip={info().composition.id}>{info().composition.id.slice(0, 16)}</dd>
            <dt>Running</dt><dd>{state.running.length === 0 ? "no turns" : `${state.running.length} turn${state.running.length === 1 ? "" : "s"}`}</dd>
          </dl>
        )}
      </Show>
      <ul class="plugin-list">
        <For each={state.plugins}>
          {(plugin) => (
            <li class="plugin">
              <div class="plugin-row">
                <span class={`state-dot state-${plugin.state}`} data-tip={plugin.state} />
                <span class="plugin-id">{plugin.id}</span>
                <Show when={plugin.version}><span class="muted small">{plugin.version}</span></Show>
                <span class="spacer" />
                <span class={`status-pill state-${plugin.state}`}>{plugin.state}</span>
                <button class="button small" classList={{ "plugin-restart": plugin.state !== "failed" && plugin.state !== "closed" }}
                  disabled={busy() !== undefined} onClick={() => void run(plugin.id, () => restartPlugin(plugin.id))}
                  data-tip="Restart this plugin and the plugins that depend on it">
                  <Show when={busy() === plugin.id} fallback="Restart"><Spinner /></Show>
                </button>
              </div>
              <Show when={plugin.fault}>
                {(fault) => (
                  <pre class="plugin-fault">{fault().phase}{fault().operation ? ` · ${fault().operation}` : ""}: {fault().message}</pre>
                )}
              </Show>
              <Show when={plugin.haltedBy}><p class="muted small">Halted by {plugin.haltedBy}</p></Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={state.plugins.length === 0}><p class="muted">No plugins reported.</p></Show>
    </Dialog>
  );
}
