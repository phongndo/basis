import { Effect, Stream } from "effect";
import type { HttpClient } from "@effect/platform";
import { LlmError, Message, Usage } from "@basis/contracts";
import type { ContentPart, Credentials, LlmProvider, LlmRequest, ModelInfo, StreamEvent } from "@basis/contracts";
import { jsonRequest, parseApiError, resolveApiKey, streamError, streamRequest } from "./http.ts";
import type { ServerEvent } from "./http.ts";

export const providerId = "openai";

export interface ProviderDeps {
  readonly http: HttpClient.HttpClient;
  readonly credentials: typeof Credentials.Service;
  readonly baseUrl: string;
  readonly models: readonly ModelInfo[];
}

/** The `openai` provider, speaking the Responses API. */
export function makeProvider(deps: ProviderDeps): LlmProvider {
  const url = `${deps.baseUrl.replace(/\/+$/, "")}/responses`;
  const apiKey = resolveApiKey(deps.credentials, providerId, { optional: false });
  return {
    id: providerId,
    name: "OpenAI",
    models: Effect.succeed(deps.models),
    stream: (request) => Stream.unwrap(Effect.map(apiKey, (key) =>
      streamRequest(providerId, deps.http, jsonRequest(url, key, toResponsesRequest(request))).pipe(responseEvents))),
  };
}

// --- Request shaping ---

/** Strips the `<provider>/` prefix the registry routes on. */
export function modelName(model: string): string {
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

/** Opaque state carried on a `ThinkingPart` so the reasoning item can be replayed verbatim. */
export interface ReasoningState {
  readonly id: string;
  readonly encrypted_content: string;
}

function reasoningState(state: unknown): ReasoningState | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const { id, encrypted_content } = state as Partial<ReasoningState>;
  return typeof id === "string" && typeof encrypted_content === "string" ? { id, encrypted_content } : undefined;
}

