import { DateTime, Duration, Effect, Layer, Option, Schema, Stream } from "effect";
import { definePlugin, PluginContext } from "@basis/core";
import {
  Llm, LlmError, Message, ModelEvent, SessionEntry, SessionError, SessionInfo, Sessions, ToolDefinition, ToolError,
  ToolResult, Tools, TurnEnded, TurnStarted, Usage,
} from "@basis/contracts";
import type { EntryPayload, LlmRequest, StreamEvent, Tool, ToolContext } from "@basis/contracts";

/** Poll until the predicate holds; dies after five seconds so a wrong expectation fails fast. */
export function waitFor<A, E, R>(effect: Effect.Effect<A, E, R>, predicate: (value: A) => boolean): Effect.Effect<A, E, R> {
  const poll: Effect.Effect<A, E, R> = Effect.flatMap(effect, (value) =>
    predicate(value) ? Effect.succeed(value) : Effect.sleep(Duration.millis(2)).pipe(Effect.zipRight(poll)));
  return poll.pipe(Effect.timeout(Duration.seconds(5)), Effect.orDie);
}

// Stream-event builders for scripts.
export const text = (text: string): StreamEvent => ({ type: "text-delta", text });
export const usage = (input: number, output: number): StreamEvent => ({ type: "usage", usage: new Usage({ input, output }) });
export const stop = (text: string, reason: "stop" | "length" | "refusal" | "error" = "stop"): StreamEvent =>
  ({ type: "finish", reason, message: new Message({ role: "assistant", parts: [{ type: "text", text }] }) });
export const toolCalls = (...calls: { id: string; name: string; input: unknown }[]): StreamEvent => ({
  type: "finish", reason: "tool-calls",
  message: new Message({ role: "assistant", parts: calls.map((call) => ({ type: "tool-call" as const, ...call })) }),
});
export const user = (text: string) => new Message({ role: "user", parts: [{ type: "text", text }] });

export type Script = Stream.Stream<StreamEvent, LlmError>;
export const scripted = (...events: StreamEvent[]): Script => Stream.fromIterable(events);
/** Emits the events, then never finishes: for cancellation tests. */
export const hanging = (...events: StreamEvent[]): Script => Stream.concat(Stream.fromIterable(events), Stream.never);
export const failing = (message: string): Script =>
  Stream.fail(new LlmError({ provider: "fake", reason: "Network", message, retryable: false }));

/** A model that plays one script per call, in order, and records every request it received. */
export function fakeLlm(scripts: readonly Script[]) {
  const requests: LlmRequest[] = [];
  const queue = [...scripts];
  const plugin = definePlugin({
    id: "llm", provides: [Llm],
    layer: Layer.succeed(Llm, {
      registerProvider: () => Effect.void,
      providers: Effect.succeed([]),
      models: Effect.succeed([]),
      model: () => Effect.succeed(Option.none()),
      stream: (request) => {
        requests.push(request);
        return queue.shift() ?? failing("no script left for this call");
      },
    }),
  });
  return { plugin, requests };
}

/** An in-memory registry that runs tools directly; no gate, no validation beyond the registered set. */
export function fakeTools(initial: readonly Tool<any>[] = []) {
  const registry = new Map<string, Tool<any>>(initial.map((tool) => [tool.name, tool]));
  const executed: string[] = [];
  const plugin = definePlugin({
    id: "tools", provides: [Tools],
    layer: Layer.succeed(Tools, {
      register: (tool) => Effect.sync(() => { registry.set(tool.name, tool); }),
      list: Effect.sync(() => [...registry.values()].map((tool) =>
        new ToolDefinition({ name: tool.name, description: tool.description, inputSchema: { type: "object" } }))),
      execute: (invocation) => Effect.gen(function* () {
        executed.push(invocation.name);
        const tool = registry.get(invocation.name);
        if (tool === undefined) return yield* new ToolError({ tool: invocation.name, reason: "NotFound", message: `no tool ${invocation.name}` });
        const context: ToolContext = { sessionId: invocation.sessionId, toolCallId: invocation.toolCallId, cwd: invocation.cwd, signal: new AbortController().signal };
        const outcome = tool.execute(invocation.input, context);
        const run = Effect.isEffect(outcome) ? outcome : Effect.tryPromise(() => outcome);
        return yield* run.pipe(Effect.mapError((error) => error instanceof ToolError
          ? error
          : new ToolError({ tool: invocation.name, reason: "Failed", message: error instanceof Error ? error.message : String(error), cause: error })));
      }),
    }),
  });
  return { plugin, registry, executed };
}

