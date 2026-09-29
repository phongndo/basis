import { createSignal } from "solid-js";
import type { InteractionAnswer, InteractionRequest } from "@lemma/contracts";
import { Client, Interactions, Notify } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

/** Questions the host is waiting on: a login's API key, a tool that asks to confirm. */
export default defineUiPlugin({
  id: "interactions",
  requires: { client: Client, notify: Notify },
  provides: { interactions: Interactions },
  setup: ({ client, notify }, plugin) => {
    const host = client.host;
    const [open, setOpen] = createSignal<readonly InteractionRequest[]>([]);
    const [claims, setClaims] = createSignal(0);
    /** Ids closed while a list is in flight, so its reply cannot bring them back. */
    let closedSince: Set<string> | undefined;
    const close = (id: string) => {
      closedSince?.add(id);
      setOpen((all) => all.filter((request) => request.id !== id));
    };
    plugin.onCleanup(
      client.onEvent((event) => {
        if (event.type === "interaction") setOpen((all) => [...all.filter((request) => request.id !== event.request.id), event.request]);
        else if (event.type === "interaction-closed") close(event.id);
      }),
    );
    // Events only carry questions asked while this plugin listens; a restarted plugin reads the ones already waiting.
    plugin.onCleanup(
      client.onConnect(() => {
        const closed = new Set<string>();
        closedSince = closed;
        void host.interaction.list().then(
          (requests) => {
            if (closedSince === closed) closedSince = undefined;
            setOpen((all) => [...requests.filter((request) => !closed.has(request.id) && !all.some((known) => known.id === request.id)), ...all]);
          },
          (error) => notify.report(error, "Sync failed"),
        );
      }),
    );
    // Questions may close while no connection can report it; the next subscription replays the ones still open.
    plugin.onCleanup(
      client.host.onStatus((status) => {
        if (status.state === "reconnecting") setOpen([]);
      }),
    );
    return {
      interactions: {
        open,
        answer: (id: string, answer: InteractionAnswer) => {
          close(id);
          host.interaction.answer(id, answer).catch((error) => notify.report(error));
        },
        dismiss: (id: string) => {
          close(id);
          host.interaction.dismiss(id).catch((error) => notify.report(error));
        },
        claim: () => {
          setClaims((count) => count + 1);
          let released = false;
          return () => {
            if (released) return;
            released = true;
            setClaims((count) => count - 1);
          };
        },
        claimed: () => claims() > 0,
      },
    };
  },
});
