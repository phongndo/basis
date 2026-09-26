import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Schema } from "effect";
import { ToolResult } from "@basis/contracts";
import type { Tool } from "@basis/contracts";
import { error, errorCode, resolvePath, text } from "./result.ts";

export const DEFAULT_READ_LIMIT = 2000;

const imageTypes: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

export const ReadInput = Schema.Struct({
  path: Schema.String.annotations({ description: "File to read; relative paths resolve against the working directory." }),
  offset: Schema.optional(Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)).annotations({ description: "First line to return, 1-based. Default 1." })),
  limit: Schema.optional(Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)).annotations({ description: `Maximum number of lines to return. Default ${DEFAULT_READ_LIMIT}.` })),
});

export const readTool: Tool<typeof ReadInput.Type> = {
  name: "read",
  description: [
    "Read a file. Text is returned with each line prefixed by its 1-based number and a pipe (\"12|...\");",
    `at most ${DEFAULT_READ_LIMIT} lines are returned per call (use offset and limit to page through longer files;`,
    "a trailing note says where to continue). PNG, JPEG, GIF, and WebP files are returned as images.",
    "Relative paths resolve against the working directory. Directories cannot be read; list them with bash.",
  ].join(" "),
  input: ReadInput,
  execute: async ({ path: target, offset, limit }, context) => {
    const absolute = resolvePath(context.cwd, target);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(absolute);
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") return error(`File not found: ${absolute}`);
      throw cause;
    }
    if (stat.isDirectory()) return error(`${absolute} is a directory, not a file. Use bash (for example \`ls\`) to list it.`);

    const mediaType = imageTypes[path.extname(absolute).toLowerCase()];
    if (mediaType !== undefined) {
      const data = await fs.readFile(absolute);
      return new ToolResult({ content: [{ type: "image", mediaType, source: { kind: "base64", data: data.toString("base64") } }] });
    }

    const content = await fs.readFile(absolute, "utf8");
    if (content.length === 0) return text("(empty file)");
    const lines = content.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const start = offset ?? 1;
    if (start > lines.length) return error(`offset ${start} is past the end of ${absolute}, which has ${lines.length} lines.`);
    const end = Math.min(lines.length, start - 1 + (limit ?? DEFAULT_READ_LIMIT));
    const numbered = lines.slice(start - 1, end).map((line, index) => `${start + index}|${line.replace(/\r$/, "")}`).join("\n");
    const note = end < lines.length ? `\n\n[showing lines ${start}-${end} of ${lines.length}; use offset=${end + 1} to continue]` : "";
    return text(numbered + note, { path: absolute, lines: lines.length, from: start, to: end });
  },
};
