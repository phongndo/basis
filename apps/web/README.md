# @basis/web

Browser chat client for a running host, built with SolidJS on `@basis/client/browser`. The desktop shell loads the same build from `dist/`.

## Run

```sh
nix develop -c bun run host:dev   # one terminal: the host, which writes ~/.basis/host.json
nix develop -c bun run web:dev    # another: Vite at http://127.0.0.1:5173
```

Open the printed URL with the host's address and token from `~/.basis/host.json` (or `$BASIS_HOME/host.json`):

```
http://127.0.0.1:5173/?host=http://127.0.0.1:4096&token=<token>
```

Without query parameters the app uses the last saved connection, or shows a connect form. The host URL defaults to `http://127.0.0.1:4096`. The settings live in `localStorage` until you disconnect.

## What it does

- **Sessions.** `Session.List` (every project the host knows; newest first), `Session.Create` in the host's working directory, and the title or the first user message as the label. The active session's `Session.Context` is re-read whenever the host appends to it and after every reconnect, so the durable record always wins.
- **Chat.** Entries render as user and assistant messages: text, images, thinking (collapsed), tool calls and results (collapsed). While a turn runs, `model` events stream text, thinking, and tool-call input into a draft that the appended assistant entry replaces. Enter sends (`Agent.Prompt`), Shift+Enter inserts a newline, Cancel calls `Agent.Cancel`. The model picker lists `Llm.Models` and remembers the choice per session; the footer shows the last turn's usage and how it ended.
- **Interaction.** `interaction` events (confirm, ask, select, open-url) open a modal answered through `Interaction.Answer`; Dismiss (or Escape) calls `Interaction.Dismiss`. `interaction-closed` removes a dialog another client answered.
- **Plugins.** The panel shows `Host.Plugins` with state and fault, restarts one (`Host.RestartPlugin`) or reloads the composition (`Host.Reload`), and follows `plugins-changed`. `notice` events appear as toasts; the connection status in the top bar follows the reconnecting `hostEvents` wrapper.

Plain CSS, light and dark through `prefers-color-scheme`, and a drawer layout below 720px.

## Rationale

- `model` deltas and `session-appended` entries travel on independent queues, so the entry for a message can arrive before its last deltas. The store counts finished and appended assistant messages per turn: a delta whose message is already durable is dropped instead of leaving a stale draft behind.
- The WebSocket client retries silently on a wrong address or token, so connecting probes `Host.Plugins` with a timeout to turn that into an error on the connect form.
- `Message` and `TurnOptions` are Schema classes; the RPC encoder needs instances, not plain objects.

## Check

```sh
nix develop -c bun run web:check    # tsc
nix develop -c bun run web:build    # vite build into dist/
nix develop -c bun run --cwd apps/web test   # store: draft bookkeeping and event handling
```
