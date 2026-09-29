import { describe, expect, it } from "vitest";
import { applyDelta, emptyLive, endTurn, parseDraftArgs, settleStep, reconcileLive } from "../src/model/live.ts";
import type { LiveState } from "../src/model/live.ts";
import type { StreamEvent } from "@basis/contracts";
import { assistant } from "./fixtures.ts";

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
});
