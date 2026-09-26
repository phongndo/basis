import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DateTime, Effect, Exit, Fiber, Layer, Stream } from "effect";
import type { Scope } from "effect";
import { definePlugin, Events, makeCore } from "@basis/core";
import { Message, Notice, Paths, SessionAppended, SessionChanged, SessionEntry, Sessions, Usage } from "@basis/contracts";
import type { EntryPayload } from "@basis/contracts";
import sessionsPlugin, { decodeLine, projectKey, sessionPath } from "../src/index.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "basis-sessions-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const fakePaths = (sessions: string) => definePlugin({
  id: "paths", provides: [Paths],
  layer: Layer.succeed(Paths, { home: sessions, userConfig: "", projectConfig: "", auth: "", sessions, cwd: "/work" }),
});

/** Mount a fresh core over the shared directory; each call is a "process restart". */
const withCore = <A, E>(body: (sessions: typeof Sessions.Service) => Effect.Effect<A, E, Scope.Scope | Events>) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const core = yield* makeCore([fakePaths(root), sessionsPlugin]);
    return yield* core.run(Effect.flatMap(Sessions, body));
  })));

const text = (role: "user" | "assistant", content: string): EntryPayload =>
  ({ type: "message", message: new Message({ role, parts: [{ type: "text", text: content }] }) });

const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter((line) => line !== "");

