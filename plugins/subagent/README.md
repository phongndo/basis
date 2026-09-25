# @basis/plugin-subagent

Registers a `task` tool that runs a nested agent turn in its own session. Requires `Agent`, `Tools`, and `Sessions`; provides nothing. No config.

## Use

Add the plugin to the composition alongside the agent and tools plugins. The model then sees:

```
task({ prompt: string, tools?: string[], model?: string })
```

The tool creates a child session in the parent's working directory, appends a `custom` entry of kind `subagent/task` with `{ parentSessionId, toolCallId }` so the child can be traced back, and runs `Agent.prompt` with the brief. The result is the text of the child's final assistant message; `details.sessionId` names the child session for UIs that want to show its transcript.

## Tools available to the child

`tools` defaults to `read`, `bash`, `edit`, and `write`. Names that are not registered are simply absent. `task` itself is always removed, so a subagent cannot spawn subagents: one level of delegation keeps the cost and the failure surface bounded.

## Cancellation

The child turn is owned by the agent plugin, not by the tool call, so interrupting the parent turn does not stop it by itself. The tool therefore cancels the child explicitly when it is interrupted, and the child's partial output is kept in the child session as the agent plugin documents.

## Failures

A child turn that fails (`AgentError`) fails the tool with `ToolError` `Failed` (or `Cancelled`); the agent loop reports that to the parent model as an error result and continues. A child that stops without producing any assistant text returns an empty string.
