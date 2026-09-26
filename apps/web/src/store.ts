import { Duration, Effect, Fiber, Stream } from "effect";
import { createStore, produce } from "solid-js/store";
import { hostEvents } from "@basis/client/browser";
import { Message, TurnOptions } from "@basis/contracts";
import type {
  HostEvent, InteractionAnswer, InteractionRequest, ModelInfo, PluginStatus, SessionEntry, SessionInfo, StreamEvent, Usage,
} from "@basis/contracts";

type Plugin = typeof PluginStatus.Type;
import { connect, describeError, run, saveSettings, clearSettings } from "./host.ts";
import type { Connection, HostSettings } from "./host.ts";

export type Status = "disconnected" | "connecting" | "connected" | "reconnecting";
export type Level = "info" | "warning" | "error";

export interface Toast { readonly id: number; readonly level: Level; readonly message: string }
export interface DraftCall { readonly id: string; readonly name: string; readonly input: string }
/** Assistant output streamed for the message the model is producing now. */
export interface Draft { readonly text: string; readonly thinking: string; readonly calls: readonly DraftCall[] }
export interface TurnSummary { readonly usage: Usage; readonly reason: "done" | "cancelled" | "error" }

interface State {
  status: Status;
  sessions: readonly SessionInfo[];
  /** First user message of sessions that have no title. */
  previews: Record<string, string>;
  activeId: string | undefined;
  entries: readonly SessionEntry[];
  draft: Draft | undefined;
  busy: boolean;
  lastTurn: TurnSummary | undefined;
  models: readonly ModelInfo[];
  model: string | undefined;
  plugins: readonly Plugin[];
  toasts: readonly Toast[];
  interactions: readonly InteractionRequest[];
}

// Every key is listed so a reset through `setState` clears the optional ones too.
const initial = (): State => ({
  status: "disconnected", sessions: [], previews: {}, activeId: undefined, entries: [], draft: undefined, busy: false,
  lastTurn: undefined, models: [], model: undefined, plugins: [], toasts: [], interactions: [],
});

export const [state, setState] = createStore<State>(initial());

let connection: Connection | undefined;
let events: Fiber.RuntimeFiber<void, unknown> | undefined;
let toastSeq = 0;
let contextSeq = 0;
/**
 * `model` and `session-appended` travel on independent queues, so the durable
 * entry for a message may land before its last deltas. Counting finished and
 * appended assistant messages per turn tells stale deltas from live ones.
 */
let rounds = { finished: 0, appended: 0 };

const client = () => {
  if (connection === undefined) throw new Error("Not connected");
  return connection.client;
};

const modelKey = (sessionId: string) => `basis.model.${sessionId}`;

export const toast = (level: Level, message: string): void => {
  const id = ++toastSeq;
  setState("toasts", (toasts) => [...toasts, { id, level, message }]);
  setTimeout(() => dismissToast(id), level === "error" ? 12_000 : 6_000);
};
export const dismissToast = (id: number): void => setState("toasts", (toasts) => toasts.filter((toast) => toast.id !== id));

const report = (error: unknown): void => toast("error", describeError(error));

const preview = (entries: readonly SessionEntry[]): string | undefined => {
  for (const entry of entries) {
    if (entry.payload.type !== "message" || entry.payload.message.role !== "user") continue;
    const text = entry.payload.message.parts.find((part) => part.type === "text");
    if (text !== undefined) return text.text.replace(/\s+/g, " ").trim().slice(0, 80);
  }
  return undefined;
};

const loadPreviews = (sessions: readonly SessionInfo[]) => {
  const missing = sessions.filter((session) => session.title === undefined && state.previews[session.id] === undefined);
  return run(Effect.forEach(missing, (session) =>
    client().Session.Context({ sessionId: session.id }).pipe(
      Effect.map((entries) => { const text = preview(entries); if (text !== undefined) setState("previews", session.id, text); }),
      Effect.ignore,
    ), { concurrency: 4, discard: true }));
};

export const refreshSessions = async (): Promise<void> => {
  const sessions = await run(client().Session.List({}));
  setState("sessions", sessions);
  await loadPreviews(sessions);
};

