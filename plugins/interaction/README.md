# @basis/plugin-interaction

Provides `Interaction` (`confirm`, `ask`, `select`). Every question becomes an `InteractionRequest` with a fresh `randomUUID()` id and runs `InteractionHook`; whichever UI or transport plugin is attached answers by handling the hook. This plugin knows nothing about how a question is displayed. No config.

## Behavior

- No handler answers (nothing attached): the terminal fails `Unavailable`. Hook and core errors are also reported as `Unavailable`, so callers only see `InteractionError`.
- The answer must match the request type, and a `select` answer must be one of the offered options; anything else fails `Unavailable` naming the question. An answerer that breaks the protocol is treated as no usable answerer rather than as a defect, so a login flow or tool recovers the same way as when nobody is attached.
- Interrupting the asking fiber interrupts the handler chain, which withdraws the question (the transport then tells clients to close it).
