import { Effect, Layer, Option, Schema } from "effect";
import { definePlugin, Events, PluginContext } from "@basis/core";
import { AgentRequestHook, Llm, LlmRequest, Notice, Sessions, TurnEnded, TurnStarted } from "@basis/contracts";
import type { Usage } from "@basis/contracts";
import { estimateTokens, rebuildMessages, summarize } from "./compaction.ts";

export { estimateTokens, rebuildMessages, summarize, SUMMARY_MARKER } from "./compaction.ts";

const Settings = Schema.Struct({
  /** Tokens kept free below the model's context window for the reply and the tools' results. */
  reserveTokens: Schema.optionalWith(Schema.Number, { default: () => 16384 }),
});

/** Absent config is the defaults: the plugin is useful without a config row. */
export const CompactionConfig = Schema.transform(Schema.UndefinedOr(Settings), Settings, {
  strict: true,
  decode: (settings) => settings ?? {},
  encode: (settings) => settings.reserveTokens === undefined ? undefined : { reserveTokens: settings.reserveTokens },
});

/** What a session's last turn cost, and whether this turn already compacted. */
interface SessionState {
  lastUsage: number | undefined;
  compacted: boolean;
}

const totalTokens = (usage: Usage): number => usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);

export default definePlugin({
  id: "compaction",
  version: "0.1.0",
  config: CompactionConfig,
  requires: [Sessions, Llm],
  layer: (config) => Layer.effectDiscard(Effect.gen(function* () {
    const owner = yield* PluginContext;
    const events = yield* Events;
    const sessions = yield* Sessions;
    const llm = yield* Llm;
    const states = new Map<string, SessionState>();
    const stateOf = (sessionId: string): SessionState => {
      const known = states.get(sessionId);
      if (known) return known;
      const created: SessionState = { lastUsage: undefined, compacted: false };
      states.set(sessionId, created);
      return created;
    };
    const notice = (level: "info" | "error", message: string) => events.publish(Notice, { level, message, source: "compaction" });

    // Turn boundaries reset the once-per-turn guard; the last turn's usage is the best size estimate we have.
    yield* owner.observe(TurnStarted, ({ sessionId }) => Effect.sync(() => { stateOf(sessionId).compacted = false; }));
    yield* owner.observe(TurnEnded, ({ sessionId, usage }) => Effect.sync(() => {
      const state = stateOf(sessionId);
      state.lastUsage = totalTokens(usage);
      state.compacted = false;
    }));

    const compact = (sessionId: string, request: LlmRequest, estimate: number) => Effect.gen(function* () {
      const summary = yield* summarize(llm.stream, request);
      yield* sessions.append(sessionId, { type: "compaction", summary, tokensBefore: estimate });
      const messages = rebuildMessages(yield* sessions.context(sessionId));
      yield* notice("info", `Compacted session ${sessionId}: about ${estimate} tokens summarized into ${summary.length} characters`);
      return new LlmRequest({ ...request, messages });
    });

    yield* owner.on(AgentRequestHook, (input, next) => Effect.gen(function* () {
      const { sessionId, request } = input;
      const state = stateOf(sessionId);
      const model = yield* llm.model(request.model).pipe(Effect.catchAll(() => Effect.succeed(Option.none())));
      if (Option.isNone(model)) return yield* next(input);
      // Usage is exact for what it measured but stale within a turn; the char estimate tracks growth since.
      const estimate = Math.max(state.lastUsage ?? 0, estimateTokens(request));
      if (estimate <= model.value.contextWindow - config.reserveTokens) {
        state.compacted = false;
        return yield* next(input);
      }
      if (state.compacted) return yield* next(input);
      state.compacted = true;
      state.lastUsage = undefined;
      // A failed compaction must not block the turn: the model call still happens (and may fail on size itself).
      const rebuilt = yield* compact(sessionId, request, estimate).pipe(
        Effect.catchAll((error) => Effect.as(notice("error", `Compaction of session ${sessionId} failed: ${error.message}`), request)),
      );
      return yield* next({ sessionId, request: rebuilt });
    }), { order: 100 });
  })),
});
