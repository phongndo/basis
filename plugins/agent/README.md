# @basis/plugin-agent

Provides `Agent`: the loop that turns a user message into model calls and tool calls until the model stops. Requires `Llm`, `Tools`, and `Sessions` from `@basis/contracts`.

## Use

```ts
import agent from "@basis/plugin-agent";

const core = yield* makeCore([llm, tools, sessions, agent], {
  configs: { agent: { model: "anthropic/claude-opus-5", maxToolRounds: 50 } },
});
yield* core.run(Effect.flatMap(Agent, (a) => a.prompt(sessionId, message, { tools: ["read", "bash"] })));
```

`prompt(sessionId, message, options?)` appends the message, runs the loop, and returns when the turn has ended. `cancel(sessionId)` interrupts a running turn and waits for it to wind down. `busy(sessionId)` reports whether a turn is in progress.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `model` | `anthropic/claude-opus-5` | `<provider>/<model>` used when `TurnOptions.model` is absent |
| `effort` | unset | Reasoning effort when `TurnOptions.effort` is absent |
| `maxToolRounds` | `200` | Rounds of tool execution allowed in one turn |
| `systemPrompt` | built in | Replaces the default prompt entirely |

The default system prompt names the session's working directory, today's date, and how to use tools, and nothing else. Skills, memory, and project instructions are contributed by other plugins through `AgentRequestHook`, which runs before every model call with the complete `LlmRequest`.

## What a turn does

1. Reject with `AgentError` `Busy` if the session already has a turn; otherwise publish `TurnStarted`.
2. Append the user message. Build the request from `Sessions.context`: message entries become messages; a compaction entry becomes a first user message `Summary of earlier conversation: ...` plus an assistant acknowledgement so roles alternate. Tools come from `Tools.list`, filtered by `TurnOptions.tools`.
3. Run `AgentRequestHook`, then `Llm.stream`. Every stream event is published as `ModelEvent`. The assistant message from the `finish` event is appended with the call's usage and model.
4. On finish reason `tool-calls`, every call runs concurrently through `Tools.execute` with the session's cwd. A tool failure becomes an `isError` result carrying the `ToolError` message; it never ends the turn. The results are appended as one user message and the loop continues.
5. Stop on `stop`, `length`, or `refusal`. When `maxToolRounds` is exceeded, the pending calls receive error results (so the next turn's context stays well-formed) and a `custom` entry of kind `agent/notice` explains why. Finish reason `error` and any `LlmError` end the turn with `AgentError` `Llm`.
6. Publish `TurnEnded` exactly once with the usage summed across rounds and `done`, `cancelled`, or `error`.

## Cancellation and ownership

Turns run on fibers owned by the plugin's scope, not the caller's. A caller that goes away (a dropped connection) does not stop the turn; `cancel` does, and so does disposing the plugin. `prompt` then fails with `AgentError` `Cancelled`.

A cancelled turn keeps what arrived: any text or thinking received since the last appended message is appended as an assistant message, followed by a `custom` entry of kind `agent/cancelled` with `{ turnId, partial }`. The session log is the durable record; events are for live views and may be lost.

## Preview

`buildRequest(sessionId, options?, config?)` is the exact request-building path a turn uses, including the hook, as an Effect requiring `Sessions`, `Tools`, and `Hooks`. The transport uses it for `Agent.Preview`. Pass the agent's config to get its default model and system prompt; without it, the built-in defaults apply.

## Rationale

- Tool execution is concurrent and failure-tolerant because the model, not the loop, decides what to do about a failed tool.
- Usage is taken from the last `usage` event of each call (a provider's final count), then summed across calls.
- No gate is installed: full permissions by default. A `ToolExecuteHook` handler in a user plugin is the place for approval.
