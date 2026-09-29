import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { Either, Schema } from "effect";
import { SessionEvent } from "@basis/contracts";

/**
 * One JSONL file per session. Line 1 is the header; every later line is a
 * `SessionEvent` or a checkout record. Events have no top-level `type`, so the
 * two kinds of line cannot be confused. The file is only ever appended to,
 * except that a torn final line (a crash mid-write) is cut off before the next
 * append.
 */
export const Header = Schema.Struct({
  type: Schema.Literal("session"),
  version: Schema.Literal(1),
  id: Schema.String,
  cwd: Schema.String,
  createdAt: Schema.Number,
});
export type Header = typeof Header.Type;

/** Moves the leaf; written by `checkout` so a reopened session resumes where it was. */
export const Checkout = Schema.Struct({
  type: Schema.Literal("checkout"),
  leaf: Schema.String,
  at: Schema.Number,
});
export type Checkout = typeof Checkout.Type;

export type Line = Header | Checkout | SessionEvent;

const decodeHeader = Schema.decodeUnknownEither(Header);
const decodeCheckout = Schema.decodeUnknownEither(Checkout);
const decodeEvent = Schema.decodeUnknownEither(SessionEvent);

export const encodeLine = (line: Line): string => `${JSON.stringify(line)}\n`;

const firstLine = (message: string) => message.split("\n")[0] ?? message;

/** Parses one line. Left carries a one-line reason. */
export function decodeLine(text: string, header: boolean): Either.Either<Line, string> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return Either.left("not JSON");
  }
  if (header) return Either.mapLeft(decodeHeader(json), (error) => firstLine(error.message));
  const type = typeof json === "object" && json !== null ? (json as { type?: unknown }).type : undefined;
  return type === "checkout"
    ? Either.mapLeft(decodeCheckout(json), (error) => firstLine(error.message))
    : Either.mapLeft(decodeEvent(json), (error) => firstLine(error.message));
}

/** Short, url-safe, random. 72 bits for sessions (global), 48 bits for events (per session, collisions retried). */
export const sessionId = (): string => randomBytes(9).toString("base64url");
export const eventId = (): string => randomBytes(6).toString("base64url");

/** Directory for a working directory, pi-style: `/home/me/app` → `--home-me-app--`. The header's `cwd` stays authoritative. */
export const encodeCwd = (cwd: string): string => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

export const fileName = (createdAt: number, id: string): string => `${new Date(createdAt).toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`;

/** Session id from a file name, or undefined for files that are not sessions. */
export function idFromFileName(name: string): string | undefined {
  const match = /_([A-Za-z0-9_-]+)\.jsonl$/.exec(name);
  return match?.[1];
}

export const sessionFile = (root: string, cwd: string, createdAt: number, id: string): string => path.join(root, encodeCwd(cwd), fileName(createdAt, id));
