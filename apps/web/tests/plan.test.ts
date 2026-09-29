import { describe, expect, it } from "vitest";
import { Context } from "effect";
import type { Plugin } from "@lemma/core";
import { defineUiPlugin } from "../src/ui/define.ts";
import { planUi } from "../src/ui/plan.ts";

class Model extends Context.Tag("test/Model")<Model, { readonly value: number }>() {}
class Composer extends Context.Tag("test/Composer")<Composer, { readonly name: string }>() {}

const model = defineUiPlugin({ id: "model", provides: { model: Model }, setup: () => ({ model: { value: 1 } }) });
const composer = defineUiPlugin({
  id: "composer",
  requires: { model: Model },
  provides: { composer: Composer },
  setup: () => ({ composer: { name: "bundled" } }),
});
const shell = defineUiPlugin({ id: "shell", requires: { composer: Composer }, setup: () => {} });
const bundled: readonly Plugin[] = [model, composer, shell];

const mine = defineUiPlugin({ id: "my-composer", requires: { model: Model }, provides: { composer: Composer }, setup: () => ({ composer: { name: "mine" } }) });

const enabled = (plan: ReturnType<typeof planUi>) =>
  Object.keys(plan.resolved.composition.plugins).filter((id) => plan.resolved.composition.plugins[id]?.enabled !== false);

describe("planUi", () => {
  it("runs every bundled plugin by default", () => {
    const plan = planUi(bundled, [], {});
    expect(enabled(plan)).toEqual(["model", "composer", "shell"]);
    expect(plan.known.map((entry) => entry.source)).toEqual(["bundled", "bundled", "bundled"]);
  });

  it("a local plugin providing what a bundled one provides replaces it unless a row decides", () => {
    const plan = planUi(bundled, [{ plugin: mine, source: "user" }], {});
    expect(enabled(plan)).toEqual(["model", "shell", "my-composer"]);
    expect(plan.composition.plugins.composer).toEqual({ enabled: false });
    // A row keeping the bundled one on wins, leaving both on for the planner to refuse.
    expect(planUi(bundled, [{ plugin: mine, source: "user" }], { composer: { enabled: true } }).composition.plugins.composer).toEqual({ enabled: true });
    // A local plugin that is off replaces nothing.
    expect(enabled(planUi(bundled, [{ plugin: mine, source: "user" }], { "my-composer": { enabled: false } }))).toEqual(["model", "composer", "shell"]);
  });

  it("a local plugin with a bundled id runs in its place", () => {
    const replacement = defineUiPlugin({ id: "shell", setup: () => {} });
    const plan = planUi(bundled, [{ plugin: replacement, source: "project" }], {});
    expect(plan.known.map((entry) => [entry.plugin.id, entry.source, entry.shadows ?? false])).toEqual([
      ["model", "bundled", false],
      ["composer", "bundled", false],
      ["shell", "project", true],
    ]);
    expect(plan.known[2]!.plugin).toBe(replacement);
  });

  it("rows turn plugins off, halting what needs them, and carry config", () => {
    const plan = planUi(bundled, [], { composer: { enabled: false }, model: { config: { value: 2 } } });
    expect(enabled(plan)).toEqual(["model"]);
    expect(plan.resolved.haltedBy.get("shell")).toBe("composer");
    expect(plan.composition.plugins.model).toEqual({ config: { value: 2 } });
  });

  it("reports rows naming no plugin, and keeps pinned plugins on", () => {
    const plan = planUi(bundled, [], { typo: { enabled: false }, model: { enabled: false } }, new Set(["model"]));
    expect(plan.unknown).toEqual(["typo"]);
    expect(enabled(plan)).toEqual(["model", "composer", "shell"]);
  });
});
