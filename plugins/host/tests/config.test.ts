import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { loadComposition, resolvePaths } from "../src/index.ts";
import type { PathsService } from "../src/index.ts";

async function withPaths<A>(body: (paths: PathsService) => Promise<A>): Promise<A> {
  const root = await mkdtemp(join(tmpdir(), "basis-host-"));
  try {
    const paths = resolvePaths({ env: { BASIS_HOME: join(root, "home") }, cwd: join(root, "project") });
    await mkdir(paths.home, { recursive: true });
    await mkdir(join(paths.cwd, ".basis"), { recursive: true });
    return await body(paths);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("resolvePaths", () => {
  test("defaults to ~/.basis and derives every location", () => {
    const paths = resolvePaths({ env: { HOME: "/home/me" }, cwd: "/work/app" });
    expect(paths).toEqual({
      home: "/home/me/.basis",
      userConfig: "/home/me/.basis/config.jsonc",
      projectConfig: "/work/app/.basis/config.jsonc",
      auth: "/home/me/.basis/auth.json",
      sessions: "/home/me/.basis/sessions",
      cwd: "/work/app",
    });
  });

  test("BASIS_HOME overrides the home directory", () => {
    const paths = resolvePaths({ env: { HOME: "/home/me", BASIS_HOME: "/var/basis" }, cwd: "/work/app" });
    expect(paths.home).toBe("/var/basis");
    expect(paths.auth).toBe("/var/basis/auth.json");
    expect(paths.projectConfig).toBe("/work/app/.basis/config.jsonc");
  });
});

describe("loadComposition", () => {
  test("missing files yield the host row alone, without diagnostics", () => withPaths(async (paths) => {
    const loaded = await Effect.runPromise(loadComposition(paths));
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.composition).toEqual({ plugins: { host: { config: paths } } });
    expect(loaded.files).toEqual([{ path: paths.userConfig, found: false }, { path: paths.projectConfig, found: false }]);
  }));

  test("merges project rows over user rows by id, replacing config objects", () => withPaths(async (paths) => {
    await writeFile(paths.userConfig, `{
      // user-level defaults
      "plugins": {
        "llm": { "config": { "default": "anthropic/claude", "temperature": 0.2 } },
        "tools": { "enabled": true, "config": { "shell": "bash" } },
        "sessions": {},
      },
    }`);
    await writeFile(paths.projectConfig, `{
      "plugins": {
        "llm": { "config": { "default": "openai/gpt" } }, /* whole object replaced */
        "tools": { "enabled": false },
        "mcp": { "config": { "servers": [] } },
      },
    }`);
    const loaded = await Effect.runPromise(loadComposition(paths));
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.files.map((file) => file.found)).toEqual([true, true]);
    expect(loaded.composition.plugins).toEqual({
      llm: { config: { default: "openai/gpt" } },
      tools: { enabled: false, config: { shell: "bash" } },
      sessions: {},
      mcp: { config: { servers: [] } },
      host: { config: paths },
    });
  }));

  test("reports malformed and invalid files by path and keeps the other file", () => withPaths(async (paths) => {
    await writeFile(paths.userConfig, `{ "plugins": { "llm": { "config": {} } `);
    await writeFile(paths.projectConfig, `{ "plugins": { "tools": { "enabled": "yes" } } }`);
    const loaded = await Effect.runPromise(loadComposition(paths));
    expect(loaded.diagnostics).toHaveLength(2);
    const [syntax, schema] = loaded.diagnostics;
    expect(syntax?.severity).toBe("error");
    expect(syntax?.message).toStartWith(`${paths.userConfig}:`);
    expect(schema?.severity).toBe("error");
    expect(schema?.message).toStartWith(`${paths.projectConfig}:`);
    expect(schema?.pluginId).toBe("tools");
    expect(schema?.path).toEqual(["plugins", "tools", "enabled"]);
    expect(loaded.composition.plugins).toEqual({ host: { config: paths } });
  }));

  test("a host row in a file is ignored with a warning", () => withPaths(async (paths) => {
    await writeFile(paths.projectConfig, `{ "plugins": { "host": { "enabled": false }, "tools": {} } }`);
    const loaded = await Effect.runPromise(loadComposition(paths));
    expect(loaded.diagnostics.map((d) => d.severity)).toEqual(["warning"]);
    expect(loaded.diagnostics[0]?.message).toContain(paths.projectConfig);
    expect(loaded.composition.plugins).toEqual({ tools: {}, host: { config: paths } });
  }));
});
