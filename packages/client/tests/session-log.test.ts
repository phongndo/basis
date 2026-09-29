import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@basis/contracts";
import { SessionLog, mergeEvents, rpcUrl, splitContiguous } from "../src/index.ts";

const ev = (seq: number): SessionEvent => ({
  seq,
  id: `e${seq}`,
  parent: seq === 1 ? null : `e${seq - 1}`,
  at: seq,
  data: { type: "title", title: `t${seq}` },
});
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ev(from + i));
const seqs = (events: readonly SessionEvent[]) => events.map((event) => event.seq);

/** A fake `Session.Events` over a server-side file, with calls recorded and optionally held. */
const server = (file: SessionEvent[]) => {
  const calls: (number | undefined)[] = [];
  let hold: (() => void) | undefined;
  let holding = false;
  const fetch = async (after: number | undefined) => {
    calls.push(after);
    // Snapshot at call time, like a server reading the file when the request arrives.
    const result = file.filter((event) => event.seq > (after ?? 0));
    if (holding)
      await new Promise<void>((resolve) => {
        hold = resolve;
      });
    return result;
  };
  return {
    calls,
    fetch,
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      hold?.();
    },
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("mergeEvents / splitContiguous", () => {
  it("sorts and dedupes by seq, keeping existing instances", () => {
    const a = ev(2);
    const merged = mergeEvents([a, ev(1)], [ev(3), { ...ev(2) }]);
    expect(seqs(merged)).toEqual([1, 2, 3]);
    expect(merged[1]).toBe(a);
  });

  it("splits at the first gap", () => {
    const { contiguous, ahead } = splitContiguous(mergeEvents([], [ev(1), ev(2), ev(4), ev(5)]), 0);
    expect(seqs(contiguous)).toEqual([1, 2]);
    expect(seqs(ahead)).toEqual([4, 5]);
  });

  it("skips events at or before `after`", () => {
    const { contiguous, ahead } = splitContiguous([ev(1), ev(2), ev(3)], 2);
    expect(seqs(contiguous)).toEqual([3]);
    expect(ahead).toEqual([]);
  });
});

describe("rpcUrl", () => {
  it("maps http(s) origins to ws(s) with the token", () => {
    expect(rpcUrl("http://127.0.0.1:7433/app/", "a b")).toBe("ws://127.0.0.1:7433/rpc?token=a+b");
    expect(rpcUrl("https://example.com", undefined)).toBe("wss://example.com/rpc");
  });
});

describe("SessionLog", () => {
  it("loads the whole log, then appends in order", async () => {
    const file = range(1, 3);
    const s = server(file);
    const log = new SessionLog({ sessionId: "s", fetch: s.fetch });
    await log.sync();
    expect(s.calls).toEqual([undefined]);
    expect(seqs(log.events)).toEqual([1, 2, 3]);
    file.push(ev(4));
    log.apply(ev(4));
    expect(seqs(log.events)).toEqual([1, 2, 3, 4]);
    expect(s.calls).toEqual([undefined]);
  });

  it("ignores duplicates", async () => {
    const s = server(range(1, 2));
    const log = new SessionLog({ sessionId: "s", fetch: s.fetch });
    await log.sync();
    const before = log.events;
    log.apply(ev(2));
    expect(log.events).toBe(before);
  });

  it("holds events beyond a gap and repairs with after=lastSeq", async () => {
    const file = range(1, 2);
    const s = server(file);
    const log = new SessionLog({ sessionId: "s", fetch: s.fetch });
    await log.sync();
    file.push(ev(3), ev(4), ev(5));
    log.apply(ev(5));
    expect(seqs(log.events)).toEqual([1, 2]);
    await settle();
    expect(s.calls).toEqual([undefined, 2]);
    expect(seqs(log.events)).toEqual([1, 2, 3, 4, 5]);
  });

  it("buffers appends that arrive during the initial load", async () => {
    const file = range(1, 3);
    const s = server(file);
    s.hold();
    const log = new SessionLog({ sessionId: "s", fetch: s.fetch });
    const loading = log.sync();
    expect(log.snapshot.syncing).toBe(true);
    file.push(ev(4));
    log.apply(ev(4));
    expect(log.events).toEqual([]);
    s.release();
    await loading;
    expect(seqs(log.events)).toEqual([1, 2, 3, 4]);
    expect(log.snapshot).toMatchObject({ loaded: true, syncing: false, lastSeq: 4 });
  });

  it("repairs a gap found during the initial load before finishing", async () => {
    const file = range(1, 3);
    const s = server(file);
    s.hold();
    const log = new SessionLog({ sessionId: "s", fetch: s.fetch });
    const loading = log.sync();
    // Event 4's notification is lost; event 5's arrives while the snapshot of 1-3 is in flight.
    file.push(ev(4), ev(5));
    log.apply(ev(5));
    s.release();
    await loading;
    expect(seqs(log.events)).toEqual([1, 2, 3, 4, 5]);
    expect(s.calls).toEqual([undefined, 3]);
  });

  it("remembers a lastSeq advertised during the initial load", async () => {
    const file = range(1, 3);
    const s = server(file);
    s.hold();
    const log = new SessionLog({ sessionId: "s", fetch: s.fetch });
    const loading = log.sync();
    file.push(ev(4));
    log.noteLastSeq(4);
    s.release();
    await loading;
    expect(seqs(log.events)).toEqual([1, 2, 3, 4]);
    expect(s.calls).toEqual([undefined, 3]);
  });

  it("coalesces concurrent syncs and refetches once more for gaps found mid-flight", async () => {
    const file = range(1, 2);
    const s = server(file);
    const log = new SessionLog({ sessionId: "s", fetch: s.fetch });
    await log.sync();
    s.hold();
    file.push(ev(3), ev(4));
    const first = log.sync();
    const second = log.sync();
    file.push(ev(5), ev(6));
    log.apply(ev(6));
    s.release();
    await first;
    await second;
    await settle();
    expect(seqs(log.events)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(s.calls).toEqual([undefined, 2, 4]);
  });

  it("noteLastSeq fetches only when behind", async () => {
    const file = range(1, 2);
    const s = server(file);
    const log = new SessionLog({ sessionId: "s", fetch: s.fetch });
    await log.sync();
    log.noteLastSeq(2);
    expect(s.calls).toEqual([undefined]);
    file.push(ev(3));
    log.noteLastSeq(3);
    await settle();
    expect(s.calls).toEqual([undefined, 2]);
    expect(log.lastSeq).toBe(3);
  });

  it("reports fetch errors and recovers on the next sync", async () => {
    let fail = true;
    const log = new SessionLog({
      sessionId: "s",
      fetch: async (after) => {
        if (fail) throw new Error("offline");
        return range(1, 2).filter((e) => e.seq > (after ?? 0));
      },
    });
    const snapshots: string[] = [];
    log.subscribe((snapshot) => snapshots.push(`${snapshot.loaded}:${snapshot.error ?? ""}`));
    await expect(log.sync()).rejects.toThrow("offline");
    expect(log.snapshot.error).toBe("offline");
    fail = false;
    await log.sync();
    expect(log.snapshot.error).toBeUndefined();
    expect(seqs(log.events)).toEqual([1, 2]);
    expect(snapshots.at(-1)).toBe("true:");
  });

  it("notifies subscribers with stable snapshots", async () => {
    const log = new SessionLog({ sessionId: "s", fetch: server(range(1, 1)).fetch });
    const seen: number[] = [];
    const stop = log.subscribe((snapshot) => seen.push(snapshot.lastSeq));
    await log.sync();
    stop();
    log.apply(ev(2));
    expect(seen.at(-1)).toBe(1);
  });
});
