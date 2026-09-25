# @basis/plugin-interaction

Provides `Interaction`: `confirm`, `ask`, `select`, `openUrl`, and `notify`. Every question becomes an `InteractionRequest` with a fresh `crypto.randomUUID()` id and runs `InteractionHook`; whichever UI or transport plugin is attached answers by handling the hook. The plugin knows nothing about how a question is displayed.

## Config

```jsonc
{ "plugins": { "interaction": { "config": { "timeoutMs": 300000 } } } }
```

`timeoutMs` (optional): a pending request fails with `InteractionError { reason: "Timeout" }` after this long, interrupting the handler. Without it, a request waits for the answerer.

## Behavior

- No handler (nothing attached): the terminal fails `Unavailable`. Hook and core errors are also reported as `Unavailable`, so callers only see `InteractionError`.
- The answer must match the request type, and a `select` answer must be one of the offered options; anything else fails `Unavailable` with a message naming the request. An answerer that violates the protocol is treated as no usable answerer rather than as a defect, so a login flow or tool can recover the same way it would when nobody is attached.
- `notify` publishes a `Notice` event. Events are losable; anything the user must not miss belongs in a session entry or a direct call, not here.
