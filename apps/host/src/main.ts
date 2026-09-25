import { Effect } from "effect";
import { makeCore } from "@basis/core";

// Mounts an empty composition. Plugin loading, transport, and the agent come later.
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const core = yield* makeCore([]);
  const { state, plugins } = yield* core.inspect;
  console.log(`basis host: core ${state} with ${plugins.length} plugins (no loader or transport yet)`);
})));
