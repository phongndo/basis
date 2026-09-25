import { Effect, Duration, Deferred } from "effect";
const t0 = Date.now();
const r = await Effect.runPromise(Effect.uninterruptible(Effect.gen(function* () {
  const d = yield* Deferred.make<void>();
  const a = yield* Deferred.await(d).pipe(Effect.disconnect, Effect.timeoutOption(Duration.millis(50)));
  const b = yield* Effect.never.pipe(Effect.disconnect, Effect.timeoutFail({ duration: Duration.millis(50), onTimeout: () => "late" }), Effect.either);
  return [a._tag, b._tag, Date.now() - t0];
})));
console.log(r);
