import * as fs from "node:fs/promises";
import { Schema } from "effect";
import type { Tool } from "@basis/contracts";
import { error, errorCode, resolvePath, text } from "./result.ts";

export const EditInput = Schema.Struct({
  path: Schema.String.annotations({ description: "File to edit; relative paths resolve against the working directory." }),
  oldText: Schema.String.annotations({ description: "Exact text to replace. Must occur exactly once in the file, including whitespace and indentation." }),
  newText: Schema.String.annotations({ description: "Replacement text." }),
});

const occurrences = (haystack: string, needle: string): number => {
  let count = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) count++;
  return count;
};

export const editTool: Tool<typeof EditInput.Type> = {
  name: "edit",
  description: [
    "Replace exactly one occurrence of oldText with newText in an existing file. oldText must match the file",
    "exactly (whitespace and indentation included) and appear only once; include enough surrounding lines to",
    "make it unique. If it is missing or ambiguous the file is left unchanged and the error says which.",
    "The file's line endings (LF or CRLF) are preserved, so write oldText and newText with plain newlines.",
  ].join(" "),
  input: EditInput,
  execute: async ({ path: target, oldText, newText }, context) => {
    const absolute = resolvePath(context.cwd, target);
    if (oldText.length === 0) return error("oldText must not be empty. To create a file or replace it entirely, use write.");
    let content: string;
    try {
      content = await fs.readFile(absolute, "utf8");
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") return error(`File not found: ${absolute}`);
      if (errorCode(cause) === "EISDIR") return error(`${absolute} is a directory, not a file.`);
      throw cause;
    }
    // Match on LF so the model need not know the file's convention; write back in the file's own.
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const normalized = eol === "\n" ? content : content.replaceAll("\r\n", "\n");
    const before = oldText.replaceAll("\r\n", "\n");
    const after = newText.replaceAll("\r\n", "\n");
    const count = occurrences(normalized, before);
    if (count === 0) return error(`oldText was not found in ${absolute}. Read the file and copy the text exactly, including whitespace.`);
    if (count > 1) return error(`oldText appears ${count} times in ${absolute}; include more surrounding context so it matches exactly once.`);
    const index = normalized.indexOf(before);
    const updated = normalized.slice(0, index) + after + normalized.slice(index + before.length);
    await fs.writeFile(absolute, eol === "\n" ? updated : updated.replaceAll("\n", eol), "utf8");
    const line = normalized.slice(0, index).split("\n").length;
    return text(`Edited ${absolute}: replaced 1 occurrence at line ${line}`, { path: absolute, line, before, after });
  },
};
