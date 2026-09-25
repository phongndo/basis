import { randomUUID } from "node:crypto";
import { DateTime, Effect, Option, Stream } from "effect";
import type { Context, Scope } from "effect";
import { Events } from "@basis/core";
import { Notice, Paths, SessionAppended, SessionChanged, SessionEntry, SessionError, SessionInfo, Sessions } from "@basis/contracts";
import type { EntryPayload } from "@basis/contracts";
import { listFiles, openSessionFile, readSession, sessionPath } from "./store.ts";
import type { SessionFile } from "./store.ts";

interface Index {
  readonly entries: Map<string, SessionEntry>;
  readonly children: Map<string | null, string[]>;
}

/** One known session. `info` is always current; the index and file handle are built on first use. */
interface Session {
  readonly id: string;
  readonly file: string;
  /** Serializes writes and the leaf update they imply. */
  readonly lock: Effect.Semaphore;
  info: SessionInfo;
  index?: Index;
  handle?: SessionFile;
}

type Opened = Session & { readonly index: Index };

const notFound = (sessionId: string, message: string) => new SessionError({ sessionId, reason: "NotFound", message });

function addToIndex(index: Index, entry: SessionEntry): void {
  index.entries.set(entry.id, entry);
  const siblings = index.children.get(entry.parent);
  if (siblings) siblings.push(entry.id);
  else index.children.set(entry.parent, [entry.id]);
}

/** Leaf to root, cut at the nearest compaction (kept), returned root first. */
function contextPath(index: Index, leaf: string | undefined): SessionEntry[] {
  const path: SessionEntry[] = [];
  for (let id = leaf; id !== undefined;) {
    const entry = index.entries.get(id);
    if (entry === undefined) break;
    path.push(entry);
    if (entry.payload.type === "compaction") break;
    id = entry.parent ?? undefined;
  }
  return path.reverse();
}

