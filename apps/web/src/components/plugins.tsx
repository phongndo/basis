import { For, Show, createEffect } from "solid-js";
import { describeError } from "../host.ts";
import { refreshPlugins, reload, restartPlugin, state, toast } from "../store.ts";

export function Plugins(props: { open: boolean; onClose: () => void }) {
  createEffect(() => { if (props.open) refreshPlugins().catch((error) => toast("error", describeError(error))); });
  return (
    <aside id="plugins" class="plugins" aria-label="Plugins" aria-hidden={!props.open} onKeyDown={(event) => { if (event.key === "Escape") props.onClose(); }}>
      <div class="plugins-head">
        <h2>Plugins</h2>
        <button onClick={reload} title="Re-read the config files and apply the composition">Reload</button>
        <button class="ghost" onClick={props.onClose} aria-label="Close plugins">Close</button>
      </div>
      <ul>
        <For each={state.plugins}>
          {(plugin) => (
            <li class={`plugin plugin-${plugin.state}`}>
              <div class="plugin-row">
                <span class="plugin-id">{plugin.id}<Show when={plugin.version}>{(version) => <span class="muted"> {version()}</span>}</Show></span>
                <span class="plugin-state">{plugin.state}</span>
                <button class="ghost" onClick={() => restartPlugin(plugin.id)} aria-label={`Restart ${plugin.id}`}>Restart</button>
              </div>
              <Show when={plugin.fault}>
                {(fault) => <p class="error">{fault().phase}{fault().operation ? ` (${fault().operation})` : ""}: {fault().message}</p>}
              </Show>
              <Show when={plugin.haltedBy}>{(by) => <p class="muted">halted by {by()}</p>}</Show>
            </li>
          )}
        </For>
      </ul>
    </aside>
  );
}
