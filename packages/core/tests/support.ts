import { Duration, Effect } from "effect";

/** Poll until the predicate holds; dies after five seconds so a wrong expectation fails fast. */
export function waitFor<A, E, R>(effect: Effect.Effect<A, E, R>, predicate: (value: A) => boolean): Effect.Effect<A, E, R> {
  const poll: Effect.Effect<A, E, R> = Effect.flatMap(effect, (value) =>
    predicate(value) ? Effect.succeed(value) : Effect.sleep(Duration.millis(2)).pipe(Effect.zipRight(poll)));
  return poll.pipe(Effect.timeout(Duration.seconds(5)), Effect.orDie);
}
