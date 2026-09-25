# @basis/plugin-tools-builtin

Registers the four file-and-shell tools every coding agent needs (`read`, `write`, `edit`, `bash`) with whichever plugin provides `Tools`. Semantics follow pi: line-numbered reads, exact-match edits that refuse to guess, and a shell that reports exit codes instead of failing.

## Use

```ts
import tools from "@basis/plugin-tools";
import builtin from "@basis/plugin-tools-builtin";

const core = yield* makeCore([tools, builtin]);
```

The tools are also exported (`readTool`, `writeTool`, `editTool`, `bashTool(options)`) for compositions that want a subset or different defaults, and the input schemas (`ReadInput`, ...) for clients that render calls.

| Tool | Input | Behavior |
| --- | --- | --- |
| `read` | `path`, `offset?` (1-based line), `limit?` (default 2000) | Text with `<n>\|` line prefixes and a note on how to continue when cut. PNG/JPEG/GIF/WebP come back as a base64 image part. Missing files and directories are error results. |
| `write` | `path`, `content` | Creates parent directories, replaces the file, returns a one-line confirmation. |
| `edit` | `path`, `oldText`, `newText` | Replaces exactly one occurrence. Zero or several matches is an error result naming the count; the file is untouched. CRLF files stay CRLF even when the model writes LF. |
| `bash` | `command`, `timeoutMs?` | `bash -lc <command>` in the session's `cwd`, no stdin, stdout and stderr merged in arrival order. Non-zero exit adds `[exit code N]` to the text and is not `isError`; a timeout or abort is. |

Relative paths resolve against `ToolContext.cwd`. Results carry `details` (path and line range, exit code, truncation flags) for UIs; the model sees only the text.

## Config

```jsonc
{ "plugins": { "tools-builtin": { "config": { "bash": { "timeoutMs": 120000, "maxOutputChars": 30000 } } } } }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `bash.timeoutMs` | `120000` | Timeout for calls that give none. On expiry the whole process group is killed. |
| `bash.maxOutputChars` | `30000` | Captured output beyond this keeps the beginning and the end around an `[... output truncated: N characters omitted ...]` marker. This is a memory bound for runaway commands; the tools plugin applies its own overall cap afterwards. |

No config means the defaults.

## Rationale

- **Error results, not failures.** A missing file, an ambiguous edit, or an unwritable path is something the model should read and correct, so these are `ToolResult`s with `isError`. Only unexpected exceptions become `ToolError` (the tools plugin does that).
- **`edit` never guesses.** Fuzzy matching hides mistakes in the text the model believes is there. Matching is done on LF-normalized text so the model does not need to know a file's line-ending convention; the write restores the file's own.
- **Process groups.** The shell is started in its own session (`detached: true`), so a timeout or abort kills every process it started, not just bash. Background children that inherit the pipes would otherwise keep the tool waiting; after bash exits, reading stops within 200 ms.
- **Login shell.** `bash -lc` gives commands the user's PATH and environment. Login shells also run logout hooks that may write terminal-title escapes; OSC sequences are stripped from the captured output because they address a terminal, not a reader.
- **No gate.** Nothing here handles `ToolExecuteHook`. Full permissions by default; a gate is a user plugin.
