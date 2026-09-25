import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BunSocket } from "@effect/platform-bun";
import { Data, Effect, Schema } from "effect";
import type { Layer, Scope } from "effect";
import { HostClient, layerHostClientWith, makeHostClientWith } from "./client.ts";
import type { HostClientOptions, HostClientService } from "./client.ts";

export * from "./index.ts";

export const makeHostClient = (options: HostClientOptions): Effect.Effect<HostClientService, never, Scope.Scope> =>
  makeHostClientWith(options, BunSocket.layerWebSocketConstructor);

export const layerHostClient = (options: HostClientOptions): Layer.Layer<HostClient> =>
  layerHostClientWith(options, BunSocket.layerWebSocketConstructor);

/** What the transport plugin writes to `<home>/host.json` while it runs. */
export const HostFile = Schema.Struct({ url: Schema.String, token: Schema.String, pid: Schema.Number });
export type HostFile = typeof HostFile.Type;

export class DiscoveryError extends Data.TaggedError("DiscoveryError")<{
  readonly reason: "NotFound" | "Invalid" | "Stale";
  readonly path: string;
  readonly message: string;
}> {}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else; still alive.
    return (error as { code?: string }).code === "EPERM";
  }
};

/**
 * Finds the running host through its discovery file. `home` defaults to
 * `$BASIS_HOME` or `~/.basis`. A file whose process is gone is reported as
 * `Stale` rather than handed out as a dead address.
 */
export const discoverHost = (options: { readonly home?: string } = {}): Effect.Effect<HostFile, DiscoveryError> => {
  const home = options.home ?? process.env["BASIS_HOME"] ?? join(homedir(), ".basis");
  const path = join(home, "host.json");
  return Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: () => new DiscoveryError({ reason: "NotFound", path, message: `No host discovery file at ${path}; is the host running?` }),
  }).pipe(
    Effect.flatMap((text) => Schema.decodeUnknown(Schema.parseJson(HostFile))(text).pipe(
      Effect.mapError((error) => new DiscoveryError({ reason: "Invalid", path, message: `Unreadable host discovery file ${path}: ${error.message}` })),
    )),
    Effect.filterOrFail(
      (entry) => alive(entry.pid),
      (entry) => new DiscoveryError({ reason: "Stale", path, message: `Host process ${entry.pid} named in ${path} is not running` }),
    ),
  );
};
