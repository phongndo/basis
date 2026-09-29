import { For, Show, createMemo, createSignal } from "solid-js";
import type { HostEvent } from "@lemma/contracts";
import { clearEventLog, eventLog, openDialog } from "../store.ts";
import { Dialog } from "./dialog.tsx";

/** One line per event, as `lemma events` prints them. */
const describe = (event: HostEvent): string => {
  switch (event.type) {
    case "notice":
      return `[${event.notice.level}]${event.notice.source === undefined ? "" : ` ${event.notice.source}:`} ${event.notice.message}`;
    case "delta":
      return `${event.sessionId} delta ${event.event.type}${event.event.type === "text-delta" ? ` ${JSON.stringify(event.event.delta)}` : ""}`;
    case "session-appended":
      return `${event.sessionId} appended #${event.event.seq} ${event.event.data.type}`;
    case "session-changed":
      return `${event.info.id} changed${event.info.title === undefined ? "" : ` "${event.info.title}"`}`;
    case "turn-started":
      return `${event.sessionId} turn started ${event.turnId}`;
    case "turn-ended":
      return `${event.sessionId} turn ended ${event.turnId} (${event.reason})`;
    case "interaction":
      return `question ${event.request.id} (${event.request.type}): ${event.request.title}`;
    case "interaction-closed":
      return `question ${event.id} closed`;
    case "plugins-changed":
      return `plugins: ${event.plugins.map((plugin) => `${plugin.id}=${plugin.state}`).join(" ")}`;
    case "commands-changed":
      return `commands: ${event.commands.map((command) => command.id).join(" ")}`;
  }
};

const clock = (at: number) => new Date(at).toTimeString().slice(0, 8);

/** The web counterpart of `lemma events`: the last few hundred host events this page received, filterable. */
export function EventsDialog() {
  const [query, setQuery] = createSignal("");
  const [deltas, setDeltas] = createSignal(false);
  const [open, setOpen] = createSignal<number>();
  const shown = createMemo(() => {
    const q = query().trim().toLowerCase();
    return eventLog().filter(({ event }) => (deltas() || event.type !== "delta") && (q === "" || `${event.type} ${describe(event)}`.toLowerCase().includes(q)));
  });
  return (
    <Dialog
      title="Event log"
      onClose={() => openDialog(undefined)}
      class="events-dialog"
      footer={
        <>
          <span class="muted small">
            {shown().length} of {eventLog().length} events since this page loaded
          </span>
          <span class="spacer" />
          <button class="button" onClick={clearEventLog}>
            Clear
          </button>
        </>
      }
    >
      <div class="events-bar">
        <input
          class="field"
          placeholder="Filter (type, session, text)"
          aria-label="Filter events"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          spellcheck={false}
        />
        <label class="events-check">
          <input type="checkbox" checked={deltas()} onChange={(event) => setDeltas(event.currentTarget.checked)} />
          Stream deltas
        </label>
      </div>
      <ol class="events-list">
        <For each={shown()}>
          {(entry) => (
            <li class="events-item" classList={{ open: open() === entry.seq }}>
              <button class="events-row" onClick={() => setOpen(open() === entry.seq ? undefined : entry.seq)}>
                <span class="events-time">{clock(entry.at)}</span>
                <span class="events-type">{entry.event.type}</span>
                <span class="events-text">{describe(entry.event)}</span>
              </button>
              <Show when={open() === entry.seq}>
                <pre class="events-json">{JSON.stringify(entry.event, null, 2)}</pre>
              </Show>
            </li>
          )}
        </For>
      </ol>
      <Show when={shown().length === 0}>
        <p class="muted small">No events yet. Send a prompt, reload config, or restart a plugin.</p>
      </Show>
    </Dialog>
  );
}
