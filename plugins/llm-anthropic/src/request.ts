import type { ContentPart, LlmRequest, Message } from "@basis/contracts";
import { factsFor, PROVIDER_ID } from "./catalog.ts";

/** Streaming keeps long outputs under HTTP timeouts; this is the ceiling when a request sets none. */
export const DEFAULT_MAX_TOKENS = 64_000;
/** Haiku 4.5 still takes a fixed budget; it must stay below max_tokens. */
export const HAIKU_THINKING_BUDGET = 4096;

const EPHEMERAL = { type: "ephemeral" } as const;

// The subset of the Messages API wire format this plugin produces.
export type WireBlock =
  | { type: "text"; text: string; cache_control?: typeof EPHEMERAL }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string }; cache_control?: typeof EPHEMERAL }
  | { type: "tool_use"; id: string; name: string; input: unknown; cache_control?: typeof EPHEMERAL }
  | { type: "tool_result"; tool_use_id: string; content: WireBlock[]; is_error?: boolean; cache_control?: typeof EPHEMERAL }
  | Record<string, unknown>; // an echoed thinking block, opaque to us

export interface WireMessage { readonly role: "user" | "assistant"; readonly content: WireBlock[] }

export interface WireRequest {
  model: string;
  max_tokens: number;
  stream: true;
  messages: WireMessage[];
  system?: { type: "text"; text: string; cache_control: typeof EPHEMERAL }[];
  tools?: { name: string; description: string; input_schema: unknown; eager_input_streaming: true }[];
  thinking?: { type: "adaptive" } | { type: "enabled"; budget_tokens: number };
  output_config?: { effort: "low" | "medium" | "high" | "max" };
  temperature?: number;
}

/** Strips this provider's routing prefix; a bare id is accepted too. */
export function modelName(id: string): string {
  return id.startsWith(`${PROVIDER_ID}/`) ? id.slice(PROVIDER_ID.length + 1) : id;
}

function contentBlock(part: ContentPart): WireBlock | undefined {
  switch (part.type) {
    case "text": return part.text === "" ? undefined : { type: "text", text: part.text };
    case "image": return {
      type: "image",
      source: part.source.kind === "base64" ? { type: "base64", media_type: part.mediaType, data: part.source.data } : { type: "url", url: part.source.url },
    };
    default: return undefined;
  }
}

function userBlocks(parts: readonly ContentPart[]): WireBlock[] {
  const blocks: WireBlock[] = [];
  for (const part of parts) {
    if (part.type === "tool-result") {
      const content = part.content.map(contentBlock).filter((block): block is WireBlock => block !== undefined);
      blocks.push({ type: "tool_result", tool_use_id: part.toolCallId, content, ...(part.isError === true ? { is_error: true } : {}) });
    } else {
      const block = contentBlock(part);
      if (block !== undefined) blocks.push(block);
    }
  }
  return blocks;
}

function assistantBlocks(parts: readonly ContentPart[]): WireBlock[] {
  const blocks: WireBlock[] = [];
  for (const part of parts) {
    if (part.type === "thinking") {
      // The block is only valid with its signature; one we never received cannot be replayed.
      if (typeof part.state === "object" && part.state !== null) blocks.push(part.state as Record<string, unknown>);
    } else if (part.type === "tool-call") {
      blocks.push({ type: "tool_use", id: part.id, name: part.name, input: part.input });
    } else if (part.type === "text") {
      const block = contentBlock(part);
      if (block !== undefined) blocks.push(block);
    }
  }
  return blocks;
}

export function toWireMessages(messages: readonly Message[]): WireMessage[] {
  const wire: WireMessage[] = [];
  for (const message of messages) {
    const content = message.role === "user" ? userBlocks(message.parts) : assistantBlocks(message.parts);
    if (content.length > 0) wire.push({ role: message.role, content });
  }
  // Cache the conversation up to the latest user turn; the next turn extends this prefix.
  for (let index = wire.length - 1; index >= 0; index -= 1) {
    const message = wire[index];
    if (message?.role !== "user") continue;
    const lastBlock = message.content[message.content.length - 1];
    if (lastBlock !== undefined) (lastBlock as { cache_control?: typeof EPHEMERAL }).cache_control = EPHEMERAL;
    break;
  }
  return wire;
}

export function toWireRequest(request: LlmRequest): WireRequest {
  const model = modelName(request.model);
  const facts = factsFor(model);
  const maxTokens = request.maxTokens ?? Math.min(DEFAULT_MAX_TOKENS, facts?.maxOutput ?? DEFAULT_MAX_TOKENS);
  const body: WireRequest = { model, max_tokens: maxTokens, stream: true, messages: toWireMessages(request.messages) };
  if (request.system !== undefined && request.system !== "") {
    body.system = [{ type: "text", text: request.system, cache_control: EPHEMERAL }];
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema, eager_input_streaming: true }));
  }
  if (facts?.thinking === "budget") {
    if (request.effort !== undefined) body.thinking = { type: "enabled", budget_tokens: HAIKU_THINKING_BUDGET };
  } else {
    body.thinking = { type: "adaptive" };
    body.output_config = { effort: request.effort ?? "high" };
  }
  // Current models reject sampling parameters; an unknown id gets what the caller asked for.
  if (request.temperature !== undefined && facts?.sampling !== false) body.temperature = request.temperature;
  return body;
}
