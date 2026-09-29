import { describe, expect, test } from "vitest";
import { cliCommand, webDist, withDefaults } from "../src/bundled.ts";

describe("withDefaults", () => {
  test("enables every plugin, with the web app served and the CLI named to the agent by default", () => {
    expect(withDefaults(["agent", "transport"], { plugins: {} }).plugins).toEqual({
      agent: { config: { cli: cliCommand } },
      transport: { config: { staticDir: webDist } },
    });
  });

  test("a transport config row keeps the web app unless it sets staticDir itself", () => {
    expect(withDefaults(["transport"], { plugins: { transport: { config: { port: 8000 } } } }).plugins.transport).toEqual({
      config: { staticDir: webDist, port: 8000 },
    });
    expect(withDefaults(["transport"], { plugins: { transport: { config: { staticDir: "/srv/ui" } } } }).plugins.transport).toEqual({
      config: { staticDir: "/srv/ui" },
    });
    expect(withDefaults(["transport"], { plugins: { transport: { enabled: false } } }).plugins.transport).toEqual({
      enabled: false,
      config: { staticDir: webDist },
    });
  });

  test("an agent config row keeps the CLI unless it sets cli itself", () => {
    expect(withDefaults(["agent"], { plugins: { agent: { config: { maxSteps: 5 } } } }).plugins.agent).toEqual({ config: { cli: cliCommand, maxSteps: 5 } });
  });

  test("other plugins' config rows replace their config", () => {
    expect(withDefaults(["tools"], { plugins: { tools: { config: { timeoutMs: 5 } }, extra: {} } }).plugins).toEqual({
      tools: { config: { timeoutMs: 5 } },
      extra: {},
    });
  });
});
