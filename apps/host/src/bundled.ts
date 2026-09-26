import { Effect } from "effect";
import { Diagnostic } from "@basis/core";
import type { Plugin, PluginSource } from "@basis/core";
import agent from "@basis/plugin-agent";
import compaction from "@basis/plugin-compaction";
import credentials from "@basis/plugin-credentials";
import interaction from "@basis/plugin-interaction";
import llm from "@basis/plugin-llm";
import llmAnthropic from "@basis/plugin-llm-anthropic";
import llmOpenai from "@basis/plugin-llm-openai";
import llmOpenaiCompatible from "@basis/plugin-llm-openai-compatible";
import mcp from "@basis/plugin-mcp";
import sessions from "@basis/plugin-sessions";
import skills from "@basis/plugin-skills";
import subagent from "@basis/plugin-subagent";
import tools from "@basis/plugin-tools";
import toolsBuiltin from "@basis/plugin-tools-builtin";
import transport from "@basis/plugin-transport";

/**
 * Shipped plugins by id. The host plugin is built by main.ts with a closure
 * over the loader, so it arrives as an argument. A config file enables any
 * subset; `defaultComposition` is what a fresh install runs.
 */
export function bundled(host: Plugin): ReadonlyMap<string, Plugin> {
  const plugins = [
    host, interaction, credentials,
    llm, llmAnthropic, llmOpenai, llmOpenaiCompatible,
    tools, toolsBuiltin, sessions, agent, compaction, subagent, skills, mcp, transport,
  ];
  return new Map(plugins.map((plugin) => [plugin.id, plugin]));
}

/** Everything a fresh install needs to chat: enabled when no config file names any plugin. */
export const defaultPluginIds: readonly string[] = [
  "interaction", "credentials", "llm", "llm-anthropic", "llm-openai", "tools", "tools-builtin",
  "sessions", "agent", "compaction", "subagent", "skills", "transport",
];

export function bundledSource(plugins: ReadonlyMap<string, Plugin>): PluginSource {
  return {
    resolve: (id) => {
      const plugin = plugins.get(id);
      return plugin ? Effect.succeed(plugin) : Effect.fail(new Diagnostic({
        severity: "error", pluginId: id,
        message: `No bundled plugin "${id}"`,
        suggestion: `Remove it from config.jsonc; bundled plugins are: ${[...plugins.keys()].join(", ")}`,
      }));
    },
  };
}
