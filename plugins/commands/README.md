# @lemma/plugin-commands

Provides `Commands` (`@lemma/contracts`): the registry of actions a person can
run from any client, such as the web app's command palette (Cmd+K on macOS,
Ctrl+K elsewhere) or `lemma do <id>`. Command plugins require `Commands` and
register during activation. A command that needs input asks for it with
`Interaction`, so every client that can answer questions can run it.

```ts
const greet = definePlugin({
  id: "greet",
  requires: [Commands, Interaction],
  exclusive: true, // the registry rejects duplicate ids; see below
  layer: Layer.scopedDiscard(
    Effect.gen(function* () {
      const [commands, ask] = yield* Effect.all([Commands, Interaction]);
      yield* commands.register({
        id: "greet.hello",
        title: "Say hello…",
        category: "Examples",
        run: ({ cwd }) => Effect.map(ask.ask("Your name?"), (name) => ({ message: `Hello, ${name}, in ${cwd}` })),
      });
    }),
  ),
});
```

No config.

## Behavior

- `register` records the registering plugin's id as `source` and removes the command when that plugin's scope closes. A duplicate id fails `Failed` and names the plugin that registered it first. Mark contributors `exclusive` so a reload unregisters the old command before the new one registers.
- Every registration and removal publishes `CommandsChanged` with the full list. The transport forwards it to clients as `commands-changed`.
- `run` passes the caller's context (`cwd`, and `sessionId` when the client has a session open). Failures and defects become `CommandError` with reason `Failed` and the original message. A dismissed question becomes `Cancelled`, which clients treat as a quiet stop rather than an error. An unknown id is `NotFound`. Interruption, such as a dropped client, interrupts the command.
- `list` is sorted by category, then title.
