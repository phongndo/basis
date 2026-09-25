import { ToolResult } from "@basis/contracts";

type Part = ToolResult["content"][number];

/** The shape `Client.callTool` resolves to, covering the legacy `toolResult` form. */
export interface McpCallResult {
  readonly content?: unknown;
  readonly isError?: boolean | undefined;
  readonly structuredContent?: unknown;
  readonly toolResult?: unknown;
}

export const errorResult = (text: string): ToolResult => new ToolResult({ content: [{ type: "text", text }], isError: true });

/**
 * Text and images map directly; audio, embedded resources, and resource links
 * become short text descriptions so the model still learns what came back.
 * Structured content is shown when it is the only content.
 */
export function toToolResult(result: McpCallResult): ToolResult {
  const blocks = Array.isArray(result.content) ? result.content as ReadonlyArray<Record<string, unknown>> : [];
  const content: Part[] = blocks.map(toPart);
  if (content.length === 0) {
    const fallback = result.structuredContent ?? result.toolResult;
    if (fallback !== undefined) content.push({ type: "text", text: JSON.stringify(fallback, null, 2) });
  }
  return new ToolResult({
    content,
    ...(result.isError ? { isError: true } : {}),
    ...(result.structuredContent === undefined ? {} : { details: { structuredContent: result.structuredContent } }),
  });
}

function toPart(block: Record<string, unknown>): Part {
  switch (block["type"]) {
    case "text":
      return { type: "text", text: String(block["text"] ?? "") };
    case "image":
      return { type: "image", mediaType: String(block["mimeType"] ?? "application/octet-stream"), source: { kind: "base64", data: String(block["data"] ?? "") } };
    case "audio":
      return { type: "text", text: `[audio ${String(block["mimeType"])}, ${String(block["data"] ?? "").length} base64 characters omitted]` };
    case "resource": {
      const resource = (block["resource"] ?? {}) as Record<string, unknown>;
      return typeof resource["text"] === "string"
        ? { type: "text", text: `[resource ${String(resource["uri"])}]\n${resource["text"]}` }
        : { type: "text", text: `[binary resource ${String(resource["uri"])} (${String(resource["mimeType"] ?? "unknown type")})]` };
    }
    case "resource_link":
      return { type: "text", text: `[resource link ${String(block["uri"])}${block["name"] ? `: ${String(block["name"])}` : ""}${block["description"] ? ` — ${String(block["description"])}` : ""}]` };
    default:
      return { type: "text", text: JSON.stringify(block) };
  }
}
