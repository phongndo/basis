# @basis/plugin-agent

Provides `Agent` (`@basis/contracts`): the turn loop. Requires `Sessions`, `Llm`,
`Tools`, and `HostControl`.

```ts
const agent = yield* Agent;
yield* agent.prompt(sessionId, [{ type: "text", text: "Fix the failing test" }]);
yield* agent.cancel(sessionId);
```

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `defaultModel` | first of `Llm.models({ available: true })` | `<provider>/<model>` for turns that name none. |
| `systemPrompt` | pi-style base prompt | Replaces the base section; the environment section is still added. |
| `maxSteps` | `200` | Model calls per turn before it ends with `max-steps`. |
| `cli` | set by `apps/host` to this checkout's CLI | Shell command for the `basis` CLI, named in the environment section so the agent can inspect itself. |

## A turn

1. One turn per session (`Busy` otherwise). The model is resolved (options →
   config → first available) and checked with `Llm.model`; failure is `NoModel`,
   before anything is logged.
2. Appends `turn-start`, the user `message`, and a `title` from the prompt if the
   session has none.
3. Each step: `step-start`; a `RequestDraft` with the base section and an
   environment section (cwd, date, platform, session id, and the `cli` command
   when configured; source `agent`), `Tools.list`, and
   `deriveMessages(branch)`; `AgentRequestHook`; the `request` event with
   per-section and per-tool `contributions`, the `HostControl.composition` id, and
   `system`/`tools` only when they differ from `requestState(branch)`. The request
   actually sent is `rebuildRequest` over the branch ending at that event, so the
   log invariant holds by construction.
4. `Llm.stream`: every event is published as `AssistantDelta`. `done` appends the
   assistant `message` with timing (`firstTokenAt` = first text, thinking, or
   tool-call delta). `error` appends an `attempt` and ends the turn (`cancelled`
   for an aborted stream, else `error`). No automatic retry.
5. Tool calls run in order through `Tools.execute` with the turn's signal; each
   result is appended with timing and `details`. Unknown tools and tool failures
   are error results the model reads.
6. `AgentContinueHook` (default: continue iff `stopReason === "toolUse"`), then
   `step-end`.

`turn-end` is always appended. On cancellation or failure the closing sequence
logs the partial model output as an `attempt`, answers every unanswered tool call
with an error result (so the next request stays valid), then `step-end` and
`turn-end`. `TurnStarted`/`TurnEnded` carry the summed usage.

## Rationale

- **Explicit parents.** After `turn-start`, every append names the previous event
  as its parent, so a `checkout` during a turn cannot splice the turn into another
  branch.
- **Plugin-owned turns.** Turns are forked into the plugin's scope. `prompt` awaits
  the turn, but interrupting the caller does not cancel it; only `cancel` does
  (abort the signal, then interrupt), and it returns after `turn-end` is logged.
  Closing the plugin cancels running turns the same way.
- **Uninterruptible appends.** Each append and the bookkeeping that follows it
  complete together, so a cancel can never leave an event in the log that the
  closing sequence does not know about (which would duplicate tool results).
- **Errors.** LLM failures are recorded in the log (`attempt`, `turn-end` with
  `error`) and `prompt` resolves; `Session` and `Hook` failures also fail `prompt`.
  A cancelled turn resolves normally.
