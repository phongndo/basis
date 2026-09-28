import { For, Match, Show, Switch, createSignal } from "solid-js";
import type { InteractionRequest } from "@basis/contracts";
import { answerInteraction, dismissInteraction, state } from "../store.ts";
import { Dialog } from "./dialog.tsx";

type Of<T extends InteractionRequest["type"]> = Extract<InteractionRequest, { type: T }>;

function Ask(props: { request: Of<"ask"> }) {
  const [value, setValue] = createSignal("");
  return (
    <Dialog
      title={props.request.title}
      onClose={() => dismissInteraction(props.request.id)}
      footer={<>
        <button type="button" class="button" onClick={() => dismissInteraction(props.request.id)}>Cancel</button>
        <button type="button" class="button button-primary" disabled={value() === ""} onClick={() => answerInteraction(props.request.id, { type: "ask", value: value() })}>
          Submit
        </button>
      </>}
    >
      <input
        class="field"
        data-autofocus
        type={props.request.secret ? "password" : "text"}
        autocomplete={props.request.secret ? "off" : "on"}
        placeholder={props.request.placeholder ?? ""}
        value={value()}
        onInput={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && value() !== "") { event.preventDefault(); answerInteraction(props.request.id, { type: "ask", value: value() }); } }}
      />
      <Show when={props.request.secret}><p class="muted small">Sent to the host and stored in its credential store; never shown again.</p></Show>
    </Dialog>
  );
}

function Confirm(props: { request: Of<"confirm"> }) {
  return (
    <Dialog
      title={props.request.title}
      onClose={() => dismissInteraction(props.request.id)}
      footer={<>
        <button class="button" onClick={() => answerInteraction(props.request.id, { type: "confirm", value: false })}>No</button>
        <button class="button button-primary" data-autofocus onClick={() => answerInteraction(props.request.id, { type: "confirm", value: true })}>Yes</button>
      </>}
    >
      <Show when={props.request.detail}><p class="dialog-detail">{props.request.detail}</p></Show>
    </Dialog>
  );
}

function Select(props: { request: Of<"select"> }) {
  const pick = (value: string) => answerInteraction(props.request.id, { type: "select", value });
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(".choice")];
    const index = items.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };
  return (
    <Dialog title={props.request.title} onClose={() => dismissInteraction(props.request.id)}>
      <div class="choices" role="listbox" onKeyDown={onKey}>
        <For each={props.request.options}>
          {(option, index) => (
            <button class="choice" role="option" {...(index() === 0 ? { "data-autofocus": "" } : {})} onClick={() => pick(option.value)}>
              <span class="choice-label">{option.label}</span>
              <Show when={option.description}><span class="choice-desc">{option.description}</span></Show>
            </button>
          )}
        </For>
      </div>
    </Dialog>
  );
}

/** The oldest open question from the host; answering or dismissing reveals the next. */
export function InteractionModal() {
  const current = () => state.interactions[0];
  return (
    <Show when={current()} keyed>
      {(request) => (
        <Switch>
          <Match when={request.type === "ask" && request}>{(r) => <Ask request={r()} />}</Match>
          <Match when={request.type === "confirm" && request}>{(r) => <Confirm request={r()} />}</Match>
          <Match when={request.type === "select" && request}>{(r) => <Select request={r()} />}</Match>
        </Switch>
      )}
    </Show>
  );
}
