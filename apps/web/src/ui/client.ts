import { createSignal } from "solid-js";
import type { ConnectionStatus, Host } from "@lemma/client";
import type { HostEvent, HostInfo } from "@lemma/contracts";
import { Client } from "./contracts.ts";
import { defineUiPlugin } from "./define.ts";

/**
 * The host connection as a capability. Built by the boot around the page's
 * one `Host`, so replacing or restarting it never reconnects; models listen
 * here for events and resync on every reconnect.
 */
export const createClientPlugin = (host: Host) =>
  defineUiPlugin({
    id: "client",
    provides: { client: Client },
    setup: (_, plugin) => {
      const [status, setStatus] = createSignal<ConnectionStatus>(host.status());
      const [info, setInfo] = createSignal<HostInfo>();
      const syncs = new Set<() => void>();
      const connected = () => status().state === "connected";
      let generation = 0;
      const run = (sync: () => void) => {
        try {
          sync();
        } catch (error) {
          console.error("Resync failed", error);
        }
      };
      plugin.onCleanup(
        host.onStatus((next) => {
          setStatus(next);
          if (next.state !== "connected" || next.generation === generation) return;
          generation = next.generation;
          void host.host.info().then(setInfo, () => {});
          for (const sync of syncs) run(sync);
        }),
      );
      return {
        client: {
          host,
          status,
          connected,
          info,
          onEvent: (listener: (event: HostEvent) => void) => host.onEvent(listener),
          onConnect: (sync: () => void) => {
            syncs.add(sync);
            if (connected()) run(sync);
            return () => syncs.delete(sync);
          },
        },
      };
    },
  });
