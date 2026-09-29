import { describe, expect, test } from "vitest";
import { Context, Layer } from "effect";
import { definePlugin } from "@lemma/core";
import type { Composition, PluginSnapshot } from "@lemma/core";
import { catalog, resolveComposition, withReplacements } from "../src/index.ts";
import type { KnownPlugin } from "../src/index.ts";

class Llm extends Context.Tag("test/Llm")<Llm, string>() {}
class Tools extends Context.Tag("test/Tools")<Tools, string>() {}
class Agent extends Context.Tag("test/Agent")<Agent, string>() {}

/** transport needs agent, which needs llm and tools; bash (a project plugin shadowing the bundled one) plugs into tools; my-llm is a second Llm provider. */
const known: KnownPlugin[] = [
  { plugin: definePlugin({ id: "llm", version: "1", provides: [Llm], layer: Layer.succeed(Llm, "llm") }), source: "bundled" },
  { plugin: definePlugin({ id: "tools", version: "1", provides: [Tools], layer: Layer.succeed(Tools, "tools") }), source: "bundled" },
  { plugin: definePlugin({ id: "bash", requires: [Tools], layer: Layer.empty }), source: "project", shadows: true },
  { plugin: definePlugin({ id: "agent", version: "1", provides: [Agent], requires: [Llm, Tools], layer: Layer.succeed(Agent, "agent") }), source: "bundled" },
  { plugin: definePlugin({ id: "transport", requires: [Agent], layer: Layer.empty }), source: "bundled" },
  { plugin: definePlugin({ id: "my-llm", provides: [Llm], layer: Layer.succeed(Llm, "my-llm") }), source: "user" },
];

const everyone = (overrides: Composition["plugins"] = {}): Composition => ({
  plugins: Object.fromEntries(known.map(({ plugin }) => [plugin.id, overrides[plugin.id] ?? {}])),
});

describe("resolveComposition", () => {
  test("keeps everything when every requirement is met", () => {
    const composition = everyone({ "my-llm": { enabled: false } });
    const resolved = resolveComposition(known, composition);
    expect(resolved.haltedBy.size).toBe(0);
    expect(resolved.composition).toEqual(composition);
  });

  test("turning a provider off takes its dependents out, transitively, naming the direct one", () => {
    const resolved = resolveComposition(known, everyone({ "my-llm": { enabled: false }, tools: { enabled: false } }));
    expect([...resolved.haltedBy]).toEqual([
      ["bash", "tools"],
      ["agent", "tools"],
      ["transport", "agent"],
    ]);
    expect(Object.keys(resolved.composition.plugins)).toEqual(["llm", "tools", "my-llm"]);
    expect(resolved.composition.plugins.tools).toEqual({ enabled: false });
  });

  test("an enabled provider counts even when a disabled one offers the same capability", () => {
    const resolved = resolveComposition(known, everyone({ llm: { enabled: false } }));
    expect(resolved.haltedBy.size).toBe(0);
  });

  test("a capability nobody provides is left to the planner", () => {
    const orphan: KnownPlugin[] = [{ plugin: definePlugin({ id: "lonely", requires: [Agent], layer: Layer.empty }), source: "bundled" }];
    const resolved = resolveComposition(orphan, { plugins: { lonely: {} } });
    expect(resolved.haltedBy.size).toBe(0);
    expect(Object.keys(resolved.composition.plugins)).toEqual(["lonely"]);
  });
});

describe("catalog", () => {
  const snapshot = (id: string, state: PluginSnapshot["state"], extra: Partial<PluginSnapshot> = {}): PluginSnapshot => ({
    id,
    state,
    provides: [],
    requires: [],
    ...extra,
  });

  test("joins definitions, config rows, and core snapshots, locking what a pinned plugin needs", () => {
    const composition = everyone({ "my-llm": { enabled: false }, bash: { enabled: false } });
    const resolved = resolveComposition(known, composition);
    const entries = catalog({
      known,
      composition,
      resolved,
      snapshots: [snapshot("llm", "active"), snapshot("tools", "active"), snapshot("agent", "failed"), snapshot("transport", "closed", { haltedBy: "agent" })],
      enabledIn: { bash: "project" },
      pinned: { transport: "Serves the clients" },
    });
    expect(entries.map((entry) => [entry.id, entry.enabled, entry.state ?? "-", entry.locked ?? "-", entry.haltedBy ?? "-"])).toEqual([
      ["llm", true, "active", "Needed by transport", "-"],
      ["tools", true, "active", "Needed by transport", "-"],
      ["bash", false, "-", "-", "-"],
      ["agent", true, "failed", "Needed by transport", "-"],
      ["transport", true, "closed", "Serves the clients", "agent"],
      ["my-llm", false, "-", "-", "-"],
    ]);
    expect(entries.find((entry) => entry.id === "bash")).toMatchObject({ source: "project", shadows: true, scope: "project", requires: ["test/Tools"] });
    expect(entries.find((entry) => entry.id === "agent")).toMatchObject({ version: "1", provides: ["test/Agent"], requires: ["test/Llm", "test/Tools"] });
    expect(entries.find((entry) => entry.id === "transport")?.version).toBeUndefined();
  });

  test("a plugin left out by a disabled provider is enabled, unloaded, and halted by that provider", () => {
    const composition = everyone({ "my-llm": { enabled: false }, tools: { enabled: false } });
    const resolved = resolveComposition(known, composition);
    const entries = catalog({ known, composition, resolved, snapshots: [snapshot("llm", "active")], enabledIn: {}, pinned: {} });
    expect(entries.find((entry) => entry.id === "agent")).toMatchObject({ enabled: true, haltedBy: "tools" });
    expect(entries.find((entry) => entry.id === "agent")?.state).toBeUndefined();
    expect(entries.find((entry) => entry.id === "transport")).toMatchObject({ enabled: true, haltedBy: "agent" });
    // Nothing is pinned, so nothing is locked.
    expect(entries.every((entry) => entry.locked === undefined)).toBe(true);
  });
});

describe("withReplacements", () => {
  test("turning on a provider turns off the enabled provider of the same capability, leaving given rows alone", () => {
    const composition = everyone({ "my-llm": { enabled: false } });
    expect(withReplacements(known, composition, { "my-llm": { enabled: true } })).toEqual({ "my-llm": { enabled: true }, llm: { enabled: false } });
    // Already off, or explicitly listed: untouched.
    expect(withReplacements(known, everyone({ llm: { enabled: false } }), { "my-llm": { enabled: true } })).toEqual({ "my-llm": { enabled: true } });
    expect(withReplacements(known, composition, { "my-llm": { enabled: true }, llm: { enabled: true } })).toEqual({
      "my-llm": { enabled: true },
      llm: { enabled: true },
    });
    // Turning off, or a plugin providing nothing, replaces nothing.
    expect(withReplacements(known, composition, { llm: { enabled: false }, bash: { enabled: true } })).toEqual({
      llm: { enabled: false },
      bash: { enabled: true },
    });
  });
});
