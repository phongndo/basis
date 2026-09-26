import { createHash } from "node:crypto";
import { Either, Schema } from "effect";
import { SessionEntry, SessionInfo } from "@basis/contracts";

/**
 * One JSONL file per session. The first line is the header; every later line
 * is an entry or a leaf move. The file is never rewritten: a title change is a
 * `title` entry, a checkout is a `leaf` record, and the current state is the
 * fold of the file in order. Dates are encoded through the contract schemas so
 * the on-disk form matches what crosses the transport.
 */
const { leaf: _leaf, ...headerFields } = SessionInfo.fields;
export const HeaderRecord = Schema.Struct({ type: Schema.Literal("header"), ...headerFields });
export const EntryRecord = Schema.Struct({ type: Schema.Literal("entry"), ...SessionEntry.fields });
export const LeafRecord = Schema.Struct({ type: Schema.Literal("leaf"), entryId: Schema.String });
export const Record = Schema.Union(HeaderRecord, EntryRecord, LeafRecord);
export type Record = typeof Record.Type;
export type HeaderRecord = typeof HeaderRecord.Type;

const encode = Schema.encodeSync(Record);
const decode = Schema.decodeUnknownEither(Record);

export const encodeLine = (record: Record): string => `${JSON.stringify(encode(record))}\n`;

/** Left carries a one-line reason; the caller decides whether that line is skippable. */
export function decodeLine(line: string): Either.Either<Record, string> {
  return Either.try({ try: () => JSON.parse(line) as unknown, catch: () => "not JSON" }).pipe(
    Either.flatMap((json) => Either.mapLeft(decode(json), (error) => error.message.split("\n")[0] ?? "invalid record")),
  );
}

export const entryFromRecord = (record: typeof EntryRecord.Type): SessionEntry =>
  new SessionEntry({ id: record.id, parent: record.parent, at: record.at, payload: record.payload });

/**
 * Directory name for a working directory: a readable tail of the path plus a
 * short hash so distinct paths that sanitize alike stay apart.
 */
export function projectKey(cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  const name = cwd.replace(/[^A-Za-z0-9._-]+/g, "-").slice(-48).replace(/^-+|-+$/g, "");
  return `${name === "" ? "root" : name}-${hash}`;
}
