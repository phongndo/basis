import { Effect, Schema } from "effect";
import { Hooks } from "@basis/core";
import {
  AgentError, AgentRequestHook, LlmRequest, Message, Sessions, Tools,
} from "@basis/contracts";
import type { SessionEntry, SessionError, TurnOptions } from "@basis/contracts";

export const DEFAULT_MODEL = "anthropic/claude-opus-5";

export const AgentConfig = Schema.Struct({
  /** `<provider>/<model>` used when a turn names none. */
  model: Schema.optionalWith(Schema.String, { default: () => DEFAULT_MODEL }),
  effort: Schema.optional(Schema.Literal("low", "medium", "high", "max")),
  /** Rounds of tool execution allowed in one turn before the loop stops with a note. */
  maxToolRounds: Schema.optionalWith(Schema.Number, { default: () => 200 }),
  /** Replaces the default system prompt entirely. */
  systemPrompt: Schema.optional(Schema.String),
});
export type AgentConfig = typeof AgentConfig.Type;

/** What `buildRequest` needs; the plugin captures these once, the exported helper resolves them from the context. */
export interface RequestServices {
  readonly sessions: Sessions["Type"];
  readonly tools: Tools["Type"];
  readonly hooks: Hooks["Type"];
}

/** Minimal by design: prompt plugins add to it through `AgentRequestHook`. */
export const defaultSystemPrompt = (cwd: string, date: string) => [
  `You are a coding agent working in ${cwd}. Today is ${date}.`,
  "Use the tools to inspect and change files and to run commands; read before you edit, and call independent tools in the same round.",
  "Keep changes minimal and in scope. Say what you did and what you verified; say plainly when something is not done.",
  "Ask when the request is ambiguous; otherwise act.",
].join("\n");

/**
 * Root-to-leaf entries become alternating messages. A compaction entry replaces
 * everything before it with a summary as the first user message, acknowledged by
 * the assistant so the roles still alternate.
 */
export function contextMessages(entries: readonly SessionEntry[]): Message[] {
  let messages: Message[] = [];
  for (const { payload } of entries) {
    if (payload.type === "compaction") {
      messages = [
        new Message({ role: "user", parts: [{ type: "text", text: `Summary of earlier conversation:\n${payload.summary}` }] }),
        new Message({ role: "assistant", parts: [{ type: "text", text: "Understood. I will continue from that summary." }] }),
      ];
    } else if (payload.type === "message") {
      messages.push(payload.message);
    }
  }
  return messages;
}

export const sessionError = (sessionId: string) => (error: SessionError) =>
  new AgentError({ sessionId, reason: "Session", message: error.message, cause: error });

/** Builds the request for the session's current context and runs `AgentRequestHook` over it. */
export function requestFor(
  services: RequestServices,
  sessionId: string,
  options: TurnOptions | undefined,
  config: Partial<AgentConfig>,
): Effect.Effect<LlmRequest, AgentError> {
  return Effect.gen(function* () {
    const info = yield* services.sessions.get(sessionId).pipe(Effect.mapError(sessionError(sessionId)));
    const entries = yield* services.sessions.context(sessionId).pipe(Effect.mapError(sessionError(sessionId)));
    const allowed = options?.tools === undefined ? undefined : new Set(options.tools);
    const tools = (yield* services.tools.list).filter((tool) => allowed === undefined || allowed.has(tool.name));
    const effort = options?.effort ?? config.effort;
    const request = new LlmRequest({
      model: options?.model ?? config.model ?? DEFAULT_MODEL,
      system: config.systemPrompt ?? defaultSystemPrompt(info.cwd, new Date().toISOString().slice(0, 10)),
      messages: contextMessages(entries),
      ...(tools.length === 0 ? {} : { tools }),
      ...(effort === undefined ? {} : { effort }),
    });
    return yield* services.hooks.invoke(AgentRequestHook, { sessionId, request }, (input) => Effect.succeed(input.request)).pipe(
      Effect.mapError((error) => new AgentError({ sessionId, reason: "Llm", message: `agent request hook: ${error.message}`, cause: error })),
    );
  });
}

/**
 * The request the agent would send now, for "what does the model see" previews
 * (the transport's `Agent.Preview`). Same code path as a turn, including the
 * hook; pass the agent's config to get its default model and system prompt.
 */
export function buildRequest(
  sessionId: string,
  options?: TurnOptions,
  config: Partial<AgentConfig> = {},
): Effect.Effect<LlmRequest, AgentError, Sessions | Tools | Hooks> {
  return Effect.flatMap(
    Effect.all({ sessions: Sessions, tools: Tools, hooks: Hooks }),
    (services) => requestFor(services, sessionId, options, config),
  );
}
