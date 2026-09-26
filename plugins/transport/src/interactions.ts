import { Deferred, Effect } from "effect";
import type { Handler } from "@basis/core";
import { HostError, InteractionError } from "@basis/contracts";
import type { InteractionAnswer, InteractionRequest } from "@basis/contracts";
import type { Hub } from "./hub.ts";

interface Pending {
  readonly request: InteractionRequest;
  readonly answer: Deferred.Deferred<InteractionAnswer, InteractionError>;
}

/**
 * Answers `InteractionHook` on behalf of connected clients. A request is
 * broadcast to every subscriber; the first answer wins and the others learn
 * of it through `interaction-closed`. With nobody attached the request passes
 * to the next handler (a TUI, for instance) instead of failing here.
 */
export interface Interactions {
  readonly handle: Handler<InteractionRequest, InteractionAnswer, InteractionError>;
  readonly answer: (id: string, answer: InteractionAnswer) => Effect.Effect<void, HostError>;
  readonly dismiss: (id: string) => Effect.Effect<void, HostError>;
}

export const makeInteractions = (hub: Hub): Interactions => {
  const open = new Map<string, Pending>();

  const lookup = (id: string): Effect.Effect<Pending, HostError> =>
    Effect.suspend(() => {
      const pending = open.get(id);
      return pending === undefined
        ? Effect.fail(new HostError({ code: "Interaction.Unknown", message: `No open interaction "${id}"`, subject: id }))
        : Effect.succeed(pending);
    });

  const settle = (id: string, pending: Pending, outcome: Effect.Effect<boolean>): Effect.Effect<void, HostError> =>
    Effect.flatMap(outcome, (first) => first ? Effect.void : Effect.fail(
      new HostError({ code: "Interaction.Closed", message: `Interaction "${id}" was already answered`, subject: id }),
    )).pipe(Effect.tap(() => open.delete(pending.request.id)));

  const unavailable = Effect.zipRight(hub.drained, Effect.fail(new InteractionError({
    reason: "Unavailable",
    message: "Every connected client disconnected before answering",
  })));

  return {
    handle: (request, next) => Effect.gen(function* () {
      if ((yield* hub.count) === 0) return yield* next(request);
      const pending: Pending = { request, answer: yield* Deferred.make<InteractionAnswer, InteractionError>() };
      open.set(request.id, pending);
      yield* hub.broadcast({ type: "interaction", request });
      return yield* Deferred.await(pending.answer).pipe(
        Effect.raceFirst(unavailable),
        Effect.ensuring(Effect.suspend(() => {
          open.delete(request.id);
          return hub.broadcast({ type: "interaction-closed", id: request.id });
        })),
      );
    }),
    answer: (id, answer) => Effect.gen(function* () {
      const pending = yield* lookup(id);
      if (answer.type !== pending.request.type) {
        return yield* new HostError({
          code: "Interaction.Mismatch",
          message: `Interaction "${id}" is a ${pending.request.type} question; got a ${answer.type} answer`,
          subject: id,
        });
      }
      yield* settle(id, pending, Deferred.succeed(pending.answer, answer));
    }),
    dismiss: (id) => Effect.gen(function* () {
      const pending = yield* lookup(id);
      yield* settle(id, pending, Deferred.fail(pending.answer, new InteractionError({
        reason: "Dismissed",
        message: `Interaction "${id}" was dismissed by a client`,
      })));
    }),
  };
};
