import { DateTime, Effect, Layer, Option, Stream } from "effect";
import { definePlugin, Events, Hooks } from "@basis/core";
import type { Core } from "@basis/core";
import {
  Agent, AgentError, CredentialError, Credentials, HostControl, Interaction, InteractionError, InteractionHook, Llm, LlmRequest, Message,
  ModelEvent, ModelInfo, Notice, Paths, PluginsChanged, SessionAppended, SessionChanged, SessionEntry, SessionError, SessionInfo,
  Sessions, TurnEnded, TurnStarted, Usage,
} from "@basis/contracts";
import type { InteractionAnswer, InteractionRequest } from "@basis/contracts";

/** In-memory session tree that publishes the same events the real plugin would. */
export const fakeSessions = definePlugin({
  id: "sessions",
  provides: [Sessions],
  layer: Layer.effect(Sessions, Effect.gen(function* () {
    const events = yield* Events;
    const store = new Map<string, { info: SessionInfo; entries: SessionEntry[] }>();
    let count = 0;
    const get = (id: string) => Effect.suspend(() => {
      const session = store.get(id);
      return session === undefined
        ? Effect.fail(new SessionError({ sessionId: id, reason: "NotFound", message: `No session "${id}"` }))
        : Effect.succeed(session);
    });
    return {
      create: (cwd) => Effect.gen(function* () {
        const now = DateTime.unsafeNow();
        const info = new SessionInfo({ id: `s${++count}`, cwd, createdAt: now, updatedAt: now });
        store.set(info.id, { info, entries: [] });
        yield* events.publish(SessionChanged, { sessionId: info.id, info });
        return info;
      }),
      get: (id) => Effect.map(get(id), (session) => session.info),
      list: (options) => Effect.sync(() =>
        [...store.values()].map((session) => session.info).filter((info) => options?.cwd === undefined || info.cwd === options.cwd)),
      append: (id, payload, options) => Effect.gen(function* () {
        const session = yield* get(id);
        const entry = new SessionEntry({
          id: `${id}-e${session.entries.length + 1}`,
          parent: options?.parent ?? session.info.leaf ?? null,
          at: DateTime.unsafeNow(),
          payload,
        });
        session.entries.push(entry);
        session.info = new SessionInfo({ ...session.info, leaf: entry.id, updatedAt: entry.at });
        yield* events.publish(SessionAppended, { sessionId: id, entry });
        return entry;
      }),
      context: (id) => Effect.map(get(id), (session) => session.entries),
      entries: (id) => Stream.unwrap(Effect.map(get(id), (session) => Stream.fromIterable(session.entries))),
      checkout: (id, entryId) => Effect.map(get(id), (session) => {
        session.info = new SessionInfo({ ...session.info, leaf: entryId });
        return session.info;
      }),
      setTitle: (id, title) => Effect.map(get(id), (session) => {
        session.info = new SessionInfo({ ...session.info, title });
        return session.info;
      }),
    };
  })),
});

/** Echoes the prompt back in two deltas, recording both messages in the session. */
export const fakeAgent = definePlugin({
  id: "agent",
  provides: [Agent],
  requires: [Sessions],
  layer: Layer.effect(Agent, Effect.gen(function* () {
    const events = yield* Events;
    const sessions = yield* Sessions;
    const busy = new Set<string>();
    let turns = 0;
    const record = (sessionId: string, message: Message, model?: string) =>
      sessions.append(sessionId, { type: "message", message, ...(model === undefined ? {} : { model }) }).pipe(
        Effect.mapError((error) => new AgentError({ sessionId, reason: "Session", message: error.message, cause: error })),
      );
    return {
      prompt: (sessionId, message, options) => Effect.gen(function* () {
        if (busy.has(sessionId)) return yield* new AgentError({ sessionId, reason: "Busy", message: "A turn is running" });
        busy.add(sessionId);
        const turnId = `t${++turns}`;
        yield* record(sessionId, message);
        yield* events.publish(TurnStarted, { sessionId, turnId });
        const text = `echo: ${message.parts.map((part) => part.type === "text" ? part.text : "").join("")}`;
        for (const piece of [text.slice(0, 6), text.slice(6)]) {
          yield* events.publish(ModelEvent, { sessionId, turnId, event: { type: "text-delta", text: piece } });
        }
        const reply = new Message({ role: "assistant", parts: [{ type: "text", text }] });
        yield* events.publish(ModelEvent, { sessionId, turnId, event: { type: "finish", reason: "stop", message: reply } });
        yield* record(sessionId, reply, options?.model ?? "fake/echo");
        yield* events.publish(TurnEnded, { sessionId, turnId, usage: new Usage({ input: 1, output: 1 }), reason: "done" });
      }).pipe(Effect.ensuring(Effect.sync(() => busy.delete(sessionId)))),
      cancel: () => Effect.void,
      busy: (sessionId) => Effect.sync(() => busy.has(sessionId)),
      preview: (sessionId, options) => Effect.succeed(new LlmRequest({ model: options?.model ?? "fake/model", messages: [], system: `preview ${sessionId}` })),
    };
  })),
});

