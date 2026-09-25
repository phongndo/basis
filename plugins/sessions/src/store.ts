import { promises as fs } from "node:fs";
import * as path from "node:path";
import { DateTime, Effect, Either } from "effect";
import { SessionEntry, SessionError, SessionInfo } from "@basis/contracts";
import { decodeLine, encodeLine, entryFromRecord, projectKey } from "./format.ts";
import type { HeaderRecord, Record } from "./format.ts";

/** The fold of one file: everything the in-memory index and the header cache need. */
export interface Parsed {
  readonly info: SessionInfo;
  /** File order, which is also insertion order for the index. */
  readonly entries: readonly SessionEntry[];
  /** Skipped lines, one message each, for the caller to surface as a Notice. */
  readonly warnings: readonly string[];
}

export const sessionPath = (root: string, cwd: string, sessionId: string): string =>
  path.join(root, projectKey(cwd), `${sessionId}.jsonl`);

const io = (sessionId: string | undefined, message: string) => (cause: unknown) =>
  new SessionError({ ...(sessionId === undefined ? {} : { sessionId }), reason: "Io", message: `${message}: ${String(cause)}`, cause });

/** Any header failure is `Corrupt`: without it nothing else in the file can be attributed. */
export function readSession(file: string, sessionId: string): Effect.Effect<Parsed, SessionError> {
  return Effect.tryPromise({ try: () => fs.readFile(file, "utf8"), catch: io(sessionId, `Cannot read ${file}`) }).pipe(
    Effect.flatMap((text) => {
      const lines = text.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      const first = lines[0] === undefined ? Either.left("empty file") : decodeLine(lines[0]);
      if (Either.isLeft(first) || first.right.type !== "header") {
        const reason = Either.isLeft(first) ? first.left : `first record is "${first.right.type}"`;
        return Effect.fail(new SessionError({ sessionId, reason: "Corrupt", message: `${file}: header is unreadable (${reason})` }));
      }
      return Effect.succeed(fold(first.right, lines.slice(1), file));
    }),
  );
}

function fold(header: HeaderRecord, lines: readonly string[], file: string): Parsed {
  const entries: SessionEntry[] = [];
  const known = new Set<string>();
  const warnings: string[] = [];
  let leaf: string | undefined;
  let title = header.title;
  let updatedAt = header.updatedAt;
  lines.forEach((line, index) => {
    const decoded = decodeLine(line);
    const lineNumber = index + 2;
    if (Either.isLeft(decoded)) {
      warnings.push(`${file}:${lineNumber}: skipped unreadable line (${decoded.left})`);
      return;
    }
    const record = decoded.right;
    switch (record.type) {
      case "entry": {
        if (record.parent !== null && !known.has(record.parent)) {
          warnings.push(`${file}:${lineNumber}: skipped entry ${record.id} whose parent ${record.parent} is unknown`);
          return;
        }
        const entry = entryFromRecord(record);
        entries.push(entry);
        known.add(entry.id);
        leaf = entry.id;
        if (entry.payload.type === "title") title = entry.payload.title;
        if (DateTime.greaterThan(entry.at, updatedAt)) updatedAt = entry.at;
        return;
      }
      case "leaf":
        if (known.has(record.entryId)) leaf = record.entryId;
        else warnings.push(`${file}:${lineNumber}: skipped leaf move to unknown entry ${record.entryId}`);
        return;
      case "header":
        warnings.push(`${file}:${lineNumber}: skipped a second header`);
    }
  });
  const info = new SessionInfo({
    id: header.id, cwd: header.cwd, createdAt: header.createdAt, updatedAt,
    ...(title === undefined ? {} : { title }),
    ...(leaf === undefined ? {} : { leaf }),
  });
  return { info, entries, warnings };
}

/**
 * An append-only handle on one session file. Each write is flushed to the
 * device before the Effect completes, so a returned append is durable.
 */
export interface SessionFile {
  readonly append: (record: Record) => Effect.Effect<void, SessionError>;
  readonly close: Effect.Effect<void>;
}

export function openSessionFile(file: string, sessionId: string): Effect.Effect<SessionFile, SessionError> {
  return Effect.tryPromise({
    try: async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      return fs.open(file, "a");
    },
    catch: io(sessionId, `Cannot open ${file}`),
  }).pipe(Effect.map((handle) => ({
    append: (record) => Effect.tryPromise({
      try: async () => {
        await handle.appendFile(encodeLine(record));
        await handle.datasync();
      },
      catch: io(sessionId, `Cannot write ${file}`),
    }),
    close: Effect.promise(() => handle.close()).pipe(Effect.ignore),
  })));
}

/** Session ids in a project directory (or every project when `cwd` is absent); a missing root is empty. */
export function listFiles(root: string, cwd?: string): Effect.Effect<readonly { readonly file: string; readonly sessionId: string }[], SessionError> {
  const missing = (error: unknown) => typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
  const projects = cwd === undefined
    ? Effect.tryPromise({ try: () => fs.readdir(root), catch: io(undefined, `Cannot list ${root}`) })
    : Effect.succeed([projectKey(cwd)]);
  return projects.pipe(
    Effect.flatMap((keys) => Effect.forEach(keys, (key) => Effect.tryPromise({
      try: () => fs.readdir(path.join(root, key)),
      catch: io(undefined, `Cannot list ${path.join(root, key)}`),
    }).pipe(
      Effect.map((names) => names.filter((name) => name.endsWith(".jsonl"))
        .map((name) => ({ file: path.join(root, key, name), sessionId: name.slice(0, -".jsonl".length) }))),
      Effect.catchIf((error) => missing(error.cause), () => Effect.succeed([])),
    ))),
    Effect.map((groups) => groups.flat()),
    Effect.catchIf((error) => missing(error.cause), () => Effect.succeed([])),
  );
}
