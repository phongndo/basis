import { Effect, Layer, Schema } from "effect";
import { definePlugin } from "@basis/core";
import { Agent, Message, Sessions, ToolError, ToolResult, Tools, TurnOptions } from "@basis/contracts";
import type { AgentError, SessionEntry, SessionError, ToolContext } from "@basis/contracts";

export const TaskInput = Schema.Struct({
  prompt: Schema.String,
  /** Tool names the child may use; defaults to the file and shell tools. `task` is always removed. */
  tools: Schema.optional(Schema.Array(Schema.String)),
  model: Schema.optional(Schema.String),
});
export type TaskInput = typeof TaskInput.Type;

export const DEFAULT_TOOLS = ["read", "bash", "edit", "write"] as const;
export const TASK_TOOL = "task";
/** Custom entry appended first to every child session, naming its parent. */
export const TaskEntry = "subagent/task";

/** The last assistant message on the child's context, as text; what the parent model gets back. */
export function finalAssistantText(entries: readonly SessionEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const payload = entries[i]!.payload;
    if (payload.type === "message" && payload.message.role === "assistant") {
      return payload.message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
    }
  }
  return "";
}

const failed = (reason: "Failed" | "Cancelled", error: SessionError | AgentError) =>
  new ToolError({ tool: TASK_TOOL, reason, message: error.message, cause: error });

export default definePlugin({
  id: "subagent",
  version: "0.1.0",
  requires: [Agent, Tools, Sessions],
  layer: Layer.scopedDiscard(Effect.gen(function* () {
    const agent = yield* Agent;
    const tools = yield* Tools;
    const sessions = yield* Sessions;

    const execute = (input: TaskInput, context: ToolContext) => Effect.gen(function* () {
      const child = yield* sessions.create(context.cwd).pipe(Effect.mapError((error) => failed("Failed", error)));
      yield* sessions.append(child.id, {
        type: "custom", kind: TaskEntry, data: { parentSessionId: context.sessionId, toolCallId: context.toolCallId },
      }).pipe(Effect.mapError((error) => failed("Failed", error)));
      const names = (input.tools ?? DEFAULT_TOOLS).filter((name) => name !== TASK_TOOL);
      const options = new TurnOptions({ tools: names, ...(input.model === undefined ? {} : { model: input.model }) });
      const message = new Message({ role: "user", parts: [{ type: "text", text: input.prompt }] });
      // The parent's interruption reaches this effect; the child turn is owned by the agent, so cancel it explicitly.
      yield* agent.prompt(child.id, message, options).pipe(
        Effect.onInterrupt(() => agent.cancel(child.id)),
        Effect.mapError((error) => failed(error.reason === "Cancelled" ? "Cancelled" : "Failed", error)),
      );
      const entries = yield* sessions.context(child.id).pipe(Effect.mapError((error) => failed("Failed", error)));
      return new ToolResult({
        content: [{ type: "text", text: finalAssistantText(entries) }],
        details: { sessionId: child.id },
      });
    });

    yield* tools.register({
      name: TASK_TOOL,
      description: "Delegate a self-contained task to a subagent that works in its own session with its own context window. "
        + "Give it a complete brief: what to do, where, and what to report back. Returns the subagent's final message.",
      input: TaskInput,
      execute,
    });
  })),
});
