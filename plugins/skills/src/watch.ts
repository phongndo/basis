import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { Deferred, Duration, Effect, Exit } from "effect";
import { subdirectories } from "./discover.ts";

interface Watchers {
  /** Completed by the first change on any watched directory. */
  readonly changed: Deferred.Deferred<void>;
  readonly close: () => void;
}

/**
 * Watch each root and its immediate subdirectories (recursive watching does not
 * see into directories created later on every platform). Roots that do not
 * exist are not watched; they appear only after a manual refresh or restart.
 */
const open = (roots: readonly string[]): Effect.Effect<Watchers> =>
  Effect.gen(function* () {
    const changed = yield* Deferred.make<void>();
    const signal = () => { Deferred.unsafeDone(changed, Exit.void); };
    const watchers: FSWatcher[] = [];
    for (const root of roots) {
      for (const directory of [root, ...(yield* subdirectories(root))]) {
        try {
          const watcher = watch(directory, signal);
          watcher.on("error", signal);
          watchers.push(watcher);
        } catch {
          // Not there (yet); the parent watcher reports its creation.
        }
      }
    }
    return { changed, close: () => { for (const watcher of watchers) watcher.close(); } };
  });

/**
 * Opens the watchers now and returns the loop that runs `refresh` after each
 * burst of changes, re-establishing watchers so newly created skills are
 * covered. Opening eagerly means a change right after activation is not missed.
 */
export const watchSources = (roots: readonly string[], refresh: Effect.Effect<void>, debounce = Duration.millis(200)): Effect.Effect<Effect.Effect<never>> =>
  Effect.map(open(roots), (initial) => {
    let current = initial;
    const loop: Effect.Effect<never> = Effect.gen(function* () {
      while (true) {
        yield* Deferred.await(current.changed);
        yield* Effect.sleep(debounce);
        // Open the next set before closing the old one so no change falls between them.
        const next = yield* open(roots);
        current.close();
        current = next;
        yield* refresh;
      }
    });
    return loop.pipe(Effect.ensuring(Effect.sync(() => current.close())));
  });
