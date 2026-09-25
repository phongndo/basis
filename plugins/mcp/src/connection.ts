import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Data, Deferred, Duration, Effect, Either, Exit, Option, Queue, Ref, Schedule } from "effect";
import type { ToolResult } from "@basis/contracts";
import type { ServerConfig } from "./config.ts";
import { errorResult, toToolResult } from "./content.ts";

export type ServerStatus =
  | { readonly state: "connecting" }
  | { readonly state: "connected" }
  | { readonly state: "failed"; readonly message: string };

export interface Connection {
  readonly name: string;
  readonly status: Effect.Effect<ServerStatus>;
  /** Empty unless connected. */
  readonly tools: Effect.Effect<readonly McpTool[]>;
  /** Never fails: every problem is an error result the model can read. */
  readonly call: (tool: string, input: unknown) => Effect.Effect<ToolResult>;
  /** Keeps the server connected, reconnecting with backoff; runs until interrupted. */
  readonly run: Effect.Effect<never>;
}

export interface ConnectionHooks {
  /** The current tool list, after connect, after `tools/list_changed`, and (empty) after disconnect. */
  readonly onTools: (connection: Connection, tools: readonly McpTool[]) => Effect.Effect<void>;
  readonly notify: (level: "info" | "warning" | "error", message: string) => Effect.Effect<void>;
}

class ConnectFailed extends Data.TaggedError("ConnectFailed")<{ readonly message: string }> {}

/** Retry delays double from one second and never exceed thirty. */
export const reconnectSchedule = Schedule.exponential(Duration.seconds(1)).pipe(Schedule.union(Schedule.spaced(Duration.seconds(30))));

/** Keeps the last part of the server's stderr so a failed connection can say why. */
const stderrTail = (limit = 2000) => {
  let text = "";
  return {
    push: (chunk: unknown) => { text = (text + String(chunk)).slice(-limit); },
    read: () => text.trim(),
  };
};

const makeTransport = (config: ServerConfig["transport"], stderr: ReturnType<typeof stderrTail>): Transport => {
  if (config.type === "http") {
    // The SDK's class declares `sessionId: string | undefined` where its own interface says optional.
    return new StreamableHTTPClientTransport(new URL(config.url), config.headers === undefined ? {} : { requestInit: { headers: config.headers } }) as Transport;
  }
  const transport = new StdioClientTransport({
    command: config.command,
    args: [...(config.args ?? [])],
    ...(config.env === undefined ? {} : { env: config.env }),
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    stderr: "pipe",
  });
  transport.stderr?.on("data", stderr.push);
  return transport;
};

const connect = (config: ServerConfig): Effect.Effect<Client, ConnectFailed> =>
  Effect.tryPromise({
    try: async () => {
      const stderr = stderrTail();
      const client = new Client({ name: "basis", version: "0.1.0" });
      try {
        await client.connect(makeTransport(config.transport, stderr));
      } catch (error) {
        const detail = stderr.read();
        throw new ConnectFailed({ message: `${error instanceof Error ? error.message : String(error)}${detail ? `\n${detail}` : ""}` });
      }
      return client;
    },
    catch: (error) => error instanceof ConnectFailed ? error : new ConnectFailed({ message: error instanceof Error ? error.message : String(error) }),
  });

const listAll = (client: Client): Effect.Effect<readonly McpTool[], ConnectFailed> =>
  Effect.tryPromise({
    try: async () => {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return tools;
    },
    catch: (error) => new ConnectFailed({ message: `tools/list failed: ${error instanceof Error ? error.message : String(error)}` }),
  });

export const makeConnection = (config: ServerConfig, hooks: ConnectionHooks): Effect.Effect<Connection> =>
  Effect.gen(function* () {
    const name = config.name;
    const status = yield* Ref.make<ServerStatus>({ state: "connecting" });
    const tools = yield* Ref.make<readonly McpTool[]>([]);
    const client = yield* Ref.make(Option.none<Client>());
    /** Only the first failure of an outage is announced; the status keeps the latest message. */
    const announced = yield* Ref.make(false);

    const call: Connection["call"] = (tool, input) => Effect.gen(function* () {
      const current = yield* Ref.get(client);
      if (Option.isNone(current)) {
        const now = yield* Ref.get(status);
        return errorResult(`MCP server "${name}" is not connected${now.state === "failed" ? `: ${now.message}` : ""}`);
      }
      const result = yield* Effect.tryPromise({
        try: (signal) => current.value.callTool({ name: tool, arguments: (input ?? {}) as Record<string, unknown> }, undefined, { signal }),
        catch: (error) => error instanceof Error ? error.message : String(error),
      }).pipe(Effect.either);
      return Either.isLeft(result) ? errorResult(`MCP call ${name}/${tool} failed: ${result.left}`) : toToolResult(result.right);
    });

    const connection: Connection = { name, status: Ref.get(status), tools: Ref.get(tools), call, run: Effect.never };
    const setTools = (list: readonly McpTool[]) => Ref.set(tools, list).pipe(Effect.zipRight(hooks.onTools(connection, list)));

    // One connected session: from a successful handshake until the transport closes.
    const session = Effect.gen(function* () {
      yield* Ref.set(status, { state: "connecting" });
      const active = yield* Effect.acquireRelease(connect(config), (c) => Effect.promise(() => c.close()).pipe(Effect.ignore));
      const closed = yield* Deferred.make<void>();
      const changes = yield* Queue.sliding<void>(1);
      active.onclose = () => { Deferred.unsafeDone(closed, Exit.void); };
      active.setNotificationHandler(ToolListChangedNotificationSchema, () => { Queue.unsafeOffer(changes, undefined); });
      const initial = yield* listAll(active);
      yield* Ref.set(client, Option.some(active));
      yield* setTools(initial);
      yield* Ref.set(status, { state: "connected" });
      yield* Ref.set(announced, false);
      yield* hooks.notify("info", `MCP server "${name}" connected with ${initial.length} tool${initial.length === 1 ? "" : "s"}`);
      yield* Effect.forkScoped(Effect.forever(Queue.take(changes).pipe(
        Effect.zipRight(listAll(active).pipe(Effect.flatMap(setTools), Effect.catchAll((error) => hooks.notify("warning", `MCP server "${name}": ${error.message}`)))),
      )));
      yield* Deferred.await(closed);
      yield* Ref.set(client, Option.none());
      yield* setTools([]);
      yield* Ref.set(status, { state: "failed", message: "connection closed" });
      yield* hooks.notify("warning", `MCP server "${name}" disconnected; reconnecting`);
    }).pipe(Effect.scoped);

    const attempt = session.pipe(Effect.tapError((error) => Effect.gen(function* () {
      yield* Ref.set(status, { state: "failed", message: error.message });
      if (yield* Ref.getAndSet(announced, true)) return;
      yield* hooks.notify("error", `MCP server "${name}" failed to connect: ${error.message}`);
    })));

    const run = attempt.pipe(
      // The schedule never ends, so the error channel is unreachable.
      Effect.retry(reconnectSchedule), Effect.orDie,
      // A session that ended cleanly reconnects after a short pause rather than in a tight loop.
      Effect.zipRight(Effect.sleep(Duration.seconds(1))),
      Effect.forever,
    );
    return { ...connection, run };
  });
