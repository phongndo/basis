import { afterEach, describe, expect, it, vi } from "vitest";
import { takeToken } from "../src/lib/token.ts";

const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
};

const page = (href: string) => {
  const history = { state: null, replaceState: vi.fn() } as unknown as History;
  return { location: { href } as Location, history };
};

describe("takeToken", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("takes the token from the link, strips it, and keeps it for this tab only", () => {
    const session = memoryStorage();
    const local = memoryStorage();
    vi.stubGlobal("sessionStorage", session);
    vi.stubGlobal("localStorage", local);
    const { location, history } = page("http://host:7433/?token=abc#s1");
    expect(takeToken(location, history)).toBe("abc");
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/#s1");
    expect(session.getItem("lemma.token")).toBe("abc");
    // Not for the origin: a later page served there could read it.
    expect(local.length).toBe(0);
    expect(takeToken(page("http://host:7433/#s1").location, history)).toBe("abc");
  });

  it("prefers a new link over the kept token", () => {
    const session = memoryStorage();
    session.setItem("lemma.token", "old");
    vi.stubGlobal("sessionStorage", session);
    const { location, history } = page("http://host:7433/?token=new");
    expect(takeToken(location, history)).toBe("new");
    expect(session.getItem("lemma.token")).toBe("new");
  });
});
