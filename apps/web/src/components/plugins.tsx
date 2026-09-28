import { For, Show, createSignal } from "solid-js";
import { openDialog, reloadConfig, restartPlugin, state } from "../store.ts";
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
        <span class="muted small">{state.info?.composition.id ? `composition ${state.info.composition.id.slice(0, 10)}` : ""}</span>
        <span class="spacer" />
        <button class="button" disabled={busy() !== undefined} onClick={() => void run("reload", reloadConfig)} data-tip="Re-read config files and apply them">
          <Show when={busy() === "reload"} fallback={<RefreshIcon />}><Spinner /></Show> Reload config
        </button>
      </>}
    >
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
                <Show when={plugin.state === "failed" || plugin.state === "closed"}>
                  <button class="button small" disabled={busy() !== undefined} onClick={() => void run(plugin.id, () => restartPlugin(plugin.id))}>
                    <Show when={busy() === plugin.id} fallback="Restart"><Spinner /></Show>
                  </button>
                </Show>
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
