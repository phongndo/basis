import { Effect, Stream } from "effect";
import { LlmRequest, Message } from "@basis/contracts";
import type { ContentPart, LlmError, SessionEntry } from "@basis/contracts";

/** Prefix of the user message that carries a compaction summary back into the model's view. */
export const SUMMARY_MARKER = "Summary of earlier conversation (compacted):";

const SUMMARY_SYSTEM =
  "You write compact, faithful summaries of conversations between a user and a coding agent, " +
  "so the agent can continue the work with the summary in place of the full transcript.";

const SUMMARY_INSTRUCTION = [
  "Summarize the conversation so far. Preserve, in this order:",
  "1. The user's goals, constraints, and preferences, in their words where it matters.",
  "2. Decisions made and why; alternatives that were rejected.",
  "3. File paths, commands, identifiers, and other exact strings that were read, written, or discussed.",
  "4. What has been completed and verified, versus attempted.",
  "5. Open tasks and the immediate next step.",
  "Be concise. Do not invent details, do not add advice, and do not address the user. Output plain text only.",
].join("\n");

/** Roughly four characters per token; images are charged a flat thousand tokens. */
export function estimateTokens(request: LlmRequest): number {
  let chars = request.system?.length ?? 0;
  for (const message of request.messages) for (const part of message.parts) chars += partChars(part);
  if (request.tools !== undefined) chars += JSON.stringify(request.tools).length;
  return Math.ceil(chars / 4);
}

function partChars(part: ContentPart): number {
  switch (part.type) {
    case "text":
    case "thinking":
      return part.text.length;
    case "image":
      return 4000;
    case "tool-call":
      return part.name.length + JSON.stringify(part.input).length;
    case "tool-result":
      return part.content.reduce((sum, item) => sum + (item.type === "text" ? item.text.length : 4000), 0);
  }
}

/** Ask the same model for a summary of the request's messages; the text deltas are the answer. */
export function summarize(
  stream: (request: LlmRequest) => Stream.Stream<import("@basis/contracts").StreamEvent, LlmError>,
  request: LlmRequest,
): Effect.Effect<string, LlmError> {
  const ask = new LlmRequest({
    model: request.model,
    system: SUMMARY_SYSTEM,
    messages: [...request.messages, new Message({ role: "user", parts: [{ type: "text", text: SUMMARY_INSTRUCTION }] })],
    ...(request.effort === undefined ? {} : { effort: request.effort }),
  });
  return Stream.runFold(stream(ask), { text: "", final: "" }, (acc, event) => {
    if (event.type === "text-delta") return { ...acc, text: acc.text + event.text };
    if (event.type === "finish") return { ...acc, final: event.message.parts.map((part) => part.type === "text" ? part.text : "").join("") };
    return acc;
  }).pipe(Effect.map(({ text, final }) => (text === "" ? final : text).trim()));
}

/** The model's view of a session path: compactions become a marked user message; non-message entries vanish. */
export function rebuildMessages(context: readonly SessionEntry[]): Message[] {
  const messages: Message[] = [];
  for (const entry of context) {
    const payload = entry.payload;
    if (payload.type === "message") messages.push(payload.message);
    else if (payload.type === "compaction") {
      messages.push(new Message({ role: "user", parts: [{ type: "text", text: `${SUMMARY_MARKER}\n\n${payload.summary}` }] }));
    }
  }
  return messages;
}
