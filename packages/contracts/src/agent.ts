import { Context, Data, Schema } from "effect";
import type { Effect } from "effect";
import { Event, Hook } from "@basis/core";
import { LlmRequest, Message, StreamEvent, Usage } from "./llm.ts";

export class AgentError extends Data.TaggedError("AgentError")<{
  readonly sessionId: string;
  readonly reason: "Busy" | "NoModel" | "Llm" | "Tool" | "Session" | "Cancelled";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class TurnOptions extends Schema.Class<TurnOptions>("basis/TurnOptions")({
  /** `<provider>/<model>`; falls back to the agent plugin's configured default. */
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.Literal("low", "medium", "high", "max")),
  /** Tool names available this turn; default is every registered tool. */
  tools: Schema.optional(Schema.Array(Schema.String)),
}) {}

/**
 * Runs before each model call. Handlers edit the request (system prompt,
 * context, tool list); the terminal sends it. This is where skills, memory,
 * and prompt plugins contribute.
 */
export const AgentRequestHook = Hook.make<{ readonly sessionId: string; readonly request: LlmRequest }, LlmRequest>("basis/agent.request");

export const TurnStarted = Event.make<{ readonly sessionId: string; readonly turnId: string }>("basis/agent.turn.started");
export const TurnEnded = Event.make<{ readonly sessionId: string; readonly turnId: string; readonly usage: Usage; readonly reason: "done" | "cancelled" | "error" }>("basis/agent.turn.ended");
/** Live model output for UIs; the durable record is the session entry appended when the message completes. */
export const ModelEvent = Event.make<{ readonly sessionId: string; readonly turnId: string; readonly event: StreamEvent }>("basis/agent.model");

export class Agent extends Context.Tag("basis/Agent")<Agent, {
  /**
   * Append the user message and run the loop (model → tools → model) until the
   * model stops. One turn per session at a time; a second call fails with `Busy`.
   * Returns when the turn has ended; progress arrives through events.
   */
  readonly prompt: (sessionId: string, message: Message, options?: TurnOptions) => Effect.Effect<void, AgentError>;
  readonly cancel: (sessionId: string) => Effect.Effect<void>;
  readonly busy: (sessionId: string) => Effect.Effect<boolean>;
}>() {}
