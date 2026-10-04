import { describe, expect, test } from "vitest";
import { appUrl, NewThreadRoute, SettingsRoute, ThreadRoute } from "../src/addresses.ts";

describe("addresses", () => {
  test("threads and settings have readable paths", () => {
    expect(NewThreadRoute.href({})).toBe("/");
    expect(ThreadRoute.href({ id: "s1" })).toBe("/threads/s1");
    expect(ThreadRoute.href({ id: "s1", view: "trajectory" })).toBe("/threads/s1/trajectory");
    expect(SettingsRoute.href({ section: "plugins" }, { plugin: "agent", kind: "host" })).toBe("/settings/plugins?plugin=agent&kind=host");
  });

  test("appUrl puts the token in the query", () => {
    expect(appUrl("http://127.0.0.1:7433", "/threads/s1", "t k")).toBe("http://127.0.0.1:7433/threads/s1?token=t+k");
    expect(appUrl("http://127.0.0.1:7433/", "/settings/plugins?plugin=agent")).toBe("http://127.0.0.1:7433/settings/plugins?plugin=agent");
  });

  test("appUrl refuses an address on another host, so the token never leaves this one", () => {
    // `\` reads as `/` in an http address: `/\evil.com` is `//evil.com`.
    expect(() => appUrl("http://127.0.0.1:7433", "/\\evil.com/x", "secret")).toThrow();
    expect(() => appUrl("http://127.0.0.1:7433", "//evil.com/x", "secret")).toThrow();
    expect(() => appUrl("http://127.0.0.1:7433", "https://evil.com/x", "secret")).toThrow();
  });
});
