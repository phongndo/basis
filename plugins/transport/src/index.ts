import { Effect, Layer, Schema } from "effect";
import type { FileSystem } from "@effect/platform";
import { definePlugin, PluginContext } from "@basis/core";
import { Agent, Credentials, HostControl, HostRpcs, InteractionHook, Llm, Paths, Sessions } from "@basis/contracts";
import { makeHandlers } from "./handlers.ts";
import { makeHub } from "./hub.ts";
import { makeInteractions } from "./interactions.ts";
import { startServer } from "./server.ts";

export { toHostError } from "./errors.ts";

export const TransportConfig = Schema.Struct({
  /** Loopback by default; set explicitly to expose the host beyond this machine. */
  host: Schema.optionalWith(Schema.String, { default: () => "127.0.0.1" }),
  /** `0` asks the OS for a free port; the chosen one lands in `host.json`. */
  port: Schema.optionalWith(Schema.Number, { default: () => 4096 }),
  /** Generated at activation when absent. */
  token: Schema.optional(Schema.String),
});
export type TransportConfig = typeof TransportConfig.Type;

/** Written to `<home>/host.json` so local clients can find a running host. */
export const HostFile = Schema.Struct({ url: Schema.String, token: Schema.String, pid: Schema.Number });
export type HostFile = typeof HostFile.Type;

const generateToken = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** A wildcard bind is reachable locally through loopback; that is what the discovery file should say. */
const clientHost = (hostname: string): string => {
  if (hostname === "0.0.0.0") return "127.0.0.1";
  if (hostname === "::" || hostname === "::1") return "[::1]";
  return hostname.includes(":") ? `[${hostname}]` : hostname;
};

/** Present while the plugin runs; removed on dispose unless another host has since replaced it. */
const publishHostFile = (fs: FileSystem.FileSystem, home: string, entry: HostFile) => {
  const path = `${home}/host.json`;
  const ours = fs.readFileString(path).pipe(
    Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(HostFile))),
    Effect.map((current) => current.pid === entry.pid && current.url === entry.url),
    Effect.orElseSucceed(() => false),
  );
  return Effect.acquireRelease(
    Effect.gen(function* () {
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.writeFileString(path, JSON.stringify(entry, null, 2), { mode: 0o600 });
    }),
    () => Effect.whenEffect(fs.remove(path), ours).pipe(Effect.ignore),
  );
};

export default definePlugin({
  id: "transport",
  version: "0.1.0",
  config: TransportConfig,
  requires: [Agent, Sessions, Llm, Credentials, HostControl, Paths],
  // Owns the listening port: a reload stops this instance before starting its replacement.
  exclusive: true,
  layer: (config) => Layer.scopedDiscard(Effect.gen(function* () {
    const owner = yield* PluginContext;
    const paths = yield* Paths;
    const [agent, sessions, llm, credentials, control] = yield* Effect.all([Agent, Sessions, Llm, Credentials, HostControl]);

    const hub = yield* makeHub(owner);
    const interactions = makeInteractions(hub);
    yield* owner.on(InteractionHook, interactions.handle, { order: 0 });

    const token = config.token ?? generateToken();
    const handlers = HostRpcs.toLayer(makeHandlers({ hub, interactions, agent, sessions, llm, credentials, control }));
    const server = yield* startServer({ host: config.host, port: config.port, token, version: owner.version ?? "0.0.0" }, handlers);
    const url = `http://${clientHost(server.address.hostname)}:${server.address.port}`;
    yield* publishHostFile(server.fs, paths.home, { url, token, pid: process.pid });
    yield* Effect.logInfo(`transport listening on ${url} (token ${token})`);
  })),
});
