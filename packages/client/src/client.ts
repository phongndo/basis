import { Context, Effect, Layer } from "effect";
import type { Scope } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import type { RpcClientError, RpcGroup } from "@effect/rpc";
import { HostRpcs } from "@basis/contracts";

/** The typed remote surface: `client.Session.List({})`, `client.Host.Events()`, ... */
export type HostClientService = RpcClient.RpcClient<RpcGroup.Rpcs<typeof HostRpcs>, RpcClientError.RpcClientError>;

export class HostClient extends Context.Tag("@basis/client/HostClient")<HostClient, HostClientService>() {}

export interface HostClientOptions {
  /** Base URL of the host, e.g. `http://127.0.0.1:4096`. */
  readonly url: string;
  readonly token: string;
  /** WebSocket multiplexes everything on one connection and reconnects; HTTP streams each call separately. */
  readonly transport: "websocket" | "http";
}

const websocketUrl = (base: string, token: string): string => {
  const url = new URL("/rpc", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
};

const protocol = (options: HostClientOptions, webSocket: Layer.Layer<Socket.WebSocketConstructor>): Layer.Layer<RpcClient.Protocol> =>
  options.transport === "websocket"
    // In-flight requests fail when the socket drops; the socket itself keeps reconnecting.
    ? RpcClient.layerProtocolSocket().pipe(
      Layer.provide(Socket.layerWebSocket(websocketUrl(options.url, options.token))),
      Layer.provide(webSocket),
      Layer.provide(RpcSerialization.layerJson),
    )
    : RpcClient.layerProtocolHttp({
      url: new URL("/rpc/http", options.url).toString(),
      // Non-2xx (a 401, say) must fail the call; the protocol folds every client error into RpcClientError,
      // so widening the error type here is invisible to callers.
      transformClient: <E, R>(client: HttpClient.HttpClient.With<E, R>) => client.pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(options.token)),
        HttpClient.filterStatusOk,
      ) as HttpClient.HttpClient.With<E, R>,
    }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(RpcSerialization.layerNdjson),
    );

/**
 * Connects for the lifetime of the scope. The runtime entry points
 * (`@basis/client/bun`, `@basis/client/browser`) supply the WebSocket
 * constructor so this module stays free of platform imports.
 */
export const makeHostClientWith = (
  options: HostClientOptions,
  webSocket: Layer.Layer<Socket.WebSocketConstructor>,
): Effect.Effect<HostClientService, never, Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(protocol(options, webSocket));
    return yield* RpcClient.make(HostRpcs).pipe(Effect.provide(context));
  });

export const layerHostClientWith = (
  options: HostClientOptions,
  webSocket: Layer.Layer<Socket.WebSocketConstructor>,
): Layer.Layer<HostClient> => Layer.scoped(HostClient, makeHostClientWith(options, webSocket));
