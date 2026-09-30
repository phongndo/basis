import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { Accessor } from "solid-js";
import { Portal } from "solid-js/web";
import type { ConnectionStatus } from "@lemma/client";
import type { HostEvent } from "@lemma/contracts";
import { LogIcon, XIcon } from "../components/icons.tsx";
import { Actions, Client, Dialogs, Layers, Slots } from "../ui/contracts.ts";
import type { ClientService } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

const DIALOG = "events";
/** Lines kept, newest last; older ones drop off the top. */
const LIMIT = 1000;

/** A line of the log: an event from the stream, or a change in the connection carrying it. */
type Line =
  | { readonly seq: number; readonly at: number; readonly kind: "event"; readonly event: HostEvent; readonly bytes: number }
  | { readonly seq: number; readonly at: number; readonly kind: "conn"; readonly status: ConnectionStatus };

/** What a line is about, for its colour. */
const category = (line: Line): string => {
  if (line.kind === "conn") return "conn";
  const event = line.event;
  if (event.type === "notice") return `notice-${event.notice.level}`;
  if (event.type === "delta" || event.type === "tool-output") return "delta";
  if (event.type.startsWith("session")) return "session";
  if (event.type.startsWith("turn")) return "turn";
  if (event.type.startsWith("interaction")) return "interaction";
  return "host";
};

const typeOf = (line: Line): string => (line.kind === "conn" ? "connection" : line.event.type);

const sessionOf = (line: Line): string | undefined => {
  if (line.kind === "conn") return undefined;
  const event = line.event;
  if ("sessionId" in event) return event.sessionId;
  if (event.type === "session-changed") return event.info.id;
  return undefined;
};

/** The line's message, as `lemma events` prints it. */
const describe = (line: Line): string => {
  if (line.kind === "conn") {
    const { state, generation, attempts, error } = line.status;
    return `${state} · generation ${generation}${attempts > 0 ? ` · attempt ${attempts}` : ""}${error === undefined ? "" : ` · ${error}`}`;
  }
  const event = line.event;
  switch (event.type) {
    case "notice":
      return `${event.notice.level}${event.notice.source === undefined ? "" : ` ${event.notice.source}:`} ${event.notice.message}`;
    case "delta":
      return `${event.event.type}${event.event.type === "text-delta" ? ` ${JSON.stringify(event.event.delta)}` : ""} · turn ${event.turnId} step ${event.stepId}`;
    case "tool-output":
      return `${JSON.stringify(event.chunk.length > 80 ? `${event.chunk.slice(0, 80)}…` : event.chunk)} · call ${event.toolCallId}`;
    case "session-appended":
      return `#${event.event.seq} ${event.event.data.type} ${event.event.id}`;
    case "session-changed":
      return `lastSeq ${event.info.lastSeq}${event.info.title === undefined ? "" : ` "${event.info.title}"`}`;
    case "turn-started":
      return `turn ${event.turnId}`;
    case "turn-ended":
      return `turn ${event.turnId} ${event.reason} · ↑${event.usage.input} ↓${event.usage.output}`;
    case "interaction":
      return `${event.request.id} ${event.request.type}: ${event.request.title}`;
    case "interaction-closed":
      return event.id;
    case "plugins-changed":
      return event.plugins.map((plugin) => `${plugin.id}=${plugin.state}`).join(" ");
    case "commands-changed":
      return event.commands.map((command) => command.id).join(" ");
    case "ui-changed":
      return `${Object.keys(event.ui.plugins).length} rows · files ${event.ui.files.map((file) => file.name).join(" ") || "none"}`;
  }
};

