import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Schema } from "effect";
import type { Tool } from "@basis/contracts";
import { error, message, resolvePath, text } from "./result.ts";

export const WriteInput = Schema.Struct({
  path: Schema.String.annotations({ description: "File to write; relative paths resolve against the working directory." }),
  content: Schema.String.annotations({ description: "Complete new content of the file." }),
});

export const writeTool: Tool<typeof WriteInput.Type> = {
  name: "write",
  description: [
    "Write a file, creating parent directories as needed and replacing any existing content entirely.",
    "Relative paths resolve against the working directory. For a small change to an existing file, prefer edit.",
  ].join(" "),
  input: WriteInput,
  execute: async ({ path: target, content }, context) => {
    const absolute = resolvePath(context.cwd, target);
    try {
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content, "utf8");
    } catch (cause) {
      return error(`Cannot write ${absolute}: ${message(cause)}`);
    }
    return text(`Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${absolute}`, { path: absolute });
  },
};