export function toResponsesRequest(request: LlmRequest): Record<string, unknown> {
  const tools = request.tools?.map((tool) => ({
    type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false,
  }));
  return {
    model: modelName(request.model),
    ...(request.system === undefined ? {} : { instructions: request.system }),
    input: request.messages.flatMap(toItems),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(request.effort === undefined ? {} : { reasoning: { effort: request.effort === "max" ? "high" : request.effort } }),
    include: ["reasoning.encrypted_content"],
    stream: true,
    store: false,
    ...(request.maxTokens === undefined ? {} : { max_output_tokens: request.maxTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  };
}

function imageUrl(part: Extract<ContentPart, { type: "image" }>): string {
  return part.source.kind === "url" ? part.source.url : `data:${part.mediaType};base64,${part.source.data}`;
}

/**
 * A contract message becomes a run of input items in part order. Tool results
 * are `function_call_output` items; images inside them follow as a user
 * message because outputs are text. Thinking is replayed only when it carries
 * the encrypted reasoning state, which is all the server accepts.
 */
function toItems(message: Message): unknown[] {
  const items: unknown[] = [];
  let content: unknown[] = [];
  const role = message.role;
  const flush = () => {
    if (content.length > 0) items.push({ type: "message", role, content });
    content = [];
  };
  for (const part of message.parts) {
    switch (part.type) {
      case "text": content.push(role === "assistant" ? { type: "output_text", text: part.text } : { type: "input_text", text: part.text }); break;
      case "image": content.push({ type: "input_image", image_url: imageUrl(part), detail: "auto" }); break;
      case "thinking": {
        const state = reasoningState(part.state);
        if (state === undefined) break;
        flush();
        items.push({ type: "reasoning", id: state.id, summary: part.text === "" ? [] : [{ type: "summary_text", text: part.text }], encrypted_content: state.encrypted_content });
        break;
      }
      case "tool-call":
        flush();
        items.push({ type: "function_call", call_id: part.id, name: part.name, arguments: JSON.stringify(part.input ?? {}) });
        break;
      case "tool-result": {
        flush();
        const output = part.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
        items.push({ type: "function_call_output", call_id: part.toolCallId, output });
        const images = part.content.flatMap((item) => item.type === "image" ? [{ type: "input_image", image_url: imageUrl(item), detail: "auto" }] : []);
        if (images.length > 0) items.push({ type: "message", role: "user", content: [{ type: "input_text", text: `Images from tool call ${part.toolCallId}:` }, ...images] });
        break;
      }
    }
  }
  flush();
  return items;
}

// --- Streamed events ---

interface OutputItem {
  readonly type: string;
  readonly id?: string;
  readonly call_id?: string;
  readonly name?: string;
  arguments?: string;
  encrypted_content?: string | null;
  summary?: readonly { readonly type: string; readonly text: string }[];
  content?: readonly { readonly type: string; readonly text?: string; readonly refusal?: string }[];
}

interface ResponseEvent {
  readonly type: string;
  readonly output_index?: number;
  readonly item_id?: string;
  readonly item?: OutputItem;
  readonly delta?: string;
  readonly arguments?: string;
  readonly response?: {
    readonly status?: string;
    readonly incomplete_details?: { readonly reason?: string } | null;
    readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number; readonly input_tokens_details?: { readonly cached_tokens?: number } } | null;
    readonly error?: unknown;
  };
  readonly code?: string;
  readonly message?: string;
}

/** Text accumulated per output item while streaming; the `done` item replaces it. */
interface Accumulated { item: OutputItem; text: string; summary: string; arguments: string }

/** Folds Responses API events into contract events, keeping items in output order for the final message. */
class ResponseCompletion {
  private readonly items: Accumulated[] = [];
  private readonly byId = new Map<string, Accumulated>();
  private status: string | undefined;
  private incompleteReason: string | undefined;

  constructor(private readonly provider: string) {}

  event(raw: ServerEvent): Effect.Effect<readonly StreamEvent[], LlmError> {
    let event: ResponseEvent;
    try { event = JSON.parse(raw.data) as ResponseEvent; } catch (cause) {
      return Effect.fail(new LlmError({ provider: this.provider, reason: "Unknown", message: "Malformed stream event", retryable: false, cause }));
    }
    switch (event.type) {
      case "response.output_item.added": {
        if (event.item === undefined) return Effect.succeed([]);
        const accumulated: Accumulated = { item: event.item, text: "", summary: "", arguments: event.item.arguments ?? "" };
        this.items[event.output_index ?? this.items.length] = accumulated;
        if (event.item.id !== undefined) this.byId.set(event.item.id, accumulated);
        return Effect.succeed([]);
      }
      case "response.output_text.delta": {
        const delta = event.delta ?? "";
        const target = this.find(event.item_id);
        if (target !== undefined) target.text += delta;
        return Effect.succeed([{ type: "text-delta", text: delta }]);
      }
      case "response.reasoning_summary_text.delta": {
        const delta = event.delta ?? "";
        const target = this.find(event.item_id);
        if (target !== undefined) target.summary += delta;
        return Effect.succeed([{ type: "thinking-delta", text: delta }]);
      }
      case "response.function_call_arguments.delta": {
        const target = this.find(event.item_id);
        if (target === undefined) return Effect.succeed([]);
        const delta = event.delta ?? "";
        target.arguments += delta;
        return Effect.succeed([{ type: "tool-call-delta", id: target.item.call_id ?? target.item.id ?? "", name: target.item.name ?? "", inputDelta: delta }]);
      }
      case "response.function_call_arguments.done": {
        const target = this.find(event.item_id);
        if (target !== undefined && event.arguments !== undefined) target.arguments = event.arguments;
        return Effect.succeed([]);
      }
      case "response.output_item.done": {
        if (event.item === undefined) return Effect.succeed([]);
        const target = this.find(event.item.id) ?? this.items[event.output_index ?? -1];
        const done = this.complete(event.item, target);
        if (target === undefined) this.items[event.output_index ?? this.items.length] = done;
        else Object.assign(target, done);
        return Effect.succeed(done.item.type === "function_call" ? [toolCall(done)] : []);
      }
      case "response.completed": case "response.incomplete": {
        this.status = event.response?.status ?? (event.type === "response.incomplete" ? "incomplete" : "completed");
        this.incompleteReason = event.response?.incomplete_details?.reason;
        const usage = event.response?.usage;
        return Effect.succeed(usage ? [{ type: "usage", usage: new Usage({
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          ...(usage.input_tokens_details?.cached_tokens === undefined ? {} : { cacheRead: usage.input_tokens_details.cached_tokens }),
        }) }] : []);
      }
      case "response.failed": {
        const error = parseApiError({ error: event.response?.error });
        return Effect.fail(error === undefined
          ? new LlmError({ provider: this.provider, reason: "Unknown", message: "Response failed", retryable: false, cause: event })
          : streamError(this.provider, error));
      }
      case "error": {
        const error = parseApiError(event);
        return Effect.fail(error === undefined
          ? new LlmError({ provider: this.provider, reason: "Unknown", message: "Stream error", retryable: false, cause: event })
          : streamError(this.provider, error));
      }
      default: return Effect.succeed([]);
    }
  }

  /** Runs once the body ends; without a terminal response event the stream was cut off. */
  finish(): Effect.Effect<readonly StreamEvent[], LlmError> {
    if (this.status === undefined) {
      return Effect.fail(new LlmError({ provider: this.provider, reason: "Network", message: "Stream ended before the response completed", retryable: true }));
    }
    const parts: ContentPart[] = [];
    let refused = false;
    for (const accumulated of this.items) {
      if (accumulated === undefined) continue;
      const { item } = accumulated;
      switch (item.type) {
        case "reasoning":
          if (accumulated.summary !== "" || item.encrypted_content) {
            parts.push({
              type: "thinking", text: accumulated.summary,
              ...(item.encrypted_content && item.id !== undefined ? { state: { id: item.id, encrypted_content: item.encrypted_content } satisfies ReasoningState } : {}),
            });
          }
          break;
        case "message":
          if (accumulated.text !== "") parts.push({ type: "text", text: accumulated.text });
          if (item.content?.some((content) => content.type === "refusal")) refused = true;
          break;
        case "function_call": parts.push(toolCall(accumulated)); break;
      }
    }
    const reason: Extract<StreamEvent, { type: "finish" }>["reason"] =
      parts.some((part) => part.type === "tool-call") ? "tool-calls"
        : this.incompleteReason === "max_output_tokens" ? "length"
          : this.incompleteReason === "content_filter" || refused ? "refusal"
            : this.status === "failed" ? "error" : "stop";
    return Effect.succeed([{ type: "finish", reason, message: new Message({ role: "assistant", parts }) }]);
  }

  private find(itemId: string | undefined): Accumulated | undefined {
    return itemId === undefined ? undefined : this.byId.get(itemId);
  }

  /** The `done` item is authoritative: its summary, text, and arguments replace what was accumulated. */
  private complete(item: OutputItem, previous: Accumulated | undefined): Accumulated {
    const summary = item.summary?.map((entry) => entry.text).join("") ?? previous?.summary ?? "";
    const text = item.content?.flatMap((content) => content.type === "output_text" && content.text !== undefined ? [content.text] : []).join("") ?? previous?.text ?? "";
    return { item, text, summary, arguments: item.arguments ?? previous?.arguments ?? "" };
  }
}

function toolCall(accumulated: Accumulated): Extract<StreamEvent, { type: "tool-call" }> {
  return { type: "tool-call", id: accumulated.item.call_id ?? accumulated.item.id ?? "", name: accumulated.item.name ?? "", input: parseArguments(accumulated.arguments) };
}

/** Invalid JSON is passed through as the raw string so the tool layer can report it to the model. */
export function parseArguments(raw: string): unknown {
  if (raw.trim() === "") return {};
  try { return JSON.parse(raw); } catch { return raw; }
}

function responseEvents(events: Stream.Stream<ServerEvent, LlmError>): Stream.Stream<StreamEvent, LlmError> {
  return Stream.unwrap(Effect.sync(() => {
    const completion = new ResponseCompletion(providerId);
    return events.pipe(
      Stream.mapConcatEffect((event) => completion.event(event)),
      Stream.concat(Stream.unwrap(Effect.map(Effect.suspend(() => completion.finish()), Stream.fromIterable))),
    );
  }));
}
