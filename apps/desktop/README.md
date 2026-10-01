# @lemma/desktop

The web app in a desktop window. The window shows what the host's `transport`
plugin serves, so it is the same app as in the browser, with the same plugins,
UI files, and `"ui"` rows.

```sh
nix develop -c pnpm desktop   # build the core and the web app, then open the window

# Developing: the window loads the web app's dev server, so web edits hot-reload
nix develop -c pnpm dev:web                              # one terminal
nix develop -c pnpm --filter @lemma/desktop dev          # another; restart it after editing src/main.ts
```

## Behavior

- **Attach first.** Like the CLI, it finds a running host through
  `$LEMMA_HOME/transport.json` and opens its page. With none running, it starts
  one with Electron's Node (`packages/host/src/main.ts --no-open`, the project
  being the directory `pnpm desktop` ran from, else `~`). Never two: the
  sessions store has a single writer.
- **A host it started stops when it quits.** One it attached to keeps running.
  On macOS, closing the last window leaves the app (and its host) running until
  you quit it.
- **Links open in the system browser.** Navigation stays within the host's
  origin.
- The start script clears `ELECTRON_RUN_AS_NODE`, which terminals inside other
  Electron apps can inherit and which would run Electron as plain Node.