const pad = (n: number, width: number) => String(n).padStart(width, "0");
const clock = (at: number) => {
  const time = new Date(at);
  return `${pad(time.getHours(), 2)}:${pad(time.getMinutes(), 2)}:${pad(time.getSeconds(), 2)}.${pad(time.getMilliseconds(), 3)}`;
};
const gap = (ms: number) => (ms < 1000 ? `+${ms}ms` : ms < 60_000 ? `+${(ms / 1000).toFixed(1)}s` : `+${Math.round(ms / 60_000)}m`);
const size = (bytes: number) => (bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}K`);

/**
 * This page's subscription to `Host.Events` over the WebSocket, as a log: one
 * line per event with its time, the gap since the one before, its type,
 * session, and size, and changes in the connection itself. Follows the tail
 * while scrolled to the bottom; a line opens to its raw JSON.
 */
function EventLog(props: { client: ClientService; lines: Accessor<readonly Line[]>; clear: () => void; close: () => void }) {
  const [query, setQuery] = createSignal("");
  const [deltas, setDeltas] = createSignal(false);
  const [paused, setPaused] = createSignal<readonly Line[]>();
  const [open, setOpen] = createSignal<ReadonlySet<number>>(new Set());
  const [stuck, setStuck] = createSignal(true);
  let scroller!: HTMLDivElement;
  let input!: HTMLInputElement;

  const source = () => paused() ?? props.lines();
  const shown = createMemo(() => {
    const words = query().trim().toLowerCase().split(/\s+/).filter(Boolean);
    return source().filter((line) => {
      // Streamed output (model deltas, tool output) is hidden until asked for.
      if (!deltas() && line.kind === "event" && (line.event.type === "delta" || line.event.type === "tool-output")) return false;
      if (words.length === 0) return true;
      const text = `${typeOf(line)} ${sessionOf(line) ?? ""} ${describe(line)}`.toLowerCase();
      return words.every((word) => (word.startsWith("-") && word.length > 1 ? !text.includes(word.slice(1)) : text.includes(word)));
    });
  });
  const rate = createMemo(() => {
    const since = Date.now() - 10_000;
    return props.lines().filter((line) => line.at >= since).length / 10;
  });
  const url = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rpc`;
  const toggle = (seq: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });

  createEffect(
    on(shown, () => {
      if (stuck()) queueMicrotask(() => scroller.scrollTo({ top: scroller.scrollHeight }));
    }),
  );
  const onScroll = () => setStuck(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24);
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    if (query() !== "" && document.activeElement === input) setQuery("");
    else props.close();
  };
  const previous = document.activeElement as HTMLElement | null;
  onMount(() => {
    document.addEventListener("keydown", onKey, true);
    queueMicrotask(() => input.focus());
  });
  onCleanup(() => {
    document.removeEventListener("keydown", onKey, true);
    previous?.focus?.();
  });

  return (
    <Portal>
      <div class="log-view" role="dialog" aria-modal="true" aria-label="Event log">
        <header class="log-bar">
          <span class={`log-dot log-dot-${props.client.status().state}`} />
          <span class="log-stream">Host.Events</span>
          <span class="log-meta">{url()}</span>
          <span class="log-meta">
            {props.client.status().state} · gen {props.client.status().generation}
          </span>
          <span class="spacer" />
          <span class="log-meta">
            {shown().length}/{props.lines().length} · {rate().toFixed(1)}/s
          </span>
          <button class="icon-button" aria-label="Close event log" data-tip="Close · Esc" onClick={props.close}>
            <XIcon />
          </button>
        </header>
        <div class="log-tools">
          <span class="log-prompt">filter›</span>
          <input
            ref={input}
            class="log-filter"
            placeholder="type, session, or text; -word excludes"
            aria-label="Filter events"
            autocomplete="off"
            spellcheck={false}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <button class="log-toggle" classList={{ on: deltas() }} aria-pressed={deltas()} onClick={() => setDeltas(!deltas())}>
            deltas
          </button>
          <button
            class="log-toggle"
            classList={{ on: paused() !== undefined }}
            aria-pressed={paused() !== undefined}
            onClick={() => setPaused(paused() === undefined ? props.lines() : undefined)}
          >
            {paused() === undefined ? "pause" : `paused · ${props.lines().length - paused()!.length} new`}
          </button>
          <button
            class="log-toggle"
            onClick={() => {
              props.clear();
              setOpen(new Set<number>());
              if (paused() !== undefined) setPaused([]);
            }}
          >
            clear
          </button>
        </div>
        <div class="log-lines" ref={scroller} onScroll={onScroll} role="log" aria-live="off">
          <div class="log-line log-head">
            <span>time</span>
            <span>gap</span>
            <span>type</span>
            <span>session</span>
            <span>size</span>
            <span>message</span>
          </div>
          <For each={shown()} fallback={<div class="log-empty">{props.lines().length === 0 ? "waiting for events…" : "no events match"}</div>}>
            {(line, index) => {
              const before = () => shown()[index() - 1];
              return (
                <>
                  <div class={`log-line is-${category(line)}`} classList={{ open: open().has(line.seq) }} onClick={() => toggle(line.seq)}>
                    <span class="log-time">{clock(line.at)}</span>
                    <span class="log-gap">{before() === undefined ? "" : gap(line.at - before()!.at)}</span>
                    <span class="log-type">{typeOf(line)}</span>
                    <span class="log-session">{sessionOf(line) ?? "·"}</span>
                    <span class="log-size">{line.kind === "event" ? size(line.bytes) : ""}</span>
                    <span class="log-message">{describe(line)}</span>
                  </div>
                  <Show when={open().has(line.seq)}>
                    <pre class="log-json">{JSON.stringify(line.kind === "event" ? line.event : line.status, null, 2)}</pre>
                  </Show>
                </>
              );
            }}
          </For>
        </div>
        <Show when={!stuck()}>
          <button
            class="log-follow"
            onClick={() => {
              setStuck(true);
              scroller.scrollTo({ top: scroller.scrollHeight });
            }}
          >
            ↓ follow
          </button>
        </Show>
      </div>
    </Portal>
  );
}

/** Records the host's event stream, and the connection carrying it, from when it starts. */
export default defineUiPlugin({
  id: "event-log",
  requires: { client: Client, dialogs: Dialogs, slots: Slots },
  setup: ({ client, dialogs, slots }, plugin) => {
    const [lines, setLines] = createSignal<readonly Line[]>([]);
    let seq = 0;
    const push = (line: Line) => setLines((current) => [...(current.length >= LIMIT ? current.slice(current.length - LIMIT + 1) : current), line]);
    plugin.onCleanup(client.onEvent((event) => push({ seq: ++seq, at: Date.now(), kind: "event", event, bytes: JSON.stringify(event).length })));
    let last: string | undefined;
    plugin.onCleanup(
      client.host.onStatus((status) => {
        // One line per change of state or generation, not per retry countdown.
        const key = `${status.state}:${status.generation}`;
        if (key === last) return;
        last = key;
        push({ seq: ++seq, at: Date.now(), kind: "conn", status });
      }),
    );
    plugin.onCleanup(
      slots.add(Layers, {
        id: DIALOG,
        component: () => (
          <Show when={dialogs.current() === DIALOG}>
            <EventLog client={client} lines={lines} clear={() => setLines([])} close={() => dialogs.open(undefined)} />
          </Show>
        ),
      }),
    );
    plugin.onCleanup(
      slots.add(Actions, {
        id: "event-log.open",
        order: 10,
        title: "Show event log",
        category: "Host",
        keywords: ["debug", "events", "stream"],
        icon: LogIcon,
        run: () => dialogs.open(DIALOG),
      }),
    );
  },
});
