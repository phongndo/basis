import { Show } from "solid-js";
import type { PluginStatus } from "@lemma/contracts";
import { state } from "../store.ts";
import { tildePath } from "../model/format.ts";
import { Spinner } from "./icons.tsx";

export function HostFacts() {
  return (
    <Show when={state.info}>
      {(info) => (
        <dl class="host-facts">
          <dt>Host</dt>
          <dd>
            {location.host} · transport {info().version}
          </dd>
          <dt>Home</dt>
          <dd>{info().home}</dd>
          <dt>Project</dt>
          <dd>{tildePath(info().cwd, info().home)}</dd>
          <dt>Composition</dt>
          <dd class="mono" data-tip={info().composition.id}>
            {info().composition.id.slice(0, 16)}
          </dd>
          <dt>Running</dt>
          <dd>{state.running.length === 0 ? "no turns" : `${state.running.length} turn${state.running.length === 1 ? "" : "s"}`}</dd>
        </dl>
      )}
    </Show>
  );
}

/** What a search over plugins matches. */
export const pluginText = (plugin: PluginStatus): string =>
  [plugin.id, plugin.version, plugin.state, plugin.fault?.message, plugin.haltedBy].filter(Boolean).join(" ");

/** One plugin's state and fault; `busy` is the action running anywhere in the list, which locks the others. */
export function PluginRow(props: { plugin: PluginStatus; busy: string | undefined; onRestart: () => void }) {
  return (
    <div class="plugin">
      <div class="plugin-row">
        <span class={`state-dot state-${props.plugin.state}`} data-tip={props.plugin.state} />
        <span class="plugin-id">{props.plugin.id}</span>
        <Show when={props.plugin.version}>
          <span class="muted small">{props.plugin.version}</span>
        </Show>
        <span class="spacer" />
        <span class={`status-pill state-${props.plugin.state}`}>{props.plugin.state}</span>
        <button
          class="button small"
          classList={{ "plugin-restart": props.plugin.state !== "failed" && props.plugin.state !== "closed" }}
          disabled={props.busy !== undefined}
          onClick={() => props.onRestart()}
          data-tip="Restart this plugin and the plugins that depend on it"
        >
          <Show when={props.busy === props.plugin.id} fallback="Restart">
            <Spinner />
          </Show>
        </button>
      </div>
      <Show when={props.plugin.fault}>
        {(fault) => (
          <pre class="plugin-fault">
            {fault().phase}
            {fault().operation ? ` · ${fault().operation}` : ""}: {fault().message}
          </pre>
        )}
      </Show>
      <Show when={props.plugin.haltedBy}>
        <p class="muted small">Halted by {props.plugin.haltedBy}</p>
      </Show>
    </div>
  );
}
