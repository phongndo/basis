import { For, Show, createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import type { InteractionRequest } from "@basis/contracts";
import { answer, dismiss, state } from "../store.ts";

/** One request per instance (the parent keys on it), so the body is a plain switch. */
function Dialog(props: { request: InteractionRequest }) {
  const request = props.request;
  const [value, setValue] = createSignal("");
  let first: HTMLElement | undefined;
  onMount(() => first?.focus());

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (request.type === "ask" || request.type === "open-url") answer(request.id, { type: request.type, value: value() });
  };

  const body = (): JSX.Element => {
    switch (request.type) {
      case "confirm": return (
        <>
          <Show when={request.detail}>{(detail) => <p class="detail">{detail()}</p>}</Show>
          <div class="actions">
            <button ref={(element) => { first = element; }} onClick={() => answer(request.id, { type: "confirm", value: true })}>Yes</button>
            <button onClick={() => answer(request.id, { type: "confirm", value: false })}>No</button>
          </div>
        </>
      );
      case "ask": return (
        <form onSubmit={submit}>
          <input
            ref={(element) => { first = element; }}
            type={request.secret ? "password" : "text"}
            placeholder={request.placeholder ?? ""}
            aria-label={request.title}
            autocomplete="off"
            onInput={(event) => setValue(event.currentTarget.value)}
          />
          <div class="actions"><button type="submit">Submit</button></div>
        </form>
      );
      case "select": return (
        <ul class="options">
          <For each={request.options}>
            {(option, index) => (
              <li>
                <button
                  ref={(element) => { if (index() === 0) first = element; }}
                  class="option"
                  onClick={() => answer(request.id, { type: "select", value: option.value })}
                >
                  <span>{option.label}</span>
                  <Show when={option.description}>{(text) => <span class="muted">{text()}</span>}</Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      );
      case "open-url": return (
        <form onSubmit={submit}>
          <p class="detail"><a ref={(element) => { first = element; }} href={request.url} target="_blank" rel="noopener noreferrer">{request.url}</a></p>
          <Show when={request.expectCode}>
            <input type="text" placeholder="Paste the code" aria-label="Code" autocomplete="off" onInput={(event) => setValue(event.currentTarget.value)} />
          </Show>
          <div class="actions"><button type="submit">{request.expectCode ? "Submit code" : "Continue"}</button></div>
        </form>
      );
    }
  };

  return (
    <div class="modal-backdrop" onKeyDown={(event) => { if (event.key === "Escape") dismiss(request.id); }}>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby={`dialog-${request.id}`}>
        <h2 id={`dialog-${request.id}`}>{request.title}</h2>
        {body()}
        <div class="actions"><button class="ghost" onClick={() => dismiss(request.id)}>Dismiss</button></div>
      </div>
    </div>
  );
}

/** Dialogs queue in arrival order; the host closes each one through `interaction-closed`. */
export function InteractionDialog() {
  return <Show when={state.interactions[0]} keyed>{(request) => <Dialog request={request} />}</Show>;
}
