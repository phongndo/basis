import { Effect, Layer } from "effect";
import { CredentialError, Credentials, Paths } from "@lemma/contracts";
import type { Credential } from "@lemma/contracts";
import { definePlugin } from "@lemma/core";
import { decodeEntry, readStore, withFileLock, writeStore } from "./store.ts";

export { decodeEntry, readStore, withFileLock, writeStore } from "./store.ts";
export type { LockOptions, RawStore } from "./store.ts";

/**
 * `auth.json` at `Paths.auth`. Reads take no lock (writes are atomic renames).
 * Writes serialize per provider in-process, then take the file lock and re-read
 * the file, so another process's change is never overwritten. Only the entry
 * being changed is replaced; every other entry is written back verbatim.
 */
export default definePlugin({
  id: "credentials",
  version: "0.1.0",
  provides: [Credentials],
  requires: [Paths],
  layer: Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const path = (yield* Paths).auth;
      const semaphores = new Map<string, Effect.Semaphore>();
      const serialized = <A, E>(provider: string, body: Effect.Effect<A, E>): Effect.Effect<A, E | CredentialError> =>
        Effect.suspend(() => {
          let semaphore = semaphores.get(provider);
          if (semaphore === undefined) {
            semaphore = Effect.unsafeMakeSemaphore(1);
            semaphores.set(provider, semaphore);
          }
          return semaphore.withPermits(1)(withFileLock(path, body));
        });

      const withProvider = (provider: string) => (error: CredentialError) =>
        error.provider !== undefined
          ? error
          : new CredentialError({
              provider,
              reason: error.reason,
              message: error.message,
              ...(error.cause === undefined ? {} : { cause: error.cause }),
            });

      const modify = <E>(provider: string, update: (current: Credential | undefined) => Effect.Effect<Credential | undefined, E>) =>
        serialized(
          provider,
          Effect.gen(function* () {
            const store = yield* readStore(path);
            const current = yield* decodeEntry(path, store, provider);
            const next = yield* update(current);
            if (next === undefined) return current;
            yield* writeStore(path, { ...store, [provider]: next });
            return next;
          }),
        ).pipe(Effect.mapError((error) => (error instanceof CredentialError ? withProvider(provider)(error) : error)));

      return {
        read: (provider) =>
          readStore(path).pipe(
            Effect.flatMap((store) => decodeEntry(path, store, provider)),
            Effect.mapError(withProvider(provider)),
          ),
        list: Effect.flatMap(readStore(path), (store) =>
          Effect.forEach(Object.keys(store), (provider) =>
            Effect.map(decodeEntry(path, store, provider), (credential) => ({ provider, type: credential!.type })),
          ),
        ),
        modify,
        remove: (provider) =>
          serialized(
            provider,
            Effect.gen(function* () {
              const store = yield* readStore(path);
              if (!Object.hasOwn(store, provider)) return;
              const { [provider]: _, ...rest } = store;
              yield* writeStore(path, rest);
            }),
          ).pipe(Effect.mapError(withProvider(provider))),
      };
    }),
  ),
});
