import { Show, createSignal } from "solid-js";
import { DEFAULT_HOST, describeError, readSettings } from "../host.ts";
import { connectHost, state } from "../store.ts";

export function Connect(props: { error: string | undefined; onError: (message: string | undefined) => void }) {
  const saved = readSettings();
  const [url, setUrl] = createSignal(saved?.url ?? DEFAULT_HOST);
  const [token, setToken] = createSignal(saved?.token ?? "");

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    props.onError(undefined);
    connectHost({ url: url().trim() || DEFAULT_HOST, token: token().trim() }).catch((cause) => props.onError(describeError(cause)));
  };

  return (
    <main class="connect">
      <form onSubmit={submit}>
        <h1>basis</h1>
        <p class="muted">Connect to a running host. The URL and token are in <code>~/.basis/host.json</code>, or pass <code>?host=&amp;token=</code>.</p>
        <label>
          Host URL
          <input type="url" value={url()} onInput={(event) => setUrl(event.currentTarget.value)} placeholder={DEFAULT_HOST} required />
        </label>
        <label>
          Token
          <input type="password" value={token()} onInput={(event) => setToken(event.currentTarget.value)} autocomplete="off" required />
        </label>
        <Show when={props.error}>{(message) => <p class="error" role="alert">{message()}</p>}</Show>
        <button type="submit" disabled={state.status === "connecting"}>{state.status === "connecting" ? "Connecting…" : "Connect"}</button>
      </form>
    </main>
  );
}
