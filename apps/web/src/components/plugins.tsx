import { For, Show, createSignal } from "solid-js";
import type { PluginStatus } from "@lemma/contracts";
import { state } from "../store.ts";
import { tildePath } from "../model/format.ts";
import { capabilityName, dependentsOf, describeState, recoverable, replaces, requiredBy, waitingOn } from "../model/plugins.ts";
import { ChevronIcon, Spinner } from "./icons.tsx";
import { Toggle } from "./toggle.tsx";

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
          <dt>Config</dt>
          <dd data-tip="Switches here write the user file; a plugin the project file sets is written there instead">
            config.jsonc in Home · .lemma/config.jsonc in Project
          </dd>
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

const sourceLabel = (plugin: PluginStatus): string | undefined => (plugin.source === "user" ? "yours" : plugin.source === "project" ? "project" : undefined);

const describeSource = (plugin: PluginStatus, home: string | undefined): string => {
  switch (plugin.source) {
    case "bundled":
      return "Bundled with Lemma";
    case "user":
      return `${tildePath(`${home ?? "~/.lemma"}/plugins`, home)}${plugin.shadows ? ", in place of the bundled plugin with this id" : ""}`;
    case "project":
      return `.lemma/plugins in this project${plugin.shadows ? ", in place of the bundled plugin with this id" : ""}`;
  }
};

interface Confirmation {
  readonly id: string;
  readonly enabled: boolean;
  /** What else the change touches: the dependents that stop, or the provider that is replaced. */
  readonly others: readonly string[];
}

// The list rebuilds its rows whenever the plugin list refreshes, so what is open or awaiting an answer lives here, by plugin id.
const [openIds, setOpenIds] = createSignal<ReadonlySet<string>>(new Set());
const [confirming, setConfirming] = createSignal<Confirmation | undefined>();

/**
 * One plugin: its state, a switch, and details on demand. Turning off a plugin
 * others need, or turning on one that replaces another, asks first and names
 * them. `busy` is the action running anywhere in the list, which locks the others.
 */
