# @basis/plugin-tools

Provides `Tools` from `@basis/contracts`: the registry the agent loop lists tools from and executes them through. Other plugins (`tools-builtin`, `skills`, `mcp`, `subagent`) require `Tools` and register their tools; nothing here knows what a tool does.

## Use

```ts
import tools from "@basis/plugin-tools";
import { Tools } from "@basis/contracts";

const myTools = definePlugin({
  id: "my-tools", requires: [Tools],
  layer: Layer.scopedDiscard(Effect.flatMap(Tools, (registry) => registry.register({
    name: "greet",
    description: "Greets someone by name.",
    input: Schema.Struct({ name: Schema.String }),
    execute: async ({ name }) => ({ content: [{ type: "text", text: `Hello, ${name}` }] }),
  }))),
});

const core = yield* makeCore([tools, myTools]);
```

`register` needs a `Scope`; use `Layer.scopedDiscard` so the tool disappears when the plugin closes or reloads. Names are unique per composition: a second registration of the same name fails with `ToolError` (`Failed`).

`list` returns `ToolDefinition`s sorted by name, each with a JSON Schema (draft-07 shape, `$schema` removed, `additionalProperties: false` on every object) generated once at registration by `JSONSchema.make`.

`execute(invocation)` runs, in order: lookup (`NotFound`), input decoding with the tool's schema (`InvalidInput`, with the parse error formatted so the model can correct itself), `ToolExecuteHook`, and the tool. The `ToolExecuted` event carries the result and the duration. Every execution is a span named `tools.execute <name>` via `PluginContext.trace`.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `maxResultChars` | `50000` | Total text characters a result may carry to the model. Longer results are cut with a `[output truncated: showing X of Y characters]` marker. Image parts do not count and are always kept. |

No config at all means the defaults.

## Rationale

- **Plain functions wrapped once.** A tool's `execute` may return a Promise or an Effect. A Promise runs under `Effect.tryPromise`, whose signal fires on interruption and is forwarded to `ToolContext.signal`; an Effect runs directly and is interrupted by Effect, with the same signal aborted for anything it handed to `fetch` or a child process. Thrown errors, rejections, failures, and defects all become `ToolError` `Failed` carrying the message, so a broken tool ends one call, not the agent loop. Interruption stays interruption. A `ToolError` a tool fails with is passed through unchanged.
- **Validate before the gate.** Input is decoded before `ToolExecuteHook` runs, so a gate handler only sees calls the tool would accept. A handler that passes a different `ToolInvocation` to `next` has that input decoded again by the terminal.
- **No handler by default.** Full permissions: this plugin installs nothing on `ToolExecuteHook`. A gate is a user plugin that handles the hook and either returns a `ToolResult` with `isError` or fails with `Blocked`.
- **`HookError` and `CoreClosed`** from dispatch surface as `ToolError` (`Failed` and `Cancelled`) because the contract's `execute` fails only with `ToolError`.
