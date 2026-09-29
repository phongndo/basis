import { For } from "solid-js";
import type { JSX } from "solid-js";

/** A setting's name and explanation, with its control on the right. */
export function SettingRow(props: { title: string; description?: string | undefined; children: JSX.Element }) {
  return (
    <div class="setting-row">
      <div class="setting-text">
        <div class="setting-title">{props.title}</div>
        {props.description === undefined ? null : <div class="setting-desc">{props.description}</div>}
      </div>
      <div class="setting-control">{props.children}</div>
    </div>
  );
}

/** A choice of a few options shown side by side. */
export function Segmented<T extends string>(props: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div class="segmented" role="radiogroup" aria-label={props.label}>
      <For each={props.options}>
        {(option) => (
          <button role="radio" aria-checked={props.value === option.value} onClick={() => props.onChange(option.value)}>
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
}
