import { For, Index, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { ContentPart, Message, SessionEntry } from "@basis/contracts";
import type { Draft } from "../store.ts";

type ImagePart = Extract<ContentPart, { type: "image" }>;

/** Tool result parts name only the call id; the name comes from the earlier call. */
export type ToolNames = ReadonlyMap<string, string>;

export const toolNames = (entries: readonly SessionEntry[]): ToolNames => {
  const names = new Map<string, string>();
  for (const entry of entries) {
    if (entry.payload.type !== "message") continue;
    for (const part of entry.payload.message.parts) if (part.type === "tool-call") names.set(part.id, part.name);
  }
  return names;
};

const imageSrc = (part: ImagePart) => part.source.kind === "url" ? part.source.url : `data:${part.mediaType};base64,${part.source.data}`;

/** Entries and their parts are immutable, so each part renders once for the life of its row. */
export function Part(props: { part: ContentPart; names: ToolNames }): JSX.Element {
  const part = props.part;
  switch (part.type) {
    case "text": return <p class="text">{part.text}</p>;
    case "image": return <img class="image" src={imageSrc(part)} alt="Attached image" />;
    case "thinking": return <details class="thinking"><summary>Thinking</summary><pre>{part.text}</pre></details>;
    case "tool-call": return (
      <details class="tool">
        <summary>Call <code>{part.name}</code></summary>
        <pre>{JSON.stringify(part.input, null, 2)}</pre>
      </details>
    );
    case "tool-result": return (
      <details class="tool" classList={{ "is-error": part.isError === true }}>
        <summary>{part.isError ? "Error from " : "Result from "}<code>{props.names.get(part.toolCallId) ?? part.toolCallId}</code></summary>
        <For each={part.content}>
          {(item) => item.type === "text" ? <pre>{item.text}</pre> : <img src={imageSrc(item)} alt="Tool result image" />}
        </For>
      </details>
    );
  }
}

const onlyToolResults = (message: Message) => message.parts.length > 0 && message.parts.every((part) => part.type === "tool-result");
const LABEL = { user: "You", assistant: "Assistant", "tool-results": "Tools" } as const;

export function MessageView(props: { message: Message; model?: string | undefined; names: ToolNames }) {
  const kind = onlyToolResults(props.message) ? "tool-results" : props.message.role;
  return (
    <article class={`message message-${kind}`}>
      <header class="message-head">
        <span>{LABEL[kind]}</span>
        <Show when={props.model}>{(model) => <span class="muted">{model()}</span>}</Show>
      </header>
      <For each={props.message.parts}>{(part) => <Part part={part} names={props.names} />}</For>
    </article>
  );
}

export function EntryView(props: { entry: SessionEntry; names: ToolNames }): JSX.Element {
  const payload = props.entry.payload;
  switch (payload.type) {
    case "message": return <MessageView message={payload.message} model={payload.model} names={props.names} />;
    case "compaction": return <p class="marker">Context compacted ({payload.tokensBefore} tokens before)</p>;
    case "title": return null;
    case "custom": {
      const data = (payload.data ?? {}) as { message?: string; partial?: boolean };
      if (payload.kind === "agent/cancelled") return <p class="marker">Turn cancelled{data.partial ? " (partial reply kept)" : ""}</p>;
      if (payload.kind === "agent/notice") return <p class="marker">{data.message ?? "Notice"}</p>;
      return <p class="marker">{payload.kind}</p>;
    }
  }
}

/** The streamed message: same shape as an assistant entry, updated as deltas arrive. */
export function DraftView(props: { draft: Draft }) {
  return (
    <article class="message message-assistant message-draft" aria-live="polite">
      <header class="message-head"><span>Assistant</span><span class="muted">streaming</span></header>
      <Show when={props.draft.thinking}>
        <details class="thinking"><summary>Thinking</summary><pre>{props.draft.thinking}</pre></details>
      </Show>
      <Show when={props.draft.text}><p class="text">{props.draft.text}</p></Show>
      <Index each={props.draft.calls}>
        {(call) => (
          <details class="tool">
            <summary>Call <code>{call().name}</code></summary>
            <pre>{call().input}</pre>
          </details>
        )}
      </Index>
    </article>
  );
}
