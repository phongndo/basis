import { describe, expect, test, vi } from "vitest";
import { interceptLinks } from "../src/links.ts";

const origin = "http://app.test";
const page = { href: `${origin}/threads/a?mock=`, origin, pathname: "/threads/a", search: "?mock=" };

/** An `<a>` as the router reads one. */
const anchor = (href: string, attributes: Record<string, string> = {}) => ({
  tagName: "A",
  href: new URL(href, page.href).href,
  target: attributes.target ?? "",
  rel: attributes.rel ?? "",
  hasAttribute: (name: string) => name === "href" || name in attributes,
  ownerDocument: { location: page },
});

const setup = (options: Parameters<typeof interceptLinks>[1] = {}) => {
  const handlers = new Map<string, (event: Event) => void>();
  const root = { addEventListener: (type: string, handler: any) => handlers.set(type, handler), removeEventListener: (type: string) => handlers.delete(type) };
  const went: string[] = [];
  const intents: string[] = [];
  const remove = interceptLinks(
    { navigate: ((href: string) => (went.push(href), true)) as any },
    {
      ...options,
      root: root as any,
      onIntent: (href) => intents.push(href),
    },
  );
  const fire = (type: string, link: unknown, init: Partial<MouseEvent> = {}) => {
    let prevented = false;
    handlers.get(type)?.({
      type,
      button: 0,
      defaultPrevented: false,
      ...init,
      composedPath: () => [{ tagName: "SPAN" }, link],
      preventDefault: () => (prevented = true),
    } as unknown as Event);
    return prevented;
  };
  return { fire, went, intents, remove, handlers };
};

describe("interceptLinks", () => {
  test("a plain click on a link to a page navigates in place", () => {
    const { fire, went } = setup();
    expect(fire("click", anchor("/settings/plugins?mock="))).toBe(true);
    expect(went).toEqual(["/settings/plugins?mock="]);
  });

  test("the browser keeps what it does best: new tabs, downloads, other targets and origins, external links, fragments, ignored paths", () => {
    const { fire, went } = setup({ ignore: (url) => url.pathname.startsWith("/api/") });
    expect(fire("click", anchor("/threads/b"), { metaKey: true })).toBe(false);
    expect(fire("click", anchor("/threads/b"), { button: 1 })).toBe(false);
    expect(fire("click", anchor("/file", { download: "" }))).toBe(false);
    expect(fire("click", anchor("/threads/b", { target: "_blank" }))).toBe(false);
    expect(fire("click", anchor("https://elsewhere.test/threads/b"))).toBe(false);
    expect(fire("click", anchor("/threads/b", { rel: "noopener external" }))).toBe(false);
    expect(fire("click", anchor("/threads/a?mock=#turn-3"))).toBe(false);
    expect(fire("click", anchor("/api/export"))).toBe(false);
    expect(fire("click", { tagName: "SPAN" })).toBe(false);
    expect(went).toEqual([]);
  });

  test("resting on or focusing a link reports the intent once until it is left; passing over it does not", () => {
    vi.useFakeTimers();
    try {
      const { fire, intents } = setup();
      const link = anchor("/threads/b");
      fire("pointerover", anchor("/threads/c"));
      fire("pointerover", link);
      fire("pointerover", link);
      vi.advanceTimersByTime(60);
      expect(intents).toEqual(["/threads/b"]);
      fire("pointerover", { tagName: "DIV" });
      fire("focusin", link);
      expect(intents).toEqual(["/threads/b", "/threads/b"]);
      fire("pointerover", anchor("https://elsewhere.test/x"));
      vi.advanceTimersByTime(60);
      expect(intents).toEqual(["/threads/b", "/threads/b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the removal stops listening", () => {
    const { remove, handlers } = setup();
    remove();
    expect(handlers.size).toBe(0);
  });
});
