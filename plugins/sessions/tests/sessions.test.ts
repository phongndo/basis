import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Chunk, Effect, Fiber, Layer, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { definePlugin, Events, makeCore } from "@lemma/core";
import { Notice, Paths, SessionAppended, SessionChanged, Sessions } from "@lemma/contracts";
import type { EventData } from "@lemma/contracts";
import sessions, { encodeCwd } from "../src/index.ts";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "lemma-sessions-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const paths = () =>
  definePlugin({
    id: "paths",
    provides: [Paths],
    layer: Layer.succeed(Paths, {
      home: dir,
      userConfig: "",
      projectConfig: "",
      auth: "",
      sessions: path.join(dir, "sessions"),
      cwd: "/work/app",
    }),
  });

/** Runs `body` against a fresh core over the same directory, as a restarted host would. */
const run = <A, E>(body: Effect.Effect<A, E, Sessions | Events>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore([paths(), sessions]);
        return yield* core.run(body);
      }),
    ),
  );

const title = (value: string): EventData => ({ type: "title", title: value });
const custom = (n: number): EventData => ({ type: "custom", kind: "test/n", data: n });

const sessionFiles = async () => {
  const root = path.join(dir, "sessions");
  const out: string[] = [];
  for (const project of await fs.readdir(root)) {
    for (const name of await fs.readdir(path.join(root, project))) out.push(path.join(root, project, name));
  }
  return out;
};

/** The session id in a file name; ids may themselves contain `_`, so take the fixed-length tail. */
const idOfFile = (file: string) => path.basename(file, ".jsonl").slice(-12);

