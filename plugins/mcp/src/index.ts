import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { Context, Effect, ExecutionStrategy, Exit, Layer, Schema, Scope } from "effect";
import { definePlugin, Events, PluginContext } from "@basis/core";
import { Notice, ToolResult, Tools } from "@basis/contracts";
import { McpConfig } from "./config.ts";
import { makeConnection } from "./connection.ts";
import type { Connection } from "./connection.ts";

export { HttpTransport, McpConfig, ServerConfig, StdioTransport } from "./config.ts";
export { makeConnection, reconnectSchedule } from "./connection.ts";
export type { Connection, ConnectionHooks, ServerStatus } from "./connection.ts";
export { toToolResult } from "./content.ts";

type Notify = (level: "info" | "warning" | "error", message: string) => Effect.Effect<void>;

/** Case-insensitive substring match on the whole query, or on any of its words. */
export function matches(query: string, tool: McpTool): boolean {
  const haystack = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
  const needle = query.trim().toLowerCase();
  return needle.length === 0 || haystack.includes(needle) || needle.split(/\s+/).some((word) => haystack.includes(word));
}

/**
 * Direct registration for `expose: true` servers. Each tool list replaces the
 * previous set atomically from the model's point of view: the old scope closes,
 * a fresh child of the plugin scope registers the new tools.
 */
const makeExposure = (server: string, tools: Context.Tag.Service<Tools>, parent: Scope.Scope, notify: Notify) => {
  let current: Scope.CloseableScope | undefined;
  return (connection: Connection, list: readonly McpTool[]) => Effect.gen(function* () {
    if (current) yield* Scope.close(current, Exit.void);
    const scope = yield* Scope.fork(parent, ExecutionStrategy.sequential);
    current = scope;
    for (const tool of list) {
      const name = `mcp__${server}__${tool.name}`;
      yield* tools.register({
        name,
        description: tool.description ?? `${tool.name} on MCP server ${server}`,
        // The server's JSON schema goes to the model verbatim; the server validates the input.
        input: Schema.Unknown.annotations({ jsonSchema: tool.inputSchema }),
        execute: (input) => connection.call(tool.name, input),
      }).pipe(Scope.extend(scope), Effect.catchAll((error) => notify("warning", `Cannot expose ${name}: ${error.message}`)));
    }
  });
};

export default definePlugin({
  id: "mcp",
  config: McpConfig,
  requires: [Tools],
  layer: (config) => Layer.scopedDiscard(Effect.gen(function* () {
    const tools = yield* Tools;
    const events = yield* Events;
    const owner = yield* PluginContext;
    const scope = yield* Effect.scope;
    const notify: Notify = (level, message) => events.publish(Notice, { level, message, source: "mcp" });

    const connections = new Map<string, Connection>();
    for (const server of config.servers) {
      const expose = server.expose ? makeExposure(server.name, tools, scope, notify) : undefined;
      const connection = yield* makeConnection(server, { notify, onTools: expose ?? (() => Effect.void) });
      connections.set(server.name, connection);
    }

    const catalogue = Effect.forEach([...connections.values()], (connection) =>
      Effect.all({ name: Effect.succeed(connection.name), status: connection.status, tools: connection.tools }));

    yield* tools.register({
      name: "mcp_search",
      description: "List tools offered by connected MCP servers, with their input schemas. Omit the query to see everything; give words to filter by name or description. Call a tool with mcp_call.",
      input: Schema.Struct({ query: Schema.optional(Schema.String), server: Schema.optional(Schema.String) }),
      execute: ({ query, server }) => Effect.map(catalogue, (servers) => {
        const considered = server === undefined ? servers : servers.filter((entry) => entry.name === server);
        if (server !== undefined && considered.length === 0) return new ToolResult({ content: [{ type: "text", text: `No MCP server named "${server}". Configured: ${[...connections.keys()].join(", ") || "none"}.` }], isError: true });
        const lines: string[] = [];
        for (const entry of considered) {
          if (entry.status.state !== "connected") lines.push(`Server "${entry.name}" is ${entry.status.state}${entry.status.state === "failed" ? `: ${entry.status.message}` : ""}`);
          for (const tool of entry.tools) {
            if (query !== undefined && !matches(query, tool)) continue;
            lines.push(`- server: ${entry.name}\n  tool: ${tool.name}\n  description: ${tool.description ?? "(none)"}\n  input: ${JSON.stringify(tool.inputSchema)}`);
          }
        }
        if (!lines.some((line) => line.startsWith("- "))) lines.push("No matching MCP tools.");
        return new ToolResult({ content: [{ type: "text", text: lines.join("\n") }], details: { servers: servers.map(({ name, status }) => ({ name, status })) } });
      }),
    });

    yield* tools.register({
      name: "mcp_call",
      description: "Call a tool on an MCP server by server name and tool name, with the input the tool's schema describes (see mcp_search).",
      input: Schema.Struct({ server: Schema.String, tool: Schema.String, input: Schema.optional(Schema.Unknown) }),
      execute: ({ server, tool, input }) => {
        const connection = connections.get(server);
        return connection === undefined
          ? Effect.succeed(new ToolResult({ content: [{ type: "text", text: `No MCP server named "${server}".` }], isError: true }))
          : connection.call(tool, input);
      },
    });

    // Optional: a server that never comes up is reported, never fatal for the plugin.
    for (const connection of connections.values()) {
      yield* owner.background(`server:${connection.name}`, connection.run, { required: false });
    }
  })),
});
