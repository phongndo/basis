import { Cause, Effect, Exit, Stream } from "effect";
import type { Events } from "@basis/core";
import {
  AgentError, Message, ModelEvent, ToolInvocation, TurnEnded, TurnStarted, Usage,
} from "@basis/contracts";
import type {
  ContentPart, FinishReason, Llm, LlmRequest, StreamEvent, TurnOptions,
} from "@basis/contracts";
import { requestFor, sessionError } from "./request.ts";
import type { AgentConfig, RequestServices } from "./request.ts";

export interface TurnServices extends RequestServices {
  readonly llm: Llm["Type"];
  readonly events: Events["Type"];
}

/** Custom entry kinds this plugin appends; `kind` is namespaced by the plugin id. */
export const CancelledEntry = "agent/cancelled";
export const NoticeEntry = "agent/notice";

const zeroUsage = new Usage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const addUsage = (a: Usage, b: Usage) => new Usage({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
  cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
});

type ToolCall = Extract<ContentPart, { type: "tool-call" }>;
type ToolResultPart = Extract<ContentPart, { type: "tool-result" }>;

/** Mutable per-turn bookkeeping shared with the exit handler, which reports even after interruption. */
interface TurnState {
  usage: Usage;
  /** Assistant output received since the last appended message, kept so a cancelled turn loses nothing. */
  text: string;
  thinking: string;
}

/**
 * One turn: append the user message, then model → tools → model until the model
 * stops, the round limit is reached, or the fiber is interrupted. `TurnEnded` is
 * published exactly once from the exit handler, whatever the exit.
 */
export function runTurn(
  services: TurnServices,
  config: AgentConfig,
  sessionId: string,
  turnId: string,
  message: Message,
  options: TurnOptions | undefined,
): Effect.Effect<void, AgentError> {
  const { sessions, tools, llm, events } = services;
  const state: TurnState = { usage: zeroUsage, text: "", thinking: "" };
  const append = (payload: Parameters<typeof sessions.append>[1]) =>
    sessions.append(sessionId, payload).pipe(Effect.mapError(sessionError(sessionId)));
  const llmError = (message: string, cause?: unknown) => new AgentError({ sessionId, reason: "Llm", message, cause });

  /** Streams one model call, publishing each event, and returns its finish. */
  const callModel = (request: LlmRequest) => Effect.gen(function* () {
    let finish: Extract<StreamEvent, { type: "finish" }> | undefined;
    let usage = zeroUsage;
    yield* llm.stream(request).pipe(
      Stream.runForEach((event) => Effect.gen(function* () {
        yield* events.publish(ModelEvent, { sessionId, turnId, event });
        if (event.type === "text-delta") state.text += event.text;
        else if (event.type === "thinking-delta") state.thinking += event.text;
        else if (event.type === "usage") usage = event.usage;
        else if (event.type === "finish") finish = event;
      })),
      Effect.mapError((error) => llmError(error.message, error)),
    );
    if (finish === undefined) return yield* llmError("model stream ended without a finish event");
    state.usage = addUsage(state.usage, usage);
    yield* append({ type: "message", message: finish.message, usage, model: request.model });
    state.text = "";
    state.thinking = "";
    return { reason: finish.reason as FinishReason, message: finish.message };
  });

  const errorResult = (call: ToolCall, text: string): ToolResultPart =>
    ({ type: "tool-result", toolCallId: call.id, content: [{ type: "text", text }], isError: true });

  /** A tool failure is a result the model sees, never the end of the turn. */
  const execute = (call: ToolCall, cwd: string) =>
    tools.execute(new ToolInvocation({ sessionId, toolCallId: call.id, name: call.name, input: call.input, cwd })).pipe(
      Effect.map((result): ToolResultPart => ({ type: "tool-result", toolCallId: call.id, content: result.content, ...(result.isError === undefined ? {} : { isError: result.isError }) })),
      Effect.catchAll((error) => Effect.succeed(errorResult(call, error.message))),
      Effect.catchAllDefect((defect) => Effect.succeed(errorResult(call, `tool ${call.name} crashed: ${String(defect)}`))),
    );

  const loop = Effect.gen(function* () {
    const info = yield* sessions.get(sessionId).pipe(Effect.mapError(sessionError(sessionId)));
    yield* append({ type: "message", message });
    let rounds = 0;
    while (true) {
      const request = yield* requestFor(services, sessionId, options, config);
      const { reason, message: reply } = yield* callModel(request);
      if (reason === "error") return yield* llmError("model finished with an error");
      const calls = reply.parts.filter((part): part is ToolCall => part.type === "tool-call");
      if (reason !== "tool-calls" || calls.length === 0) return;
      if (rounds >= config.maxToolRounds) {
        // The pending calls still need results so the next turn's context stays well-formed.
        const note = `Tool round limit (${config.maxToolRounds}) reached; the turn was stopped.`;
        yield* append({ type: "message", message: new Message({ role: "user", parts: calls.map((call) => errorResult(call, note)) }) });
        yield* append({ type: "custom", kind: NoticeEntry, data: { turnId, message: note } });
        return;
      }
      rounds += 1;
      const results = yield* Effect.all(calls.map((call) => execute(call, info.cwd)), { concurrency: "unbounded" });
      yield* append({ type: "message", message: new Message({ role: "user", parts: results }) });
    }
  });

  /** Keeps whatever the model said before the interruption; the entry marks the turn as cut short. */
  const recordCancelled = Effect.gen(function* () {
    const parts: ContentPart[] = [
      ...(state.thinking === "" ? [] : [{ type: "thinking", text: state.thinking } as const]),
      ...(state.text === "" ? [] : [{ type: "text", text: state.text } as const]),
    ];
    const partial = parts.length > 0;
    if (partial) yield* append({ type: "message", message: new Message({ role: "assistant", parts }) });
    yield* append({ type: "custom", kind: CancelledEntry, data: { turnId, partial } });
  }).pipe(Effect.catchAll((error) => Effect.logWarning(`agent: could not record the cancelled turn ${turnId}: ${error.message}`)));

  const report = (exit: Exit.Exit<void, AgentError>) => Effect.gen(function* () {
    const reason: "done" | "cancelled" | "error" = Exit.isSuccess(exit) ? "done" : Cause.isInterruptedOnly(exit.cause) ? "cancelled" : "error";
    if (reason === "cancelled") yield* recordCancelled;
    yield* events.publish(TurnEnded, { sessionId, turnId, usage: state.usage, reason });
  });

  return events.publish(TurnStarted, { sessionId, turnId }).pipe(
    Effect.zipRight(loop),
    Effect.onExit(report),
  );
}
