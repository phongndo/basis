import { Duration, Effect, Layer, Schema } from "effect";
import { Interaction, InteractionError, InteractionHook, Notice } from "@basis/contracts";
import type { InteractionAnswer, InteractionRequest } from "@basis/contracts";
import { definePlugin, Events, Hooks } from "@basis/core";

export const InteractionConfig = Schema.UndefinedOr(Schema.Struct({
  /** Fail a pending request with `Timeout` after this long. Absent: wait for the answerer. */
  timeoutMs: Schema.optional(Schema.Number),
}));
export type InteractionConfig = typeof InteractionConfig.Type;

type Answer<T extends InteractionRequest["type"]> = Extract<InteractionAnswer, { type: T }>["value"];

/**
 * Every question becomes an `InteractionHook` invocation. Whichever UI or
 * transport plugin is attached answers by handling the hook; the terminal is
 * reached only when nobody does, and fails `Unavailable`. Nothing here knows
 * how a question is displayed.
 */
export default definePlugin({
  id: "interaction",
  config: InteractionConfig,
  provides: [Interaction],
  layer: (config) => Layer.effect(Interaction, Effect.gen(function* () {
    const hooks = yield* Hooks;
    const events = yield* Events;
    const timeout = config?.timeoutMs === undefined ? undefined : Duration.millis(config.timeoutMs);

    const request = <T extends InteractionRequest["type"]>(request: Extract<InteractionRequest, { type: T }>): Effect.Effect<Answer<T>, InteractionError> => {
      const asked = hooks.invoke(InteractionHook, request, unavailable).pipe(
        Effect.flatMap((answer) => answer.type === request.type
          ? Effect.succeed(answer.value as Answer<T>)
          : Effect.fail(new InteractionError({ reason: "Unavailable", message: `"${request.title}" is a ${request.type} request but was answered as ${answer.type}` }))),
        Effect.catchTags({
          HookError: (error) => new InteractionError({ reason: "Unavailable", message: error.message }),
          CoreClosed: (error) => new InteractionError({ reason: "Unavailable", message: error.message }),
        }),
      );
      return timeout === undefined ? asked : asked.pipe(Effect.timeoutFail({
        duration: timeout,
        onTimeout: () => new InteractionError({ reason: "Timeout", message: `"${request.title}" was not answered within ${Duration.format(timeout)}` }),
      }));
    };

    return {
      confirm: (title, detail) => request({ type: "confirm", id: crypto.randomUUID(), title, ...(detail === undefined ? {} : { detail }) }),
      ask: (title, options) => request({
        type: "ask", id: crypto.randomUUID(), title,
        ...(options?.placeholder === undefined ? {} : { placeholder: options.placeholder }),
        ...(options?.secret === undefined ? {} : { secret: options.secret }),
      }),
      select: <V extends string>(title: string, options: readonly { readonly value: V; readonly label: string; readonly description?: string }[]) =>
        request({ type: "select", id: crypto.randomUUID(), title, options }).pipe(
          Effect.filterOrFail(
            (value): value is V => options.some((option) => option.value === value),
            (value) => new InteractionError({ reason: "Unavailable", message: `Selected "${value}" is not one of the offered options` }),
          ),
        ),
      openUrl: (title, url, options) => request({ type: "open-url", id: crypto.randomUUID(), title, url, expectCode: options?.expectCode ?? false }),
      notify: (message, level = "info") => events.publish(Notice, { level, message }),
    };
  })),
});

const unavailable = (request: InteractionRequest): Effect.Effect<never, InteractionError> =>
  Effect.fail(new InteractionError({ reason: "Unavailable", message: `No client is attached to answer "${request.title}"` }));
