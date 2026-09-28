import { JSONSchema } from "effect";
import type { Schema } from "effect";
import type { JsonSchema } from "@basis/contracts";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Keywords that mean nothing to a model provider, or that some providers reject. */
const dropped = new Set(["$schema", "$id", "$defs", "definitions", "$comment", "title"]);
/** Keywords whose value is a map of name → schema. */
const schemaMaps = new Set(["properties", "patternProperties"]);
/** Keywords whose value is a schema or an array of schemas. */
const schemaValues = new Set(["items", "additionalProperties", "not", "anyOf", "allOf", "oneOf", "prefixItems", "contains", "propertyNames"]);

/**
 * Provider-friendly JSON Schema for a tool input: `$schema`, ids, and Effect's
 * generated titles removed, and every `$ref` inlined (sibling keywords such as
 * a field's description override the definition's). A recursive reference
 * cannot be inlined and becomes an unconstrained schema. The root is always an
 * object schema with `properties`, which every major provider requires.
 */
export function toolParameters(schema: Schema.Schema<any, any, never>): JsonSchema {
  const root = JSONSchema.make(schema) as unknown as Json;
  const defs: Json = { ...(isObject(root["definitions"]) ? root["definitions"] : {}), ...(isObject(root["$defs"]) ? root["$defs"] : {}) };

  const clean = (node: unknown, seen: ReadonlySet<string>): unknown => {
    if (Array.isArray(node)) return node.map((item) => clean(item, seen));
    if (!isObject(node)) return node;
    const ref = node["$ref"];
    if (typeof ref === "string") {
      const { $ref: _, ...siblings } = node;
      const name = decodeURIComponent(ref.replace(/^#\/(\$defs|definitions)\//, ""));
      const target = defs[name];
      if (!isObject(target) || seen.has(name)) return clean(siblings, seen);
      return clean({ ...target, ...siblings }, new Set([...seen, name]));
    }
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (dropped.has(key)) continue;
      if (schemaMaps.has(key) && isObject(value)) {
        out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, clean(child, seen)]));
      } else if (schemaValues.has(key)) {
        out[key] = clean(value, seen);
      } else {
        out[key] = value;
      }
    }
    return out;
  };

  const cleaned = clean(root, new Set()) as Json;
  const composite = "anyOf" in cleaned || "oneOf" in cleaned || "allOf" in cleaned;
  if (cleaned["type"] === undefined && !composite) cleaned["type"] = "object";
  if (cleaned["type"] === "object" && cleaned["properties"] === undefined) cleaned["properties"] = {};
  return cleaned;
}
