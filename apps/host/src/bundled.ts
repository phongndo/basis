import { fileURLToPath } from "node:url";
import type { Composition, Plugin, PluginEntry } from "@basis/core";
import agent from "@basis/plugin-agent";
import credentials from "@basis/plugin-credentials";
import interaction from "@basis/plugin-interaction";
import llm from "@basis/plugin-llm-pi-ai";
import projectContext from "@basis/plugin-project-context";
import sessions from "@basis/plugin-sessions";
import tools from "@basis/plugin-tools";
import { bash, edit, read, write } from "@basis/plugin-tools-builtin";
import transport from "@basis/plugin-transport";
import workspace from "@basis/plugin-workspace";

/** The web app build the transport serves when no `staticDir` is configured. */
export const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));

/**
 * Everything a fresh install runs. The host plugin is built by main.ts with a
 * closure over the loader, so it arrives as an argument.
 */
export function bundled(host: Plugin): readonly Plugin[] {
  return [host, interaction, credentials, llm, tools, read, write, edit, bash, sessions, agent, projectContext, workspace, transport];
}

/**
 * The default composition is every bundled and local plugin, enabled with its
 * default config. Config files patch it by plugin id: `enabled: false` removes a
 * plugin, and a `config` object replaces the default config.
 */
export function withDefaults(ids: readonly string[], patch: Composition): Composition {
  const plugins: Record<string, PluginEntry> = {};
  for (const id of ids) plugins[id] = id === "transport" ? { config: { staticDir: webDist } } : {};
  for (const [id, row] of Object.entries(patch.plugins)) plugins[id] = { ...plugins[id], ...row };
  return { plugins };
}
