import { describe, expect, it } from "vitest";
import { OUTPUT_TAIL_CHARS, appendOutput, applyDelta, dropOutput, emptyLive, endTurn, parseDraftArgs, settleStep, reconcileLive } from "../src/model/live.ts";
import type { LiveState } from "../src/model/live.ts";
import type { StreamEvent } from "@lemma/contracts";
import { assistant, branch, toolResult } from "./fixtures.ts";

const feed = (events: StreamEvent[], state: LiveState = emptyLive, stepId = "s1") => events.reduce((s, event) => applyDelta(s, "t1", stepId, event), state);

describe("live drafts", () => {
  it("accumulates text, thinking, and tool call deltas by index", () => {
    const s = feed([
      { type: "start" },
      { type: "thinking-delta", index: 0, delta: "hm" },
      { type: "thinking-delta", index: 0, delta: "m" },
      { type: "text-delta", index: 1, delta: "Hel" },
      { type: "text-delta", index: 1, delta: "lo" },
      { type: "toolcall-start", index: 2, id: "c1", name: "bash" },
      { type: "toolcall-delta", index: 2, delta: '{"command":"l' },
    ]);
    const blocks = s.drafts[0]!.blocks;
    expect(blocks[0]).toEqual({ kind: "thinking", text: "hmm" });
    expect(blocks[1]).toEqual({ kind: "text", text: "Hello" });
    expect(blocks[2]).toMatchObject({ kind: "tool", id: "c1", name: "bash", args: '{"command":"l' });
    const done = feed([{ type: "toolcall-end", index: 2, toolCall: { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } } }], s);
    const tool = done.drafts[0]!.blocks[2]!;
    expect(tool.kind === "tool" && parseDraftArgs(tool)).toEqual({ command: "ls" });
  });

  it("marks the draft finished with the stream error", () => {
    const s = feed([
      { type: "text-delta", index: 0, delta: "x" },
      { type: "error", message: assistant([], { stopReason: "error", errorMessage: "boom" }) },
    ]);
    expect(s.drafts[0]).toMatchObject({ finished: true, error: "boom" });
  });

  it("drops a settled step and ignores its late deltas", () => {
    let s = feed([{ type: "text-delta", index: 0, delta: "x" }]);
    s = settleStep(s, "s1");
    expect(s.drafts).toEqual([]);
    s = feed([{ type: "text-delta", index: 0, delta: "late" }], s);
    expect(s.drafts).toEqual([]);
  });

  it("settling before any delta prevents a stale draft", () => {
    const s = feed([{ type: "text-delta", index: 0, delta: "x" }], settleStep(emptyLive, "s1"));
    expect(s.drafts).toEqual([]);
  });

  it("ending a turn clears its drafts only", () => {
    let s = feed([{ type: "text-delta", index: 0, delta: "x" }]);
    s = applyDelta(s, "t2", "s9", { type: "text-delta", index: 0, delta: "y" });
    s = endTurn(s, "t1");
    expect(s.drafts.map((d) => d.stepId)).toEqual(["s9"]);
  });

  it("parses partial arguments leniently", () => {
    expect(parseDraftArgs({ kind: "tool", id: "", name: "bash", args: '{"command":' })).toBeUndefined();
  });
});

describe("reconcileLive", () => {
  it("settles drafts the recovered log already covers", () => {
    let state = applyDelta(emptyLive, "t1", "s1", { type: "text-delta", index: 0, delta: "partial" });
    state = applyDelta(state, "t2", "s2", { type: "text-delta", index: 0, delta: "other" });
    const events = [{ seq: 1, id: "a", parent: null, at: 1, data: { type: "message", message: assistant([]), turnId: "t1", stepId: "s1" } }] as const;
    const reconciled = reconcileLive(state, events as never);
    expect(reconciled.drafts.map((draft) => draft.stepId)).toEqual(["s2"]);
    const ended = reconcileLive(reconciled, [{ seq: 2, id: "b", parent: "a", at: 2, data: { type: "turn-end", turnId: "t2", reason: "done" } }] as never);
    expect(ended.drafts).toEqual([]);
    // Nothing to do leaves the state untouched.
    expect(reconcileLive(ended, events as never)).toBe(ended);
  });

  it("keeps a running tool's output tail until its result is logged or the turn ends", () => {
    let s = appendOutput(appendOutput(emptyLive, "c1", "a\n"), "c1", "b\n");
    expect(s.output.get("c1")).toBe("a\nb\n");
    expect(appendOutput(s, "c1", "x".repeat(OUTPUT_TAIL_CHARS)).output.get("c1")).toHaveLength(OUTPUT_TAIL_CHARS);
    expect(dropOutput(s, "c1").output.has("c1")).toBe(false);
    expect(reconcileLive(s, branch(toolResult("c1", "a\nb"))).output.has("c1")).toBe(false);
    s = appendOutput(s, "c2", "y");
    expect(endTurn(s, "t1").output.size).toBe(0);
  });

  it("drops only the ended turn's tool output when the log is replayed", () => {
    const running = appendOutput(emptyLive, "now", "building\n");
    const call = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: {} });
    const log = [
      { seq: 1, id: "a", parent: null, at: 1, data: { type: "message", message: assistant([call("old")] as never), turnId: "t0", stepId: "s0" } },
      { seq: 2, id: "b", parent: "a", at: 2, data: { type: "turn-end", turnId: "t0", reason: "cancelled" } },
      { seq: 3, id: "c", parent: "b", at: 3, data: { type: "message", message: assistant([call("now")] as never), turnId: "t1", stepId: "s1" } },
    ];
    // An earlier turn's end leaves the running tool's output alone...
    expect(reconcileLive(appendOutput(running, "old", "stale"), log as never).output).toEqual(new Map([["now", "building\n"]]));
    // ...and the running turn's own end drops it.
    const ended = [...log, { seq: 4, id: "d", parent: "c", at: 4, data: { type: "turn-end", turnId: "t1", reason: "cancelled" } }];
    expect(reconcileLive(running, ended as never).output.size).toBe(0);
  });
});
