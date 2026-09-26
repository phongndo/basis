import { DateTime } from "effect";
import { For, Show } from "solid-js";
import type { SessionInfo } from "@basis/contracts";
import { createSession, selectSession, sessionLabel, state, toast } from "../store.ts";
import { describeError } from "../host.ts";

const when = (session: SessionInfo) => DateTime.toDate(session.updatedAt).toLocaleString();
const project = (session: SessionInfo) => session.cwd.split("/").filter(Boolean).pop() ?? session.cwd;

export function Sessions(props: { onSelect: () => void }) {
  const open = (id: string) => { props.onSelect(); selectSession(id).catch((error) => toast("error", describeError(error))); };
  return (
    <nav id="sessions" class="sessions" aria-label="Sessions">
      <div class="sessions-head">
        <h2>Sessions</h2>
        <button onClick={() => { props.onSelect(); createSession().catch((error) => toast("error", describeError(error))); }}>New</button>
      </div>
      <Show when={state.sessions.length > 0} fallback={<p class="muted">No sessions yet.</p>}>
        <ul>
          <For each={state.sessions}>
            {(session) => (
              <li>
                <button class="session" aria-current={session.id === state.activeId ? "true" : undefined} onClick={() => open(session.id)}>
                  <span class="session-title">{sessionLabel(session)}</span>
                  <span class="session-meta">{project(session)} · {when(session)}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </nav>
  );
}
