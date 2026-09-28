import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { Duration, Effect, Stream } from "effect";
import type { PathsService } from "./paths.ts";

export interface WatchOptions {
  /** Quiet period before a burst of changes becomes one emission. Default 250ms. */
  readonly debounceMs?: number;
}

/**
 * Emits the path of a config file after it changes, is created, or is removed.
 * Watches the containing directories rather than the files, because editors
 * replace files by rename and a project `.basis` directory may not exist yet;
 * a directory that does not exist when the stream starts is not watched.
 */
export function watchConfig(paths: PathsService, options: WatchOptions = {}): Stream.Stream<string> {
  const targets = [...new Set([paths.userConfig, paths.projectConfig])];
  return Stream.async<string>((emit) => {
    const watchers: FSWatcher[] = [];
    for (const target of targets) {
      const name = basename(target);
      try {
        const watcher = watch(dirname(target), (_, changed) => {
          if (changed === null || changed === name) emit.single(target);
        });
        // A watcher error (directory removed) ends this source; the host keeps running without it.
        watcher.on("error", () => { watcher.close(); });
        watchers.push(watcher);
      } catch {
        // Directory absent: nothing to watch until the next start.
      }
    }
    return Effect.sync(() => { for (const watcher of watchers) watcher.close(); });
  }).pipe(Stream.debounce(Duration.millis(options.debounceMs ?? 250)));
}