export function PluginRow(props: {
  plugin: PluginStatus;
  busy: string | undefined;
  onRestart: (force: boolean) => void;
  onToggle: (enabled: boolean) => void;
}) {
  const plugin = () => props.plugin;
  const open = () => openIds().has(plugin().id);
  const setOpen = (value: boolean) =>
    setOpenIds((ids) => {
      const next = new Set(ids);
      if (value) next.add(plugin().id);
      else next.delete(plugin().id);
      return next;
    });
  const confirm = () => {
    const pending = confirming();
    return pending?.id === plugin().id ? pending : undefined;
  };
  const busyHere = () => props.busy === plugin().id;
  const locked = () => plugin().locked !== undefined;
  const providerOf = (key: string) => state.plugins.find((other) => other.provides.includes(key));
  const replaced = () => replaces(state.plugins, plugin().id);
  const toggle = (enabled: boolean) => {
    const others = enabled ? replaced() : dependentsOf(state.plugins, plugin().id);
    if (others.length) {
      setConfirming({ id: plugin().id, enabled, others });
      return;
    }
    // Only this row's pending question is answered by acting on it; another row's stays until answered.
    setConfirming((pending) => (pending?.id === plugin().id ? undefined : pending));
    props.onToggle(enabled);
  };
  const switchTip = () => plugin().locked ?? (plugin().enabled ? `Turn ${plugin().id} off` : `Turn ${plugin().id} on`);
  return (
    <div class="plugin" classList={{ off: !plugin().enabled, open: open() }}>
      <div class="plugin-row">
        <button class="plugin-main" aria-expanded={open()} onClick={() => setOpen(!open())}>
          <ChevronIcon class="chevron" />
          <span class={`state-dot state-${plugin().state}`} />
          <span class="plugin-id">{plugin().id}</span>
          <Show when={plugin().version}>
            <span class="muted small">{plugin().version}</span>
          </Show>
          <Show when={sourceLabel(plugin())}>{(label) => <span class="tag">{label()}</span>}</Show>
        </button>
        <span class="spacer" />
        <span class={`status-pill state-${plugin().state}`}>{describeState(plugin())}</span>
        <Show when={recoverable(plugin())}>
          <button
            class="button small"
            disabled={props.busy !== undefined}
            onClick={() => props.onRestart(false)}
            data-tip="Start it again, with the plugins it halted"
          >
            <Show when={busyHere()} fallback="Restart">
              <Spinner />
            </Show>
          </button>
        </Show>
        <span class="plugin-switch" data-tip={switchTip()}>
          <Show when={busyHere() && !recoverable(plugin())}>
            <Spinner />
          </Show>
          <Toggle label={`${plugin().id} on`} checked={plugin().enabled} disabled={locked() || props.busy !== undefined} onChange={toggle} />
        </span>
      </div>
      <Show when={confirm()}>
        {(pending) => (
          <div class="plugin-confirm" role="alertdialog" aria-label={`Turn ${plugin().id} ${pending().enabled ? "on" : "off"}?`}>
            <span>
              <Show
                when={pending().enabled}
                fallback={
                  <>
                    Turning off <b>{plugin().id}</b> also stops {pending().others.join(", ")}. They start again when it does.
                  </>
                }
              >
                Turning on <b>{plugin().id}</b> turns off {pending().others.join(", ")}, which provides the same thing; plugins using it restart.
              </Show>
            </span>
            <span class="spacer" />
            <button class="button small" onClick={() => setConfirming(undefined)}>
              Cancel
            </button>
            <button
              class="button small"
              onClick={() => {
                // Read before clearing: the accessor is gone once the confirm closes.
                const enabled = pending().enabled;
                setConfirming(undefined);
                props.onToggle(enabled);
              }}
            >
              {pending().enabled ? "Turn on" : "Turn off"}
            </button>
          </div>
        )}
      </Show>
      <Show when={plugin().fault}>
        {(fault) => (
          <pre class="plugin-fault">
            {fault().phase}
            {fault().operation ? ` · ${fault().operation}` : ""}: {fault().message}
          </pre>
        )}
      </Show>
      <Show when={open()}>
        <dl class="plugin-details">
          <dt>Provides</dt>
          <dd>
            <Show when={plugin().provides.length > 0} fallback={<span class="muted">Nothing; it contributes through hooks</span>}>
              {plugin().provides.map(capabilityName).join(", ")}
            </Show>
          </dd>
          <dt>Requires</dt>
          <dd>
            <Show when={plugin().requires.length > 0} fallback={<span class="muted">Nothing</span>}>
              <For each={plugin().requires}>
                {(key, index) => (
                  <>
                    {index() > 0 ? ", " : ""}
                    {capabilityName(key)}
                    <span class="muted"> from {providerOf(key)?.id ?? "no plugin"}</span>
                  </>
                )}
              </For>
            </Show>
          </dd>
          <dt>Needed by</dt>
          <dd>
            <Show when={requiredBy(state.plugins, plugin().id).length > 0} fallback={<span class="muted">Nothing</span>}>
              {requiredBy(state.plugins, plugin().id).join(", ")}
            </Show>
          </dd>
          <dt>Source</dt>
          <dd>{describeSource(plugin(), state.info?.home)}</dd>
          <Show when={plugin().scope}>
            {(scope) => (
              <>
                <dt>Set in</dt>
                <dd>The {scope()} config file</dd>
              </>
            )}
          </Show>
          <Show when={plugin().locked}>
            {(reason) => (
              <>
                <dt>Locked</dt>
                <dd>{reason()}</dd>
              </>
            )}
          </Show>
          <Show when={!plugin().enabled && replaced().length > 0}>
            <dt>Replaces</dt>
            <dd>{replaced().join(", ")} when turned on: they provide the same thing</dd>
          </Show>
          <Show when={!plugin().enabled && waitingOn(state.plugins, plugin().id).length > 0}>
            <dt>Waiting</dt>
            <dd>{waitingOn(state.plugins, plugin().id).join(", ")} start when it does</dd>
          </Show>
          <Show when={plugin().state === "active" && !locked()}>
            <dt>Actions</dt>
            <dd class="plugin-actions">
              <button class="button small" disabled={props.busy !== undefined} onClick={() => props.onRestart(true)}>
                <Show when={busyHere()} fallback="Restart">
                  <Spinner />
                </Show>
              </button>
              <span class="muted small">Stops it and the plugins that need it, then starts them again.</span>
            </dd>
          </Show>
        </dl>
      </Show>
    </div>
  );
}
