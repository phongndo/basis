import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import type { Context } from "effect";
import type { Command, HostControl, Interaction, Llm, Workspace } from "@basis/contracts";
import { hostCommands, llmCommands, workspaceCommands } from "../src/index.ts";

type Ask = Context.Tag.Service<typeof Interaction>;

/** Answers every question with the scripted value, recording what was asked. */
const scripted = (answer: string) => {
  const asked: { title: string; options?: readonly string[] }[] = [];
  const ask: Ask = {
    confirm: (title) => Effect.sync(() => (asked.push({ title }), true)),
    ask: (title) => Effect.sync(() => (asked.push({ title }), answer)),
    select: (title, options) => Effect.sync(() => (asked.push({ title, options: options.map((option) => option.value) }), answer as never)),
  };
  return { ask, asked };
};

const find = (commands: readonly Command[], id: string) => commands.find((command) => command.id === id)!;
const run = (command: Command, cwd = "/repo") => Effect.runPromise(Effect.either(command.run({ cwd })));

describe("workspace commands", () => {
  const calls: unknown[] = [];
  const workspace = {
    branches: () =>
      Effect.succeed([
        { name: "main", current: true, remote: false, updatedAt: 3 },
        { name: "feature", current: false, remote: false, updatedAt: 2 },
        { name: "elsewhere", current: false, remote: false, updatedAt: 1, worktree: "/other" },
        { name: "origin/fix", current: false, remote: true, updatedAt: 0 },
      ]),
    checkout: (path: string, branch: string, options?: { create?: boolean }) =>
      Effect.sync(() => {
        calls.push({ path, branch, options });
        return { path, exists: true, git: { root: path, branch: branch.replace(/^origin\//, ""), changes: 0, ahead: 0, behind: 0 } };
      }),
  } as unknown as Context.Tag.Service<typeof Workspace>;

  test("switch branch offers every branch it could check out here", async () => {
    calls.length = 0;
    const { ask, asked } = scripted("origin/fix");
    const result = await run(find(workspaceCommands(workspace, ask), "workspace.checkout"));
    expect(asked).toEqual([{ title: "Switch to which branch?", options: ["feature", "origin/fix"] }]);
    expect(calls).toEqual([{ path: "/repo", branch: "origin/fix", options: undefined }]);
    expect(result).toMatchObject({ right: { message: "Switched to fix" } });
  });

  test("create branch creates the named branch from HEAD", async () => {
    calls.length = 0;
    const { ask } = scripted("  topic  ");
    const result = await run(find(workspaceCommands(workspace, ask), "workspace.new-branch"));
    expect(calls).toEqual([{ path: "/repo", branch: "topic", options: { create: true } }]);
    expect(result).toMatchObject({ right: { message: "Created and switched to topic" } });
  });
});

describe("host commands", () => {
  const restarted: string[] = [];
  const control = {
    plugins: Effect.succeed([
      { id: "agent", state: "active" },
      { id: "llm", state: "failed" },
    ]),
    reload: Effect.succeed({ started: ["x"], restarted: [], stopped: ["y"], unchanged: [], failed: [], interrupted: 0, faults: [] }),
    restart: (id: string) => Effect.sync(() => void restarted.push(id)),
  } as unknown as Context.Tag.Service<typeof HostControl>;

  test("reload describes what changed", async () => {
    const result = await run(find(hostCommands(control, scripted("").ask), "host.reload"));
    expect(result).toMatchObject({ right: { message: "Config reloaded: started x; stopped y" } });
  });

  test("restart plugin restarts the chosen one", async () => {
    const { ask, asked } = scripted("llm");
    const result = await run(find(hostCommands(control, ask), "host.restart-plugin"));
    expect(asked[0]?.options).toEqual(["agent", "llm"]);
    expect(restarted).toEqual(["llm"]);
    expect(result).toMatchObject({ right: { message: "Restarted llm" } });
  });
});

describe("llm commands", () => {
  test("log out offers only configured providers, and fails when there are none", async () => {
    const loggedOut: string[] = [];
    const llm = (configured: boolean) =>
      ({
        providers: Effect.succeed([
          { id: "a", name: "Alpha", auth: [], configured, source: "auth.json" },
          { id: "b", name: "Beta", auth: [], configured: false },
        ]),
        logout: (id: string) => Effect.sync(() => void loggedOut.push(id)),
      }) as unknown as Context.Tag.Service<typeof Llm>;

    const { ask, asked } = scripted("a");
    expect(await run(find(llmCommands(llm(true), ask), "llm.logout"))).toMatchObject({ right: { message: "Logged out of Alpha" } });
    expect(asked[0]?.options).toEqual(["a"]);
    expect(loggedOut).toEqual(["a"]);

    expect(await run(find(llmCommands(llm(false), ask), "llm.logout"))).toMatchObject({ left: { reason: "Failed", message: "No provider is logged in" } });
  });
});
