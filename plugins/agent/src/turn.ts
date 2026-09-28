import { randomBytes } from "node:crypto";
import { Cause, Effect, Exit, Stream } from "effect";
import type { Context } from "effect";
import type { Events, Hooks } from "@basis/core";
import {
  AgentContinueHook, AgentError, AgentRequestHook, AssistantDelta, deriveMessages, emptyUsage, rebuildRequest, requestState,
  ToolInvocation, TurnEnded, TurnStarted,
} from "@basis/contracts";
import type {
  AssistantMessage, Contribution, EventData, HostControl, Llm, LlmRequest, ModelInfo, PromptContent, RequestDraft, RequestPlan, SessionError,
  SessionEvent, Sessions, StreamEvent, ThinkingLevel, ToolCall, ToolResultMessage, Tools, ToolSpec, Usage,
} from "@basis/contracts";
import { baseSection, environmentSection, titleFrom } from "./prompt.ts";

export interface TurnServices {
  readonly sessions: Context.Tag.Service<typeof Sessions>;
  readonly llm: Context.Tag.Service<typeof Llm>;
  readonly tools: Context.Tag.Service<typeof Tools>;
  readonly host: Context.Tag.Service<typeof HostControl>;
  readonly hooks: Context.Tag.Service<typeof Hooks>;
  readonly events: Context.Tag.Service<typeof Events>;
  /** The agent plugin's id, recorded as the source of the sections it contributes. */
  readonly source: string;
}

export interface TurnSettings {
  readonly systemPrompt?: string;
  readonly maxSteps: number;
}

export interface TurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly cwd: string;
  /** Session title before the turn; a missing title is set from this prompt. */
  readonly title?: string;
  readonly model: ModelInfo;
  readonly thinking?: ThinkingLevel;
  readonly content: PromptContent;
  /** Aborted by `cancel`; handed to every tool execution. */
  readonly signal: AbortSignal;
}

type TurnReason = "done" | "cancelled" | "error" | "max-steps";
interface Ended { readonly reason: TurnReason; readonly error?: string }

export const newId = (): string => randomBytes(6).toString("base64url");

const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  ...(a.reasoning === undefined && b.reasoning === undefined ? {} : { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) }),
  totalTokens: a.totalTokens + b.totalTokens,
  cost: {
    input: a.cost.input + b.cost.input,
    output: a.cost.output + b.cost.output,
    cacheRead: a.cost.cacheRead + b.cost.cacheRead,
    cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
    total: a.cost.total + b.cost.total,
  },
});

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return keysA.length === keysB.length
    && keysA.every((key) => Object.hasOwn(b, key) && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** Rebuilds what a stream produced so far, so a cancelled call is logged with its partial output. */
class PartialMessage {
  private readonly blocks: (AssistantMessage["content"][number] | undefined)[] = [];

  apply(event: StreamEvent): void {
    if (event.type === "text-delta") {
      const block = this.blocks[event.index];
      this.blocks[event.index] = block?.type === "text" ? { ...block, text: block.text + event.delta } : { type: "text", text: event.delta };
    } else if (event.type === "thinking-delta") {
      const block = this.blocks[event.index];
      this.blocks[event.index] = block?.type === "thinking" ? { ...block, thinking: block.thinking + event.delta } : { type: "thinking", thinking: event.delta };
    } else if (event.type === "toolcall-end") {
      this.blocks[event.index] = event.toolCall;
    }
  }

  message(model: ModelInfo, stopReason: "aborted" | "error", errorMessage: string): AssistantMessage {
    return {
      role: "assistant",
      content: this.blocks.filter((block) => block !== undefined),
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage,
      stopReason,
      errorMessage,
      timestamp: Date.now(),
    };
  }
}

const isFirstToken = (event: StreamEvent) =>
  event.type === "text-delta" || event.type === "thinking-delta" || event.type === "toolcall-start" || event.type === "toolcall-delta";

const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
};

