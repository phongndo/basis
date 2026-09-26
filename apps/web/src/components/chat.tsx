import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { ModelInfo } from "@basis/contracts";
import { cancel, send, setModel, state } from "../store.ts";
import type { TurnSummary } from "../store.ts";
import { DraftView, EntryView, toolNames } from "./parts.tsx";

const byProvider = (models: readonly ModelInfo[]) => {
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models) groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
  return [...groups.entries()];
};

const number = (value: number | undefined) => (value ?? 0).toLocaleString();
const summary = (turn: TurnSummary) => {
  const usage = `${number(turn.usage.input)} in, ${number(turn.usage.output)} out, cache ${number(turn.usage.cacheRead)} read / ${number(turn.usage.cacheWrite)} write`;
  return turn.reason === "done" ? `Last turn: ${usage}` : `Last turn ${turn.reason === "error" ? "ended with an error" : "was cancelled"}: ${usage}`;
};

function Composer() {
  const [text, setText] = createSignal("");
  let input!: HTMLTextAreaElement;
  const submit = () => {
    const value = text().trim();
    if (!value || state.busy) return;
    send(value);
    setText("");
    input.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
  };
  return (
    <form class="composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <textarea
        ref={input}
        rows={2}
        value={text()}
        placeholder="Message the assistant (Enter to send, Shift+Enter for a new line)"
        aria-label="Message"
        onInput={(event) => setText(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <div class="composer-row">
        <label class="model">
          <span class="visually-hidden">Model</span>
          <select value={state.model ?? ""} onChange={(event) => setModel(event.currentTarget.value || undefined)}>
            <option value="">Host default model</option>
            <For each={byProvider(state.models)}>
              {([provider, models]) => (
                <optgroup label={provider}>
                  <For each={models}>{(model) => <option value={model.id} selected={model.id === state.model}>{model.name}</option>}</For>
                </optgroup>
              )}
            </For>
          </select>
        </label>
        <span class="spacer" />
        <Show when={state.busy}><button type="button" class="danger" onClick={cancel}>Cancel</button></Show>
        <button type="submit" disabled={state.busy || !text().trim()}>Send</button>
      </div>
    </form>
  );
}

export function Chat() {
  const names = createMemo(() => toolNames(state.entries));
  let log: HTMLDivElement | undefined;
  // Follow the conversation unless the reader has scrolled up to look at something.
  createEffect(on(() => [state.entries.length, state.draft?.text.length, state.draft?.thinking.length], () => {
    if (log === undefined) return;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }, { defer: true }));

  return (
    <main class="chat">
      <Show when={state.activeId} fallback={<div class="empty"><p class="muted">Pick a session or start a new one.</p></div>}>
        <div class="log" ref={log}>
          <Show when={state.entries.length === 0 && !state.draft}><p class="muted">Empty session. Say something.</p></Show>
          <For each={state.entries}>{(entry) => <EntryView entry={entry} names={names()} />}</For>
          <Show when={state.draft}>{(draft) => <DraftView draft={draft()} />}</Show>
          <Show when={state.busy && !state.draft}><p class="marker">Working…</p></Show>
        </div>
        <Composer />
        <footer class="usage" classList={{ "is-error": state.lastTurn?.reason === "error" }}>
          <Show when={state.lastTurn} fallback={<span class="muted">No turn yet.</span>}>{(turn) => <span>{summary(turn())}</span>}</Show>
        </footer>
      </Show>
    </main>
  );
}