/**
 * Re-reads the authoritative context; a slower, older read never overwrites a
 * newer one. Entries are immutable, so known ids keep their instance and the
 * rendered rows (and their expanded details) survive the refresh.
 */
const refreshContext = async (): Promise<void> => {
  const sessionId = state.activeId;
  if (sessionId === undefined || connection === undefined) return;
  const seq = ++contextSeq;
  const entries = await run(client().Session.Context({ sessionId }));
  if (seq !== contextSeq || state.activeId !== sessionId) return;
  const known = new Map(state.entries.map((entry) => [entry.id, entry]));
  setState("entries", entries.map((entry) => known.get(entry.id) ?? entry));
};

export const refreshPlugins = async (): Promise<void> => setState("plugins", await run(client().Host.Plugins()));

const resync = () => Promise.all([refreshSessions(), refreshContext(), refreshPlugins()]).catch(report);

const applyModelEvent = (event: StreamEvent): void => {
  if (event.type === "usage") return;
  if (event.type === "finish") {
    rounds.finished += 1;
    // The durable entry is already displayed; otherwise keep the draft until it arrives.
    if (rounds.finished <= rounds.appended) setState("draft", undefined);
    return;
  }
  if (rounds.finished < rounds.appended) return;
  setState(produce((s) => {
    const draft: Draft = s.draft ?? { text: "", thinking: "", calls: [] };
    switch (event.type) {
      case "text-delta": s.draft = { ...draft, text: draft.text + event.text }; break;
      case "thinking-delta": s.draft = { ...draft, thinking: draft.thinking + event.text }; break;
      case "tool-call-delta": {
        const existing = draft.calls.find((call) => call.id === event.id);
        const calls = existing === undefined
          ? [...draft.calls, { id: event.id, name: event.name, input: event.inputDelta }]
          : draft.calls.map((call) => call.id === event.id ? { ...call, input: call.input + event.inputDelta } : call);
        s.draft = { ...draft, calls };
        break;
      }
      case "tool-call": {
        const complete = { id: event.id, name: event.name, input: JSON.stringify(event.input, null, 2) };
        const calls = draft.calls.some((call) => call.id === event.id)
          ? draft.calls.map((call) => call.id === event.id ? complete : call)
          : [...draft.calls, complete];
        s.draft = { ...draft, calls };
        break;
      }
    }
  }));
};

/** Applies one host event to the state; exported for tests. */
export const onEvent = (event: HostEvent): void => {
  const active = "sessionId" in event && event.sessionId === state.activeId;
  switch (event.type) {
    case "notice":
      if (event.source === "transport") { setState("status", "connected"); void resync(); return; }
      if (event.source === "client" && event.level === "warning") setState("status", "reconnecting");
      toast(event.level, event.message);
      return;
    case "turn-started":
      if (!active) return;
      rounds = { finished: 0, appended: 0 };
      setState({ busy: true, draft: undefined, lastTurn: undefined });
      return;
    case "model":
      if (active) applyModelEvent(event.event);
      return;
    case "turn-ended":
      if (!active) return;
      setState({ busy: false, lastTurn: { usage: event.usage, reason: event.reason } });
      if (event.reason !== "done") setState("draft", undefined);
      void refreshContext().catch(report);
      return;
    case "session-appended":
      if (!active) return;
      if (event.entry.payload.type === "message" && event.entry.payload.message.role === "assistant") {
        rounds.appended += 1;
        setState("draft", undefined);
      }
      void refreshContext().catch(report);
      return;
    case "session-changed": {
      const others = state.sessions.filter((session) => session.id !== event.sessionId);
      setState("sessions", [event.info, ...others]);
      if (event.info.title === undefined && state.previews[event.sessionId] === undefined) void loadPreviews([event.info]);
      return;
    }
    case "interaction":
      setState("interactions", (open) => [...open.filter((request) => request.id !== event.request.id), event.request]);
      return;
    case "interaction-closed":
      setState("interactions", (open) => open.filter((request) => request.id !== event.id));
      return;
    case "plugins-changed":
      setState("plugins", event.plugins);
      return;
  }
};

