import { Context, Data, Schema } from "effect";
import type { Effect, Stream } from "effect";
import { Event } from "@basis/core";
import { Message, Usage } from "./llm.ts";

/**
 * A session is an append-only tree of entries (pi's model): each entry names
 * its parent, so branching is a new child of an older entry and the file is
 * never rewritten. The current leaf defines what the model sees.
 */
export class SessionInfo extends Schema.Class<SessionInfo>("basis/SessionInfo")({
  id: Schema.String,
  cwd: Schema.String,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  title: Schema.optional(Schema.String),
  /** Id of the entry the next append will follow. */
  leaf: Schema.optional(Schema.String),
}) {}

export const EntryPayload = Schema.Union(
  Schema.Struct({ type: Schema.Literal("message"), message: Message, usage: Schema.optional(Usage), model: Schema.optional(Schema.String) }),
  /** Replaces everything before it in the model's view; the originals stay in the file. */
  Schema.Struct({ type: Schema.Literal("compaction"), summary: Schema.String, tokensBefore: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("title"), title: Schema.String }),
  /** Plugin-owned data; `kind` is namespaced by the plugin id. */
  Schema.Struct({ type: Schema.Literal("custom"), kind: Schema.String, data: Schema.Unknown }),
);
export type EntryPayload = typeof EntryPayload.Type;

export class SessionEntry extends Schema.Class<SessionEntry>("basis/SessionEntry")({
  id: Schema.String,
  parent: Schema.NullOr(Schema.String),
  at: Schema.DateTimeUtc,
  payload: EntryPayload,
}) {}

export class SessionError extends Data.TaggedError("SessionError")<{
  readonly sessionId?: string;
  readonly reason: "NotFound" | "Corrupt" | "Io";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const SessionAppended = Event.make<{ readonly sessionId: string; readonly entry: SessionEntry }>("basis/session.appended");
export const SessionChanged = Event.make<{ readonly sessionId: string; readonly info: SessionInfo }>("basis/session.changed");

export class Sessions extends Context.Tag("basis/Sessions")<Sessions, {
  readonly create: (cwd: string) => Effect.Effect<SessionInfo, SessionError>;
  readonly get: (sessionId: string) => Effect.Effect<SessionInfo, SessionError>;
  readonly list: (options?: { readonly cwd?: string }) => Effect.Effect<readonly SessionInfo[], SessionError>;
  /** Appends after the current leaf (or `parent` when given) and moves the leaf. Durable before it returns. */
  readonly append: (sessionId: string, payload: EntryPayload, options?: { readonly parent?: string }) => Effect.Effect<SessionEntry, SessionError>;
  /** Root-to-leaf path the model sees, honoring compaction. */
  readonly context: (sessionId: string) => Effect.Effect<readonly SessionEntry[], SessionError>;
  /** Every entry in the file, for trees and UIs. */
  readonly entries: (sessionId: string) => Stream.Stream<SessionEntry, SessionError>;
  /** Point the leaf at another entry; later appends branch from there. */
  readonly checkout: (sessionId: string, entryId: string) => Effect.Effect<SessionInfo, SessionError>;
  readonly setTitle: (sessionId: string, title: string) => Effect.Effect<SessionInfo, SessionError>;
}>() {}
