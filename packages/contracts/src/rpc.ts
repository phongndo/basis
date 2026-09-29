import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import { PromptContent, TurnOptions } from "./agent.ts";
import { CompositionInfo, NoticePayload } from "./host.ts";
import { InteractionAnswer, InteractionRequest } from "./interaction.ts";
import { AuthType, ModelInfo, ProviderInfo, StreamEvent, Usage } from "./llm.ts";
import { SessionEvent, SessionInfo } from "./sessions.ts";
import { DirectoryListing, GitBranch, WorkspaceStatus } from "./workspace.ts";

/**
 * The host's remote surface, served by the transport plugin and consumed by
 * every client. Domain errors map to `HostError` at the boundary; `code` keeps
 * the original tag or reason so clients can branch on it.
 */
export class HostError extends Schema.TaggedError<HostError>()("HostError", {
  code: Schema.String,
  message: Schema.String,
  /** Plugin, session, or provider the error concerns, when known. */
  subject: Schema.optional(Schema.String),
}) {}

export const PluginStatus = Schema.Struct({
  id: Schema.String,
  version: Schema.optional(Schema.String),
  state: Schema.Literal("pending", "activating", "active", "draining", "closed", "failed"),
  fault: Schema.optional(Schema.Struct({ phase: Schema.String, operation: Schema.optional(Schema.String), message: Schema.String })),
  haltedBy: Schema.optional(Schema.String),
});
export type PluginStatus = typeof PluginStatus.Type;

/** Everything a client reacts to, multiplexed on one subscription. Losable: clients repair gaps from `Session.Events`. */
export const HostEvent = Schema.Union(
  Schema.Struct({ type: Schema.Literal("session-appended"), sessionId: Schema.String, event: SessionEvent }),
  Schema.Struct({ type: Schema.Literal("session-changed"), info: SessionInfo }),
  Schema.Struct({ type: Schema.Literal("delta"), sessionId: Schema.String, turnId: Schema.String, stepId: Schema.String, event: StreamEvent }),
  Schema.Struct({ type: Schema.Literal("turn-started"), sessionId: Schema.String, turnId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("turn-ended"),
    sessionId: Schema.String,
    turnId: Schema.String,
    usage: Usage,
    reason: Schema.Literal("done", "cancelled", "error", "max-steps"),
  }),
  Schema.Struct({ type: Schema.Literal("interaction"), request: InteractionRequest }),
  Schema.Struct({ type: Schema.Literal("interaction-closed"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("notice"), notice: NoticePayload }),
  Schema.Struct({ type: Schema.Literal("plugins-changed"), plugins: Schema.Array(PluginStatus) }),
);
export type HostEvent = typeof HostEvent.Type;

export const HostInfo = Schema.Struct({
  version: Schema.String,
  cwd: Schema.String,
  home: Schema.String,
  composition: CompositionInfo,
});
export type HostInfo = typeof HostInfo.Type;

export class HostRpcs extends RpcGroup.make(
  Rpc.make("Session.List", { payload: { cwd: Schema.optional(Schema.String) }, success: Schema.Array(SessionInfo), error: HostError }),
  Rpc.make("Session.Get", { payload: { sessionId: Schema.String }, success: SessionInfo, error: HostError }),
  Rpc.make("Session.Create", { payload: { cwd: Schema.optional(Schema.String) }, success: SessionInfo, error: HostError }),
  Rpc.make("Session.Events", {
    payload: { sessionId: Schema.String, after: Schema.optional(Schema.Number) },
    success: Schema.Array(SessionEvent),
    error: HostError,
  }),
  Rpc.make("Session.Checkout", { payload: { sessionId: Schema.String, eventId: Schema.String }, success: SessionInfo, error: HostError }),
  Rpc.make("Session.SetTitle", { payload: { sessionId: Schema.String, title: Schema.String }, success: SessionInfo, error: HostError }),

  /** Returns when the turn ends. */
  Rpc.make("Agent.Prompt", { payload: { sessionId: Schema.String, content: PromptContent, options: Schema.optional(TurnOptions) }, error: HostError }),
  Rpc.make("Agent.Cancel", { payload: { sessionId: Schema.String } }),
  Rpc.make("Agent.Running", { success: Schema.Array(Schema.String) }),

  Rpc.make("Llm.Providers", { success: Schema.Array(ProviderInfo), error: HostError }),
  Rpc.make("Llm.Models", { payload: { available: Schema.optional(Schema.Boolean) }, success: Schema.Array(ModelInfo), error: HostError }),
  /** Drives the provider's login flow; its questions arrive as `interaction` events and its progress as `notice` events. */
  Rpc.make("Llm.Login", { payload: { provider: Schema.String, type: AuthType }, error: HostError }),
  Rpc.make("Llm.Logout", { payload: { provider: Schema.String }, error: HostError }),

  Rpc.make("Interaction.Answer", { payload: { id: Schema.String, answer: InteractionAnswer }, error: HostError }),
  Rpc.make("Interaction.Dismiss", { payload: { id: Schema.String }, error: HostError }),

  Rpc.make("Workspace.Status", { payload: { path: Schema.String }, success: WorkspaceStatus }),
  Rpc.make("Workspace.Browse", { payload: { partialPath: Schema.String }, success: DirectoryListing }),
  Rpc.make("Workspace.CreateDirectory", { payload: { path: Schema.String }, success: WorkspaceStatus, error: HostError }),
  Rpc.make("Workspace.CreateWorktree", {
    payload: { path: Schema.String, branch: Schema.String, base: Schema.optional(Schema.String) },
    success: WorkspaceStatus,
    error: HostError,
  }),
  Rpc.make("Workspace.Branches", { payload: { path: Schema.String }, success: Schema.Array(GitBranch), error: HostError }),
  Rpc.make("Workspace.Checkout", {
    payload: { path: Schema.String, branch: Schema.String, create: Schema.optional(Schema.Boolean) },
    success: WorkspaceStatus,
    error: HostError,
  }),

  Rpc.make("Host.Info", { success: HostInfo }),
  Rpc.make("Host.Events", { success: HostEvent, stream: true }),
  Rpc.make("Host.Plugins", { success: Schema.Array(PluginStatus) }),
  Rpc.make("Host.RestartPlugin", { payload: { pluginId: Schema.String }, error: HostError }),
  /** Re-read config files and apply the composition; diagnostics come back as the error message. */
  Rpc.make("Host.Reload", {
    success: Schema.Struct({ started: Schema.Array(Schema.String), restarted: Schema.Array(Schema.String), stopped: Schema.Array(Schema.String) }),
    error: HostError,
  }),
) {}
