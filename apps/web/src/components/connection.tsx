import { Show, createSignal } from "solid-js";
import { state } from "../store.ts";

const [now, setNow] = createSignal(Date.now());
const timer = setInterval(() => setNow(Date.now()), 1_000);

export function ConnectionBadge() {
  const label = () => {
    const status = state.status;
    switch (status.state) {
      case "connected":
        return "Connected";
      case "closed":
        return "Disconnected";
      case "connecting":
      case "reconnecting": {
        const verb = status.state === "connecting" ? "Connecting" : "Reconnecting";
        const wait = status.retryAt === undefined ? 0 : Math.ceil((status.retryAt - now()) / 1_000);
        return wait > 1 ? `${verb} in ${wait}s` : `${verb}…`;
      }
    }
  };
  return (
    <span class={`connection connection-${state.status.state}`} role="status" data-tip={state.status.error}>
      <span class="connection-dot" aria-hidden="true" />
      {label()}
    </span>
  );
}

/** Shown over the app until the first connection succeeds, and as a strip while reconnecting. */
export function ConnectionBanner() {
  const status = () => state.status;
  return (
    <>
      <Show when={status().state === "reconnecting"}>
        <div class="banner" role="status">
          Connection to the host lost. <ConnectionBadge />
        </div>
      </Show>
      <Show when={status().state === "connecting" && status().attempts >= 2}>
        <div class="banner banner-strong" role="alert">
          <span>Can't reach the host{status().error ? ` (${status().error})` : ""}.</span>
          <span class="muted">
            Is it running? Open the link it printed — the page needs its <code>?token=</code>.
          </span>
          <ConnectionBadge />
        </div>
      </Show>
    </>
  );
}

export const stopConnectionClock = (): void => clearInterval(timer);
