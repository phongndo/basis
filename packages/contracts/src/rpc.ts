import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import { TurnOptions } from "./agent.ts";
import { Credential } from "./credentials.ts";
import { InteractionAnswer, InteractionRequest } from "./interaction.ts";
import { LlmRequest, Message, ModelInfo, StreamEvent, Usage } from "./llm.ts";
import { EntryPayload, SessionEntry, SessionInfo } from "./sessions.ts";

/**
 * The host's remote surface, served by the transport plugin over HTTP and
 * WebSocket with `@effect/rpc` and consumed by every client (web, desktop,
 * CLI attach). Domain errors are mapped to `HostError` at the boundary; the
 * `code` keeps the original tag/reason so clients can branch on it.
 */
export class HostError extends Schema.TaggedError<HostError>()("HostError", {
  code: Schema.String,
  message: Schema.String,
  /** Plugin, session, or provider the error concerns, when known. */
  subject: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
}) {}

export const PluginStatus = Schema.Struct({
  id: Schema.String,
  version: Schema.optional(Schema.String),
  state: Schema.Literal("pending", "activating", "active", "draining", "closed", "failed"),
  fault: Schema.optional(Schema.Struct({ phase: Schema.String, operation: Schema.optional(Schema.String), message: Schema.String })),
  haltedBy: Schema.optional(Schema.String),
});

/** Everything a client may need to react to, multiplexed on one subscription. */
export const HostEvent = Schema.Union(
  Schema.Struct({ type: Schema.Literal("model"), sessionId: Schema.String, turnId: Schema.String, event: StreamEvent }),
  Schema.Struct({ type: Schema.Literal("turn-started"), sessionId: Schema.String, turnId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("turn-ended"), sessionId: Schema.String, turnId: Schema.String, usage: Usage, reason: Schema.Literal("done", "cancelled", "error") }),
  Schema.Struct({ type: Schema.Literal("session-appended"), sessionId: Schema.String, entry: SessionEntry }),
  Schema.Struct({ type: Schema.Literal("session-changed"), sessionId: Schema.String, info: SessionInfo }),
  Schema.Struct({ type: Schema.Literal("interaction"), request: InteractionRequest }),
  Schema.Struct({ type: Schema.Literal("interaction-closed"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("notice"), level: Schema.Literal("info", "warning", "error"), message: Schema.String, source: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("plugins-changed"), plugins: Schema.Array(PluginStatus) }),
);
export type HostEvent = typeof HostEvent.Type;

export class HostRpcs extends RpcGroup.make(
  // Sessions
  Rpc.make("Session.List", { payload: { cwd: Schema.optional(Schema.String) }, success: Schema.Array(SessionInfo), error: HostError }),
  Rpc.make("Session.Get", { payload: { sessionId: Schema.String }, success: SessionInfo, error: HostError }),
  Rpc.make("Session.Create", { payload: { cwd: Schema.optional(Schema.String) }, success: SessionInfo, error: HostError }),
  Rpc.make("Session.Entries", { payload: { sessionId: Schema.String }, success: SessionEntry, error: HostError, stream: true }),
  Rpc.make("Session.Context", { payload: { sessionId: Schema.String }, success: Schema.Array(SessionEntry), error: HostError }),
  Rpc.make("Session.Append", { payload: { sessionId: Schema.String, payload: EntryPayload, parent: Schema.optional(Schema.String) }, success: SessionEntry, error: HostError }),
  Rpc.make("Session.Checkout", { payload: { sessionId: Schema.String, entryId: Schema.String }, success: SessionInfo, error: HostError }),
  Rpc.make("Session.SetTitle", { payload: { sessionId: Schema.String, title: Schema.String }, success: SessionInfo, error: HostError }),
  // Agent
  Rpc.make("Agent.Prompt", { payload: { sessionId: Schema.String, message: Message, options: Schema.optional(TurnOptions) }, error: HostError }),
  Rpc.make("Agent.Cancel", { payload: { sessionId: Schema.String } }),
  Rpc.make("Agent.Busy", { payload: { sessionId: Schema.String }, success: Schema.Boolean }),
  /** Preview of the request the agent would send now, for "what does the model see" views. */
  Rpc.make("Agent.Preview", { payload: { sessionId: Schema.String, options: Schema.optional(TurnOptions) }, success: LlmRequest, error: HostError }),
  // Models and credentials
  Rpc.make("Llm.Models", { success: Schema.Array(ModelInfo), error: HostError }),
  Rpc.make("Credentials.List", { success: Schema.Array(Schema.Struct({ provider: Schema.String, type: Schema.Literal("api-key", "oauth", "command") })), error: HostError }),
  Rpc.make("Credentials.Methods", { success: Schema.Array(Schema.Struct({ provider: Schema.String, id: Schema.String, label: Schema.String })) }),
  /** Drives the method's login flow; its questions arrive as `interaction` events. */
  Rpc.make("Credentials.Login", { payload: { provider: Schema.String, methodId: Schema.String }, success: Schema.Struct({ type: Schema.Literal("api-key", "oauth", "command") }), error: HostError }),
  Rpc.make("Credentials.Set", { payload: { provider: Schema.String, credential: Credential }, error: HostError }),
  Rpc.make("Credentials.Remove", { payload: { provider: Schema.String }, error: HostError }),
  // Interaction
  Rpc.make("Interaction.Answer", { payload: { id: Schema.String, answer: InteractionAnswer }, error: HostError }),
  Rpc.make("Interaction.Dismiss", { payload: { id: Schema.String }, error: HostError }),
  // Host
  Rpc.make("Host.Events", { success: HostEvent, stream: true }),
  Rpc.make("Host.Plugins", { success: Schema.Array(PluginStatus) }),
  Rpc.make("Host.RestartPlugin", { payload: { pluginId: Schema.String }, error: HostError }),
  /** Re-read config files and apply the composition; diagnostics come back as the error. */
  Rpc.make("Host.Reload", { success: Schema.Struct({ started: Schema.Array(Schema.String), restarted: Schema.Array(Schema.String), stopped: Schema.Array(Schema.String) }), error: HostError }),
) {}
