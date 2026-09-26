import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { definePlugin, Events, Hooks } from "@basis/core";
import { Agent, AgentError, Llm, Sessions, Tools } from "@basis/contracts";
import type { Message, TurnOptions } from "@basis/contracts";
import { AgentConfig, requestFor } from "./request.ts";
import { runTurn } from "./turn.ts";

export { AgentConfig, buildRequest, contextMessages, defaultSystemPrompt, DEFAULT_MODEL } from "./request.ts";
export { CancelledEntry, NoticeEntry } from "./turn.ts";

/** The fiber is set right after the fork; `cancel` waits for it so no turn can slip past an early cancel. */
interface RunningTurn {
  readonly turnId: string;
  readonly fiber: Deferred.Deferred<Fiber.RuntimeFiber<void, AgentError>>;
}

export default definePlugin({
  id: "agent",
  version: "0.1.0",
  config: AgentConfig,
  provides: [Agent],
  requires: [Llm, Tools, Sessions],
  layer: (config) => Layer.scoped(Agent, Effect.gen(function* () {
    const services = {
      llm: yield* Llm, tools: yield* Tools, sessions: yield* Sessions, hooks: yield* Hooks, events: yield* Events,
    };
    // Turns run in the plugin's scope, so they outlive the caller and end with the plugin.
    const scope = yield* Scope.Scope;
    const running = new Map<string, RunningTurn>();

    const prompt = (sessionId: string, message: Message, options?: TurnOptions) => Effect.gen(function* () {
      const turnId = crypto.randomUUID();
      const slot = yield* Deferred.make<Fiber.RuntimeFiber<void, AgentError>>();
      const admitted = yield* Effect.sync(() => {
        if (running.has(sessionId)) return false;
        running.set(sessionId, { turnId, fiber: slot });
        return true;
      });
      if (!admitted) {
        return yield* new AgentError({ sessionId, reason: "Busy", message: `session ${sessionId} already has a turn in progress` });
      }
      const turn = runTurn(services, config, sessionId, turnId, message, options).pipe(
        Effect.ensuring(Effect.sync(() => { running.delete(sessionId); })),
        Effect.interruptible,
      );
      const fiber = yield* Effect.forkIn(turn, scope);
      yield* Deferred.succeed(slot, fiber);
      // Await, not join: a caller that goes away does not cancel the turn, and cancellation is an error, not an interrupt.
      const exit = yield* Fiber.await(fiber);
      if (Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)) {
        return yield* new AgentError({ sessionId, reason: "Cancelled", message: `turn ${turnId} was cancelled` });
      }
      return yield* exit;
    });

    const cancel = (sessionId: string) => Effect.gen(function* () {
      const turn = running.get(sessionId);
      if (turn === undefined) return;
      yield* Fiber.interrupt(yield* Deferred.await(turn.fiber));
    });

    return {
      prompt,
      cancel,
      busy: (sessionId: string) => Effect.sync(() => running.has(sessionId)),
      preview: (sessionId, options) => requestFor(services, sessionId, options, config),
    };
  })),
});
