import { Deferred, Effect, Fiber } from "effect";
import type { Context, Scope } from "effect";
import { HostError } from "@basis/contracts";
import type { AuthType, Llm, LlmError } from "@basis/contracts";

interface Running {
  readonly type: AuthType;
  /** Set right after the fork, so the entry exists before the login can end. */
  readonly fiber: Deferred.Deferred<Fiber.RuntimeFiber<void, LlmError>>;
}

/**
 * Logins belong to the plugin, not the RPC: a client that reloads or drops its
 * socket mid-login leaves the flow running, so its questions stay open under
 * the interaction grace period and are replayed when the client returns. One
 * login per provider; a second call of the same type waits for the first.
 */
export const makeLogins = (llm: Context.Tag.Service<Llm>, scope: Scope.Scope) => {
  const running = new Map<string, Running>();
  return (provider: string, type: AuthType): Effect.Effect<void, HostError | LlmError> => Effect.gen(function* () {
    // Admission and fork cannot be split by the caller's interruption, or the provider would stay busy forever.
    const fiber = yield* Effect.uninterruptible(Effect.gen(function* () {
      const current = running.get(provider);
      if (current !== undefined) {
        if (current.type !== type) {
          return yield* new HostError({ code: "Busy", message: `A ${current.type} login to "${provider}" is in progress`, subject: provider });
        }
        return current.fiber;
      }
      const entry: Running = { type, fiber: yield* Deferred.make<Fiber.RuntimeFiber<void, LlmError>>() };
      running.set(provider, entry);
      const forked = yield* Effect.forkIn(
        Effect.interruptible(llm.login(provider, type)).pipe(
          Effect.ensuring(Effect.sync(() => { if (running.get(provider) === entry) running.delete(provider); })),
        ),
        scope,
      );
      yield* Deferred.succeed(entry.fiber, forked);
      return entry.fiber;
    }));
    // Awaiting, not joining: a caller that goes away leaves the login running.
    return yield* Effect.flatten(Fiber.await(yield* Deferred.await(fiber)));
  });
};
