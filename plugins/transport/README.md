# @basis/plugin-transport

Serves `HostRpcs` from `@basis/contracts` over HTTP and WebSocket with `@effect/rpc`, so the web app, the desktop shell, and `basis attach` can drive a running host. Requires `Agent`, `Sessions`, `Llm`, `Credentials`, `HostControl`, and `Paths`; provides nothing and answers `InteractionHook` for connected clients. Marked `exclusive`: it owns the port, so a reload stops the old instance before starting the new one.

## Use

```jsonc
{ "plugins": { "transport": { "config": { "port": 4096 } } } }
```

| Config | Default | Meaning |
| --- | --- | --- |
| `host` | `"127.0.0.1"` | Bind address. Loopback unless set explicitly; set it to expose the host beyond this machine. |
| `port` | `4096` | `0` asks the OS for a free port. |
| `token` | generated | Bearer token every request must present. A generated one is logged once at activation. |

Endpoints, all behind the token (`Authorization: Bearer <token>`, or `?token=` for WebSocket upgrades, whose browser API cannot set headers; anything else is `401`):

- `GET /rpc` WebSocket, JSON: one multiplexed connection for long-lived clients.
- `POST /rpc/http` NDJSON: one request per call, streamed so `Session.Entries` and `Host.Events` do not buffer.
- `GET /health` → `{ ok: true, version }`.

While active the plugin writes `<Paths.home>/host.json` as `{ url, token, pid }` (mode 0600) and removes it on dispose unless another host has replaced it; `discoverHost()` in `@basis/client/bun` reads it. Connect with `@basis/client`.

## Behavior

- **Errors.** Domain errors cross the wire as `HostError` with `code` = `<tag>.<reason>` (`SessionError.NotFound`, `AgentError.Busy`), `subject` = the session, provider, or plugin concerned, and `retryable` when the error type implies it (`Busy`, `Io`, `LlmError.retryable`). Kernel errors keep their tag (`ReloadError`, `CoreClosed`).
- **`Host.Events`.** One subscription per call. Kernel events (`ModelEvent`, `TurnStarted`, `TurnEnded`, `SessionAppended`, `SessionChanged`, `Notice`, `PluginsChanged`) are observed once, at activation, and copied into each subscriber's bounded drop-oldest queue (512 entries): a slow client loses old model deltas, never the publisher's time, and resyncs from `Session.Entries`. Kinds are observed through independent queues, so `turn-ended` may arrive before the last delta; treat the `session-appended` message as the durable text. The first element of every subscription is a `notice` from source `transport`; anything published after it reaches this subscriber. The `@effect/rpc` client sends stream requests asynchronously, so wait for that marker before acting when you need to see the effects of your own calls.
- **Interaction.** With at least one `Host.Events` subscriber, an `InteractionHook` request is broadcast as an `interaction` event (through a queue that never drops) and the handler waits: the first `Interaction.Answer` wins, later answers get `Interaction.Closed`, `Interaction.Dismiss` fails the request with `Dismissed`, and the last subscriber disconnecting fails it with `Unavailable`. `interaction-closed` tells other clients to drop the dialog. With no subscriber the request passes to the next handler (a TUI), and if nothing answers the interaction plugin's terminal reports `Unavailable`.
- **`Agent.Preview`.** The `Agent` contract has no preview. If the agent service exposes `preview(sessionId, options)` it is called; otherwise the call fails with `HostError` code `Unsupported`.
- **`Host.*`** map to `HostControl`; `Host.Plugins` converts `PluginSnapshot` to the serializable `PluginStatus` (fault phase, operation, squashed cause message).

## Rationale

Two protocols share one handler set because their consumers differ: a UI keeps a socket and multiplexes everything; a script or a CLI subcommand wants one HTTP call that returns when done. Authentication is a router middleware rather than RPC middleware so the WebSocket upgrade and `/health` are covered by the same check. Interaction goes through the hook, not an event, because a question the user never sees must fail the operation rather than hang it; the event stream is only the delivery vehicle, and its disconnect semantics turn into hook failures.

## Test

```sh
nix develop -c bun run --cwd plugins/transport check
nix develop -c bun test plugins/transport
```

The end-to-end test mounts the plugin with in-memory fakes on an ephemeral port and drives it with `@basis/client` over both protocols.
