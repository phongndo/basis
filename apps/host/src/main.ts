import { Effect } from "effect";
import { Diagnostic, makeLoader } from "@basis/core";
import type { Plugin } from "@basis/core";

// Bundled plugins by id. Shipped plugins register here; config loading and transport come later.
const bundled = new Map<string, Plugin>();

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const loader = yield* makeLoader({
    source: {
      resolve: (id) => {
        const plugin = bundled.get(id);
        return plugin ? Effect.succeed(plugin) : Effect.fail(new Diagnostic({ severity: "error", pluginId: id, message: `No bundled plugin "${id}"` }));
      },
    },
    composition: { plugins: {} },
  });
  const { state, plugins } = yield* loader.core.inspect;
  console.log(`basis host: core ${state} with ${plugins.length} plugins (no config file or transport yet)`);
})));