export const make: Effect.Effect<Context.Tag.Service<Sessions>, never, Paths | Events | Scope.Scope> = Effect.gen(function* () {
  const paths = yield* Paths;
  const events = yield* Events;
  const sessions = new Map<string, Session>();
  // Guards the map and index construction so a session is parsed at most once.
  const registry = yield* Effect.makeSemaphore(1);
  yield* Effect.addFinalizer(() => Effect.forEach(sessions.values(), (session) => session.handle?.close ?? Effect.void, { discard: true }));

  const warn = (messages: readonly string[]) =>
    Effect.forEach(messages, (message) => events.publish(Notice, { level: "warning", message, source: "sessions" }), { discard: true });

  const remember = (id: string, file: string, info: SessionInfo, entries?: readonly SessionEntry[]) =>
    Effect.map(Effect.makeSemaphore(1), (lock) => {
      const session: Session = { id, file, lock, info };
      if (entries !== undefined) {
        const index: Index = { entries: new Map(), children: new Map() };
        for (const entry of entries) addToIndex(index, entry);
        session.index = index;
      }
      sessions.set(id, session);
      return session;
    });

  /** Find the file for an id not seen yet: any project directory may hold it. */
  const locate = (id: string): Effect.Effect<Session, SessionError> => registry.withPermits(1)(Effect.gen(function* () {
    const known = sessions.get(id);
    if (known) return known;
    const found = (yield* listFiles(paths.sessions)).find((candidate) => candidate.sessionId === id);
    if (!found) return yield* notFound(id, `Session ${id} does not exist`);
    const parsed = yield* readSession(found.file, id);
    yield* warn(parsed.warnings);
    return yield* remember(id, found.file, parsed.info, parsed.entries);
  }));

  const open = (id: string): Effect.Effect<Opened, SessionError> => Effect.gen(function* () {
    const session = yield* locate(id);
    if (session.index !== undefined) return session as Opened;
    return yield* registry.withPermits(1)(Effect.gen(function* () {
      if (session.index !== undefined) return session as Opened;
      const parsed = yield* readSession(session.file, id);
      yield* warn(parsed.warnings);
      const index: Index = { entries: new Map(), children: new Map() };
      for (const entry of parsed.entries) addToIndex(index, entry);
      session.info = parsed.info;
      session.index = index;
      return session as Opened;
    }));
  });

  const fileOf = (session: Session): Effect.Effect<SessionFile, SessionError> =>
    session.handle === undefined
      ? Effect.tap(openSessionFile(session.file, session.id), (handle) => Effect.sync(() => { session.handle = handle; }))
      : Effect.succeed(session.handle);

  const changed = (session: Session) => events.publish(SessionChanged, { sessionId: session.id, info: session.info });

  const create: Context.Tag.Service<Sessions>["create"] = (cwd) => Effect.gen(function* () {
    const id = randomUUID();
    const now = yield* DateTime.now;
    const info = new SessionInfo({ id, cwd, createdAt: now, updatedAt: now });
    const session = yield* remember(id, sessionPath(paths.sessions, cwd, id), info, []);
    const file = yield* fileOf(session);
    yield* file.append({ type: "header", id, cwd, createdAt: now, updatedAt: now });
    yield* changed(session);
    return info;
  });

  const append: Context.Tag.Service<Sessions>["append"] = (sessionId, payload, options) => Effect.gen(function* () {
    const session = yield* open(sessionId);
    return yield* session.lock.withPermits(1)(Effect.gen(function* () {
      const parent = options?.parent ?? session.info.leaf ?? null;
      if (parent !== null && !session.index.entries.has(parent)) {
        return yield* notFound(sessionId, `Entry ${parent} does not exist in session ${sessionId}`);
      }
      const entry = new SessionEntry({ id: randomUUID(), parent, at: yield* DateTime.now, payload });
      const file = yield* fileOf(session);
      yield* file.append({ type: "entry", id: entry.id, parent: entry.parent, at: entry.at, payload: entry.payload });
      addToIndex(session.index, entry);
      session.info = new SessionInfo({
        ...session.info, leaf: entry.id, updatedAt: entry.at,
        ...(payload.type === "title" ? { title: payload.title } : {}),
      });
      yield* events.publish(SessionAppended, { sessionId, entry });
      yield* changed(session);
      return entry;
    }));
  });

  const checkout: Context.Tag.Service<Sessions>["checkout"] = (sessionId, entryId) => Effect.gen(function* () {
    const session = yield* open(sessionId);
    return yield* session.lock.withPermits(1)(Effect.gen(function* () {
      if (!session.index.entries.has(entryId)) {
        return yield* notFound(sessionId, `Entry ${entryId} does not exist in session ${sessionId}`);
      }
      const file = yield* fileOf(session);
      yield* file.append({ type: "leaf", entryId });
      session.info = new SessionInfo({ ...session.info, leaf: entryId });
      yield* changed(session);
      return session.info;
    }));
  });

  const list: Context.Tag.Service<Sessions>["list"] = (options) => registry.withPermits(1)(Effect.gen(function* () {
    const files = yield* listFiles(paths.sessions, options?.cwd);
    const infos: SessionInfo[] = [];
    for (const { file, sessionId } of files) {
      const known = sessions.get(sessionId);
      if (known) {
        infos.push(known.info);
        continue;
      }
      // Headers are cached without an index; a session that cannot be read is reported, not fatal.
      const parsed = yield* readSession(file, sessionId).pipe(Effect.map(Option.some), Effect.catchAll((error) => Effect.as(warn([error.message]), Option.none())));
      if (Option.isNone(parsed)) continue;
      yield* warn(parsed.value.warnings);
      infos.push((yield* remember(sessionId, file, parsed.value.info)).info);
    }
    return infos
      .filter((info) => options?.cwd === undefined || info.cwd === options.cwd)
      .sort((a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt));
  }));

  return Sessions.of({
    create,
    get: (sessionId) => Effect.map(locate(sessionId), (session) => session.info),
    list,
    append,
    context: (sessionId) => Effect.map(open(sessionId), (session) => contextPath(session.index, session.info.leaf)),
    entries: (sessionId) => Stream.unwrap(Effect.map(open(sessionId), (session) => Stream.fromIterable([...session.index.entries.values()]))),
    checkout,
    setTitle: (sessionId, title) => Effect.flatMap(append(sessionId, { type: "title", title }), () => Effect.map(locate(sessionId), (session) => session.info)),
  });
});
