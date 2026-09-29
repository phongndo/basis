import { batch, createMemo, createSignal } from "solid-js";
import { SessionLog, startPrompt } from "@lemma/client";
import { branchOf } from "@lemma/contracts";
import type { PromptContent, SessionEvent, SessionInfo, TurnOptions } from "@lemma/contracts";
import { applyDelta, emptyLive, endTurn, reconcileLive, settleStep } from "../model/live.ts";
import type { LiveState } from "../model/live.ts";
import { resolveLeaf, trackTurn, upsertSession } from "../model/sessions.ts";
import { Client, Notify, Sessions } from "../ui/contracts.ts";
import type { LogState } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

/**
 * Sessions and the active one's log: the list, which is open, its events and
 * streaming drafts, which sessions are running, and sending prompts. The URL
 * hash names the open session, so a reload returns to it.
 */
export default defineUiPlugin({
  id: "sessions",
  requires: { client: Client, notify: Notify },
  provides: { sessions: Sessions },
  setup: ({ client, notify }, plugin) => {
    const host = client.host;
    const [list, setList] = createSignal<readonly SessionInfo[]>([]);
    const [loaded, setLoaded] = createSignal(false);
    const [activeId, setActiveId] = createSignal<string>();
    const [running, setRunning] = createSignal<readonly string[]>([]);
    const [pendingCwd, setPendingCwd] = createSignal<string>();
    // Event arrays and streaming drafts change often and are replaced wholesale.
    const [events, setEvents] = createSignal<readonly SessionEvent[]>([], { equals: false });
    const [log, setLog] = createSignal<LogState>({ loaded: true, syncing: false });
    const [live, setLive] = createSignal<Readonly<Record<string, LiveState>>>({});
    const selectListeners = new Set<(sessionId: string | undefined) => void>();

    let sessionLog: SessionLog | undefined;
    let stopLog: (() => void) | undefined;
    /** The last ended turn per session, so a late `turn-started` cannot mark it running again (see `trackTurn`). */
    let endedTurns: Readonly<Record<string, string>> = {};
    let restored = false;

    const active = createMemo(() => list().find((session) => session.id === activeId()));
    const leaf = createMemo(() => resolveLeaf(events(), active()?.leaf, active()?.lastSeq));
    const branch = createMemo(() => branchOf(events(), leaf()));
    const activeLive = createMemo(() => {
      const id = activeId();
      return (id === undefined ? undefined : live()[id]) ?? emptyLive;
    });
    const busy = createMemo(() => {
      const id = activeId();
      return id !== undefined && running().includes(id);
    });

    const updateLive = (sessionId: string, update: (state: LiveState) => LiveState): void => {
      const current = live()[sessionId] ?? emptyLive;
      const next = update(current);
      if (next !== current) setLive({ ...live(), [sessionId]: next });
    };
    const upsert = (info: SessionInfo) => setList((sessions) => upsertSession(sessions, info));

    const closeLog = () => {
      stopLog?.();
      sessionLog?.close();
      sessionLog = undefined;
      stopLog = undefined;
    };
    plugin.onCleanup(closeLog);

    const select = async (sessionId: string | undefined): Promise<void> => {
      for (const listener of selectListeners) listener(sessionId);
      if (sessionId === activeId() && (sessionId === undefined || sessionLog !== undefined)) return;
      closeLog();
      batch(() => {
        setActiveId(sessionId);
        setEvents([]);
        setLog({ loaded: sessionId === undefined, syncing: false });
      });
      history.replaceState(history.state, "", sessionId === undefined ? `${location.pathname}${location.search}` : `#${encodeURIComponent(sessionId)}`);
      if (sessionId === undefined) return;
      const next = new SessionLog({ sessionId, fetch: (after) => host.session.events(sessionId, after) });
      sessionLog = next;
      stopLog = next.subscribe((snapshot) =>
        batch(() => {
          setEvents(snapshot.events);
          updateLive(sessionId, (current) => reconcileLive(current, snapshot.events));
          setLog({ loaded: snapshot.loaded, syncing: snapshot.syncing, ...(snapshot.error === undefined ? {} : { error: snapshot.error }) });
        }),
      );
      await next.sync().catch((error) => notify.report(error, "Could not load the session"));
    };

    plugin.onCleanup(
      client.onConnect(() => {
        const tasks = [
          host.session.list().then((sessions) => batch(() => (setList(sessions), setLoaded(true)))),
          host.agent.running().then(setRunning),
          ...(sessionLog === undefined ? [] : [sessionLog.sync()]),
        ];
        void Promise.allSettled(tasks).then((results) => {
          const failed = results.find((result) => result.status === "rejected");
          if (failed !== undefined) notify.report((failed as PromiseRejectedResult).reason, "Sync failed");
          if (restored) return;
          restored = true;
          const fromHash = decodeURIComponent(window.location.hash.replace(/^#\/?/, ""));
          if (fromHash !== "" && list().some((session) => session.id === fromHash)) void select(fromHash);
        });
      }),
    );

    plugin.onCleanup(
      client.onEvent((event) => {
        switch (event.type) {
          case "session-appended": {
            if (sessionLog?.sessionId === event.sessionId) sessionLog.apply(event.event);
            const data = event.event.data;
            if ((data.type === "message" && data.message.role === "assistant" && data.stepId !== undefined) || data.type === "attempt") {
              updateLive(event.sessionId, (state) => settleStep(state, data.stepId!));
            }
            return;
          }
          case "session-changed":
            upsert(event.info);
            if (sessionLog?.sessionId === event.info.id) sessionLog.noteLastSeq(event.info.lastSeq);
            return;
          case "delta":
            updateLive(event.sessionId, (state) => applyDelta(state, event.turnId, event.stepId, event.event));
            return;
          case "turn-started":
            setRunning(trackTurn({ running: running(), ended: endedTurns }, event).running);
            return;
          case "turn-ended": {
            const next = trackTurn({ running: running(), ended: endedTurns }, event);
            endedTurns = next.ended;
            setRunning(next.running);
            updateLive(event.sessionId, (state) => endTurn(state, event.turnId));
            return;
          }
        }
      }),
    );

    const send = async (
      content: PromptContent,
      options: { readonly turn?: TurnOptions | undefined; readonly cwd?: string | undefined } = {},
    ): Promise<boolean> => {
      let sessionId = activeId();
      if (sessionId === undefined) {
        try {
          const info = await host.session.create(options.cwd ?? pendingCwd());
          setPendingCwd(undefined);
          upsert(info);
          await select(info.id);
          sessionId = info.id;
        } catch (error) {
          notify.report(error, "Could not create a session");
          return false;
        }
      }
      const id = sessionId;
      if (!running().includes(id)) setRunning((current) => [...current, id]);
      const prompt = startPrompt(host, id, content, options.turn);
      void prompt.done
        .catch(() => {})
        .finally(() => {
          // turn-ended normally clears this; the prompt settling is the fallback when the event was lost.
          setRunning((current) => current.filter((candidate) => candidate !== id));
          void sessionLog?.sync().catch(() => {});
        });
      // A refused prompt returns false so the composer keeps the text; failures after that are only reported.
      const accepted = await prompt.accepted.then(
        () => true,
        (error: unknown) => {
          notify.report(error, "Prompt was not sent");
          return false;
        },
      );
      if (accepted) void prompt.done.catch((error) => notify.report(error));
      return accepted;
    };

    return {
      sessions: {
        list,
        loaded,
        activeId,
        active,
        branch,
        log,
        live: activeLive,
        running,
        busy,
        pendingCwd,
        select,
        onSelect: (listener: (sessionId: string | undefined) => void) => {
          selectListeners.add(listener);
          return () => selectListeners.delete(listener);
        },
        newChat: (cwd?: string) => {
          setPendingCwd(cwd);
          void select(undefined);
        },
        rename: async (sessionId: string, title: string) => {
          const trimmed = title.trim();
          if (trimmed === "") return;
          try {
            upsert(await host.session.setTitle(sessionId, trimmed));
          } catch (error) {
            notify.report(error, "Rename failed");
          }
        },
        send,
        cancel: () => {
          const sessionId = activeId();
          if (sessionId !== undefined) host.agent.cancel(sessionId).catch((error) => notify.report(error, "Cancel failed"));
        },
        checkout: async (eventId: string) => {
          const sessionId = activeId();
          if (sessionId === undefined) return;
          try {
            upsert(await host.session.checkout(sessionId, eventId));
            notify.toast({ level: "info", message: "The next prompt continues from the chosen event, on a new branch." });
          } catch (error) {
            notify.report(error, "Could not branch the session");
          }
        },
      },
    };
  },
});
