import { Schema } from "effect";
import type { Tool } from "@basis/contracts";
import { text } from "./result.ts";

export interface BashOptions {
  /** Applied when the call gives no `timeoutMs`. */
  readonly timeoutMs: number;
  /** Captured output beyond this keeps the head and the tail around a marker. */
  readonly maxOutputChars: number;
}

export const DEFAULT_BASH_OPTIONS: BashOptions = { timeoutMs: 120_000, maxOutputChars: 30_000 };

/** How long to wait for output after the shell exits when a background child still holds the pipes. */
const PIPE_GRACE_MS = 200;

export const BashInput = Schema.Struct({
  command: Schema.String.annotations({ description: "Command line to run with `bash -lc`." }),
  timeoutMs: Schema.optional(Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)).annotations({ description: "Kill the command after this many milliseconds. Default 120000." })),
});

/**
 * Keeps the first and last part of a stream of text within a budget, counting
 * what was dropped, so a runaway command costs bounded memory and the model
 * still sees how it started and how it ended.
 */
export class OutputBuffer {
  private head = "";
  private tail: string[] = [];
  private tailLength = 0;
  total = 0;
  private readonly headMax: number;
  private readonly tailMax: number;

  constructor(readonly maxChars: number) {
    this.headMax = Math.ceil(maxChars * 0.6);
    this.tailMax = maxChars - this.headMax;
  }

  push(chunk: string): void {
    this.total += chunk.length;
    if (this.head.length < this.headMax) {
      const take = Math.min(this.headMax - this.head.length, chunk.length);
      this.head += chunk.slice(0, take);
      chunk = chunk.slice(take);
    }
    if (chunk.length === 0) return;
    this.tail.push(chunk);
    this.tailLength += chunk.length;
    while (this.tail.length > 1 && this.tailLength - this.tail[0]!.length >= this.tailMax) {
      this.tailLength -= this.tail.shift()!.length;
    }
  }

  get truncated(): boolean { return this.total > this.maxChars; }

  render(): string {
    const tail = this.tail.join("");
    if (!this.truncated) return this.head + tail;
    const kept = tail.slice(-this.tailMax);
    const omitted = this.total - this.head.length - kept.length;
    return `${this.head}\n\n[... output truncated: ${omitted} characters omitted ...]\n\n${kept}`;
  }
}

/** Reads a stream to the buffer in arrival order; returns a way to stop early when a child keeps the pipe open. */
function drain(stream: ReadableStream<Uint8Array>, buffer: OutputBuffer): { readonly done: Promise<void>; readonly stop: () => void } {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer.push(decoder.decode(value, { stream: true }));
      }
      buffer.push(decoder.decode());
    } catch {
      // Cancelled by `stop`, or the pipe went away with the process group.
    }
  })();
  return { done, stop: () => { void reader.cancel().catch(() => undefined); } };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Login shells run logout hooks that may reset the terminal title (NixOS's
 * `/etc/bash_logout` prints `\e]0;\a`). Operating-system-command sequences
 * address a terminal, never a reader, so they are dropped from what the model sees.
 */
const stripOsc = (value: string): string => value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

export const bashTool = (options: BashOptions = DEFAULT_BASH_OPTIONS): Tool<typeof BashInput.Type> => ({
  name: "bash",
  description: [
    "Run a shell command with `bash -lc` in the working directory and return its output (stdout and stderr",
    "interleaved) followed by the exit code when it is not zero. No TTY and no stdin: the command must not",
    `wait for input. It is killed, with everything it started, after timeoutMs (default ${options.timeoutMs} ms).`,
    "Long output keeps the beginning and the end around a truncation marker. Use it for listing and searching",
    "files, git, builds, tests, and other shell work; use read, write, and edit for file contents.",
  ].join(" "),
  input: BashInput,
  execute: async ({ command, timeoutMs }, context) => {
    const limit = timeoutMs ?? options.timeoutMs;
    const output = new OutputBuffer(options.maxOutputChars);
    // A new session makes the shell a group leader, so killing -pid reaches everything it spawned.
    const child = Bun.spawn(["bash", "-lc", command], { cwd: context.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
    const killGroup = () => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    let timedOut = false;
    let aborted = false;
    const onAbort = () => { aborted = true; killGroup(); };
    if (context.signal.aborted) onAbort(); else context.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, limit);

    const stdout = drain(child.stdout, output);
    const stderr = drain(child.stderr, output);
    const streams = Promise.all([stdout.done, stderr.done]);
    let exitCode: number;
    try {
      exitCode = await child.exited;
      // A background child that inherited the pipes would hold them open; give it a moment, then stop reading.
      await Promise.race([streams, sleep(PIPE_GRACE_MS).then(() => { stdout.stop(); stderr.stop(); return streams; })]);
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
    }

    const parts = [stripOsc(output.render()).trimEnd() || "(no output)"];
    if (timedOut) parts.push(`[command timed out after ${limit} ms and was killed]`);
    else if (aborted) parts.push("[command aborted]");
    else if (exitCode !== 0) parts.push(`[exit code ${exitCode}]`);
    const result = text(parts.join("\n\n"), { exitCode, signal: child.signalCode, timedOut, aborted, truncated: output.truncated });
    return timedOut || aborted ? { ...result, isError: true } : result;
  },
});