export const fakeLlm = definePlugin({
  id: "llm",
  provides: [Llm],
  layer: Layer.succeed(Llm, {
    registerProvider: () => Effect.void,
    providers: Effect.succeed([{ id: "fake", name: "Fake" }]),
    models: Effect.succeed([new ModelInfo({ id: "fake/echo", provider: "fake", name: "Echo", contextWindow: 1000, toolCall: false, reasoning: false })]),
    model: () => Effect.succeed(Option.none()),
    stream: () => Stream.empty,
  }),
});

export const fakeCredentials = definePlugin({
  id: "credentials",
  provides: [Credentials],
  layer: Layer.succeed(Credentials, {
    resolve: () => Effect.succeed(Option.none()),
    set: () => Effect.void,
    remove: () => Effect.void,
    list: Effect.succeed([{ provider: "fake", type: "api-key" as const }]),
    registerMethod: () => Effect.void,
    methods: Effect.succeed([]),
    login: (provider) => Effect.fail(new CredentialError({ provider, reason: "LoginFailed", message: "No login methods" })),
  }),
});

/** Runs `InteractionHook` the way the real interaction plugin does: no handler answers, `Unavailable`. */
export const fakeInteraction = definePlugin({
  id: "interaction",
  provides: [Interaction],
  layer: Layer.effect(Interaction, Effect.gen(function* () {
    const hooks = yield* Hooks;
    const events = yield* Events;
    let count = 0;
    const ask = <V>(request: Omit<InteractionRequest, "id">, pick: (answer: InteractionAnswer) => V) =>
      hooks.invoke(
        InteractionHook,
        { ...request, id: `i${++count}` } as InteractionRequest,
        () => Effect.fail(new InteractionError({ reason: "Unavailable", message: "No answerer is attached" })),
      ).pipe(Effect.map(pick), Effect.catchTags({ HookError: Effect.die, CoreClosed: Effect.die }));
    return {
      confirm: (title, detail) => ask({ type: "confirm", title, ...(detail === undefined ? {} : { detail }) }, (answer) => answer.value === true),
      ask: (title) => ask({ type: "ask", title }, (answer) => String(answer.value)),
      select: (title, options) => ask({ type: "select", title, options }, (answer) => answer.value as never),
      openUrl: (title, url, options) => ask({ type: "open-url", title, url, expectCode: options?.expectCode ?? false }, (answer) => String(answer.value)),
      notify: (message, level = "info") => events.publish(Notice, { level, message, source: "interaction" }),
    };
  })),
});

export interface ControlHolder {
  core?: Core<any>;
  readonly restarted: string[];
}

/** Delegates to the real core once the test has it; the host application does the same with its loader. */
export const fakeHostControl = (holder: ControlHolder) => definePlugin({
  id: "host-control",
  provides: [HostControl],
  layer: Layer.effect(HostControl, Effect.gen(function* () {
    const events = yield* Events;
    const core = Effect.suspend(() => holder.core === undefined ? Effect.dieMessage("core not attached") : Effect.succeed(holder.core));
    return {
      plugins: Effect.flatMap(core, (core) => Effect.map(core.inspect, (snapshot) => snapshot.plugins)),
      restart: (pluginId) => Effect.gen(function* () {
        const runtime = yield* core;
        yield* runtime.restart(pluginId);
        holder.restarted.push(pluginId);
        const snapshot = yield* runtime.inspect;
        yield* events.publish(PluginsChanged, { plugins: snapshot.plugins });
      }),
      reload: Effect.succeed({ started: [], stopped: [], restarted: [], unchanged: [], failed: [], interrupted: 0, faults: [] }),
    };
  })),
});

export const fakePaths = (home: string) => definePlugin({
  id: "paths",
  provides: [Paths],
  layer: Layer.succeed(Paths, {
    home,
    userConfig: `${home}/config.jsonc`,
    projectConfig: `${home}/project/.basis/config.jsonc`,
    auth: `${home}/auth.json`,
    sessions: `${home}/sessions`,
    cwd: `${home}/project`,
  }),
});
