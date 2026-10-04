import { createEffect, createRoot } from "solid-js";
import { describe, expect, test } from "vitest";
import { createMemoryHistory, createRouter, defineRoute } from "@lemma/router";
import { createRouteSignals } from "../src/signals.ts";

const Home = defineRoute("home", { path: "/" });
const Item = defineRoute("item", { path: "/items/:id" });
const Other = defineRoute("other", { path: "/other" });

const setup = (initial = "/") => {
  const router = createRouter<{ readonly route: typeof Home | typeof Item | typeof Other }>({ history: createMemoryHistory(initial) });
  router.setEntries([{ route: Home }, { route: Item }, { route: Other }]);
  return { router, signals: createRouteSignals(router) };
};

/** Runs `read` in an effect; returns how many times it has run, and stops. */
const watch = (read: () => unknown) => {
  let runs = 0;
  let stop!: () => void;
  createRoot((dispose) => {
    stop = dispose;
    createEffect(() => {
      read();
      runs++;
    });
  });
  return { runs: () => runs, stop: () => stop() };
};

describe("createRouteSignals", () => {
  test("a route's reader runs again when that route's match changes, not on other navigations", () => {
    const { router, signals } = setup("/items/1");
    const item = watch(() => signals.matchOf(Item));
    expect(item.runs()).toBe(1);
    expect(signals.matchOf(Item)?.params.id).toBe("1");
    router.navigate("/items/2");
    expect(item.runs()).toBe(2);
    router.navigate("/other");
    expect(item.runs()).toBe(3);
    expect(signals.matchOf(Item)).toBeUndefined();
    router.navigate("/");
    router.navigate("/other");
    expect(item.runs()).toBe(3);
    item.stop();
  });

  test("the match and the location follow every change; disposing stops following", () => {
    const { router, signals } = setup();
    const match = watch(() => signals.match());
    const location = watch(() => signals.location());
    router.navigate("/other");
    expect(signals.match()).toMatchObject({ status: "matched", route: Other });
    expect(signals.location().pathname).toBe("/other");
    expect([match.runs(), location.runs()]).toEqual([2, 2]);
    // Entries going: the match changes, the location does not.
    router.setEntries([{ route: Home }]);
    expect(signals.match().status).toBe("unmatched");
    expect([match.runs(), location.runs()]).toEqual([3, 2]);
    signals.dispose();
    router.navigate("/");
    expect(match.runs()).toBe(3);
  });
});
