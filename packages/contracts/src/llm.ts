import { Context, Data, Schema } from "effect";
import type { Effect, Option, Stream } from "effect";
import { Hook } from "@basis/core";

/** Provider-neutral model description. Catalog data may come from models.dev; providers own the truth. */
export class ModelInfo extends Schema.Class<ModelInfo>("basis/ModelInfo")({
  /** `<provider>/<model>`; unique across the composition. */
  id: Schema.String,
  provider: Schema.String,
  name: Schema.String,
  contextWindow: Schema.Number,
  maxOutput: Schema.optional(Schema.Number),
  toolCall: Schema.Boolean,
  reasoning: Schema.Boolean,
  /** USD per million tokens. */
  cost: Schema.optional(Schema.Struct({
    input: Schema.Number, output: Schema.Number,
    cacheRead: Schema.optional(Schema.Number), cacheWrite: Schema.optional(Schema.Number),
  })),
}) {}

export const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
export const ImagePart = Schema.Struct({
  type: Schema.Literal("image"),
  mediaType: Schema.String,
  /** Base64 data or a URL; providers that cannot fetch URLs reject them with `InvalidRequest`. */
  source: Schema.Union(Schema.Struct({ kind: Schema.Literal("base64"), data: Schema.String }), Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String })),
});
export const ThinkingPart = Schema.Struct({
  type: Schema.Literal("thinking"),
  text: Schema.String,
  /** Provider-specific opaque state (signatures, redacted blocks) that must be echoed back unchanged. */
  state: Schema.optional(Schema.Unknown),
});
export const ToolCallPart = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});
export const ToolResultPart = Schema.Struct({
  type: Schema.Literal("tool-result"),
  toolCallId: Schema.String,
  content: Schema.Array(Schema.Union(TextPart, ImagePart)),
  isError: Schema.optional(Schema.Boolean),
});
export const ContentPart = Schema.Union(TextPart, ImagePart, ThinkingPart, ToolCallPart, ToolResultPart);
export type ContentPart = typeof ContentPart.Type;

export class Message extends Schema.Class<Message>("basis/Message")({
  role: Schema.Literal("user", "assistant"),
  parts: Schema.Array(ContentPart),
}) {}

/** JSON Schema for a tool's input; produced from an Effect Schema by the tools plugin. */
export const JsonSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });

export class ToolDefinition extends Schema.Class<ToolDefinition>("basis/ToolDefinition")({
  name: Schema.String,
  description: Schema.String,
  inputSchema: JsonSchema,
}) {}

export class Usage extends Schema.Class<Usage>("basis/Usage")({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.optional(Schema.Number),
  cacheWrite: Schema.optional(Schema.Number),
}) {}

export const FinishReason = Schema.Literal("stop", "length", "tool-calls", "refusal", "error");
export type FinishReason = typeof FinishReason.Type;

/** Streamed by providers. Deltas are ordered; a `tool-call` carries the complete parsed input. */
export const StreamEvent = Schema.Union(
  Schema.Struct({ type: Schema.Literal("text-delta"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thinking-delta"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("tool-call-delta"), id: Schema.String, name: Schema.String, inputDelta: Schema.String }),
  ToolCallPart,
  Schema.Struct({ type: Schema.Literal("usage"), usage: Usage }),
  Schema.Struct({ type: Schema.Literal("finish"), reason: FinishReason, message: Message }),
);
export type StreamEvent = typeof StreamEvent.Type;

export class LlmRequest extends Schema.Class<LlmRequest>("basis/LlmRequest")({
  model: Schema.String,
  system: Schema.optional(Schema.String),
  messages: Schema.Array(Message),
  tools: Schema.optional(Schema.Array(ToolDefinition)),
  maxTokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  /** Reasoning depth where the provider supports it; providers ignore what they cannot honor. */
  effort: Schema.optional(Schema.Literal("low", "medium", "high", "max")),
}) {}

export class LlmError extends Data.TaggedError("LlmError")<{
  readonly provider: string;
  readonly reason: "Auth" | "RateLimit" | "InvalidRequest" | "Network" | "ContextTooLong" | "Unknown";
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}> {}

/** One provider implementation; registered with `Llm` by a provider plugin. */
export interface LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly models: Effect.Effect<readonly ModelInfo[], LlmError>;
  readonly stream: (request: LlmRequest) => Stream.Stream<StreamEvent, LlmError>;
}

/** Wraps every request so gates, logging, caching, and retries can be plugins. Terminal is the provider. */
export const LlmRequestHook = Hook.make<LlmRequest, Stream.Stream<StreamEvent, LlmError>, LlmError>("basis/llm.request");

export class Llm extends Context.Tag("basis/Llm")<Llm, {
  readonly registerProvider: (provider: LlmProvider) => Effect.Effect<void, never, import("effect").Scope.Scope>;
  readonly providers: Effect.Effect<readonly { readonly id: string; readonly name: string }[]>;
  readonly models: Effect.Effect<readonly ModelInfo[], LlmError>;
  readonly model: (id: string) => Effect.Effect<Option.Option<ModelInfo>, LlmError>;
  /** Routes by the `<provider>/` prefix of `request.model` and runs `LlmRequestHook`. */
  readonly stream: (request: LlmRequest) => Stream.Stream<StreamEvent, LlmError>;
}>() {}
