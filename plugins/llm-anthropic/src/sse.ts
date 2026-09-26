import { Effect, Stream } from "effect";
import { LlmError, Message, Usage } from "@basis/contracts";
import type { ContentPart, FinishReason, StreamEvent } from "@basis/contracts";
import { PROVIDER_ID } from "./catalog.ts";
import { fromErrorEvent } from "./errors.ts";

export interface SseEvent { readonly event: string; readonly data: string }

interface SseState { readonly event: string; readonly data: readonly string[] }
const emptySse: SseState = { event: "", data: [] };

/** Server-sent events per the WHATWG spec subset the API uses: `event:` and `data:` lines, blank-line delimited, `:` comments. */
export const parseSse = <E, R>(bytes: Stream.Stream<Uint8Array, E, R>): Stream.Stream<SseEvent, E, R> =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    // A final event without a trailing blank line is still an event.
    Stream.concat(Stream.make("")),
    Stream.mapAccum(emptySse, (state, line): [SseState, readonly SseEvent[]] => {
      if (line === "") {
        return [emptySse, state.data.length === 0 ? [] : [{ event: state.event || "message", data: state.data.join("\n") }]];
      }
      if (line.startsWith(":")) return [state, []];
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const raw = colon === -1 ? "" : line.slice(colon + 1);
      const value = raw.startsWith(" ") ? raw.slice(1) : raw;
      if (field === "event") return [{ ...state, event: value }, []];
      if (field === "data") return [{ ...state, data: [...state.data, value] }, []];
      return [state, []];
    }),
    Stream.flattenIterables,
  );

// The event shapes the Messages API streams; fields we do not read are omitted.
interface WireUsage {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation_input_tokens?: number | null;
}
type WireBlockStart =
  | { readonly type: "text"; readonly text?: string }
  | { readonly type: "thinking"; readonly thinking?: string; readonly signature?: string }
  | { readonly type: "redacted_thinking"; readonly data: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string }
  | { readonly type: string };
type WireDelta =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly thinking: string }
  | { readonly type: "signature_delta"; readonly signature: string }
  | { readonly type: "input_json_delta"; readonly partial_json: string }
  | { readonly type: string };
type WireEvent =
  | { readonly type: "message_start"; readonly message: { readonly usage?: WireUsage } }
  | { readonly type: "content_block_start"; readonly index: number; readonly content_block: WireBlockStart }
  | { readonly type: "content_block_delta"; readonly index: number; readonly delta: WireDelta }
  | { readonly type: "content_block_stop"; readonly index: number }
  | { readonly type: "message_delta"; readonly delta: { readonly stop_reason?: string | null }; readonly usage?: WireUsage }
  | { readonly type: "message_stop" }
  | { readonly type: "ping" }
  | { readonly type: "error"; readonly error: { readonly type?: string; readonly message: string } }
  /** Synthetic: the byte stream ended. */
  | { readonly type: "basis/end" };

type Building =
  | { readonly type: "text"; text: string }
  | { readonly type: "thinking"; thinking: string; signature: string }
  | { readonly type: "redacted_thinking"; readonly data: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; json: string }
  | { readonly type: "ignored" };

interface Accumulated {
  readonly blocks: Map<number, Building>;
  readonly parts: Map<number, ContentPart>;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  reason: FinishReason;
  finished: boolean;
}

const STOP_REASONS: Readonly<Record<string, FinishReason>> = {
  end_turn: "stop", stop_sequence: "stop", pause_turn: "stop", max_tokens: "length", tool_use: "tool-calls", refusal: "refusal",
};

const fail = (message: string, retryable: boolean, cause?: unknown) =>
  Effect.fail(new LlmError({ provider: PROVIDER_ID, reason: "Unknown", message, retryable, ...(cause === undefined ? {} : { cause }) }));

function decodeEvent(event: SseEvent): Effect.Effect<WireEvent, LlmError> {
  try {
    const parsed = JSON.parse(event.data) as WireEvent;
    return typeof parsed === "object" && parsed !== null && typeof parsed.type === "string"
      ? Effect.succeed(parsed)
      : fail(`Malformed Anthropic stream event: ${event.data.slice(0, 200)}`, true);
  } catch (cause) {
    return fail(`Malformed Anthropic stream event: ${event.data.slice(0, 200)}`, true, cause);
  }
}

function startBlock(block: WireBlockStart): Building {
  switch (block.type) {
    case "text": return { type: "text", text: (block as { text?: string }).text ?? "" };
    case "thinking": return { type: "thinking", thinking: (block as { thinking?: string }).thinking ?? "", signature: (block as { signature?: string }).signature ?? "" };
    case "redacted_thinking": return { type: "redacted_thinking", data: (block as { data: string }).data };
    case "tool_use": return { type: "tool_use", id: (block as { id: string }).id, name: (block as { name: string }).name, json: "" };
    default: return { type: "ignored" };
  }
}

