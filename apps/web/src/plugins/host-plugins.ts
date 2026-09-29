import { createSignal } from "solid-js";
import type { PluginStatus } from "@lemma/contracts";
import { Client, HostPlugins, Notify } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

/** The host's plugins, kept current from `plugins-changed`. Changes throw; whoever asked reports how it went. */
export default defineUiPlugin({
  id: "host-plugins",
  requires: { client: Client, notify: Notify },
  provides: { plugins: HostPlugins },
  setup: ({ client, notify }, plugin) => {
    const host = client.host;
    const [list, setList] = createSignal<readonly PluginStatus[]>([]);
    const refresh = async () => {
      setList(await host.host.plugins());
    };
    plugin.onCleanup(client.onConnect(() => void refresh().catch((error) => notify.report(error, "Sync failed"))));
    plugin.onCleanup(
      client.onEvent((event) => {
        if (event.type === "plugins-changed") setList(event.plugins);
      }),
    );
    return {
      plugins: {
        list,
        refresh,
        restart: async (target: PluginStatus, options?: { force?: boolean }) => {
          await host.host.restartPlugin(target.id, options?.force ? { force: true } : undefined);
          await refresh();
        },
        // The row goes where `enabled` is set now: the user file unless the project file decides.
        setEnabled: async (target: PluginStatus, enabled: boolean) => {
          const result = await host.host.configure({ [target.id]: { enabled } }, target.scope === "project" ? { scope: "project" } : undefined);
          if (!result.deferred) await refresh();
          return result;
        },
        setConfig: async (target: PluginStatus, values: Readonly<Record<string, unknown>>) => {
          const result = await host.host.configure({ [target.id]: { values } }, target.configScope === "project" ? { scope: "project" } : undefined);
          if (!result.deferred) await refresh();
          return result;
        },
        reload: async () => {
          const result = await host.host.reload();
          await refresh();
          return result;
        },
      },
    };
  },
});
