import { describe, expect, test } from "vitest";
import { createBrowserHistory } from "../src/history.ts";
import { createRouter } from "../src/router.ts";

/** Enough of a window for the browser history: a stack of entries with state, and `popstate`. */
const fakeWindow = (initial: string, initialState: unknown = null) => {
  const stack: { url: string; state: unknown }[] = [{ url: initial, state: initialState }];
  let index = 0;
  /** With `later`, a `go` lands only on `land()`, as a browser's does on a later task. */
  let later = false;
  let landing: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const unloads = new Set<(event: { preventDefault: () => void; returnValue: unknown }) => void>();
  const at = () => new URL(stack[index]!.url, "http://app.test");
  const target = {
    location: {
      get pathname() {
        return at().pathname;
      },
      get search() {
        return at().search;
      },
      get hash() {
        return at().hash;
      },
    },
    history: {
      get state() {
        return stack[index]!.state;
      },
      pushState: (state: unknown, _: string, url?: string) => {
        index++;
        stack.splice(index, stack.length, { url: url ?? stack[index - 1]!.url, state });
      },
      replaceState: (state: unknown, _: string, url?: string) => {
        stack[index] = { url: url ?? stack[index]!.url, state };
      },
      go: (delta: number) => {
        const move = () => {
          index = Math.max(0, Math.min(stack.length - 1, index + delta));
          for (const listener of listeners) listener();
        };
        if (later) landing = move;
        else move();
      },
    },
    addEventListener: (type: string, listener: any) => (type === "beforeunload" ? unloads : listeners).add(listener),
    removeEventListener: (type: string, listener: any) => (type === "beforeunload" ? unloads : listeners).delete(listener),
    /** The page is about to unload: whether something asked the user to confirm. */
    unload: () => {
      let asked = false;
      for (const listener of unloads) listener({ preventDefault: () => (asked = true), returnValue: undefined });
      return asked;
    },
    /** The user edits the address: a new entry without state, then popstate. */
    edit: (url: string) => {
      index++;
      stack.splice(index, stack.length, { url, state: null });
      for (const listener of listeners) listener();
    },
    later: () => void (later = true),
    land: () => {
      const move = landing;
      landing = undefined;
      move?.();
    },
    stack,
  };
  return target;
};

describe("createBrowserHistory", () => {
  test("adopts the first entry, keeping the page's own state", () => {
    const target = fakeWindow("/a?x=1#h", { mine: true });
    const history = createBrowserHistory(target as unknown as Window);
    expect(history.location()).toMatchObject({ href: "/a?x=1#h", pathname: "/a", search: "?x=1", hash: "#h", index: 0 });
    expect(target.stack[0]!.state).toMatchObject({ mine: true, __router: { index: 0 } });
  });

  test("measures back and forward, and resumes an entry's index after a reload", () => {
    const target = fakeWindow("/");
    const history = createBrowserHistory(target as unknown as Window);
    const updates: { action: string; delta: number; pathname: string }[] = [];
    history.subscribe(({ action, delta, location }) => updates.push({ action, delta, pathname: location.pathname }));
    history.push("/one");
    history.push("/two");
    history.go(-2);
    history.go(1);
    expect(updates).toEqual([
      { action: "push", delta: 1, pathname: "/one" },
      { action: "push", delta: 1, pathname: "/two" },
      { action: "pop", delta: -2, pathname: "/" },
      { action: "pop", delta: 1, pathname: "/one" },
    ]);
    history.destroy();
    // A reload reads the entry's state back.
    expect(createBrowserHistory(target as unknown as Window).location().index).toBe(1);
  });

  test("an address edited by hand becomes a new entry after the current one", () => {
    const target = fakeWindow("/");
    const history = createBrowserHistory(target as unknown as Window);
    const actions: string[] = [];
    history.subscribe(({ action, delta }) => actions.push(`${action}:${delta}`));
    target.edit("/typed");
    expect(actions).toEqual(["pop:0"]);
    expect(history.location()).toMatchObject({ pathname: "/typed", index: 1 });
  });
});

describe("a router on the browser history", () => {
  test("a navigation made while a back is landing waits for it, so the back does not leave it", () => {
    const target = fakeWindow("/a");
    const router = createRouter({ history: createBrowserHistory(target as unknown as Window) });
    router.navigate("/settings");
    target.later();
    router.back();
    router.navigate("/b");
    expect(router.location().href).toBe("/settings");
    target.land();
    expect(router.location()).toMatchObject({ href: "/b", index: 1 });
    expect(target.stack.map((entry) => entry.url)).toEqual(["/a", "/b"]);
  });

  test("a forward past the last known entry is not waited for", () => {
    const target = fakeWindow("/a");
    const router = createRouter({ history: createBrowserHistory(target as unknown as Window) });
    router.navigate("/b");
    router.back();
    target.later();
    router.go(2);
    router.navigate("/c");
    expect(router.location()).toMatchObject({ href: "/c", index: 1 });
  });

  test("a forward within the known entries is waited for", () => {
    const target = fakeWindow("/a");
    const router = createRouter({ history: createBrowserHistory(target as unknown as Window) });
    router.navigate("/b");
    router.back();
    target.later();
    router.go(1);
    router.navigate("/c");
    expect(router.location().href).toBe("/a");
    target.land();
    expect(router.location()).toMatchObject({ href: "/c", index: 2 });
    expect(target.stack.map((entry) => entry.url)).toEqual(["/a", "/b", "/c"]);
  });

  test("after a reload the entries ahead are unknown, so a forward is not waited for", () => {
    const target = fakeWindow("/a", { __router: { key: "k", index: 3 } });
    const history = createBrowserHistory(target as unknown as Window);
    expect(history.go(1)).toBe(false);
    expect(history.go(-1)).toBe(true);
  });

  test("a back past the first entry is not waited for", () => {
    const target = fakeWindow("/a");
    const router = createRouter({ history: createBrowserHistory(target as unknown as Window) });
    target.later();
    router.back();
    router.navigate("/b");
    expect(router.location().href).toBe("/b");
  });
});

describe("leaving the page", () => {
  test("a blocker refusing an unload has the browser ask; one allowing it, or removed, does not", () => {
    const target = fakeWindow("/a");
    const router = createRouter({ history: createBrowserHistory(target as unknown as Window) });
    let unsent = true;
    const unblock = router.block((transition) => transition.action !== "unload" || !unsent);
    expect(target.unload()).toBe(true);
    unsent = false;
    expect(target.unload()).toBe(false);
    unsent = true;
    unblock();
    expect(target.unload()).toBe(false);
    router.block(() => false);
    router.destroy();
    expect(target.unload()).toBe(false);
  });
});
