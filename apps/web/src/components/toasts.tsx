import { For, Show, createSignal } from "solid-js";
import { dismissToast, state } from "../store.ts";
import type { Toast } from "../store.ts";
import { AlertIcon, CopyIcon, ExternalIcon, XIcon } from "./icons.tsx";
import { copyText } from "./markdown.tsx";

function CodeBox(props: { code: string }) {
  const [copied, setCopied] = createSignal(false);
  return (
    <div class="device-code">
      <code>{props.code}</code>
      <button
        class="button small"
        onClick={() => void copyText(props.code).then((ok) => { setCopied(ok); setTimeout(() => setCopied(false), 1500); })}
      >
        <CopyIcon /> {copied() ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function ToastView(props: { toast: Toast }) {
  return (
    <div class={`toast toast-${props.toast.level}`} role={props.toast.level === "error" ? "alert" : "status"}>
      <div class="toast-main">
        <Show when={props.toast.level !== "info"}><AlertIcon /></Show>
        <div class="toast-text">
          <span>{props.toast.message}</span>
          <Show when={props.toast.source && props.toast.source !== "client"}><span class="toast-source">{props.toast.source}</span></Show>
        </div>
        <button class="icon-button" aria-label="Dismiss" onClick={() => dismissToast(props.toast.id)}><XIcon /></button>
      </div>
      <Show when={props.toast.code}>{(code) => <CodeBox code={code()} />}</Show>
      <Show when={props.toast.links?.length}>
        <div class="toast-links">
          <For each={props.toast.links}>
            {(link) => (
              <a class="button small" href={link.url} target="_blank" rel="noopener noreferrer">
                {link.label ?? new URL(link.url, location.href).host} <ExternalIcon />
              </a>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export function Toasts() {
  return (
    <div class="toasts" aria-live="polite">
      <For each={state.toasts}>{(toast) => <ToastView toast={toast} />}</For>
    </div>
  );
}
