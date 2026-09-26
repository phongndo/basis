import * as path from "node:path";
import { ToolResult } from "@basis/contracts";

export const text = (value: string, details?: unknown): ToolResult =>
  new ToolResult({ content: [{ type: "text", text: value }], ...(details === undefined ? {} : { details }) });

/** An error the model should read and act on (wrong path, ambiguous edit), as opposed to a tool defect. */
export const error = (message: string): ToolResult =>
  new ToolResult({ content: [{ type: "text", text: message }], isError: true });

export const resolvePath = (cwd: string, target: string): string => path.resolve(cwd, target);

export const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;

export const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
