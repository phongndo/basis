import { Show, createSignal } from "solid-js";
import { state } from "../store.ts";
import { AlertIcon, CheckIcon, CopyIcon } from "./icons.tsx";
import { copyText } from "./markdown.tsx";

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

/** Sits above the composer while the host is unreachable, since nothing can be sent until it's back. */
export function ConnectionNotice() {
  const status = () => state.status;
  const unreachable = () => status().state === "connecting" && status().attempts >= 2;
  const [copied, setCopied] = createSignal(false);
  const copy = (error: string) =>
    void copyText(`Can't reach the host: ${error}`).then((ok) => {
      setCopied(ok);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <Show when={status().state === "reconnecting" || unreachable()}>
      <div class="callout callout-warn composer-callout" role={unreachable() ? "alert" : "status"}>
        <AlertIcon />
        <div class="callout-text">
          <span>{unreachable() ? "Can't reach the host." : "Connection to the host lost."}</span>
          <Show when={unreachable()}>
            <span class="muted">
              Is it running? Open the link it printed — the page needs its <code>?token=</code>.
            </span>
          </Show>
          <Show when={status().error}>{(error) => <code class="callout-detail">{error()}</code>}</Show>
        </div>
        <ConnectionBadge />
        <Show when={status().error}>
          {(error) => (
            <button class="icon-button" aria-label="Copy error" data-tip={copied() ? "Copied" : "Copy error"} onClick={() => copy(error())}>
              {copied() ? <CheckIcon /> : <CopyIcon />}
            </button>
          )}
        </Show>
      </div>
    </Show>
  );
}

export const stopConnectionClock = (): void => clearInterval(timer);
