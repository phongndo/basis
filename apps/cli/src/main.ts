#!/usr/bin/env -S node --conditions=source
import { createInterface } from "node:readline";
import { run } from "./cli.ts";

const argv = process.argv.slice(2);
// `lemma inspect … | head` closes the pipe early; that ends the output, it is not a failure.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  else throw error;
});

/** A question at the terminal, on stderr so stdout stays clean for output; secrets are not echoed. */
const ask = (question: string, secret: boolean) =>
  new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (secret) {
      const output = rl as unknown as { _writeToOutput: (text: string) => void; output: NodeJS.WritableStream };
      let prompted = false;
      output._writeToOutput = (text) => {
        if (!prompted) {
          output.output.write(text);
          prompted = true;
        }
      };
    }
    rl.question(question, (answer) => {
      if (secret) process.stderr.write("\n");
      rl.close();
      resolve(answer);
    });
  });

if (argv[0] === "serve") {
  // The host app runs until SIGINT/SIGTERM and reads its own flags (`--no-open`) from argv.
  await import("@lemma/host");
} else {
  process.exitCode = await run(argv, {
    env: process.env,
    // `pnpm lemma` runs from the workspace root; INIT_CWD is where the user invoked it.
    cwd: process.env.INIT_CWD ?? process.cwd(),
    out: (text) => {
      process.stdout.write(`${text}\n`);
    },
    write: (text) => {
      process.stdout.write(text);
    },
    err: (text) => {
      process.stderr.write(`${text}\n`);
    },
    ...(process.stdin.isTTY ? { ask } : {}),
  });
}
