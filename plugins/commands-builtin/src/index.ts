import { Effect, Layer } from "effect";
import type { Context } from "effect";
import { definePlugin } from "@lemma/core";
import { CommandError, Commands, HostControl, Interaction, Llm, Workspace } from "@lemma/contracts";
import type { Command, PluginInfo } from "@lemma/contracts";
import type { ReloadReport } from "@lemma/core";

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
        const summary = describeReport(report);
        return { message: summary === "nothing changed" ? "Config reloaded; nothing changed" : `Config reloaded: ${summary}` };
      }),
  },
  {
    id: "host.restart-plugin",
    title: "Restart plugin…",
    category: "Host",
    description: "Restart a failed plugin and what it halted, or a running plugin the host does not depend on",
    run: () =>
      Effect.gen(function* () {
        // Restarting a running plugin restarts its dependents; excluded when those include the transport serving this call.
        const plugins = (yield* control.plugins).filter((plugin) => recoverable(plugin) || (plugin.state === "active" && plugin.locked === undefined));
        if (plugins.length === 0) return yield* nothing("host.restart-plugin", "No plugin can be restarted");
        const id = yield* ask.select(
          "Restart which plugin?",
          plugins.map((plugin) => ({ value: plugin.id, label: plugin.id, description: plugin.state! })),
        );
        const chosen = plugins.find((plugin) => plugin.id === id)!;
        yield* control.restart(id, chosen.state === "active" ? { force: true } : undefined);
        return { message: `Restarted ${id}` };
      }),
  },
  {
    id: "host.toggle-plugin",
    title: "Turn plugin on or off…",
    category: "Host",
    description: "Change a plugin's `enabled` row in the config file that decides it, and apply",
    keywords: ["enable", "disable", "plugins"],
    run: () =>
      Effect.gen(function* () {
        const plugins = (yield* control.plugins).filter((plugin) => plugin.locked === undefined);
        if (plugins.length === 0) return yield* nothing("host.toggle-plugin", "Every plugin is needed by the host");
        const id = yield* ask.select(
          "Turn which plugin on or off?",
          plugins.map((plugin) => ({ value: plugin.id, label: plugin.id, description: plugin.enabled ? `on · turn off` : `off · turn on` })),
        );
        const chosen = plugins.find((plugin) => plugin.id === id)!;
        const enabled = !chosen.enabled;
        const report = yield* control.configure({ [id]: { enabled } }, chosen.scope === "project" ? { scope: "project" } : undefined);
        if (!(enabled ? report.started : report.stopped).includes(id)) {
          const after = (yield* control.plugins).find((plugin) => plugin.id === id);
          return yield* nothing("host.toggle-plugin", `${id} is still ${after?.enabled ? "on" : "off"}: the ${after?.scope ?? "user"} config decides it`);
        }
        const also = describeReport(report, id);
        return { message: `Turned ${id} ${enabled ? "on" : "off"}${also === "nothing changed" ? "" : `; ${also}`}` };
      }),
  },
];

/** Whether a restart would do anything without `force`: the plugin failed, or a failed dependency halted it. */
const recoverable = (plugin: PluginInfo): boolean => plugin.state === "failed" || (plugin.state === "closed" && plugin.haltedBy !== undefined);

/** `started x; restarted y; stopped z`, leaving out `except` (the plugin the caller already named). */
const describeReport = (report: ReloadReport, except?: string): string => {
  const list = (ids: readonly string[]) => ids.filter((id) => id !== except);
  const parts = [
    list(report.started).length > 0 ? `started ${list(report.started).join(", ")}` : "",
    list(report.restarted).length > 0 ? `restarted ${list(report.restarted).join(", ")}` : "",
    list(report.stopped).length > 0 ? `stopped ${list(report.stopped).join(", ")}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : "nothing changed";
};

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
