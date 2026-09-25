import { Duration, Effect, Layer, Option } from "effect";
import type { Context } from "effect";
import { CredentialError, Credentials, Interaction, Paths } from "@basis/contracts";
import type { AuthMethod, Credential, InteractionError } from "@basis/contracts";
import { definePlugin } from "@basis/core";
import { readStore, withLock, writeStore } from "./store.ts";

export { LOCK_STALE, readStore, withLock, writeStore } from "./store.ts";

/** Convention: `anthropic` → `ANTHROPIC_API_KEY`, `my-provider` → `MY_PROVIDER_API_KEY`. */
export const envVariable = (provider: string): string => `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;

/** Refresh OAuth credentials this close to expiry, so a token never expires mid-request. */
export const REFRESH_WINDOW = Duration.minutes(5);
/** Command output is reused this long; secrets managers are slow and often prompt. */
export const COMMAND_CACHE = Duration.seconds(60);

const API_KEY_METHOD = "api-key";
/** Provider id of the generic `api-key` entry in `methods`: it applies to any provider. */
export const ANY_PROVIDER = "*";

type OAuth = Extract<Credential, { type: "oauth" }>;
type Service = Context.Tag.Service<Credentials>;

/**
 * Resolution order: environment variable, then `auth.json`. `command`
 * credentials run the command and cache its output; OAuth credentials are
 * refreshed under the store lock by the provider's registered method. Login
 * flows are `AuthMethod`s that provider plugins register; the built-in
 * `api-key` method asks for the key and exists for every provider.
 */
export default definePlugin({
  id: "credentials",
  provides: [Credentials],
  requires: [Paths, Interaction],
  layer: Layer.effect(Credentials, Effect.gen(function* () {
    const paths = yield* Paths;
    const interaction = yield* Interaction;
    const path = paths.auth;
    const methods = new Map<string, AuthMethod>();
    const commandCache = new Map<string, { readonly command: string; readonly key: string; readonly until: number }>();

    const apiKeyMethod = (provider: string): AuthMethod => ({
      provider, id: API_KEY_METHOD, label: "API key",
      login: (ui) => ui.ask(`API key for ${provider}`, { secret: true }).pipe(
        Effect.map((key) => key.trim()),
        Effect.mapError((error: InteractionError) => new CredentialError({ provider, reason: "LoginFailed", message: `Key entry ${error.reason.toLowerCase()}: ${error.message}`, cause: error })),
        Effect.filterOrFail((key) => key.length > 0, () => new CredentialError({ provider, reason: "LoginFailed", message: "No key was entered" })),
        Effect.map((key): Credential => ({ type: "api-key", key })),
      ),
    });

    const runCommand = (provider: string, command: string): Effect.Effect<Credential, CredentialError> => {
      const cached = commandCache.get(provider);
      if (cached && cached.command === command && cached.until > Date.now()) return Effect.succeed({ type: "api-key", key: cached.key });
      return Effect.tryPromise({
        try: async () => {
          const child = Bun.spawn(["sh", "-c", command], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
          const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
          return { stdout, stderr, code };
        },
        catch: (cause) => new CredentialError({ provider, reason: "Io", message: `Cannot run credential command: ${String(cause)}`, cause }),
      }).pipe(
        Effect.flatMap(({ stdout, stderr, code }) => {
          const key = stdout.trim();
          if (code !== 0) return Effect.fail(new CredentialError({ provider, reason: "Io", message: `Credential command exited with ${code}: ${stderr.trim()}` }));
          if (!key) return Effect.fail(new CredentialError({ provider, reason: "NotFound", message: "Credential command printed nothing" }));
          commandCache.set(provider, { command, key, until: Date.now() + Duration.toMillis(COMMAND_CACHE) });
          return Effect.succeed<Credential>({ type: "api-key", key });
        }),
      );
    };

    const nearExpiry = (credential: OAuth) => credential.expiresAt - Date.now() <= Duration.toMillis(REFRESH_WINDOW);

    // Re-read under the lock: another process may have refreshed since our read.
    const refresh = (provider: string): Effect.Effect<Credential, CredentialError> => withLock(path, Effect.gen(function* () {
      const store = yield* readStore(path);
      const current = store[provider];
      if (current === undefined) return yield* new CredentialError({ provider, reason: "NotFound", message: `Credential for "${provider}" was removed while refreshing` });
      if (current.type !== "oauth" || !nearExpiry(current)) return current;
      const method = [...methods.values()].find((candidate) => candidate.provider === provider && candidate.refresh !== undefined);
      if (method?.refresh === undefined) {
        return yield* new CredentialError({ provider, reason: "RefreshFailed", message: `The OAuth credential for "${provider}" is expiring and no registered method can refresh it`, cause: undefined });
      }
      const refreshed = yield* method.refresh(current).pipe(
        Effect.mapError((error) => error.reason === "RefreshFailed" ? error : new CredentialError({ provider, reason: "RefreshFailed", message: `Refresh failed: ${error.message}`, cause: error })),
      );
      yield* writeStore(path, { ...store, [provider]: refreshed });
      return refreshed;
    }));

    const resolve: Service["resolve"] = (provider) => Effect.gen(function* () {
      const fromEnv = process.env[envVariable(provider)]?.trim();
      if (fromEnv) return Option.some<Credential>({ type: "api-key", key: fromEnv });
      const stored = (yield* readStore(path))[provider];
      if (stored === undefined) return Option.none();
      switch (stored.type) {
        case "api-key": return Option.some(stored);
        case "command": return Option.some(yield* runCommand(provider, stored.command));
        case "oauth": return Option.some(nearExpiry(stored) ? yield* refresh(provider) : stored);
      }
    });

    const update = (provider: string, change: (store: Record<string, Credential>) => Record<string, Credential>) =>
      withLock(path, Effect.flatMap(readStore(path), (store) => writeStore(path, change(store))));

    const login: Service["login"] = (provider, methodId) => Effect.gen(function* () {
      const method = methods.get(`${provider}/${methodId}`) ?? (methodId === API_KEY_METHOD ? apiKeyMethod(provider) : undefined);
      if (method === undefined) return yield* new CredentialError({ provider, reason: "NotFound", message: `No login method "${methodId}" for "${provider}"` });
      const credential = yield* method.login(interaction);
      yield* update(provider, (store) => ({ ...store, [provider]: credential }));
      commandCache.delete(provider);
      return credential;
    });

    return {
      resolve,
      set: (provider, credential) => update(provider, (store) => ({ ...store, [provider]: credential })).pipe(Effect.tap(() => Effect.sync(() => commandCache.delete(provider)))),
      remove: (provider) => update(provider, ({ [provider]: _, ...rest }) => rest).pipe(Effect.tap(() => Effect.sync(() => commandCache.delete(provider)))),
      list: Effect.map(readStore(path), (store) => Object.entries(store).map(([provider, credential]) => ({ provider, type: credential.type }))),
      registerMethod: (method) => Effect.acquireRelease(
        Effect.sync(() => { methods.set(`${method.provider}/${method.id}`, method); }),
        () => Effect.sync(() => { if (methods.get(`${method.provider}/${method.id}`) === method) methods.delete(`${method.provider}/${method.id}`); }),
      ),
      methods: Effect.sync(() => {
        const listed = [...methods.values()].map(({ provider, id, label }) => ({ provider, id, label }));
        for (const provider of new Set(listed.map((method) => method.provider))) {
          if (!methods.has(`${provider}/${API_KEY_METHOD}`)) listed.push({ provider, id: API_KEY_METHOD, label: "API key" });
        }
        listed.push({ provider: ANY_PROVIDER, id: API_KEY_METHOD, label: "API key" });
        return listed;
      }),
      login,
    };
  })),
});
