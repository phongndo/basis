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

/** How the agent runs this checkout's `basis` CLI from its shell; `node` is on PATH wherever the host runs. */
export const cliCommand = `node --conditions=source ${fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url))}`;

/**
 * Everything a fresh install runs. The host plugin is built by main.ts with a
 * closure over the loader, so it arrives as an argument.
 */
export function bundled(host: Plugin): readonly Plugin[] {
  return [host, interaction, credentials, llm, tools, read, write, edit, bash, sessions, agent, projectContext, workspace, transport];
}

/** Config the app supplies for bundled plugins, beneath whatever a config file sets. */
const appConfig: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  transport: { staticDir: webDist },
  agent: { cli: cliCommand },
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The default composition is every bundled and local plugin, enabled with its
 * default config. Config files patch it by plugin id: `enabled: false` removes a
 * plugin, and a `config` object replaces the default config. App-supplied
 * config (the web app's `staticDir`, the agent's `cli`) stays underneath a file's
 * `config` object key by key, so setting the transport's port does not also unset the web app.
 */
export function withDefaults(ids: readonly string[], patch: Composition): Composition {
  const plugins: Record<string, PluginEntry> = {};
  for (const id of ids) plugins[id] = appConfig[id] === undefined ? {} : { config: appConfig[id] };
  for (const [id, row] of Object.entries(patch.plugins)) {
    const base = appConfig[id];
    plugins[id] = { ...plugins[id], ...row, ...(base !== undefined && isRecord(row.config) ? { config: { ...base, ...row.config } } : {}) };
  }
  return { plugins };
}
