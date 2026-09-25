import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect, Fiber, Stream } from "effect";
import { resolvePaths, watchConfig } from "../src/index.ts";

describe("watchConfig", () => {
  test("emits the changed file after a quiet period, for creation and later edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "basis-watch-"));
    try {
      const paths = resolvePaths({ env: { BASIS_HOME: join(root, "home") }, cwd: join(root, "project") });
      await mkdir(paths.home, { recursive: true });
      await mkdir(join(paths.cwd, ".basis"), { recursive: true });
      await writeFile(paths.userConfig, "{}");
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const seen = yield* Effect.fork(Stream.runCollect(Stream.take(watchConfig(paths, { debounceMs: 50 }), 2)));
        // Let the watchers attach before writing.
        yield* Effect.sleep(Duration.millis(50));
        yield* Effect.promise(() => writeFile(paths.projectConfig, `{ "plugins": {} }`));
        yield* Effect.sleep(Duration.millis(150));
        yield* Effect.promise(() => writeFile(paths.userConfig, `{ "plugins": { "x": {} } }`));
        const changes = [...(yield* Fiber.join(seen).pipe(Effect.timeout(Duration.seconds(5))))];
        expect(changes).toEqual([paths.projectConfig, paths.userConfig]);
      })));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
