import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { definePlugin, Events, Hooks, PluginContext } from "@lemma/core";
import { Agent, AgentError, HostControl, InteractionOrigin, Llm, Sessions, Tools } from "@lemma/contracts";
import type { ModelInfo, PromptContent, TurnOptions } from "@lemma/contracts";
import { newId, runTurn } from "./turn.ts";

export { basePrompt, environment, titleFrom } from "./prompt.ts";
export type { EnvironmentFacts } from "./prompt.ts";
export { runTurn } from "./turn.ts";

export const AgentConfig = Schema.Struct({
  /** `<provider>/<model>` for turns that name none. Absent: the first available model. */
  defaultModel: Schema.optional(Schema.String),
  /** Replaces the default base prompt; the environment section is still added. */
  systemPrompt: Schema.optional(Schema.String),
  /** Shell command that runs the `lemma` CLI; named in the environment section so the agent can inspect itself. */
  cli: Schema.optional(Schema.String),
  /** Model calls allowed in one turn before it ends with `max-steps`. */
  maxSteps: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), { default: () => 200 }),
});
export type AgentConfig = typeof AgentConfig.Type;

interface Running {
  readonly controller: AbortController;
  /** Set right after the fork; `cancel` waits for it so an early cancel cannot miss the turn. */
  readonly fiber: Deferred.Deferred<Fiber.RuntimeFiber<void, AgentError>>;
}

export default definePlugin({
  id: "agent",
  version: "0.1.0",
  config: AgentConfig,
  provides: [Agent],
  requires: [Sessions, Llm, Tools, HostControl],
  layer: (config) =>
    Layer.scoped(
      Agent,
      Effect.gen(function* () {
        const owner = yield* PluginContext;
        const services = {
          sessions: yield* Sessions,
          llm: yield* Llm,
          tools: yield* Tools,
          host: yield* HostControl,
          hooks: yield* Hooks,
          events: yield* Events,
          source: owner.id,
        };
        const settings = {
          maxSteps: config.maxSteps,
          ...(config.systemPrompt === undefined ? {} : { systemPrompt: config.systemPrompt }),
          ...(config.cli === undefined ? {} : { cli: config.cli }),
        };
        // Turns belong to the plugin, not the caller: they outlive an interrupted `prompt` and end with the plugin.
        const scope = yield* Effect.scope;
        const running = new Map<string, Running>();

        const resolveModel = (sessionId: string, options?: TurnOptions): Effect.Effect<ModelInfo, AgentError> =>
          Effect.gen(function* () {
            const ref = options?.model ?? config.defaultModel;
            if (ref !== undefined) {
              return yield* services.llm
                .model(ref)
                .pipe(Effect.mapError((error) => new AgentError({ sessionId, reason: "NoModel", message: error.message, cause: error })));
            }
            const [first] = yield* services.llm.models({ available: true });
            if (first === undefined) {
              return yield* new AgentError({
                sessionId,
                reason: "NoModel",
                message: "No model is available. Log in to a provider or configure agent.defaultModel.",
              });
            }
            return first;
          });

        const turn = (sessionId: string, content: PromptContent, options: TurnOptions | undefined, signal: AbortSignal) =>
          Effect.gen(function* () {
            const info = yield* services.sessions
              .get(sessionId)
              .pipe(Effect.mapError((error) => new AgentError({ sessionId, reason: "Session", message: error.message, cause: error })));
            const model = yield* resolveModel(sessionId, options);
            yield* owner.trace(
              "agent.turn",
              runTurn(services, settings, {
                sessionId,
                turnId: newId(),
                cwd: info.cwd,
                model,
                content,
                signal,
                ...(info.title === undefined ? {} : { title: info.title }),
                ...(options?.thinking === undefined ? {} : { thinking: options.thinking }),
              }),
            );
          });

        const prompt = (sessionId: string, content: PromptContent, options?: TurnOptions) =>
          Effect.gen(function* () {
            // Admission and fork cannot be split by the caller's interruption, or the session would stay busy forever.
            const fiber = yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const slot = yield* Deferred.make<Fiber.RuntimeFiber<void, AgentError>>();
                const entry: Running = { controller: new AbortController(), fiber: slot };
                if (running.has(sessionId)) {
                  return yield* new AgentError({ sessionId, reason: "Busy", message: `Session ${sessionId} already has a turn in progress` });
                }
                running.set(sessionId, entry);
                const forked = yield* Effect.forkIn(
                  Effect.interruptible(
                    Effect.locally(turn(sessionId, content, options, entry.controller.signal), InteractionOrigin, `session:${sessionId}`),
                  ).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        if (running.get(sessionId) === entry) running.delete(sessionId);
                      }),
                    ),
                  ),
                  scope,
                );
                yield* Deferred.succeed(slot, forked);
                return forked;
              }),
            );
            // Awaiting, not joining: a caller that goes away leaves the turn running. A cancelled turn resolves normally.
            const exit = yield* Fiber.await(fiber);
            if (Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)) return;
            return yield* exit;
          });

        const cancel = (sessionId: string) =>
          Effect.gen(function* () {
            const entry = running.get(sessionId);
            if (entry === undefined) return;
            entry.controller.abort();
            yield* Fiber.interrupt(yield* Deferred.await(entry.fiber));
          });

        return {
          prompt,
          cancel,
          busy: (sessionId: string) => Effect.sync(() => running.has(sessionId)),
          running: Effect.sync(() => [...running.keys()]),
        };
      }),
    ),
});
