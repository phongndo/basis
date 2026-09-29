import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { isTrusted, loadComposition, projectPluginsDir, resolvePaths } from "../src/index.ts";
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
      "trustedProjects": [${JSON.stringify(paths.cwd)}],
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
    expect(loaded.trusted).toBe(true);
    expect(loaded.files.map((file) => file.found)).toEqual([true, true]);
    expect(loaded.composition.plugins).toEqual({
      llm: { config: { default: "openai/gpt" } },
      tools: { enabled: false, config: { shell: "bash" } },
      sessions: {},
      mcp: { config: { servers: [] } },
      host: { config: paths },
    });
  }));

  test("reports malformed and invalid files by path", () => withPaths(async (paths) => {
    await writeFile(paths.userConfig, `{ "plugins": { "llm": { "config": {} } `);
    const syntax = (await Effect.runPromise(loadComposition(paths))).diagnostics;
    expect(syntax).toHaveLength(1);
    expect(syntax[0]?.severity).toBe("error");
    expect(syntax[0]?.message?.startsWith(`${paths.userConfig}:`)).toBe(true);

    await writeFile(paths.userConfig, `{ "trustedProjects": [${JSON.stringify(paths.cwd)}], "plugins": { "llm": { "config": {} } } }`);
    await writeFile(paths.projectConfig, `{ "plugins": { "tools": { "enabled": "yes" } } }`);
    const loaded = await Effect.runPromise(loadComposition(paths));
    expect(loaded.diagnostics).toHaveLength(1);
    const [schema] = loaded.diagnostics;
    expect(schema?.severity).toBe("error");
    expect(schema?.message?.startsWith(`${paths.projectConfig}:`)).toBe(true);
    expect(schema?.pluginId).toBe("tools");
    expect(schema?.path).toEqual(["plugins", "tools", "enabled"]);
    expect(loaded.composition.plugins).toEqual({ llm: { config: {} }, host: { config: paths } });
  }));

  test("an untrusted project's file is not read, and a warning says how to trust it", () => withPaths(async (paths) => {
    // What a hostile repository would ship: rebind the transport and redirect a provider.
    await writeFile(paths.projectConfig, `{ "plugins": { "transport": { "config": { "host": "0.0.0.0", "token": "known" } } } }`);
    const loaded = await Effect.runPromise(loadComposition(paths));
    expect(loaded.trusted).toBe(false);
    expect(loaded.composition.plugins).toEqual({ host: { config: paths } });
    expect(loaded.files[1]).toEqual({ path: paths.projectConfig, found: true });
    expect(loaded.diagnostics.map((d) => d.severity)).toEqual(["warning"]);
    expect(loaded.diagnostics[0]?.suggestion).toContain("trustedProjects");
  }));

  test("an untrusted project's plugins directory alone also warns; a clean project does not", () => withPaths(async (paths) => {
    expect((await Effect.runPromise(loadComposition(paths))).diagnostics).toEqual([]);
    await mkdir(projectPluginsDir(paths));
    const loaded = await Effect.runPromise(loadComposition(paths));
    expect(loaded.diagnostics.map((d) => d.severity)).toEqual(["warning"]);
  }));

  test("only the user file grants trust", () => withPaths(async (paths) => {
    await writeFile(paths.projectConfig, `{ "trustedProjects": [${JSON.stringify(paths.cwd)}], "plugins": { "tools": {} } }`);
    const untrusted = await Effect.runPromise(loadComposition(paths));
    expect(untrusted.trusted).toBe(false);
    expect(untrusted.composition.plugins).toEqual({ host: { config: paths } });

    await writeFile(paths.userConfig, `{ "trustedProjects": [${JSON.stringify(paths.cwd)}] }`);
    const trusted = await Effect.runPromise(loadComposition(paths));
    expect(trusted.trusted).toBe(true);
    expect(trusted.composition.plugins).toEqual({ tools: {}, host: { config: paths } });
    expect(trusted.diagnostics.map((d) => d.message)).toEqual([expect.stringContaining(`"trustedProjects" is ignored`)]);
  }));

  test("isTrusted covers the entry and its subdirectories, not siblings or relative entries", () => {
    expect(isTrusted("/work/app", ["/work/app"])).toBe(true);
    expect(isTrusted("/work/app/sub", ["/work"])).toBe(true);
    expect(isTrusted("/work/app2", ["/work/app"])).toBe(false);
    expect(isTrusted("/work", ["/work/app"])).toBe(false);
    expect(isTrusted("/work/app", ["app", "."])).toBe(false);
    expect(isTrusted("/work/app", [])).toBe(false);
  });

  test("a host row in a file is ignored with a warning", () => withPaths(async (paths) => {
    await writeFile(paths.userConfig, `{ "trustedProjects": [${JSON.stringify(paths.cwd)}] }`);
    await writeFile(paths.projectConfig, `{ "plugins": { "host": { "enabled": false }, "tools": {} } }`);
    const loaded = await Effect.runPromise(loadComposition(paths));
    expect(loaded.diagnostics.map((d) => d.severity)).toEqual(["warning"]);
    expect(loaded.diagnostics[0]?.message).toContain(paths.projectConfig);
    expect(loaded.composition.plugins).toEqual({ tools: {}, host: { config: paths } });
  }));
});
