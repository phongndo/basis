import { Context, Data, Schema } from "effect";
import type { Effect } from "effect";
import { Event, Hook } from "@lemma/core";
import { AssistantMessage, ImageContent, Message, ModelRef, StreamEvent, TextContent, ThinkingLevel, Usage } from "./llm.ts";
import type { ToolResultMessage } from "./llm.ts";
import type { EventData, SessionEvent } from "./sessions.ts";
import type { ToolContribution } from "./tools.ts";

export class AgentError extends Data.TaggedError("AgentError")<{
  readonly sessionId: string;
  readonly reason: "Busy" | "NoModel" | "Session" | "Hook";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const TurnOptions = Schema.Struct({
  /** Falls back to the agent's configured default, then the first available model. */
  model: Schema.optional(ModelRef),
  thinking: Schema.optional(ThinkingLevel),
});
export type TurnOptions = typeof TurnOptions.Type;

export const PromptContent = Schema.Array(Schema.Union(TextContent, ImageContent));
export type PromptContent = typeof PromptContent.Type;

/** A named part of the system prompt and the plugin that contributed it (a handler uses its own `PluginContext` id). */
export interface SystemSection {
  readonly id: string;
  readonly source: string;
  readonly text: string;
}

/**
 * The model-facing request before it is logged and sent. Handlers of
 * `AgentRequestHook` add or edit sections and tools and may change the model
 * or thinking level. `branch` and `history` are read-only, as they stood when
 * the hook began: the terminal ignores them, because changing what the model
 * sees means appending session events, with `append`.
 */
export interface RequestDraft {
  readonly sessionId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly model: ModelRef;
  readonly thinking?: ThinkingLevel;
  readonly sections: readonly SystemSection[];
  readonly tools: readonly ToolContribution[];
  /** The turn's branch, root to its last event: what the request continues. */
  readonly branch: readonly SessionEvent[];
  /** `deriveMessages(branch)`. */
  readonly history: readonly Message[];
  /**
   * Appends an event after the turn's last one (a `compaction`, say); the
   * request, and the rest of the turn, continue from it. It stays on the
   * turn's branch even if a later handler fails or the turn is cancelled, and
   * a checkout meanwhile cannot move it.
   */
  readonly append: (data: EventData) => Effect.Effect<SessionEvent, AgentError>;
}

export type RequestPlan = Omit<RequestDraft, "history" | "branch" | "append" | "sessionId" | "turnId" | "cwd">;

/** Runs before every model call. Skills, project context, and prompt plugins contribute here. */
export const AgentRequestHook = Hook.make<RequestDraft, RequestPlan, AgentError>("lemma/agent.request");

/**
 * Runs after each step. The default continues while the model asked for tools
 * and stops otherwise; a handler can stop early or push the model to continue.
 */
export interface StepOutcome {
  readonly sessionId: string;
  readonly turnId: string;
  readonly step: number;
  readonly message: AssistantMessage;
  readonly results: readonly ToolResultMessage[];
}
export const AgentContinueHook = Hook.make<StepOutcome, "continue" | "stop", AgentError>("lemma/agent.continue");

export const TurnStarted = Event.make<{ readonly sessionId: string; readonly turnId: string }>("lemma/agent.turn.started");
export const TurnEnded = Event.make<{
  readonly sessionId: string;
  readonly turnId: string;
  readonly usage: Usage;
  readonly reason: "done" | "cancelled" | "error" | "max-steps";
}>("lemma/agent.turn.ended");
/** Live model output for UIs; the durable record is the `message` or `attempt` event appended when the stream settles. */
export const AssistantDelta = Event.make<{
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly event: StreamEvent;
}>("lemma/agent.delta");

export class Agent extends Context.Tag("lemma/Agent")<
  Agent,
  {
    /**
     * Appends the user message and runs steps (model, then tools) until the model
     * stops. One turn per session at a time; another prompt fails with `Busy`.
     * Resolves when the turn has ended; progress arrives through events and the log.
     */
    readonly prompt: (sessionId: string, content: PromptContent, options?: TurnOptions) => Effect.Effect<void, AgentError>;
    readonly cancel: (sessionId: string) => Effect.Effect<void>;
    readonly busy: (sessionId: string) => Effect.Effect<boolean>;
    /** Sessions with a running turn. */
    readonly running: Effect.Effect<readonly string[]>;
  }
>() {}