/**
 * One turn. The log is written as the turn goes: `turn-start`, the user
 * message, then per step `step-start`, `request`, the assistant `message` (or
 * an `attempt`), tool results, and `step-end`; `turn-end` always closes it.
 * Every append names the previous one as its parent, so a checkout elsewhere
 * during the turn cannot splice the turn into another branch.
 */
export function runTurn(services: TurnServices, settings: TurnSettings, input: TurnInput): Effect.Effect<void, AgentError> {
  const { sessions, llm, tools, host, hooks, events, source } = services;
  const { sessionId, turnId, cwd, signal } = input;

  const state: {
    lastId: string | undefined;
    usage: Usage;
    /** Open step, closed by `step-end`. */
    step: { readonly id: string; readonly model: ModelInfo } | undefined;
    /** Output of a model call in flight. */
    partial: PartialMessage | undefined;
    partialStartedAt: number;
    /** Tool calls of the logged assistant message that have no result yet. */
    pending: ToolCall[];
  } = { lastId: undefined, usage: emptyUsage, step: undefined, partial: undefined, partialStartedAt: 0, pending: [] };

  const sessionError = (error: SessionError) => new AgentError({ sessionId, reason: "Session", message: error.message, cause: error });

  /** Uninterruptible so a cancelled turn never loses track of an event that did reach the log. */
  const append = (data: EventData): Effect.Effect<SessionEvent, AgentError> => Effect.uninterruptible(
    sessions.append(sessionId, data, state.lastId === undefined ? undefined : { parent: state.lastId }).pipe(
      Effect.tap((event) => Effect.sync(() => { state.lastId = event.id; })),
      Effect.mapError(sessionError),
    ),
  );

  const hookError = (hook: string) => (error: { readonly message: string }) =>
    new AgentError({ sessionId, reason: "Hook", message: `${hook}: ${error.message}`, cause: error });

  const toolResult = (call: ToolCall, text: string): ToolResultMessage =>
    ({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError: true, timestamp: Date.now() });

  /** Builds, logs, and returns the exact request for this step. */
  const prepareRequest = (stepId: string) => Effect.gen(function* () {
    const branch = yield* sessions.branch(sessionId, { leaf: state.lastId! }).pipe(Effect.mapError(sessionError));
    const listed = yield* tools.list;
    const draft: RequestDraft = {
      sessionId, turnId, cwd,
      model: input.model.ref,
      ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
      sections: [
        baseSection(source, new Set(listed.map((tool) => tool.spec.name)), settings.systemPrompt),
        environmentSection(source, cwd),
      ],
      tools: listed,
      history: deriveMessages(branch),
    };
    const plan = yield* hooks.invoke(AgentRequestHook, draft, (final): Effect.Effect<RequestPlan> => Effect.succeed({
      model: final.model,
      ...(final.thinking === undefined ? {} : { thinking: final.thinking }),
      sections: final.sections,
      tools: final.tools,
    })).pipe(Effect.mapError(hookError("AgentRequestHook")));
    const model = plan.model === input.model.ref ? input.model : yield* llm.model(plan.model).pipe(
      Effect.mapError((error) => new AgentError({ sessionId, reason: "NoModel", message: error.message, cause: error })),
    );
    const system = plan.sections.map((section) => section.text).filter((text) => text.length > 0).join("\n\n");
    const specs: ToolSpec[] = plan.tools.map((tool) => tool.spec);
    const contributions: Contribution[] = [
      ...plan.sections.map((section): Contribution => ({ source: section.source, kind: "system", label: section.id, chars: section.text.length })),
      ...plan.tools.map((tool): Contribution => ({ source: tool.source, kind: "tool", label: tool.spec.name, chars: JSON.stringify(tool.spec).length })),
    ];
    const previous = requestState(branch);
    const composition = yield* host.composition;
    const logged = yield* append({
      type: "request", turnId, stepId,
      model: plan.model,
      ...(plan.thinking === undefined ? {} : { thinking: plan.thinking }),
      composition: composition.id,
      ...(previous.system === system ? {} : { system }),
      ...(deepEqual(previous.tools ?? [], specs) ? {} : { tools: specs }),
      contributions,
    });
    // Send what the log says was sent: the request is rebuilt from the branch that now ends at the request event.
    const request = rebuildRequest(yield* sessions.branch(sessionId, { leaf: logged.id }).pipe(Effect.mapError(sessionError)), logged.id, sessionId);
    if (request === undefined) return yield* Effect.dieMessage(`request ${logged.id} is not on its own branch`);
    return { request, model };
  });

  /** Streams one model call. Returns the settled message, or how the turn ends when the call failed. */
  const callModel = (stepId: string, request: LlmRequest, model: ModelInfo) => Effect.gen(function* () {
    const startedAt = Date.now();
    let firstTokenAt: number | undefined;
    let settled: Extract<StreamEvent, { type: "done" | "error" }> | undefined;
    const partial = new PartialMessage();
    state.partial = partial;
    state.partialStartedAt = startedAt;
    const failure = yield* llm.stream(request).pipe(
      Stream.runForEach((event) => Effect.gen(function* () {
        if (firstTokenAt === undefined && isFirstToken(event)) firstTokenAt = Date.now();
        partial.apply(event);
        if (event.type === "done" || event.type === "error") settled = event;
        yield* events.publish(AssistantDelta, { sessionId, turnId, stepId, event });
      })),
      Effect.as(undefined),
      Effect.catchAll((error) => Effect.succeed(error.message)),
    );
    const timing = { startedAt, ...(firstTokenAt === undefined ? {} : { firstTokenAt }), endedAt: Date.now() };
    return yield* Effect.uninterruptible(Effect.gen(function* () {
      state.partial = undefined;
      if (settled === undefined) {
        const error = failure ?? "The model stream ended without a result";
        yield* append({ type: "attempt", turnId, stepId, message: partial.message(model, "error", error), timing });
        return { ended: { reason: "error", error } satisfies Ended };
      }
      state.usage = addUsage(state.usage, settled.message.usage);
      if (settled.type === "error") {
        yield* append({ type: "attempt", turnId, stepId, message: settled.message, timing });
        const aborted = settled.message.stopReason === "aborted";
        return { ended: { reason: aborted ? "cancelled" : "error", error: settled.message.errorMessage ?? (aborted ? "Aborted" : "Model error") } satisfies Ended };
      }
      yield* append({ type: "message", message: settled.message, turnId, stepId, timing });
      state.pending = settled.message.content.filter((block): block is ToolCall => block.type === "toolCall");
      return { message: settled.message };
    }));
  });

  /** Runs the pending tool calls in order, logging each result as it arrives. */
  const runTools = (stepId: string) => Effect.gen(function* () {
    const results: ToolResultMessage[] = [];
    while (state.pending.length > 0) {
      // `cancel` aborts before it interrupts; start nothing new in between.
      if (signal.aborted) return yield* Effect.interrupt;
      const call = state.pending[0]!;
      const startedAt = Date.now();
      const invocation = new ToolInvocation({ sessionId, toolCallId: call.id, name: call.name, input: call.arguments, cwd });
      const result = yield* tools.execute(invocation, signal).pipe(
        Effect.map((value) => ({ content: value.content, isError: value.isError ?? false, details: value.details })),
        Effect.catchAll((error) => Effect.succeed({ content: [{ type: "text" as const, text: error.message }], isError: true, details: undefined })),
        Effect.catchAllDefect((defect) => Effect.succeed({ content: [{ type: "text" as const, text: `Tool ${call.name} crashed: ${String(defect)}` }], isError: true, details: undefined })),
      );
      const message: ToolResultMessage = {
        role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, isError: result.isError, timestamp: Date.now(),
      };
      yield* Effect.uninterruptible(Effect.gen(function* () {
        yield* append({
          type: "message", message, turnId, stepId,
          timing: { startedAt, endedAt: Date.now() },
          ...(result.details === undefined ? {} : { details: result.details }),
        });
        state.pending.shift();
      }));
      results.push(message);
    }
    return results;
  });

  const steps = Effect.gen(function* () {
    for (let step = 1; ; step++) {
      const stepId = newId();
      yield* append({ type: "step-start", turnId, stepId });
      state.step = { id: stepId, model: input.model };
      const { request, model } = yield* prepareRequest(stepId);
      state.step = { id: stepId, model };
      const outcome = yield* callModel(stepId, request, model);
      if ("ended" in outcome) return outcome.ended;
      const results = yield* runTools(stepId);
      const decision = yield* hooks.invoke(
        AgentContinueHook,
        { sessionId, turnId, step, message: outcome.message, results },
        (final) => Effect.succeed(final.message.stopReason === "toolUse" ? "continue" as const : "stop" as const),
      ).pipe(Effect.mapError(hookError("AgentContinueHook")));
      yield* append({ type: "step-end", turnId, stepId });
      state.step = undefined;
      if (decision === "stop") return { reason: "done" } satisfies Ended;
      if (step >= settings.maxSteps) return { reason: "max-steps" } satisfies Ended;
    }
  });

  /**
   * Closes the turn whatever happened: the partial output of an interrupted
   * model call becomes an `attempt`, unanswered tool calls get error results so
   * the next request is still valid, then `step-end` and `turn-end`.
   */
  const finish = (exit: Exit.Exit<Ended, AgentError>) => Effect.gen(function* () {
    const ended: Ended = Exit.isSuccess(exit) ? exit.value
      : Cause.isInterruptedOnly(exit.cause) ? { reason: "cancelled" }
      : { reason: "error", error: causeMessage(exit.cause) };
    const cancelled = ended.reason === "cancelled";
    const step = state.step;
    if (step !== undefined && state.partial !== undefined) {
      const message = state.partial.message(step.model, cancelled ? "aborted" : "error", cancelled ? "Cancelled" : ended.error ?? "Turn failed");
      yield* append({ type: "attempt", turnId, stepId: step.id, message, timing: { startedAt: state.partialStartedAt, endedAt: Date.now() } });
      state.partial = undefined;
    }
    while (state.pending.length > 0) {
      const call = state.pending[0]!;
      const text = cancelled ? "Tool execution was cancelled." : `Tool was not executed: the turn failed (${ended.error ?? "unknown error"}).`;
      yield* append({ type: "message", message: toolResult(call, text), turnId, ...(step === undefined ? {} : { stepId: step.id }) });
      state.pending.shift();
    }
    if (step !== undefined) yield* append({ type: "step-end", turnId, stepId: step.id });
    yield* append({ type: "turn-end", turnId, reason: ended.reason, ...(ended.error === undefined ? {} : { error: ended.error }) });
  }).pipe(
    Effect.catchAll((error) => Effect.logWarning(`agent: could not close turn ${turnId} in session ${sessionId}: ${error.message}`)),
    Effect.ensuring(Effect.suspend(() => events.publish(TurnEnded, {
      sessionId, turnId, usage: state.usage,
      reason: Exit.isSuccess(exit) ? exit.value.reason : Cause.isInterruptedOnly(exit.cause) ? "cancelled" : "error",
    }))),
  );

  return Effect.gen(function* () {
    yield* append({ type: "turn-start", turnId });
    yield* events.publish(TurnStarted, { sessionId, turnId });
    const body = Effect.gen(function* () {
      yield* append({ type: "message", message: { role: "user", content: input.content, timestamp: Date.now() }, turnId });
      const title = input.title === undefined ? titleFrom(input.content) : undefined;
      if (title !== undefined) yield* append({ type: "title", title });
      return yield* steps;
    });
    yield* body.pipe(Effect.onExit(finish));
  });
}
