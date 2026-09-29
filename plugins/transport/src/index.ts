import { randomBytes } from "node:crypto";
import { Effect, Layer, Schema } from "effect";
import { Agent, Commands, HostControl, HostRpcs, InteractionHook, Llm, Notice, Paths, secret, Sessions, Workspace } from "@lemma/contracts";
import { definePlugin, Events, PluginContext } from "@lemma/core";
import { makeHandlers } from "./handlers.ts";
import { makeHub } from "./hub.ts";
import type { Hub } from "./hub.ts";
import { makeInteractions } from "./interactions.ts";
import { makeLogins } from "./logins.ts";
import { publishDiscovery } from "./discovery.ts";
import { startServer } from "./server.ts";

export { Discovery, discoveryPath, readDiscovery } from "./discovery.ts";
export { toHostError, toPluginStatus } from "./errors.ts";

/** Reported by `Host.Info` and as the plugin version. */
export const VERSION = "0.1.0";

export const TransportConfig = Schema.Struct({
  host: Schema.optionalWith(Schema.String, { default: () => "127.0.0.1" }).annotations({
    description: "Loopback by default; set explicitly to expose the host beyond this machine.",
  }),
  port: Schema.optionalWith(Schema.Number.pipe(Schema.int(), Schema.between(0, 65535)), { default: () => 7433 }).annotations({
    description: "0 asks the OS for a free port; the chosen one lands in transport.json.",
  }),
  token: Schema.optional(Schema.NonEmptyString).annotations({
    ...secret,
    description: "Generated once per host process when absent, so plugin restarts keep it.",
  }),
  staticDir: Schema.optional(Schema.String).annotations({
    description: "A built web app served at /, with index.html as the fallback for client-side routes.",
  }),
  interactionGraceMs: Schema.optionalWith(Schema.Number.pipe(Schema.nonNegative()), { default: () => 15_000 }).annotations({
    description: "How long an open interaction waits for a client to (re)connect before failing Unavailable.",
  }),
});
export type TransportConfig = typeof TransportConfig.Type;

/** A wildcard bind is reachable locally through loopback; that is what the discovery file should say. */
/**
 * Generated once per host process, not per start: plugin modules are imported
 * once, so a restart (a config change here or in a dependency) keeps the token
 * that connected clients and the web app's tokenized link already hold.
 */
const generatedToken = randomBytes(24).toString("base64url");

const clientHost = (hostname: string): string => {
  if (hostname === "0.0.0.0") return "127.0.0.1";
  if (hostname === "::") return "[::1]";
  return hostname.includes(":") ? `[${hostname}]` : hostname;
};

export default definePlugin({
  id: "transport",
  version: VERSION,
  config: TransportConfig,
  requires: [Paths, Sessions, Agent, Llm, HostControl, Workspace, Commands],
  // Owns the listening port: a reload stops this instance before starting its replacement.
  exclusive: true,
  layer: (config) =>
    Layer.scopedDiscard(
      Effect.gen(function* () {
        const owner = yield* PluginContext;
        const events = yield* Events;
        const [paths, sessions, agent, llm, control, workspace, commands] = yield* Effect.all([Paths, Sessions, Agent, Llm, HostControl, Workspace, Commands]);

        let hub: Hub | undefined;
        const interactions = makeInteractions(() => hub!, config.interactionGraceMs);
        hub = yield* makeHub(owner, interactions.open);
        yield* owner.on(InteractionHook, interactions.handle);

        const token = config.token ?? generatedToken;
        const login = makeLogins(llm, yield* Effect.scope);
        const handlers = HostRpcs.toLayer(
          makeHandlers({ version: VERSION, hub, interactions, paths, sessions, agent, llm, control, workspace, commands, login }),
        );
        const address = yield* startServer(
          { host: config.host, port: config.port, token, version: VERSION, staticDir: config.staticDir, ui: control.ui },
          handlers,
        );
        const url = `http://${clientHost(address.hostname)}:${address.port}`;
        yield* publishDiscovery(paths.home, { url, token, pid: process.pid, startedAt: Date.now() });
        yield* events.publish(Notice, {
          level: "info",
          source: owner.id,
          message: `Listening on ${url}`,
          ...(config.staticDir === undefined ? {} : { links: [{ url: `${url}/?token=${encodeURIComponent(token)}`, label: "Open the web app" }] }),
        });
      }),
    ),
});
