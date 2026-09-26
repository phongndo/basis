import "./storage.ts";
import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { Message, SessionEntry, Usage } from "@basis/contracts";
import type { HostEvent, StreamEvent } from "@basis/contracts";
import { onEvent, selectSession, state } from "../src/store.ts";

const session = "s1";
const model = (event: StreamEvent): HostEvent => ({ type: "model", sessionId: session, turnId: "t1", event });
const reply = (text: string) => new Message({ role: "assistant", parts: [{ type: "text", text }] });
const appended = (text: string): HostEvent => ({
  type: "session-appended",
  sessionId: session,
  entry: new SessionEntry({ id: `e-${text}`, parent: null, at: DateTime.unsafeNow(), payload: { type: "message", message: reply(text) } }),
});
const finish = (text: string): HostEvent => model({ type: "finish", reason: "stop", message: reply(text) });

/** Selecting without a connection only resets the view; no RPC is attempted. */
const start = async () => {
  await selectSession(session);
  onEvent({ type: "turn-started", sessionId: session, turnId: "t1" });
};

describe("streamed draft", () => {
  test("accumulates text, thinking, and tool-call deltas for the active session only", async () => {
    await start();
    onEvent(model({ type: "thinking-delta", text: "hm" }));
    onEvent(model({ type: "text-delta", text: "Hel" }));
    onEvent(model({ type: "text-delta", text: "lo" }));
    onEvent(model({ type: "tool-call-delta", id: "c1", name: "read", inputDelta: '{"path":' }));
    onEvent(model({ type: "tool-call-delta", id: "c1", name: "read", inputDelta: '"a"}' }));
    onEvent(model({ type: "tool-call", id: "c1", name: "read", input: { path: "a" } }));
    expect(state.busy).toBe(true);
    expect(state.draft).toEqual({ text: "Hello", thinking: "hm", calls: [{ id: "c1", name: "read", input: JSON.stringify({ path: "a" }, null, 2) }] });
    onEvent({ ...model({ type: "text-delta", text: "other" }), sessionId: "s2" });
    expect(state.draft?.text).toBe("Hello");
  });

  test("the appended assistant entry replaces the draft even when it precedes the last deltas", async () => {
    await start();
    onEvent(model({ type: "text-delta", text: "Hel" }));
    onEvent(appended("Hello"));
    expect(state.draft).toBeUndefined();
    onEvent(model({ type: "text-delta", text: "lo" }));
    expect(state.draft).toBeUndefined();
    onEvent(finish("Hello"));
    expect(state.draft).toBeUndefined();
    onEvent(model({ type: "text-delta", text: "Again" }));
    expect(state.draft?.text).toBe("Again");
  });

  test("a finished draft stays visible until its entry arrives", async () => {
    await start();
    onEvent(model({ type: "text-delta", text: "Hello" }));
    onEvent(finish("Hello"));
    expect(state.draft?.text).toBe("Hello");
    onEvent(appended("Hello"));
    expect(state.draft).toBeUndefined();
  });

  test("turn-ended records usage and reason; an error drops the draft", async () => {
    await start();
    onEvent(model({ type: "text-delta", text: "partial" }));
    onEvent({ type: "turn-ended", sessionId: session, turnId: "t1", usage: new Usage({ input: 3, output: 4 }), reason: "error" });
    expect(state.busy).toBe(false);
    expect(state.draft).toBeUndefined();
    expect(state.lastTurn).toMatchObject({ reason: "error", usage: { input: 3, output: 4 } });
  });
});

describe("other events", () => {
  test("notices become toasts except the transport's subscription marker", () => {
    const before = state.toasts.length;
    onEvent({ type: "notice", level: "info", message: "Subscribed to host events", source: "transport" });
    expect(state.toasts.length).toBe(before);
    onEvent({ type: "notice", level: "warning", message: "Connection to the host was lost; reconnecting", source: "client" });
    expect(state.status).toBe("reconnecting");
    onEvent({ type: "notice", level: "error", message: "boom", source: "llm" });
    expect(state.toasts.slice(before).map((toast) => [toast.level, toast.message])).toEqual([
      ["warning", "Connection to the host was lost; reconnecting"], ["error", "boom"],
    ]);
  });

  test("interaction requests queue and close by id", () => {
    onEvent({ type: "interaction", request: { type: "confirm", id: "i1", title: "Sure?" } });
    onEvent({ type: "interaction", request: { type: "ask", id: "i2", title: "Key?" } });
    expect(state.interactions.map((request) => request.id)).toEqual(["i1", "i2"]);
    onEvent({ type: "interaction-closed", id: "i1" });
    expect(state.interactions.map((request) => request.id)).toEqual(["i2"]);
  });

  test("plugins-changed replaces the plugin list", () => {
    const plugins = [{ id: "llm", state: "failed" as const, fault: { phase: "activate", message: "no" } }];
    onEvent({ type: "plugins-changed", plugins });
    expect(state.plugins).toEqual(plugins);
  });
});
