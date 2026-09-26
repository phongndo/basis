import { For } from "solid-js";
import { dismissToast, state } from "../store.ts";

export function Toasts() {
  return (
    <div class="toasts" aria-live="polite">
      <For each={state.toasts}>
        {(toast) => (
          <div class={`toast toast-${toast.level}`} role={toast.level === "error" ? "alert" : "status"}>
            <span>{toast.message}</span>
            <button class="ghost" onClick={() => dismissToast(toast.id)} aria-label="Dismiss notice">×</button>
          </div>
        )}
      </For>
    </div>
  );
}
