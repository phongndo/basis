import { Effect, Layer } from "effect";
import type { Context } from "effect";
import { definePlugin } from "@lemma/core";
import { CommandError, Commands, HostControl, Interaction, Llm, Workspace } from "@lemma/contracts";
import type { Command } from "@lemma/contracts";

type Ask = Context.Tag.Service<typeof Interaction>;

/** A command's own dead end: nothing to choose from. Reported like any failure. */
const nothing = (command: string, message: string) => new CommandError({ command, reason: "Failed", message });

export const hostCommands = (control: Context.Tag.Service<typeof HostControl>, ask: Ask): readonly Command[] => [
  {
    id: "host.reload",
    title: "Reload config",
    category: "Host",
    description: "Re-read the config files and apply them",
    keywords: ["plugins", "composition", "settings"],
    run: () =>
      Effect.map(control.reload, (report) => {
        const parts = [
          report.started.length > 0 ? `started ${report.started.join(", ")}` : "",
          report.restarted.length > 0 ? `restarted ${report.restarted.join(", ")}` : "",
          report.stopped.length > 0 ? `stopped ${report.stopped.join(", ")}` : "",
        ].filter(Boolean);
        return { message: parts.length > 0 ? `Config reloaded: ${parts.join("; ")}` : "Config reloaded; nothing changed" };
      }),
  },
  {
    id: "host.restart-plugin",
    title: "Restart plugin…",
    category: "Host",
    description: "Restart one plugin and the plugins that depend on it",
    run: () =>
      Effect.gen(function* () {
        const plugins = yield* control.plugins;
        if (plugins.length === 0) return yield* nothing("host.restart-plugin", "No plugins are running");
        const id = yield* ask.select(
          "Restart which plugin?",
          plugins.map((plugin) => ({ value: plugin.id, label: plugin.id, description: plugin.state })),
        );
        yield* control.restart(id);
        return { message: `Restarted ${id}` };
      }),
  },
];

export const llmCommands = (llm: Context.Tag.Service<typeof Llm>, ask: Ask): readonly Command[] => [
  {
    id: "llm.logout",
    title: "Log out of a provider…",
    category: "Providers",
    keywords: ["sign out", "credentials", "api key"],
    run: () =>
      Effect.gen(function* () {
        const providers = (yield* llm.providers).filter((provider) => provider.configured);
        if (providers.length === 0) return yield* nothing("llm.logout", "No provider is logged in");
        const id = yield* ask.select(
          "Log out of which provider?",
          providers.map((provider) => ({
            value: provider.id,
            label: provider.name,
            ...(provider.source === undefined ? {} : { description: provider.source }),
          })),
        );
        yield* llm.logout(id);
        return { message: `Logged out of ${providers.find((provider) => provider.id === id)?.name ?? id}` };
      }),
  },
];

export const workspaceCommands = (workspace: Context.Tag.Service<typeof Workspace>, ask: Ask): readonly Command[] => [
  {
    id: "workspace.checkout",
    title: "Switch branch…",
    category: "Git",
    description: "Check out another branch in the working directory",
    keywords: ["checkout", "git"],
    run: ({ cwd }) =>
      Effect.gen(function* () {
        // A branch checked out in another worktree cannot be checked out here too.
        const branches = (yield* workspace.branches(cwd)).filter((branch) => !branch.current && branch.worktree === undefined);
        if (branches.length === 0) return yield* nothing("workspace.checkout", `No other branch to switch to in ${cwd}`);
        const name = yield* ask.select(
          "Switch to which branch?",
          branches.map((branch) => ({ value: branch.name, label: branch.name, ...(branch.remote ? { description: "remote" } : {}) })),
        );
        const status = yield* workspace.checkout(cwd, name);
        return { message: `Switched to ${status.git?.branch ?? name}` };
      }),
  },
  {
    id: "workspace.new-branch",
    title: "Create branch…",
    category: "Git",
    description: "Create a branch from HEAD and switch to it",
    keywords: ["checkout", "git"],
    run: ({ cwd }) =>
      Effect.gen(function* () {
        const name = (yield* ask.ask("New branch name", { placeholder: "feature/name" })).trim();
        if (name === "") return yield* nothing("workspace.new-branch", "A branch needs a name");
        const status = yield* workspace.checkout(cwd, name, { create: true });
        return { message: `Created and switched to ${status.git?.branch ?? name}` };
      }),
  },
];

/**
 * One plugin per area, so a composition without `Llm` (say) still gets the
 * host and git commands. Exclusive because the registry rejects duplicate ids:
 * a reload must unregister the old commands before the new ones register.
 */
const commandsPlugin = <I, S>(id: string, service: Context.Tag<I, S>, commands: (service: S, ask: Ask) => readonly Command[]) =>
  definePlugin({
    id,
    version: "0.1.0",
    requires: [Commands, Interaction, service],
    exclusive: true,
    layer: Layer.scopedDiscard(
      Effect.gen(function* () {
        const [registry, ask, dependency] = yield* Effect.all([Commands, Interaction, service]);
        yield* Effect.forEach(commands(dependency, ask), registry.register, { discard: true });
      }),
    ),
  });

export const host = commandsPlugin("commands-host", HostControl, hostCommands);
export const llm = commandsPlugin("commands-llm", Llm, llmCommands);
export const workspace = commandsPlugin("commands-workspace", Workspace, workspaceCommands);
