import { describe, expect, test } from "vitest";
import { kernelOf, tablesOf } from "../src/kernel.ts";
import type { PluginStatus } from "../src/rpc.ts";

const plugin = (id: string, fields: Partial<PluginStatus> = {}): PluginStatus => ({
  id,
  source: "bundled",
  enabled: true,
  state: "active",
  provides: [],
  requires: [],
  ...fields,
});

describe("kernelOf", () => {
  const plugins = [
    plugin("agent", { provides: ["lemma/Agent"], requires: ["lemma/Llm"], hooks: [{ name: "turn.before", order: 10 }], observes: ["tool.executed"] }),
    plugin("guard", { hooks: [{ name: "turn.before", order: -5 }], contributes: [{ name: "lemma/tools.guards", items: 1 }] }),
    plugin("tools", { contributes: [{ name: "lemma/tools", items: 2, keys: ["read", "write"] }], observes: ["tool.executed"] }),
    plugin("llm-off", { enabled: false, state: "disabled", provides: ["lemma/Llm"] }),
    plugin("orphan", { requires: ["lemma/Nothing"] }),
  ];
  const kernel = kernelOf(plugins);

  test("each hook's chain runs in order, lowest first", () => {
    expect(kernel.hooks).toEqual([
      {
        name: "turn.before",
        handlers: [
          { plugin: "guard", order: -5 },
          { plugin: "agent", order: 10 },
        ],
      },
    ]);
  });

  test("each registry lists its contributors and counts their items", () => {
    expect(kernel.registries).toEqual([
      { name: "lemma/tools", items: 2, contributors: [{ plugin: "tools", items: 2, keys: ["read", "write"] }] },
      { name: "lemma/tools.guards", items: 1, contributors: [{ plugin: "guard", items: 1, keys: [] }] },
    ]);
  });

  test("each event lists its observers; each capability its providers, in what state, and its dependents", () => {
    expect(kernel.events).toEqual([{ name: "tool.executed", observers: ["agent", "tools"] }]);
    expect(kernel.capabilities).toEqual([
      { key: "lemma/Agent", providers: [{ plugin: "agent", state: "active", enabled: true }], users: [] },
      { key: "lemma/Llm", providers: [{ plugin: "llm-off", state: "disabled", enabled: false }], users: ["agent"] },
      { key: "lemma/Nothing", providers: [], users: ["orphan"] },
    ]);
  });
});

describe("tablesOf", () => {
  test("an array of objects is a table; an object of such arrays is a table per key", () => {
    expect(
      tablesOf([
        { a: 1, b: "x" },
        { a: 2, c: true },
      ]),
    ).toEqual([
      {
        columns: ["a", "b", "c"],
        rows: [
          ["1", "x", ""],
          ["2", "", "true"],
        ],
      },
    ]);
    expect(tablesOf({ tools: [{ name: "read" }], guards: [] })).toEqual([
      { title: "tools", columns: ["name"], rows: [["read"]] },
      { title: "guards", columns: [], rows: [] },
    ]);
  });

  test("anything else is not tables, and shows as JSON", () => {
    expect(tablesOf({ count: 3 })).toBeUndefined();
    expect(tablesOf([1, 2])).toBeUndefined();
    expect(tablesOf("text")).toBeUndefined();
  });
});