export const connectHost = async (settings: HostSettings): Promise<void> => {
  setState("status", "connecting");
  const next = await connect(settings);
  try {
    // The socket retries silently on a bad address or token; a bounded probe turns that into an error.
    await run(next.client.Host.Plugins().pipe(Effect.timeout(Duration.seconds(5))));
  } catch (error) {
    await next.close();
    setState("status", "disconnected");
    throw new Error(`Cannot reach ${settings.url} (${describeError(error)}); check the URL and token`);
  }
  connection = next;
  saveSettings(settings);
  setState("status", "connected");
  events = Effect.runFork(Stream.runForEach(hostEvents(next.client), (event) => Effect.sync(() => onEvent(event))));
  run(next.client.Llm.Models()).then((models) => setState("models", models)).catch(report);
};

export const disconnectHost = async (): Promise<void> => {
  if (events !== undefined) await run(Fiber.interrupt(events));
  await connection?.close();
  connection = undefined;
  events = undefined;
  clearSettings();
  setState(initial());
};

export const selectSession = async (sessionId: string | undefined): Promise<void> => {
  contextSeq += 1;
  rounds = { finished: 0, appended: 0 };
  setState({
    activeId: sessionId, entries: [], draft: undefined, busy: false, lastTurn: undefined,
    model: sessionId === undefined ? undefined : localStorage.getItem(modelKey(sessionId)) ?? undefined,
  });
  if (sessionId === undefined || connection === undefined) return;
  const [busy] = await Promise.all([run(client().Agent.Busy({ sessionId })), refreshContext()]);
  if (state.activeId === sessionId) setState("busy", busy);
};

export const createSession = async (): Promise<void> => {
  const info = await run(client().Session.Create({}));
  setState("sessions", (sessions) => [info, ...sessions.filter((session) => session.id !== info.id)]);
  await selectSession(info.id);
};

export const setModel = (model: string | undefined): void => {
  const sessionId = state.activeId;
  if (sessionId === undefined) return;
  if (model === undefined) localStorage.removeItem(modelKey(sessionId));
  else localStorage.setItem(modelKey(sessionId), model);
  setState("model", model);
};

/** Resolves when the turn has ended; progress arrives through events. */
export const send = (text: string): void => {
  const sessionId = state.activeId;
  if (sessionId === undefined) return;
  const message = new Message({ role: "user", parts: [{ type: "text", text }] });
  const options = state.model === undefined ? undefined : new TurnOptions({ model: state.model });
  setState("busy", true);
  run(client().Agent.Prompt({ sessionId, message, options })).catch((error) => {
    report(error);
    if (state.activeId === sessionId) setState("busy", false);
  });
};

export const cancel = (): void => {
  const sessionId = state.activeId;
  if (sessionId !== undefined) run(client().Agent.Cancel({ sessionId })).catch(report);
};

export const answer = (id: string, answer: InteractionAnswer): void => {
  setState("interactions", (open) => open.filter((request) => request.id !== id));
  run(client().Interaction.Answer({ id, answer })).catch(report);
};

export const dismiss = (id: string): void => {
  setState("interactions", (open) => open.filter((request) => request.id !== id));
  run(client().Interaction.Dismiss({ id })).catch(report);
};

export const restartPlugin = (pluginId: string): void => {
  run(client().Host.RestartPlugin({ pluginId })).then(() => toast("info", `Restarted ${pluginId}`)).catch(report);
};

export const reload = (): void => {
  run(client().Host.Reload()).then((result) => {
    const parts = [
      result.started.length ? `started ${result.started.join(", ")}` : "",
      result.restarted.length ? `restarted ${result.restarted.join(", ")}` : "",
      result.stopped.length ? `stopped ${result.stopped.join(", ")}` : "",
    ].filter(Boolean);
    toast("info", parts.length ? `Reloaded: ${parts.join("; ")}` : "Reloaded: nothing changed");
  }).catch(report);
};

export const sessionLabel = (session: SessionInfo): string => session.title ?? state.previews[session.id] ?? "New session";
