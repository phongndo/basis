# @basis/client

Typed client for a running host's `HostRpcs` (`@basis/contracts`), used by the web app, the desktop shell, and the CLI. It wraps `RpcClient.make(HostRpcs)` from `@effect/rpc`; every method is the Rpc name split on its prefix: `client.Session.List({})`, `client.Agent.Prompt({...})`, `client.Host.Events()`.

## Use

Pick the entry for the runtime; the root export has no connector and imports no platform module.

```ts
import { Effect, Stream } from "effect";
import { discoverHost, makeHostClient, hostEvents } from "@basis/client/bun"; // or "@basis/client/browser"

const program = Effect.scoped(Effect.gen(function* () {
  const { url, token } = yield* discoverHost();                    // Bun only: reads <home>/host.json
  const client = yield* makeHostClient({ url, token, transport: "websocket" });
  const sessions = yield* client.Session.List({});
  yield* hostEvents(client).pipe(Stream.runForEach((event) => Effect.log(event.type)));
}));
```

- `makeHostClient({ url, token, transport })` connects for the lifetime of the scope. `"websocket"` multiplexes everything on one socket (`/rpc`, token as `?token=`, JSON) and reconnects the socket by itself; requests in flight when it drops fail with `RpcClientError`. `"http"` posts each call to `/rpc/http` (`Authorization: Bearer`, NDJSON) and streams the response. `layerHostClient(options)` provides the same client as the `HostClient` tag.
- `discoverHost({ home? })` reads `host.json` from `home`, `$BASIS_HOME`, or `~/.basis`, and fails with `DiscoveryError` (`NotFound`, `Invalid`, or `Stale` when the recorded process is gone).
- `hostEvents(client, { backoff? })` is `Host.Events` that outlives the connection: a subscription that fails after delivering ends with a synthetic warning `notice` (source `client`), re-subscribes under the backoff (default exponential from 250ms capped at 5s, forever), and precedes the first event of the new subscription with an info `notice`. Events published during the outage are gone; resync from `Session.Entries` when that notice arrives. The transport also emits its own `notice` (source `transport`) as the first element of every subscription, once the subscription is in place on the host.
- `makeHostClientWith(options, webSocketConstructorLayer)` from the root export builds a client for any runtime that can supply `Socket.WebSocketConstructor`.

## Rationale

Two entry points rather than runtime detection keep the browser bundle free of Bun and Node imports, which bundlers otherwise have to stub. The events wrapper marks disconnection and recovery only around actual deliveries: an attempt that fails before delivering anything is silent, so a host that is down at startup does not produce a stream of notices.

## Test

```sh
nix develop -c bun run --cwd packages/client check
nix develop -c bun test packages/client
```

Unit tests cover the reconnecting wrapper with a scripted client and `discoverHost` with temporary files; the live round trip over both protocols is in `plugins/transport/tests`.
