import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Duration, Effect, Either, Schema } from "effect";
import { Credential, CredentialError } from "@basis/contracts";

export const StoreFile = Schema.parseJson(Schema.Record({ key: Schema.String, value: Credential }));
export type Store = typeof StoreFile.Type;

/** A lock older than this belongs to a process that died holding it. */
export const LOCK_STALE = Duration.seconds(30);
const LOCK_POLL = Duration.millis(50);

const io = (provider: string, message: string, cause: unknown) =>
  new CredentialError({ provider, reason: "Io", message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`, cause });

const errno = (cause: unknown): string | undefined => (cause as NodeJS.ErrnoException | undefined)?.code;

/** Missing file: empty store. A file that is not valid JSON of the expected shape is an `Io` error, never silently emptied. */
export function readStore(path: string): Effect.Effect<Store, CredentialError> {
  return Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (cause) => cause }).pipe(
    Effect.matchEffect({
      onFailure: (cause) => errno(cause) === "ENOENT" ? Effect.succeed({} as Store) : Effect.fail(io("*", `Cannot read ${path}`, cause)),
      onSuccess: (text) => {
        const decoded = Schema.decodeUnknownEither(StoreFile)(text);
        return Either.isLeft(decoded)
          ? Effect.fail(new CredentialError({ provider: "*", reason: "Io", message: `${path} is not a valid credential store: ${decoded.left.message}`, cause: decoded.left }))
          : Effect.succeed(decoded.right);
      },
    }),
  );
}

/** Temp file plus rename so a reader never sees a partial file; mode 0600 from creation. */
export function writeStore(path: string, store: Store): Effect.Effect<void, CredentialError> {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(temp, Schema.encodeSync(StoreFile)(store), { mode: 0o600 });
      await rename(temp, path);
    },
    catch: (cause) => io("*", `Cannot write ${path}`, cause),
  }).pipe(Effect.onError(() => Effect.promise(() => rm(temp, { force: true }))));
}

/**
 * Serialize read-modify-write across processes with `<path>.lock` created
 * exclusively. Waiting is polled; a stale lock is removed and taken over.
 */
export function withLock<A, E, R>(path: string, body: Effect.Effect<A, E, R>): Effect.Effect<A, E | CredentialError, R> {
  const lock = `${path}.lock`;
  const acquire: Effect.Effect<void, CredentialError> = Effect.gen(function* () {
    yield* Effect.tryPromise({ try: () => mkdir(dirname(path), { recursive: true, mode: 0o700 }), catch: (cause) => io("*", `Cannot create ${dirname(path)}`, cause) });
    while (true) {
      const taken = yield* Effect.tryPromise({
        try: async () => {
          const handle = await open(lock, "wx", 0o600);
          await handle.writeFile(`${process.pid}\n`);
          await handle.close();
        },
        catch: (cause) => cause,
      }).pipe(Effect.either);
      if (Either.isRight(taken)) return;
      if (errno(taken.left) !== "EEXIST") return yield* io("*", `Cannot create ${lock}`, taken.left);
      const age = yield* Effect.tryPromise({ try: () => stat(lock), catch: (cause) => cause }).pipe(
        Effect.map((info) => Date.now() - info.mtimeMs),
        // Vanished between our attempts: the holder released it; try again at once.
        Effect.catchAll(() => Effect.succeed(0)),
      );
      if (age > Duration.toMillis(LOCK_STALE)) {
        yield* Effect.promise(() => rm(lock, { force: true }));
      } else {
        yield* Effect.sleep(LOCK_POLL);
      }
    }
  });
  const release = Effect.promise(() => rm(lock, { force: true }));
  return Effect.acquireUseRelease(acquire, () => body, () => release);
}
