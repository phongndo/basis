import { Schema } from "effect";

const Headers = Schema.Record({ key: Schema.String, value: Schema.String });

export const StdioTransport = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  /** Merged over the SDK's safe default environment (HOME, PATH, ...). */
  env: Schema.optional(Headers),
  cwd: Schema.optional(Schema.String),
});

export const HttpTransport = Schema.Struct({
  type: Schema.Literal("http"),
  url: Schema.String,
  headers: Schema.optional(Headers),
});

export const ServerConfig = Schema.Struct({
  /** Used in tool names (`mcp__<name>__<tool>`), so it is restricted to a safe alphabet. */
  name: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]+$/, { message: () => "server name must use letters, digits, '-' or '_'" })),
  transport: Schema.Union(StdioTransport, HttpTransport),
  /** Also register every tool directly as `mcp__<name>__<tool>`; default is search-and-call only. */
  expose: Schema.optional(Schema.Boolean),
});
export type ServerConfig = typeof ServerConfig.Type;

export const McpConfig = Schema.Struct({
  servers: Schema.Array(ServerConfig).pipe(Schema.filter((servers) =>
    new Set(servers.map((server) => server.name)).size === servers.length || "server names must be unique")),
});
export type McpConfig = typeof McpConfig.Type;
