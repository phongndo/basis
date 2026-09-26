import { Effect, Stream } from "effect";
import type { HttpClient } from "@effect/platform";
import { LlmError, Message, ModelInfo, Usage } from "@basis/contracts";
import type { ContentPart, Credentials, LlmProvider, LlmRequest, StreamEvent } from "@basis/contracts";
import { isLocal, jsonRequest, parseApiError, resolveApiKey, streamError, streamRequest } from "./http.ts";
import type { ServerEvent } from "./http.ts";

export interface ProviderConfig {
  readonly id: string;
  readonly name?: string | undefined;
  readonly baseUrl: string;
  readonly models: readonly {
    readonly id: string;
    readonly name?: string | undefined;
    readonly contextWindow: number;
    readonly maxOutput?: number | undefined;
    readonly toolCall?: boolean | undefined;
    readonly reasoning?: boolean | undefined;
  }[];
}

export interface ProviderDeps {
  readonly http: HttpClient.HttpClient;
  readonly credentials: typeof Credentials.Service;
}

/** A Chat Completions provider for one configured endpoint. */
export function makeProvider(config: ProviderConfig, deps: ProviderDeps): LlmProvider {
  const id = config.id;
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const models = config.models.map((model) => new ModelInfo({
    id: `${id}/${model.id}`,
    provider: id,
    name: model.name ?? model.id,
    contextWindow: model.contextWindow,
    ...(model.maxOutput === undefined ? {} : { maxOutput: model.maxOutput }),
    toolCall: model.toolCall ?? true,
    reasoning: model.reasoning ?? false,
  }));
  const apiKey = resolveApiKey(deps.credentials, id, { optional: isLocal(config.baseUrl) });
  return {
    id,
    name: config.name ?? id,
    models: Effect.succeed(models),
    stream: (request) => Stream.unwrap(Effect.map(apiKey, (key) => {
      const body = toChatRequest(request);
      return streamRequest(id, deps.http, jsonRequest(url, key, body)).pipe(chatEvents(id));
    })),
  };
}

// --- Request shaping ---

/** Strips the `<provider>/` prefix the registry routes on. */
export function modelName(model: string): string {
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

export function toChatRequest(request: LlmRequest): Record<string, unknown> {
  const messages: unknown[] = [];
  if (request.system !== undefined) messages.push({ role: "system", content: request.system });
  for (const message of request.messages) messages.push(...toChatMessages(message));
  const tools = request.tools?.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
  return {
    model: modelName(request.model),
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  };
}

function imageUrl(part: Extract<ContentPart, { type: "image" }>): string {
  return part.source.kind === "url" ? part.source.url : `data:${part.mediaType};base64,${part.source.data}`;
}

/**
 * One contract message can become several wire messages: each tool result is
 * its own `tool` message, and images inside a tool result follow as a user
 * message because the `tool` role only carries text.
 */
function toChatMessages(message: Message): unknown[] {
  const text: string[] = [];
  const content: unknown[] = [];
  const toolCalls: unknown[] = [];
  const toolMessages: unknown[] = [];
  for (const part of message.parts) {
    switch (part.type) {
      case "text": text.push(part.text); content.push({ type: "text", text: part.text }); break;
      case "image": content.push({ type: "image_url", image_url: { url: imageUrl(part) } }); break;
      case "tool-call": toolCalls.push({ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) } }); break;
      case "tool-result": {
        const resultText = part.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
        const images = part.content.flatMap((item) => item.type === "image" ? [{ type: "image_url", image_url: { url: imageUrl(item) } }] : []);
        toolMessages.push({ role: "tool", tool_call_id: part.toolCallId, content: resultText });
        if (images.length > 0) toolMessages.push({ role: "user", content: [{ type: "text", text: `Images from tool call ${part.toolCallId}:` }, ...images] });
        break;
      }
      // Thinking is not echoed back: Chat Completions servers disagree on the field and many reject unknown ones.
      case "thinking": break;
    }
  }
  if (message.role === "user") {
    const textOnly = content.length === text.length;
    return [...toolMessages, ...(content.length > 0 ? [{ role: "user", content: textOnly ? text.join("") : content }] : [])];
  }
  const assistant = text.length > 0 || toolCalls.length > 0
    ? [{ role: "assistant", content: text.length > 0 ? text.join("") : null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) }]
    : [];
  return [...assistant, ...toolMessages];
}

// --- Streamed chunks ---

interface ToolCallAccumulator { id: string; name: string; arguments: string }

interface Chunk {
  readonly error?: unknown;
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: string | null;
      readonly reasoning_content?: string | null;
      readonly reasoning?: string | null;
      readonly tool_calls?: readonly { readonly index?: number; readonly id?: string; readonly function?: { readonly name?: string; readonly arguments?: string } }[];
    };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number; readonly prompt_tokens_details?: { readonly cached_tokens?: number } } | null;
}

