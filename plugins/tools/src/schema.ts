import { JSONSchema } from "effect";
import type { Schema } from "effect";
import type { ToolDefinition } from "@basis/contracts";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Closes every object schema that leaves `additionalProperties` unspecified, so models cannot invent fields. */
function close(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(close);
  if (!isObject(node)) return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) out[key] = close(value);
  if (out["type"] === "object" && isObject(out["properties"]) && out["additionalProperties"] === undefined) {
    out["additionalProperties"] = false;
  }
  return out;
}

/** JSON Schema (draft-07 shape) for a tool input, as sent to model providers. */
export function toolInputSchema(schema: Schema.Schema<any, any, never>): typeof ToolDefinition.Type["inputSchema"] {
  const { $schema: _, ...rest } = JSONSchema.make(schema);
  return close(rest) as Json;
}
