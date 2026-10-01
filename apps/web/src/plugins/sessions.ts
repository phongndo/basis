import { batch, createMemo, createSignal } from "solid-js";
import { SessionLog, startPrompt } from "@lemma/client";
import { branchOf } from "@lemma/contracts";
import type { HostEvent, PromptContent, SessionEvent, SessionInfo, SessionMarks, TurnOptions } from "@lemma/contracts";
import { appendOutput, applyDelta, dropOutput, emptyLive, endTurn, reconcileLive, settleStep } from "../model/live.ts";
import type { LiveState } from "../model/live.ts";
import { resolveLeaf, trackTurn, upsertSession } from "../model/sessions.ts";
import { Client, Notify, Sessions } from "../ui/contracts.ts";
import type { LogState } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

/** The session id in the page's address (`#<id>`), if any; a malformed one reads as none. */
const hashSession = (): string | undefined => {
  try {
    const id = decodeURIComponent(window.location.hash.replace(/^#\/?/, ""));
    return id === "" ? undefined : id;
  } catch {
    return undefined;
  }
};

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
    /** Drops a deleted session, leaving it first if it is open. */
    const forget = (sessionId: string) => {
      if (activeId() === sessionId) void select(undefined);
      setList((sessions) => sessions.filter((session) => session.id !== sessionId));
    };

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
          const fromHash = hashSession();
          if (fromHash !== undefined && list().some((session) => session.id === fromHash)) void select(fromHash);
        });
      }),
    );

    // The address names the open session (`select` keeps it current): a link, or an address edited by hand, opens the
    // session it names, and an address without one a new chat. An id no session has is left alone.
    const followHash = () => {
      const fromHash = hashSession();
      if (fromHash === undefined) void select(undefined);
      else if (list().some((session) => session.id === fromHash)) void select(fromHash);
    };
    window.addEventListener("hashchange", followHash);
    plugin.onCleanup(() => window.removeEventListener("hashchange", followHash));

    // Deltas and tool output arrive many times a frame; they are applied together, once per frame, in order. A hidden
    // tab gets no frames, so a long queue is applied at once instead.
    const QUEUE_LIMIT = 256;
    type Streamed = Extract<HostEvent, { type: "delta" | "tool-output" }>;
    let deltas: Streamed[] = [];
    let frame: number | undefined;
    const flushDeltas = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      if (deltas.length === 0) return;
      const pending = deltas;
      deltas = [];
      const bySession = new Map<string, typeof pending>();
      for (const event of pending) {
        const list = bySession.get(event.sessionId);
        if (list === undefined) bySession.set(event.sessionId, [event]);
        else list.push(event);
      }
      batch(() => {
        for (const [sessionId, events] of bySession)
          updateLive(sessionId, (state) =>
            events.reduce(
              (next, event) =>
                event.type === "delta" ? applyDelta(next, event.turnId, event.stepId, event.event) : appendOutput(next, event.toolCallId, event.chunk),
              state,
            ),
          );
      });
    };
    plugin.onCleanup(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
    });

    plugin.onCleanup(
      client.onEvent((event) => {
        if (event.type === "delta" || event.type === "tool-output") {
          deltas.push(event);
          if (deltas.length >= QUEUE_LIMIT) flushDeltas();
          else frame ??= requestAnimationFrame(flushDeltas);
          return;
        }
        // Everything else sees the deltas that came before it.
        flushDeltas();
        switch (event.type) {
          case "session-appended": {
            const data = event.event.data;
            // The open session's log settles drafts itself once the event is in its gap-free prefix (`reconcileLive`); settling
            // here as well would drop a draft whose message is held back behind a gap.
            if (sessionLog?.sessionId === event.sessionId) sessionLog.apply(event.event);
            else if (data.type === "message" && data.message.role === "toolResult") {
              const toolCallId = data.message.toolCallId;
              updateLive(event.sessionId, (state) => dropOutput(state, toolCallId));
            } else if ((data.type === "message" && data.message.role === "assistant" && data.stepId !== undefined) || data.type === "attempt") {
              updateLive(event.sessionId, (state) => settleStep(state, data.stepId!));
            }
            return;
          }
          case "session-removed":
            forget(event.sessionId);
            return;
          case "session-changed":
            upsert(event.info);
            if (sessionLog?.sessionId === event.info.id) sessionLog.noteLastSeq(event.info.lastSeq);
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
        startIn: setPendingCwd,
        rename: async (sessionId: string, title: string) => {
          const trimmed = title.trim();
          if (trimmed === "") return;
          try {
            upsert(await host.session.setTitle(sessionId, trimmed));
          } catch (error) {
            notify.report(error, "Rename failed");
          }
        },
        mark: async (sessionId: string, marks: SessionMarks) => {
          try {
            upsert(await host.session.mark(sessionId, marks));
          } catch (error) {
            notify.report(error, "Could not update the session");
          }
        },
        remove: async (sessionId: string) => {
          try {
            await host.session.remove(sessionId);
            forget(sessionId);
          } catch (error) {
            notify.report(error, "Could not delete the session");
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
