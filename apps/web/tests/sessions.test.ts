import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionInfo } from "@basis/contracts";
import { groupSessions, resolveLeaf, upsertSession } from "../src/model/sessions.ts";

const info = (id: string, cwd: string, updatedAt: number, lastSeq = 0): SessionInfo => ({ id, cwd, createdAt: 0, updatedAt, lastSeq });
const ev = (id: string, parent: string | null, seq: number): SessionEvent => ({ seq, id, parent, at: seq, data: { type: "title", title: id } });

describe("groupSessions", () => {
  it("groups by cwd with newest groups and sessions first", () => {
    const groups = groupSessions([info("a", "/x", 1), info("b", "/y", 5), info("c", "/x", 9), info("d", "/y", 2)]);
    expect(groups.map((g) => [g.cwd, g.sessions.map((s) => s.id)])).toEqual([["/x", ["c", "a"]], ["/y", ["b", "d"]]]);
  });
});

describe("upsertSession", () => {
  it("inserts new sessions first and never steps back", () => {
    const list = [info("a", "/x", 5, 3)];
    expect(upsertSession(list, info("b", "/x", 1)).map((s) => s.id)).toEqual(["b", "a"]);
    expect(upsertSession(list, info("a", "/x", 4, 2))[0]!.lastSeq).toBe(3);
    expect(upsertSession(list, { ...info("a", "/x", 6, 4), title: "t" })[0]!.title).toBe("t");
  });
});

describe("resolveLeaf", () => {
  const events = [ev("1", null, 1), ev("2", "1", 2), ev("3", "2", 3), ev("4", "1", 4)];
  it("uses the newest event when the reported leaf is its ancestor (stale info)", () => {
    expect(resolveLeaf(events.slice(0, 3), "2")).toBe("3");
  });
  it("keeps a checkout of an earlier event on the same branch once the info has seen every event", () => {
    // Log 1 → 2 → 3, then a checkout of 2: the info already counts event 3.
    expect(resolveLeaf(events.slice(0, 3), "2", 3)).toBe("2");
    // A newer event than the info knows still wins when it descends from the leaf.
    expect(resolveLeaf(events.slice(0, 3), "2", 2)).toBe("3");
  });
  it("keeps a checked-out leaf on another branch", () => {
    expect(resolveLeaf(events, "3")).toBe("3");
  });
  it("falls back to the newest event for unknown or missing leaves", () => {
    expect(resolveLeaf(events, "zzz")).toBe("4");
    expect(resolveLeaf(events, undefined)).toBe("4");
    expect(resolveLeaf([], "1")).toBeUndefined();
  });
});
