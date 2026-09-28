import { Context, Data, Schema } from "effect";
import type { Effect, Stream } from "effect";
import { Hook } from "@basis/core";

// Message shapes follow pi-ai's provider-neutral format so opaque provider
// state (reasoning signatures, response ids) survives a round trip through the
// session log unchanged. The log stores these values verbatim.

export const TextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  /** Provider message metadata that must be echoed back (OpenAI Responses item ids). */
  textSignature: Schema.optional(Schema.String),
});
export type TextContent = typeof TextContent.Type;

export const ThinkingContent = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  /** Opaque reasoning replay data; echoed back unchanged. */
  thinkingSignature: Schema.optional(Schema.String),
  redacted: Schema.optional(Schema.Boolean),
});
export type ThinkingContent = typeof ThinkingContent.Type;

export const ImageContent = Schema.Struct({
  type: Schema.Literal("image"),
  /** Base64 without a data: prefix. */
  data: Schema.String,
  mimeType: Schema.String,
});
export type ImageContent = typeof ImageContent.Type;

export const ToolCall = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  thoughtSignature: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
});
export type ToolCall = typeof ToolCall.Type;

export const Usage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  /** Subset of `output`, when the provider reports it. */
  reasoning: Schema.optional(Schema.Number),
  totalTokens: Schema.Number,
  /** USD. */
  cost: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
    total: Schema.Number,
  }),
});
export type Usage = typeof Usage.Type;

export const emptyUsage: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const StopReason = Schema.Literal("stop", "length", "toolUse", "error", "aborted");
export type StopReason = typeof StopReason.Type;

export const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Array(Schema.Union(TextContent, ImageContent)),
  timestamp: Schema.Number,
});
export type UserMessage = typeof UserMessage.Type;

export const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Union(TextContent, ThinkingContent, ToolCall)),
  /** Wire API that produced the message, e.g. `openai-responses`. */
  api: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  responseId: Schema.optional(Schema.String),
  usage: Usage,
  stopReason: StopReason,
  errorMessage: Schema.optional(Schema.String),
  timestamp: Schema.Number,
});
export type AssistantMessage = typeof AssistantMessage.Type;

export const ToolResultMessage = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  content: Schema.Array(Schema.Union(TextContent, ImageContent)),
  isError: Schema.Boolean,
  timestamp: Schema.Number,
});
export type ToolResultMessage = typeof ToolResultMessage.Type;

export const Message = Schema.Union(UserMessage, AssistantMessage, ToolResultMessage);
export type Message = typeof Message.Type;

/** JSON Schema object describing a tool's input. */
export const JsonSchema = Schema.Record({ key: Schema.String, value: Schema.Unknown });
export type JsonSchema = typeof JsonSchema.Type;

export const ToolSpec = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: JsonSchema,
});
export type ToolSpec = typeof ToolSpec.Type;

export const ThinkingLevel = Schema.Literal("off", "minimal", "low", "medium", "high", "xhigh", "max");
export type ThinkingLevel = typeof ThinkingLevel.Type;

/**
 * `<provider>/<model>`. Provider ids never contain `/`; model ids may
 * (`openrouter/anthropic/claude-sonnet-4`), so split at the first slash.
 */
export const ModelRef = Schema.String;
export type ModelRef = string;

export const parseModelRef = (ref: ModelRef): { readonly provider: string; readonly model: string } | undefined => {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
};

export const ModelInfo = Schema.Struct({
  /** `<provider>/<model>` */
  ref: ModelRef,
  provider: Schema.String,
  id: Schema.String,
  name: Schema.String,
  api: Schema.String,
  reasoning: Schema.Boolean,
  thinkingLevels: Schema.Array(ThinkingLevel),
  input: Schema.Array(Schema.Literal("text", "image")),
  contextWindow: Schema.Number,
  maxTokens: Schema.Number,
  /** USD per million tokens. */
  cost: Schema.Struct({ input: Schema.Number, output: Schema.Number, cacheRead: Schema.Number, cacheWrite: Schema.Number }),
});
export type ModelInfo = typeof ModelInfo.Type;

export const AuthType = Schema.Literal("api_key", "oauth");
export type AuthType = typeof AuthType.Type;

export const ProviderInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** Login methods this provider offers in `/login`, with display names. */
  auth: Schema.Array(Schema.Struct({ type: AuthType, name: Schema.String, interactive: Schema.Boolean })),
  /** Whether requests can authenticate now (stored credential, env var, ambient config). */
  configured: Schema.Boolean,
  /** Where the working auth comes from: `OPENAI_API_KEY`, `OAuth`, `auth.json`. */
  source: Schema.optional(Schema.String),
});
export type ProviderInfo = typeof ProviderInfo.Type;

export class LlmRequest extends Schema.Class<LlmRequest>("basis/LlmRequest")({
  model: ModelRef,
  system: Schema.optional(Schema.String),
  messages: Schema.Array(Message),
  tools: Schema.optional(Schema.Array(ToolSpec)),
  thinking: Schema.optional(ThinkingLevel),
  maxTokens: Schema.optional(Schema.Number),
  /** Lets providers key prompt caches and pooled connections. */
  sessionId: Schema.optional(Schema.String),
}) {}

/**
 * Streamed by `Llm.stream`. Every stream that starts ends with exactly one
 * `done` or `error`; both carry the complete assistant message so a failed
 * attempt can be logged with whatever it produced. `index` is the content
 * block index in that message.
 */
export const StreamEvent = Schema.Union(
  Schema.Struct({ type: Schema.Literal("start") }),
  Schema.Struct({ type: Schema.Literal("text-delta"), index: Schema.Number, delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thinking-delta"), index: Schema.Number, delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("toolcall-start"), index: Schema.Number, id: Schema.String, name: Schema.String }),
  Schema.Struct({ type: Schema.Literal("toolcall-delta"), index: Schema.Number, delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("toolcall-end"), index: Schema.Number, toolCall: ToolCall }),
  Schema.Struct({ type: Schema.Literal("done"), message: AssistantMessage }),
  /** `message.stopReason` is `error` or `aborted`; `message.errorMessage` explains it. */
  Schema.Struct({ type: Schema.Literal("error"), message: AssistantMessage }),
);
export type StreamEvent = typeof StreamEvent.Type;

/** A request that cannot start: unknown model or provider. Provider failures arrive as an `error` event instead. */
export class LlmError extends Data.TaggedError("LlmError")<{
  readonly reason: "UnknownModel" | "UnknownProvider" | "NotConfigured" | "LoginFailed" | "Cancelled";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Wraps every model request: logging, retries, routing, and gates can be plugins. The terminal is the provider. */
export const LlmRequestHook = Hook.make<LlmRequest, Stream.Stream<StreamEvent, LlmError>, LlmError>("basis/llm.request");

export class Llm extends Context.Tag("basis/Llm")<Llm, {
  readonly providers: Effect.Effect<readonly ProviderInfo[]>;
  /** Every known model, or only those whose provider is configured. */
  readonly models: (options?: { readonly available?: boolean }) => Effect.Effect<readonly ModelInfo[]>;
  readonly model: (ref: ModelRef) => Effect.Effect<ModelInfo, LlmError>;
  /** Runs `LlmRequestHook`; interrupting the stream aborts the provider request. */
  readonly stream: (request: LlmRequest) => Stream.Stream<StreamEvent, LlmError>;
  /** Runs the provider's login flow through `Interaction` and stores the credential. */
  readonly login: (provider: string, type: AuthType) => Effect.Effect<void, LlmError>;
  readonly logout: (provider: string) => Effect.Effect<void, LlmError>;
}>() {}