describe("sessions", () => {
  it("writes a header and one line per event under the encoded cwd", async () => {
    const info = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const info = yield* store.create();
        yield* store.append(info.id, custom(1));
        return info;
      }),
    );
    expect(info.cwd).toBe("/work/app");
    expect(info.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    const [file] = await sessionFiles();
    expect(path.basename(path.dirname(file!))).toBe(encodeCwd("/work/app"));
    expect(path.basename(file!)).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[\\d-]+Z_${info.id}\\.jsonl$`));
    const lines = (await fs.readFile(file!, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0]).toEqual({ type: "session", version: 1, id: info.id, cwd: "/work/app", createdAt: info.createdAt });
    expect(lines[1]).toMatchObject({ seq: 1, parent: null, data: custom(1) });
  });

  it("chains appends, branches from an explicit parent, and restores the leaf after a checkout on reopen", async () => {
    const { id, first, third } = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create({ cwd: "/work/other" });
        const first = yield* store.append(id, custom(1));
        const second = yield* store.append(id, custom(2));
        expect(second.parent).toBe(first.id);
        const third = yield* store.append(id, custom(3), { parent: first.id });
        expect(third.seq).toBe(3);
        expect((yield* store.branch(id)).map((event) => event.id)).toEqual([first.id, third.id]);
        expect((yield* store.branch(id, { leaf: second.id })).map((event) => event.id)).toEqual([first.id, second.id]);
        const info = yield* store.checkout(id, second.id);
        expect(info.leaf).toBe(second.id);
        return { id, first, third };
      }),
    );
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const info = yield* store.get(id);
        expect(info.lastSeq).toBe(3);
        expect((yield* store.branch(id)).map((event) => event.data)).toEqual([custom(1), custom(2)]);
        expect((yield* store.events(id, { after: 1 })).map((event) => event.seq)).toEqual([2, 3]);
        yield* store.checkout(id, third.id);
        const next = yield* store.append(id, custom(4));
        expect(next.parent).toBe(third.id);
        expect(first.parent).toBeNull();
      }),
    );
  });

  it("rejects an unknown parent and unknown checkout target", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        const parent = yield* Effect.flip(store.append(id, custom(1), { parent: "nope" }));
        expect(parent.reason).toBe("InvalidParent");
        expect((yield* Effect.flip(store.checkout(id, "nope"))).reason).toBe("NotFound");
        expect((yield* Effect.flip(store.get("missing"))).reason).toBe("NotFound");
        expect((yield* store.get(id)).lastSeq).toBe(0);
      }),
    );
  });

  it("ignores a torn final line and cuts it before the next append", async () => {
    const id = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        yield* store.append(id, custom(1));
        return id;
      }),
    );
    const [file] = await sessionFiles();
    await fs.appendFile(file!, '{"seq":2,"id":"torn","par');
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.list()).map((info) => info.lastSeq)).toEqual([1]);
        expect((yield* store.events(id)).length).toBe(1);
        const next = yield* store.append(id, custom(2));
        expect(next.seq).toBe(2);
      }),
    );
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.events(id)).map((event) => event.data)).toEqual([custom(1), custom(2)]);
      }),
    );
  });

  it("treats a damaged complete line as Corrupt and skips that session in list with a notice", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        yield* store.create();
        yield* store.create();
      }),
    );
    const [bad] = await sessionFiles();
    await fs.appendFile(bad!, "garbage\n");
    const badId = idOfFile(bad!);
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const events = yield* Events;
        const notices = yield* Effect.fork(Stream.runCollect(Stream.take(events.stream(Notice), 1)));
        yield* Effect.yieldNow();
        const listed = yield* store.list();
        expect(listed.length).toBe(1);
        expect(Chunk.toArray(yield* Fiber.join(notices))[0]!.message).toContain("line 2");
        expect((yield* Effect.flip(store.events(badId))).reason).toBe("Corrupt");
      }),
    );
  });

  it("skips a session with a complete null line in list instead of failing", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        yield* store.create();
        yield* store.create();
      }),
    );
    const [bad] = await sessionFiles();
    await fs.appendFile(bad!, "null\n");
    const badId = idOfFile(bad!);
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.list()).length).toBe(1);
        expect((yield* Effect.flip(store.get(badId))).reason).toBe("Corrupt");
        expect((yield* Effect.flip(store.events(badId))).reason).toBe("Corrupt");
      }),
    );
  });

  it("keeps the file and memory in step when an append is interrupted mid-write", async () => {
    const id = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        const first = yield* Effect.fork(store.append(id, title("first")));
        // Let the append reach the file write, then interrupt it there.
        for (let i = 0; i < 5; i++) yield* Effect.yieldNow();
        yield* Fiber.interrupt(first);
        const next = yield* store.append(id, title("second"));
        const all = yield* store.events(id);
        expect(all.at(-1)).toBe(next);
        expect(next.seq).toBe(all.length);
        return id;
      }),
    );
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const all = yield* store.events(id);
        expect(all.map((event) => event.seq)).toEqual(all.map((_, i) => i + 1));
        expect(all.at(-1)!.data).toEqual(title("second"));
      }),
    );
  });

  it("lists newest first, filters by cwd, takes the latest title, and sees files changed on disk", async () => {
    const [a, b] = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const a = yield* store.create({ cwd: "/p/one" });
        yield* Effect.sleep(5);
        const b = yield* store.create({ cwd: "/p/two" });
        yield* store.append(a.id, title("first"));
        yield* store.append(a.id, title("second"));
        const listed = yield* store.list();
        expect(listed.map((info) => info.id)).toEqual([a.id, b.id]);
        expect(listed[0]!.title).toBe("second");
        expect((yield* store.list({ cwd: "/p/two" })).map((info) => info.id)).toEqual([b.id]);
        return [a, b];
      }),
    );
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.list()).map((info) => info.id)).toEqual([a!.id, b!.id]);
        // Another writer appends to b; the cached info refreshes because the file changed.
        const file = (yield* Effect.promise(sessionFiles)).find((name) => name.includes(b!.id))!;
        const line = { seq: 1, id: "x1", parent: null, at: Date.now() + 1000, data: title("external") };
        yield* Effect.promise(() => fs.appendFile(file, `${JSON.stringify(line)}\n`));
        const listed = yield* store.list();
        expect(listed[0]).toMatchObject({ id: b!.id, title: "external", lastSeq: 1, leaf: "x1" });
      }),
    );
  });

  it("serializes concurrent appends and publishes appended and changed events", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const events = yield* Events;
        const { id } = yield* store.create();
        const appended = yield* Effect.fork(Stream.runCollect(Stream.take(events.stream(SessionAppended), 20)));
        const changed = yield* Effect.fork(Stream.runCollect(Stream.take(events.stream(SessionChanged), 20)));
        yield* Effect.yieldNow();
        yield* Effect.forEach(
          Array.from({ length: 20 }, (_, i) => i),
          (i) => store.append(id, custom(i)),
          { concurrency: "unbounded" },
        );
        const all = yield* store.events(id);
        expect(all.map((event) => event.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
        // Every event's parent is its predecessor: no two appends raced for the same leaf.
        all.slice(1).forEach((event, i) => expect(event.parent).toBe(all[i]!.id));
        expect(Chunk.toArray(yield* Fiber.join(appended)).map((payload) => payload.event.seq)).toEqual(all.map((event) => event.seq));
        expect(Chunk.toArray(yield* Fiber.join(changed)).at(-1)!.info.lastSeq).toBe(20);
      }),
    );
  });
  it("recovers from a failed write: the next append follows the last good line, and the file stays loadable", async () => {
    const probe = await fs.open(path.join(dir, "probe"), "w");
    const FileHandle = Object.getPrototypeOf(probe) as fs.FileHandle;
    await probe.close();
    const appendFile = FileHandle.appendFile;
    const id = await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        const { id } = yield* store.create();
        yield* store.append(id, custom(1));

        // A full disk tears the line: some bytes land, then the write fails.
        vi.spyOn(FileHandle, "appendFile").mockImplementationOnce(async function (this: fs.FileHandle, data) {
          await appendFile.call(this, String(data).slice(0, 10));
          throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
        });
        expect((yield* Effect.flip(store.append(id, custom(2)))).reason).toBe("Io");
        expect((yield* store.append(id, custom(3))).seq).toBe(2);

        // The line lands but is not confirmed durable; the append failed, so its seq is reused.
        vi.spyOn(FileHandle, "datasync").mockRejectedValueOnce(Object.assign(new Error("I/O error"), { code: "EIO" }));
        expect((yield* Effect.flip(store.append(id, custom(4)))).reason).toBe("Io");
        expect((yield* store.append(id, custom(5))).seq).toBe(3);
        return id;
      }),
    );
    await run(
      Effect.gen(function* () {
        const store = yield* Sessions;
        expect((yield* store.events(id)).map((event) => event.data)).toEqual([custom(1), custom(3), custom(5)]);
      }),
    );
  });
});