function mergeUsage(current: Accumulated["usage"], usage: WireUsage | undefined): Accumulated["usage"] {
  if (usage === undefined) return current;
  const next = { ...current };
  if (typeof usage.input_tokens === "number") next.input = usage.input_tokens;
  if (typeof usage.output_tokens === "number") next.output = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === "number") next.cacheRead = usage.cache_read_input_tokens;
  if (typeof usage.cache_creation_input_tokens === "number") next.cacheWrite = usage.cache_creation_input_tokens;
  return next;
}

function finishBlock(block: Building): Effect.Effect<{ readonly part?: ContentPart; readonly events: readonly StreamEvent[] }, LlmError> {
  switch (block.type) {
    case "text": return Effect.succeed({ part: { type: "text", text: block.text }, events: [] });
    // The whole block, signature included, is what the API accepts back; ThinkingPart.state carries it verbatim.
    case "thinking": return Effect.succeed({ part: { type: "thinking", text: block.thinking, state: { type: "thinking", thinking: block.thinking, signature: block.signature } }, events: [] });
    case "redacted_thinking": return Effect.succeed({ part: { type: "thinking", text: "", state: { type: "redacted_thinking", data: block.data } }, events: [] });
    case "tool_use": {
      let input: unknown;
      try {
        input = block.json.trim() === "" ? {} : JSON.parse(block.json);
      } catch (cause) {
        // With eager input streaming the API does not validate; a cut-off or malformed input cannot be a tool call.
        return fail(`Tool call "${block.name}" (${block.id}) produced invalid JSON input`, true, cause);
      }
      const part: ContentPart = { type: "tool-call", id: block.id, name: block.name, input };
      return Effect.succeed({ part, events: [part] });
    }
    case "ignored": return Effect.succeed({ events: [] });
  }
}

/** Folds API events into basis `StreamEvent`s and the assembled assistant `Message`. */
export const toStreamEvents = <E, R>(events: Stream.Stream<SseEvent, E, R>): Stream.Stream<StreamEvent, E | LlmError, R> =>
  // The accumulator is mutated in place, so each run of the stream gets its own.
  Stream.suspend(() => events.pipe(
    Stream.mapEffect(decodeEvent),
    Stream.concat(Stream.succeed<WireEvent>({ type: "basis/end" })),
    Stream.mapAccumEffect(
      { blocks: new Map(), parts: new Map(), usage: { input: 0, output: 0 }, reason: "stop", finished: false } as Accumulated,
      (state: Accumulated, event: WireEvent): Effect.Effect<[Accumulated, readonly StreamEvent[]], LlmError> => {
        const next = (events: readonly StreamEvent[] = []): Effect.Effect<[Accumulated, readonly StreamEvent[]], LlmError> => Effect.succeed([state, events]);
        switch (event.type) {
          case "message_start":
            state.usage = mergeUsage(state.usage, event.message.usage);
            return next();
          case "content_block_start":
            state.blocks.set(event.index, startBlock(event.content_block));
            return next();
          case "content_block_delta": {
            const block = state.blocks.get(event.index);
            const delta = event.delta;
            if (block?.type === "text" && delta.type === "text_delta") {
              const text = (delta as { text: string }).text;
              block.text += text;
              return next([{ type: "text-delta", text }]);
            }
            if (block?.type === "thinking" && delta.type === "thinking_delta") {
              const text = (delta as { thinking: string }).thinking;
              block.thinking += text;
              return next([{ type: "thinking-delta", text }]);
            }
            if (block?.type === "thinking" && delta.type === "signature_delta") {
              block.signature += (delta as { signature: string }).signature;
              return next();
            }
            if (block?.type === "tool_use" && delta.type === "input_json_delta") {
              const inputDelta = (delta as { partial_json: string }).partial_json;
              block.json += inputDelta;
              return next([{ type: "tool-call-delta", id: block.id, name: block.name, inputDelta }]);
            }
            return next();
          }
          case "content_block_stop": {
            const block = state.blocks.get(event.index);
            if (block === undefined) return next();
            state.blocks.delete(event.index);
            return Effect.map(finishBlock(block), ({ part, events }) => {
              if (part !== undefined) state.parts.set(event.index, part);
              return [state, events];
            });
          }
          case "message_delta": {
            state.usage = mergeUsage(state.usage, event.usage);
            const stopReason = event.delta.stop_reason;
            if (typeof stopReason === "string") state.reason = STOP_REASONS[stopReason] ?? "stop";
            return next([{ type: "usage", usage: new Usage(state.usage) }]);
          }
          case "message_stop": {
            state.finished = true;
            const parts = [...state.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part);
            return next([{ type: "finish", reason: state.reason, message: new Message({ role: "assistant", parts }) }]);
          }
          case "error":
            return Effect.fail(fromErrorEvent(event.error));
          case "basis/end":
            return state.finished
              ? next()
              : Effect.fail(new LlmError({ provider: PROVIDER_ID, reason: "Network", message: "Anthropic stream ended before message_stop", retryable: true }));
          default:
            return next();
        }
      },
    ),
    Stream.flattenIterables,
  ));
