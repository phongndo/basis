import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { discoverHost } from "../src/bun.ts";

const withHome = async (content: string | undefined, run: (home: string) => Promise<void>) => {
  const home = mkdtempSync(join(tmpdir(), "basis-client-"));
  try {
    if (content !== undefined) writeFileSync(join(home, "host.json"), content);
    await run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

const reasonOf = (exit: Exit.Exit<unknown, { reason: string }>) =>
  Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error.reason : `unexpected: ${String(exit)}`;

describe("discoverHost", () => {
  test("returns a live host entry", () => withHome(JSON.stringify({ url: "http://127.0.0.1:4096", token: "t", pid: process.pid }), async (home) => {
    expect(await Effect.runPromise(discoverHost({ home }))).toEqual({ url: "http://127.0.0.1:4096", token: "t", pid: process.pid });
  }));

  test("reports a missing, invalid, or stale file", async () => {
    await withHome(undefined, async (home) => {
      expect(reasonOf(await Effect.runPromiseExit(discoverHost({ home })))).toBe("NotFound");
    });
    await withHome("{ nope", async (home) => {
      expect(reasonOf(await Effect.runPromiseExit(discoverHost({ home })))).toBe("Invalid");
    });
    await withHome(JSON.stringify({ url: "http://127.0.0.1:1", token: "t", pid: 2 ** 22 - 1 }), async (home) => {
      expect(reasonOf(await Effect.runPromiseExit(discoverHost({ home })))).toBe("Stale");
    });
  });
});
