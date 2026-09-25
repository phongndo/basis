# @basis/plugin-mcp

Connects configured [Model Context Protocol](https://modelcontextprotocol.io) servers and makes their tools callable. Requires `Tools`. By default a server's tools stay out of the prompt: the model finds them with `mcp_search` and runs them with `mcp_call`, so a composition with many servers costs two tool definitions. A server can opt into direct registration with `expose: true`.

## Use

```ts
import mcp from "@basis/plugin-mcp";
// makeCore([tools, mcp, ...], { configs: { mcp: { servers: [
//   { name: "fs", transport: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } },
//   { name: "docs", transport: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ..." } }, expose: true },
// ] } } })
```

## Config

```ts
{ servers: Array<{
  name: string;                     // letters, digits, '-' or '_'; unique
  transport:
    | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
    | { type: "http"; url: string; headers?: Record<string, string> };
  expose?: boolean;                 // also register every tool as mcp__<name>__<tool>
}> }
```

`env` is merged over the SDK's safe default environment (`HOME`, `PATH`, `SHELL`, ...). The `http` transport is Streamable HTTP; put static credentials in `headers`.

## Behavior

- Each server is connected in a supervised background task (`required: false`). A server that never starts, or dies, is reported and retried; the plugin and the other servers stay active.
- Reconnection uses `Schedule.exponential(1s)` capped at 30 s. A session that ends (the process exits, the stream closes) reconnects after one second with a fresh backoff.
- Status per server is `connecting`, `connected`, or `failed` with a message. Notices (source `mcp`) are published on connect (`info`), disconnect (`warning`), and the first failure of an outage (`error`, including the tail of the server's stderr for stdio servers). Later retries only update the status, which `mcp_search` prints for servers that are not connected.
- `tools/list_changed` notifications refresh the server's tool list (and, in expose mode, its registrations).
- `mcp_search { query?, server? }`: every tool of every connected server when there is no query; otherwise tools whose name or description contains the query or any of its words. Each entry shows server, tool, description, and the input JSON schema. `details` carries server statuses for UIs.
- `mcp_call { server, tool, input }`: calls the tool. Text and image content map to `ToolResult` parts; audio, embedded resources, and resource links become short text descriptions; `isError` follows the MCP result. Problems (server down, unknown tool, invalid input as judged by the server, transport error) are error results the model can read, not failed tool calls. Cancelling the turn aborts the request.
- `expose: true`: each tool is also registered as `mcp__<server>__<tool>` with the server's JSON schema attached verbatim (`Schema.Unknown` annotated with `jsonSchema`, so the tools plugin emits it unchanged); only the server validates the input. When the list changes, the previous registrations are replaced. While the server is disconnected its exposed tools are unregistered.

## Rationale

- Search-and-call keeps large servers from dominating the prompt and lets tool lists change without changing the model's tool set mid-turn; expose mode exists for small, stable servers where a direct call is worth the tokens.
- The plugin is never `failed` because of a server: the user is told through notices and `mcp_search`, and the retry loop keeps working without a restart.
- Errors are results, not exceptions, because the model is the caller and can adapt (fix the input, pick another tool) when it sees the message.

## Limitations

- OAuth for HTTP servers is not implemented; the SDK's `authProvider` is not wired. Use static headers, or a proxy that adds them.
- Tool results are the only MCP feature surfaced: prompts, resources, sampling, elicitation, and roots are not.
