#!/usr/bin/env -S node --conditions=source
import { run } from "./cli.ts";

const argv = process.argv.slice(2);
if (argv[0] === "serve") {
  // The host app runs until SIGINT/SIGTERM and reads its own flags (`--no-open`) from argv.
  await import("@basis/host");
} else {
  process.exitCode = await run(argv, {
    env: process.env,
    // `pnpm basis` runs from the workspace root; INIT_CWD is where the user invoked it.
    cwd: process.env.INIT_CWD ?? process.cwd(),
    out: (text) => { process.stdout.write(`${text}\n`); },
    err: (text) => { process.stderr.write(`${text}\n`); },
  });
}
