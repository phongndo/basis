# @basis/plugin-compaction

Keeps a session's model view inside the context window. Requires `Sessions` and `Llm`; provides nothing. It registers an `AgentRequestHook` handler at order 100, after prompt-shaping plugins, so it measures the request as it will actually be sent.

```ts
import compaction from "@basis/plugin-compaction";
const core = yield* makeCore([..., sessions, llm, compaction], { configs: { compaction: { reserveTokens: 20000 } } });
```

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `reserveTokens` | `16384` | Tokens kept free below `ModelInfo.contextWindow` for the reply and tool results. |

Config may be omitted entirely.

## Behavior

On every model call:

1. Estimate the request size. This is the larger of the last `TurnEnded` usage seen for the session (`input + output + cacheRead + cacheWrite`) and `chars / 4` over the system prompt, messages, and tool definitions. The usage is exact for what it measured but stale within a turn; the character estimate tracks growth since.
2. If the estimate is at or under `contextWindow - reserveTokens`, pass the request through. Unknown models (no `ModelInfo`) always pass through.
3. Otherwise, ask the same model for a summary of the request's messages (the prompt asks it to keep the user's goals, decisions, file paths, exact identifiers, what is done, and what is open), append `{ type: "compaction", summary, tokensBefore }` to the session, rebuild `messages` from `Sessions.context`, and call `next` with the rebuilt request. The summary becomes the first user message, prefixed with `SUMMARY_MARKER` ("Summary of earlier conversation (compacted):"). A `Notice` (level `info`, source `compaction`) reports it.

At most one compaction happens per turn: the guard is set when compacting and cleared by `TurnStarted`, `TurnEnded`, or any later request that is under the threshold. The stored usage is dropped after compacting so the next estimate reflects the rebuilt request.

If the summary call or the append fails, the request is passed through unchanged and a `Notice` (level `error`) says why. The hook does not fail the turn: an oversize request then fails at the provider with `ContextTooLong`, which reaches the user through the agent's error path, so the notice is not the only signal.

## Rationale

The compaction entry is written to the session before the rebuilt request is sent, so a crash mid-turn leaves the summary in the file rather than only in memory. `rebuildMessages` is exported so a UI can show the model's view of a compacted path; `estimateTokens` is exported so the same heuristic can be shown next to the window.
