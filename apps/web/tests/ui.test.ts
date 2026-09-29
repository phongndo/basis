import { describe, expect, it } from "vitest";
import { Context, Effect, Exit, Schema, Scope } from "effect";
import { createSignal } from "solid-js";
import { makeLoader } from "@lemma/core";
import type { Loader, Plugin } from "@lemma/core";
import { Slots } from "../src/ui/contracts.ts";
import { defineUiPlugin } from "../src/ui/define.ts";
import { createSlots, defineSlot } from "../src/ui/slots.ts";

const Items = defineSlot<{ readonly label: string }>("test.items");

describe("slots", () => {
  it("orders items by order, then by when they were added, and removes them", () => {
    const slots = createSlots();
    const removeB = slots.add(Items, { id: "b", label: "B" });
    slots.add(Items, { id: "a", label: "A", order: -1 });
    slots.add(Items, { id: "c", label: "C" });
    expect(slots.list(Items).map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(slots.first(Items)?.id).toBe("a");
    expect(slots.get(Items, "c")?.label).toBe("C");
    removeB();
    expect(slots.list(Items).map((item) => item.id)).toEqual(["a", "c"]);
    expect(slots.list(defineSlot<unknown>("test.empty"))).toEqual([]);
  });

  it("records who added what, through each plugin's own view", () => {
    const slots = createSlots();
    const remove = slots.as("sidebar").add(Items, { id: "a", label: "A" });
    slots.as("palette").add(Items, { id: "b", label: "B" });
    slots.add(Items, { id: "c", label: "C" });
    // One registry: every view lists every item.
    expect(
      slots
        .as("sidebar")
        .list(Items)
        .map((item) => item.id),
    ).toEqual(["a", "b", "c"]);
    expect(slots.contributions("sidebar")).toEqual([{ slot: "test.items", id: "a" }]);
    remove();
    expect(slots.contributions("sidebar")).toEqual([]);
  });
});

class Counter extends Context.Tag("test/Counter")<Counter, { readonly count: () => number; readonly add: () => void }>() {}

const counter = defineUiPlugin({
  id: "counter",
  provides: { counter: Counter },
  setup: () => {
    const [count, setCount] = createSignal(0);
    return { counter: { count, add: () => setCount(count() + 1) } };
  },
});

const slotsPlugin = defineUiPlugin({ id: "slots", provides: { slots: Slots }, setup: () => ({ slots: createSlots() }) });

/** Runs `plugins` on the kernel the way the boot does, starting with those in `running`, and closes it. */
const run = async (plugins: readonly Plugin[], body: (loader: Loader) => Promise<void>, running = plugins.map((plugin) => plugin.id)) => {
  const scope = Effect.runSync(Scope.make());
  try {
    const loader = await Effect.runPromise(
      Scope.extend(
        makeLoader({
          source: { resolve: (id) => Effect.succeed(plugins.find((plugin) => plugin.id === id)!) },
          composition: { plugins: Object.fromEntries(running.map((id) => [id, {}])) },
        }),
        scope,
      ),
    );
    await body(loader);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
};

describe("defineUiPlugin", () => {
  it("provides services by name and hands required ones to setup", async () => {
    const seen: number[] = [];
    const reader = defineUiPlugin({
      id: "reader",
      requires: { counter: Counter, slots: Slots },
      setup: ({ counter, slots }, plugin) => {
        counter.add();
        seen.push(counter.count());
        plugin.onCleanup(slots.add(Items, { id: "reader", label: String(counter.count()) }));
      },
    });
    await run([counter, slotsPlugin, reader], async (loader) => {
      expect(seen).toEqual([1]);
      const slots = await Effect.runPromise(loader.core.run(Slots));
      expect(slots.list(Items).map((item) => item.label)).toEqual(["1"]);
      // What it added is attributed to it, for the plugins inspector.
      expect(slots.contributions("reader")).toEqual([{ slot: "test.items", id: "reader" }]);
      // Turning it off runs its cleanups: its item leaves the slot.
      await Effect.runPromise(loader.apply({ plugins: { counter: {}, slots: {}, reader: { enabled: false } } }));
      expect(slots.list(Items)).toEqual([]);
    });
  });

  it("decodes its config and passes it to setup", async () => {
    const seen: unknown[] = [];
    const configured = defineUiPlugin({
      id: "configured",
      config: Schema.Struct({ size: Schema.optionalWith(Schema.Number, { default: () => 3 }) }),
      setup: (_, plugin) => void seen.push(plugin.config),
    });
    await run([configured], async (loader) => {
      await Effect.runPromise(loader.apply({ plugins: { configured: { config: { size: 5 } } } }));
    });
    expect(seen).toEqual([{ size: 3 }, { size: 5 }]);
  });

  it("a setup that throws fails only its own plugin, releasing what it added", async () => {
    const broken = defineUiPlugin({
      id: "broken",
      requires: { slots: Slots },
      setup: ({ slots }, plugin) => {
        plugin.onCleanup(slots.add(Items, { id: "broken", label: "half-made" }));
        throw new Error("boom");
      },
    });
    await run(
      [slotsPlugin, broken],
      async (loader) => {
        const slots = await Effect.runPromise(loader.core.run(Slots));
        const applied = await Effect.runPromiseExit(loader.apply({ plugins: { slots: {}, broken: {} } }));
        expect(applied._tag).toBe("Failure");
        expect(slots.list(Items)).toEqual([]);
        // The rest keeps running.
        expect(await Effect.runPromise(loader.core.run(Slots))).toBe(slots);
      },
      ["slots"],
    );
  });
});
