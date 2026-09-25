import { Context, Data, Schema } from "effect";
import type { Effect, Scope } from "effect";
import { Event, Hook } from "@basis/core";
import { ImagePart, TextPart, ToolDefinition } from "./llm.ts";

export class ToolResult extends Schema.Class<ToolResult>("basis/ToolResult")({
  content: Schema.Array(Schema.Union(TextPart, ImagePart)),
  isError: Schema.optional(Schema.Boolean),
  /** Structured data for UIs (diffs, exit codes); never sent to the model. */
  details: Schema.optional(Schema.Unknown),
}) {}

export interface ToolContext {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly cwd: string;
  /** Aborted when the turn is cancelled. Promise-based tools must check it; Effect tools are interrupted. */
  readonly signal: AbortSignal;
}

export class ToolError extends Data.TaggedError("ToolError")<{
  readonly tool: string;
  readonly reason: "NotFound" | "InvalidInput" | "Failed" | "Blocked" | "Cancelled";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A tool as registered by a plugin. `execute` may return a Promise (plain async
 * function) or an Effect; the tools plugin wraps promises once at registration.
 */
export interface Tool<Input = unknown> {
  readonly name: string;
  readonly description: string;
  readonly input: Schema.Schema<Input, any, never>;
  readonly execute: (input: Input, context: ToolContext) => Promise<ToolResult> | Effect.Effect<ToolResult, ToolError | unknown>;
}

export class ToolInvocation extends Schema.Class<ToolInvocation>("basis/ToolInvocation")({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
  cwd: Schema.String,
}) {}

/**
 * The gate. Every execution passes through here; a handler that does not call
 * `next` blocks the call (return a ToolResult with isError, or fail with
 * `Blocked`). No handler is installed by default: full permissions.
 */
export const ToolExecuteHook = Hook.make<ToolInvocation, ToolResult, ToolError>("basis/tool.execute");

export const ToolExecuted = Event.make<{ readonly invocation: ToolInvocation; readonly result: ToolResult; readonly durationMs: number }>("basis/tool.executed");

export class Tools extends Context.Tag("basis/Tools")<Tools, {
  /** Removed when the scope closes. Names are unique; a duplicate fails. */
  readonly register: <I>(tool: Tool<I>) => Effect.Effect<void, ToolError, Scope.Scope>;
  readonly list: Effect.Effect<readonly ToolDefinition[]>;
  /** Validates input against the tool's schema, runs `ToolExecuteHook`, then the tool. */
  readonly execute: (invocation: ToolInvocation) => Effect.Effect<ToolResult, ToolError>;
}>() {}
