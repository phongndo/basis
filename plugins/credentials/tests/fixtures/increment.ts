// Runs in a separate Node process: increments a counter credential `count` times through the plugin.
import { dirname } from "node:path";
import { Effect, Layer } from "effect";
import { Credentials, Paths } from "@basis/contracts";
import { definePlugin, makeCore } from "@basis/core";
import credentials from "../../src/index.ts";

const [auth, provider, count] = process.argv.slice(2) as [string, string, string];
const home = dirname(auth);
const paths = definePlugin({
  id: "paths", provides: [Paths],
  layer: Layer.succeed(Paths, { home, userConfig: "", projectConfig: "", auth, sessions: "", cwd: home }),
});

await Effect.runPromise(Effect.scoped(Effect.flatMap(makeCore([paths, credentials]), (core) => core.run(Effect.gen(function* () {
  const service = yield* Credentials;
  for (let i = 0; i < Number(count); i++) {
    yield* service.modify(provider, (current) => Effect.succeed({
      type: "api_key" as const, key: String(Number(current?.type === "api_key" ? current.key : 0) + 1),
    }));
  }
})))));
