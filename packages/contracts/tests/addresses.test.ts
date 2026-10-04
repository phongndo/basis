import { describe, expect, test } from "vitest";
import { NewThreadRoute, SettingsRoute, ThreadRoute } from "../src/addresses.ts";

describe("addresses", () => {
  test("threads and settings have readable paths", () => {
    expect(NewThreadRoute.href({})).toBe("/");
    expect(ThreadRoute.href({ id: "s1" })).toBe("/threads/s1");
    expect(ThreadRoute.href({ id: "s1", view: "trajectory" })).toBe("/threads/s1/trajectory");
    expect(SettingsRoute.href({ section: "plugins" }, { plugin: "agent", kind: "host" })).toBe("/settings/plugins?plugin=agent&kind=host");
  });
});