/** Folds Chat Completions chunks into contract events; tool calls are emitted whole when the choice finishes. */
class ChatCompletion {
  private text = "";
  private thinking = "";
  private readonly toolCalls = new Map<number, ToolCallAccumulator>();
  private finishReason: string | undefined;
  private toolCallsEmitted = false;
  private done = false;
  private usage: Usage | undefined;

  constructor(private readonly provider: string) {}

  chunk(event: ServerEvent): Effect.Effect<readonly StreamEvent[], LlmError> {
    if (event.data === "[DONE]") { this.done = true; return Effect.succeed([]); }
    let chunk: Chunk;
    try { chunk = JSON.parse(event.data) as Chunk; } catch (cause) {
      return Effect.fail(new LlmError({ provider: this.provider, reason: "Unknown", message: "Malformed stream chunk", retryable: false, cause }));
    }
    const error = parseApiError(chunk.error === undefined ? undefined : { error: chunk.error });
    if (error !== undefined) return Effect.fail(streamError(this.provider, error));
    const events: StreamEvent[] = [];
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (delta?.content) { this.text += delta.content; events.push({ type: "text-delta", text: delta.content }); }
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (reasoning) { this.thinking += reasoning; events.push({ type: "thinking-delta", text: reasoning }); }
    for (const call of delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      let current = this.toolCalls.get(index);
      if (current === undefined) {
        current = { id: call.id ?? `call_${index}`, name: call.function?.name ?? "", arguments: "" };
        this.toolCalls.set(index, current);
      } else {
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name = call.function.name;
      }
      const inputDelta = call.function?.arguments ?? "";
      current.arguments += inputDelta;
      events.push({ type: "tool-call-delta", id: current.id, name: current.name, inputDelta });
    }
    if (choice?.finish_reason) {
      this.finishReason = choice.finish_reason;
      events.push(...this.emitToolCalls());
    }
    if (chunk.usage) {
      this.usage = new Usage({
        input: chunk.usage.prompt_tokens ?? 0,
        output: chunk.usage.completion_tokens ?? 0,
        ...(chunk.usage.prompt_tokens_details?.cached_tokens === undefined ? {} : { cacheRead: chunk.usage.prompt_tokens_details.cached_tokens }),
      });
      events.push({ type: "usage", usage: this.usage });
    }
    return Effect.succeed(events);
  }

  /** Runs once the body ends. A body that ends without a finish reason or `[DONE]` was cut off. */
  finish(): Effect.Effect<readonly StreamEvent[], LlmError> {
    if (this.finishReason === undefined && !this.done) {
      return Effect.fail(new LlmError({ provider: this.provider, reason: "Network", message: "Stream ended before the completion finished", retryable: true }));
    }
    const events = [...this.emitToolCalls()];
    const parts: ContentPart[] = [];
    if (this.thinking !== "") parts.push({ type: "thinking", text: this.thinking });
    if (this.text !== "") parts.push({ type: "text", text: this.text });
    parts.push(...this.toolCallParts());
    events.push({ type: "finish", reason: this.reason(), message: new Message({ role: "assistant", parts }) });
    return Effect.succeed(events);
  }

  private emitToolCalls(): readonly StreamEvent[] {
    if (this.toolCallsEmitted) return [];
    this.toolCallsEmitted = true;
    return this.toolCallParts();
  }

  private toolCallParts(): Extract<ContentPart, { type: "tool-call" }>[] {
    return [...this.toolCalls.entries()].sort(([a], [b]) => a - b)
      .map(([, call]) => ({ type: "tool-call", id: call.id, name: call.name, input: parseArguments(call.arguments) }));
  }

  private reason(): Extract<StreamEvent, { type: "finish" }>["reason"] {
    if (this.toolCalls.size > 0) return "tool-calls";
    switch (this.finishReason) {
      case "length": return "length";
      case "content_filter": return "refusal";
      case "tool_calls": case "function_call": return "tool-calls";
      default: return "stop";
    }
  }
}

/** Invalid JSON is passed through as the raw string so the tool layer can report it to the model. */
export function parseArguments(raw: string): unknown {
  if (raw.trim() === "") return {};
  try { return JSON.parse(raw); } catch { return raw; }
}

function chatEvents(provider: string) {
  return (events: Stream.Stream<ServerEvent, LlmError>): Stream.Stream<StreamEvent, LlmError> =>
    Stream.unwrap(Effect.sync(() => {
      const completion = new ChatCompletion(provider);
      return events.pipe(
        Stream.mapConcatEffect((event) => completion.chunk(event)),
        Stream.concat(Stream.unwrap(Effect.map(Effect.suspend(() => completion.finish()), Stream.fromIterable))),
      );
    }));
}

