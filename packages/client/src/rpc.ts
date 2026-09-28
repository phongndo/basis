import { Effect, Layer } from "effect";
import type { Scope } from "effect";
import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import type { RpcClientError, RpcGroup } from "@effect/rpc";
import { HostRpcs } from "@basis/contracts";

/** The typed Effect surface: `rpc.Session.List({})`, `rpc.Host.Events()`, ... */
export type HostRpcClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof HostRpcs>, RpcClientError.RpcClientError>;

/**
 * `ws(s)://<origin>/rpc?token=…` for a page or host base URL. `http:` maps to
 * `ws:` and `https:` to `wss:`; an explicit `ws(s):` URL is kept.
 */
export const rpcUrl = (base: string, token: string | undefined): string => {
  const url = new URL("/rpc", base);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (token !== undefined && token !== "") url.searchParams.set("token", token);
  return url.toString();
};

/**
 * Connects for the lifetime of the scope over one multiplexed WebSocket with
 * JSON serialization. The socket reconnects by itself; calls in flight when it
 * drops fail with `RpcClientError`, and calls made while it is down fail fast.
 */
export const makeHostRpc = (
  url: string,
  webSocket: Layer.Layer<Socket.WebSocketConstructor> = Socket.layerWebSocketConstructorGlobal,
): Effect.Effect<HostRpcClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const protocol = RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
      Layer.provide(Socket.layerWebSocket(url)),
      Layer.provide(webSocket),
      Layer.provide(RpcSerialization.layerJson),
    );
    const context = yield* Layer.build(protocol);
    return yield* RpcClient.make(HostRpcs).pipe(Effect.provide(context));
  });