describe("sessions", () => {
  test("round-trips header and entries through the file and a reopened core", async () => {
    const { info, appended, events } = await withCore((sessions) => Effect.gen(function* () {
      const bus = yield* Events;
      const collect = yield* Effect.fork(Stream.runCollect(Stream.take(bus.stream(SessionAppended), 4)));
      yield* Effect.sleep("2 millis");
      const info = yield* sessions.create("/work/project");
      const appended = [
        yield* sessions.append(info.id, text("user", "hello")),
        yield* sessions.append(info.id, { type: "message", message: new Message({ role: "assistant", parts: [{ type: "tool-call", id: "c1", name: "read", input: { path: "a.ts" } }] }), usage: new Usage({ input: 10, output: 5 }), model: "fake/m" }),
        yield* sessions.append(info.id, { type: "compaction", summary: "so far", tokensBefore: 1234 }),
        yield* sessions.append(info.id, { type: "custom", kind: "test/mark", data: { nested: [1, "two"] } }),
      ];
      const events = yield* Fiber.join(collect);
      return { info, appended, events: [...events] };
    }));
    expect(events.map((event) => event.entry.id)).toEqual(appended.map((entry) => entry.id));

    const file = sessionPath(root, "/work/project", info.id);
    const records = lines(file).map((line) => decodeLine(line));
    expect(records.every((record) => record._tag === "Right")).toBe(true);
    expect(records.map((record) => record._tag === "Right" && record.right.type)).toEqual(["header", "entry", "entry", "entry", "entry"]);
    const header = JSON.parse(lines(file)[0]!);
    expect(header).toMatchObject({ type: "header", id: info.id, cwd: "/work/project" });
    expect(header.leaf).toBeUndefined();
    expect(typeof header.createdAt).toBe("string");

    // A new core reads the same state back: entries, order, timestamps, leaf, and the chain of parents.
    await withCore((sessions) => Effect.gen(function* () {
      const reopened = yield* sessions.get(info.id);
      expect(reopened.leaf).toBe(appended[3]!.id);
      expect(reopened.createdAt.epochMillis).toBe(info.createdAt.epochMillis);
      expect(reopened.updatedAt.epochMillis).toBe(appended[3]!.at.epochMillis);
      const entries = [...(yield* Stream.runCollect(sessions.entries(info.id)))];
      expect(entries).toEqual(appended);
      expect(entries.map((entry) => entry.parent)).toEqual([null, appended[0]!.id, appended[1]!.id, appended[2]!.id]);
      expect(entries.every((entry) => entry instanceof SessionEntry && DateTime.isUtc(entry.at))).toBe(true);
    }));
  });

  test("branching and checkout survive a reopen without rewriting the file", async () => {
    const ids = await withCore((sessions) => Effect.gen(function* () {
      const { id } = yield* sessions.create("/work");
      const a = yield* sessions.append(id, text("user", "a"));
      const b = yield* sessions.append(id, text("assistant", "b"));
      const c = yield* sessions.append(id, text("user", "c"));
      const info = yield* sessions.checkout(id, a.id);
      expect(info.leaf).toBe(a.id);
      const d = yield* sessions.append(id, text("user", "d"));
      expect(d.parent).toBe(a.id);
      expect((yield* sessions.context(id)).map((entry) => entry.id)).toEqual([a.id, d.id]);
      // Explicit parent branches without a checkout; the leaf follows the new entry.
      const e = yield* sessions.append(id, text("user", "e"), { parent: b.id });
      expect(e.parent).toBe(b.id);
      expect((yield* sessions.get(id)).leaf).toBe(e.id);
      yield* sessions.checkout(id, c.id);
      return { id, a, b, c, d, e };
    }));
    const file = sessionPath(root, "/work", ids.id);
    const kinds = lines(file).map((line) => JSON.parse(line).type);
    expect(kinds).toEqual(["header", "entry", "entry", "entry", "leaf", "entry", "entry", "leaf"]);

    await withCore((sessions) => Effect.gen(function* () {
      expect((yield* sessions.get(ids.id)).leaf).toBe(ids.c.id);
      expect((yield* sessions.context(ids.id)).map((entry) => entry.id)).toEqual([ids.a.id, ids.b.id, ids.c.id]);
      expect((yield* Stream.runCollect(sessions.entries(ids.id))).length).toBe(5);
      const f = yield* sessions.append(ids.id, text("assistant", "f"));
      expect(f.parent).toBe(ids.c.id);
    }));
    expect(lines(file).length).toBe(9);
  });

  test("context honors the nearest compaction on the current path only", async () => {
    await withCore((sessions) => Effect.gen(function* () {
      const { id } = yield* sessions.create("/work");
      const a = yield* sessions.append(id, text("user", "a"));
      const b = yield* sessions.append(id, text("assistant", "b"));
      const first = yield* sessions.append(id, { type: "compaction", summary: "a+b", tokensBefore: 100 });
      const c = yield* sessions.append(id, text("user", "c"));
      expect((yield* sessions.context(id)).map((entry) => entry.id)).toEqual([first.id, c.id]);

      const second = yield* sessions.append(id, { type: "compaction", summary: "a+b+c", tokensBefore: 200 });
      const d = yield* sessions.append(id, text("user", "d"));
      expect((yield* sessions.context(id)).map((entry) => entry.id)).toEqual([second.id, d.id]);

      // A branch from before the compaction sees the full history; the compaction entry itself is a valid leaf.
      yield* sessions.checkout(id, b.id);
      expect((yield* sessions.context(id)).map((entry) => entry.id)).toEqual([a.id, b.id]);
      yield* sessions.checkout(id, first.id);
      expect((yield* sessions.context(id)).map((entry) => entry.id)).toEqual([first.id]);
      // The entries stream still carries everything.
      expect((yield* Stream.runCollect(sessions.entries(id))).length).toBe(6);
    }));
  });

  test("skips corrupt lines with a Notice and reports a corrupt header", async () => {
    const { id, a, c } = await withCore((sessions) => Effect.gen(function* () {
      const { id } = yield* sessions.create("/work");
      const a = yield* sessions.append(id, text("user", "a"));
      yield* sessions.append(id, text("assistant", "b"));
      const c = yield* sessions.append(id, text("user", "c"));
      return { id, a, c };
    }));
    const file = sessionPath(root, "/work", id);
    const original = lines(file);
    // Damage the middle entry, add garbage, a leaf move to nowhere, and an orphaned entry.
    writeFileSync(file, [
      original[0], original[1], original[2]!.slice(0, 40), original[3],
      "{not json", JSON.stringify({ type: "leaf", entryId: "missing" }),
      JSON.stringify({ type: "entry", id: "orphan", parent: "missing", at: new Date().toISOString(), payload: { type: "title", title: "x" } }),
      JSON.stringify({ type: "leaf", entryId: a.id }),
    ].join("\n") + "\n");

    const notices = await withCore((sessions) => Effect.gen(function* () {
      const bus = yield* Events;
      const collect = yield* Effect.fork(Stream.runCollect(Stream.take(bus.stream(Notice), 5)));
      yield* Effect.sleep("2 millis");
      const info = yield* sessions.get(id);
      expect(info.leaf).toBe(a.id);
      const entries = [...(yield* Stream.runCollect(sessions.entries(id)))];
      // "b" is gone, so "c" (whose parent was b) is dropped too; the chain stays consistent.
      expect(entries.map((entry) => entry.id)).toEqual([a.id]);
      expect(entries.map((entry) => entry.id)).not.toContain(c.id);
      const appended = yield* sessions.append(id, text("assistant", "after"));
      expect(appended.parent).toBe(a.id);
      return [...(yield* Fiber.join(collect))];
    }));
    expect(notices.every((notice) => notice.level === "warning" && notice.source === "sessions")).toBe(true);
    expect(notices.map((notice) => notice.message)).toEqual([
      expect.stringContaining(":3: skipped unreadable line"),
      expect.stringContaining(`:4: skipped entry ${c.id} whose parent`),
      expect.stringContaining(":5: skipped unreadable line"),
      expect.stringContaining(":6: skipped leaf move to unknown entry missing"),
      expect.stringContaining(":7: skipped entry orphan whose parent missing is unknown"),
    ]);

    // A broken header cannot be attributed to anything: the session is Corrupt.
    const broken = sessionPath(root, "/work", "broken");
    writeFileSync(broken, "garbage\n");
    const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
      const core = yield* makeCore([fakePaths(root), sessionsPlugin]);
      return yield* core.run(Effect.flatMap(Sessions, (sessions) => sessions.get("broken")));
    })));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause).toMatchObject({ error: { _tag: "SessionError", reason: "Corrupt", sessionId: "broken" } });
  });

  test("lists sessions newest first, filters by cwd, and reports unreadable files without failing", async () => {
    await withCore((sessions) => Effect.gen(function* () {
      const one = yield* sessions.create("/work/one");
      const two = yield* sessions.create("/work/two");
      const three = yield* sessions.create("/work/one");
      yield* sessions.setTitle(three.id, "third");
      yield* Effect.sleep("2 millis");
      yield* sessions.append(one.id, text("user", "bump"));
      return { one, two, three };
    }));
    expect(readdirSync(root).sort()).toEqual([projectKey("/work/one"), projectKey("/work/two")].sort());
    writeFileSync(path.join(root, projectKey("/work/two"), "bad.jsonl"), "{}\n");

    await withCore((sessions) => Effect.gen(function* () {
      const bus = yield* Events;
      const notice = yield* Effect.fork(Stream.runHead(bus.stream(Notice)));
      yield* Effect.sleep("2 millis");
      const all = yield* sessions.list();
      expect(all.map((info) => info.cwd)).toEqual(["/work/one", "/work/one", "/work/two"]);
      expect(all[0]!.title).toBeUndefined();
      expect(all[1]!.title).toBe("third");
      expect(all[0]!.updatedAt.epochMillis).toBeGreaterThan(all[1]!.updatedAt.epochMillis);
      const filtered = yield* sessions.list({ cwd: "/work/two" });
      expect(filtered.map((info) => info.cwd)).toEqual(["/work/two"]);
      expect(yield* sessions.list({ cwd: "/nowhere" })).toEqual([]);
      const reported = yield* Fiber.join(notice);
      expect(reported._tag === "Some" && reported.value.message).toContain("bad.jsonl");

      // The header cache follows appends: the bumped session moves to the front.
      const target = all[2]!;
      yield* sessions.append(target.id, text("user", "newest"));
      expect((yield* sessions.list())[0]!.id).toBe(target.id);
      const changed = yield* sessions.setTitle(target.id, "renamed");
      expect(changed.title).toBe("renamed");
      expect((yield* sessions.get(target.id)).title).toBe("renamed");
    }));

    // Errors name the session.
    const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
      const core = yield* makeCore([fakePaths(root), sessionsPlugin]);
      return yield* core.run(Effect.flatMap(Sessions, (sessions) => sessions.append("nope", text("user", "x"))));
    })));
    if (Exit.isFailure(exit)) expect(exit.cause).toMatchObject({ error: { reason: "NotFound", sessionId: "nope" } });
    else throw new Error("expected NotFound");
  });

  test("serializes concurrent appends into one durable chain", async () => {
    const { id, appended } = await withCore((sessions) => Effect.gen(function* () {
      const { id } = yield* sessions.create("/work");
      const appended = yield* Effect.all(
        Array.from({ length: 40 }, (_, n) => sessions.append(id, text(n % 2 === 0 ? "user" : "assistant", `m${n}`))),
        { concurrency: "unbounded" },
      );
      const context = yield* sessions.context(id);
      expect(context.length).toBe(40);
      for (let n = 1; n < context.length; n++) expect(context[n]!.parent).toBe(context[n - 1]!.id);
      expect(new Set(appended.map((entry) => entry.id)).size).toBe(40);
      expect((yield* sessions.get(id)).leaf).toBe(context[39]!.id);
      return { id, appended };
    }));
    const file = sessionPath(root, "/work", id);
    expect(lines(file).length).toBe(41);
    await withCore((sessions) => Effect.gen(function* () {
      expect((yield* sessions.context(id)).length).toBe(40);
      expect((yield* sessions.get(id)).leaf).toBe(JSON.parse(lines(file).at(-1)!).id);
      expect(appended.some((entry) => entry.id === JSON.parse(lines(file).at(-1)!).id)).toBe(true);
    }));
  });

  test("publishes SessionChanged on create, append, checkout, and title", async () => {
    await withCore((sessions) => Effect.gen(function* () {
      const bus = yield* Events;
      const collect = yield* Effect.fork(Stream.runCollect(Stream.take(bus.stream(SessionChanged), 4)));
      yield* Effect.sleep("2 millis");
      const { id } = yield* sessions.create("/work");
      const a = yield* sessions.append(id, text("user", "a"));
      yield* sessions.checkout(id, a.id);
      yield* sessions.setTitle(id, "named");
      const seen = [...(yield* Fiber.join(collect))];
      expect(seen.map((event) => event.info.leaf)).toEqual([undefined, a.id, a.id, expect.any(String)]);
      expect(seen[3]!.info.title).toBe("named");
    }));
  });
});
