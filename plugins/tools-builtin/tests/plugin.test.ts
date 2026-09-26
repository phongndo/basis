import { describe, expect, test } from "bun:test";
import { Effect, Exit, JSONSchema, Scope } from "effect";
import { makeCore } from "@basis/core";
import type { Tool } from "@basis/contracts";
import builtin from "../src/index.ts";
import { fakeTools } from "./support.ts";

describe("plugin", () => {
  test("registers the four tools through Tools and releases them when it closes", async () => {
    const registered = new Map<string, Tool<any>>();
    const scope = await Effect.runPromise(Scope.make());
    await Effect.runPromise(makeCore([fakeTools(registered), builtin]).pipe(Scope.extend(scope)));
    expect([...registered.keys()].sort()).toEqual(["bash", "edit", "read", "write"]);
    for (const tool of registered.values()) {
      expect(tool.description.length).toBeGreaterThan(80);
      expect(JSONSchema.make(tool.input)).toMatchObject({ type: "object" });
    }
    expect(registered.get("bash")?.description).toContain("120000 ms");
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(registered.size).toBe(0);
  });

  test("bash config sets the default timeout", async () => {
    const registered = new Map<string, Tool<any>>();
    const description = await Effect.runPromise(Effect.scoped(Effect.map(
      makeCore([fakeTools(registered), builtin], { configs: { "tools-builtin": { bash: { timeoutMs: 5 } } } }),
      () => registered.get("bash")?.description,
    )));
    expect(description).toContain("(default 5 ms)");
  });
});
