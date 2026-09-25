import { Context, Effect, Layer } from "effect";
import type { Scope } from "effect";
import { FileSystem, HttpMiddleware, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import type { Rpc, RpcGroup } from "@effect/rpc";
import { HostRpcs } from "@basis/contracts";

export type HostHandlers = Layer.Layer<Rpc.ToHandler<RpcGroup.Rpcs<typeof HostRpcs>>>;

export interface ServerOptions {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly version: string;
}

export interface Server {
  readonly address: HttpServer.TcpAddress;
  /** Bun's file system, for the discovery file next to the server it describes. */
  readonly fs: FileSystem.FileSystem;
}

const equalTokens = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Bearer header for HTTP; `?token=` for WebSocket, whose browser API cannot set headers. */
const presented = (request: HttpServerRequest.HttpServerRequest): string | undefined => {
  const header = request.headers["authorization"];
  if (header !== undefined && header.startsWith("Bearer ")) return header.slice("Bearer ".length);
  const query = request.url.indexOf("?");
  if (query === -1) return undefined;
  return new URLSearchParams(request.url.slice(query + 1)).get("token") ?? undefined;
};

/** Every route, including the WebSocket upgrade and `/health`, sits behind the token. */
const authenticate = (token: string) => HttpMiddleware.make((app) => Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const candidate = presented(request);
  if (candidate === undefined || !equalTokens(candidate, token)) {
    return HttpServerResponse.unsafeJson({ error: "Unauthorized" }, { status: 401 });
  }
  return yield* app;
}));

const health = (version: string) => HttpRouter.Default.use((router) =>
  router.get("/health", HttpServerResponse.unsafeJson({ ok: true, version })),
);

/** Two protocols, one handler set: WebSocket for clients that stay, streaming HTTP for one-shot callers. */
const websocket = RpcServer.layer(HostRpcs).pipe(
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
);
const http = RpcServer.layer(HostRpcs).pipe(
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc/http" })),
  Layer.provide(RpcSerialization.layerNdjson),
);

/**
 * Binds the address and serves until the scope closes. Routes register into
 * the shared default router before `serve` snapshots it, so the order of the
 * provided layers is load-bearing.
 */
export const startServer = (options: ServerOptions, handlers: HostHandlers): Effect.Effect<Server, never, Scope.Scope> =>
  Effect.gen(function* () {
    const listener = BunHttpServer.layer({ hostname: options.host, port: options.port });
    const routes = HttpRouter.Default.serve(authenticate(options.token)).pipe(
      Layer.provide(Layer.mergeAll(websocket, http, health(options.version))),
      Layer.provide(handlers),
    );
    const context = yield* Layer.build(Layer.provideMerge(routes, listener));
    const address = Context.get(context, HttpServer.HttpServer).address;
    if (address._tag !== "TcpAddress") return yield* Effect.dieMessage("Expected a TCP listener");
    return { address, fs: Context.get(context, FileSystem.FileSystem) };
  });