/** Append-only in-memory sessions with the same tree and compaction semantics as the JSONL plugin. */
export function fakeSessions() {
  const store = new Map<string, { info: SessionInfo; entries: SessionEntry[] }>();
  let counter = 0;
  const notFound = (sessionId: string) => new SessionError({ sessionId, reason: "NotFound", message: `no session ${sessionId}` });
  const lookup = (sessionId: string) => {
    const session = store.get(sessionId);
    return session === undefined ? Effect.fail(notFound(sessionId)) : Effect.succeed(session);
  };
  const path = (session: { info: SessionInfo; entries: SessionEntry[] }) => {
    const byId = new Map(session.entries.map((entry) => [entry.id, entry]));
    const chain: SessionEntry[] = [];
    for (let id = session.info.leaf; id !== undefined; ) {
      const entry = byId.get(id)!;
      chain.unshift(entry);
      id = entry.parent ?? undefined;
    }
    const compaction = chain.map((entry) => entry.payload.type).lastIndexOf("compaction");
    return compaction < 0 ? chain : chain.slice(compaction);
  };
  const plugin = definePlugin({
    id: "sessions", provides: [Sessions],
    layer: Layer.succeed(Sessions, {
      create: (cwd) => Effect.sync(() => {
        const now = DateTime.unsafeNow();
        const info = new SessionInfo({ id: `session-${++counter}`, cwd, createdAt: now, updatedAt: now });
        store.set(info.id, { info, entries: [] });
        return info;
      }),
      get: (sessionId) => Effect.map(lookup(sessionId), (session) => session.info),
      list: () => Effect.sync(() => [...store.values()].map((session) => session.info)),
      append: (sessionId, payload: EntryPayload, options) => Effect.map(lookup(sessionId), (session) => {
        const entry = new SessionEntry({ id: `entry-${++counter}`, parent: options?.parent ?? session.info.leaf ?? null, at: DateTime.unsafeNow(), payload });
        session.entries.push(entry);
        session.info = new SessionInfo({ ...session.info, leaf: entry.id, updatedAt: entry.at });
        return entry;
      }),
      context: (sessionId) => Effect.map(lookup(sessionId), path),
      entries: (sessionId) => Stream.unwrap(Effect.map(lookup(sessionId), (session) => Stream.fromIterable(session.entries))),
      checkout: (sessionId, entryId) => Effect.map(lookup(sessionId), (session) => {
        session.info = new SessionInfo({ ...session.info, leaf: entryId });
        return session.info;
      }),
      setTitle: (sessionId, title) => Effect.map(lookup(sessionId), (session) => {
        session.info = new SessionInfo({ ...session.info, title });
        return session.info;
      }),
    }),
  });
  return { plugin, store };
}

/** Records agent events so tests can assert on what a UI would have seen. */
export function recorder() {
  const started: { sessionId: string; turnId: string }[] = [];
  const ended: { sessionId: string; turnId: string; usage: Usage; reason: string }[] = [];
  const model: StreamEvent[] = [];
  const plugin = definePlugin({
    id: "recorder",
    layer: Layer.effectDiscard(Effect.gen(function* () {
      const owner = yield* PluginContext;
      yield* owner.observe(TurnStarted, (payload) => Effect.sync(() => { started.push(payload); }));
      yield* owner.observe(TurnEnded, (payload) => Effect.sync(() => { ended.push(payload); }));
      yield* owner.observe(ModelEvent, (payload) => Effect.sync(() => { model.push(payload.event); }), { buffer: 1024 });
    })),
  });
  return { plugin, started, ended, model };
}

export const textOf = (message: Message) =>
  message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("");

export const okTool = (name: string, reply: (input: any) => string): Tool<any> => ({
  name, description: `fake ${name}`, input: Schema.Unknown,
  execute: async (input) => new ToolResult({ content: [{ type: "text", text: reply(input) }] }),
});
