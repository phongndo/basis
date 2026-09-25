import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect, Fiber, Layer, Option } from "effect";
import type { Scope } from "effect";
import { CredentialError, Credentials, Interaction, InteractionError, Paths } from "@basis/contracts";
import type { AuthMethod, Credential } from "@basis/contracts";
import { definePlugin, makeCore } from "@basis/core";
import credentials from "../src/index.ts";

let root: string;
let auth: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "basis-credentials-"));
  auth = join(root, "home", "auth.json");
  await mkdir(join(root, "home"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** Paths pointing into the temp directory; the credentials plugin only uses `auth`. */
const pathsPlugin = () => definePlugin({
  id: "paths", provides: [Paths],
  layer: Layer.sync(Paths, () => ({ home: join(root, "home"), userConfig: "", projectConfig: "", auth, sessions: "", cwd: root })),
});

/** An Interaction that answers `ask` with a scripted value and refuses everything else. */
const interactionPlugin = (answers: readonly string[]) => {
  const queue = [...answers];
  const refuse = Effect.fail(new InteractionError({ reason: "Unavailable", message: "not scripted" }));
  return definePlugin({
    id: "interaction", provides: [Interaction],
    layer: Layer.succeed(Interaction, {
      ask: () => queue.length ? Effect.succeed(queue.shift()!) : refuse,
      confirm: () => refuse, select: () => refuse, openUrl: () => refuse, notify: () => Effect.void,
    }),
  });
};

const run = <A, E>(body: Effect.Effect<A, E, Credentials | Scope.Scope>, answers: readonly string[] = []) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(makeCore([pathsPlugin(), interactionPlugin(answers), credentials]), (core) => core.run(Effect.scoped(body)))));

const stored = async (): Promise<Record<string, Credential>> => JSON.parse(await readFile(auth, "utf8"));

describe("credentials", () => {
  test("environment variables take precedence over the store, by convention name", async () => {
    process.env.MY_PROVIDER_API_KEY = "  from-env  ";
    try {
      await run(Effect.gen(function* () {
        const service = yield* Credentials;
        yield* service.set("my-provider", { type: "api-key", key: "from-store" });
        expect(yield* service.resolve("my-provider")).toEqual(Option.some({ type: "api-key", key: "from-env" }));
        expect(yield* service.resolve("other")).toEqual(Option.none());
      }));
    } finally {
      delete process.env.MY_PROVIDER_API_KEY;
    }
  });

  test("writes the store atomically with mode 0600 and lists what it holds", async () => {
    await run(Effect.gen(function* () {
      const service = yield* Credentials;
      yield* service.set("anthropic", { type: "api-key", key: "sk-1" });
      yield* service.set("openai", { type: "command", command: "echo sk-2" });
      expect((yield* service.list).map((entry) => `${entry.provider}:${entry.type}`).sort()).toEqual(["anthropic:api-key", "openai:command"]);
      yield* service.remove("openai");
      expect(yield* service.list).toEqual([{ provider: "anthropic", type: "api-key" }]);
      expect(yield* service.resolve("anthropic")).toEqual(Option.some({ type: "api-key", key: "sk-1" }));
    }));
    expect((await stat(auth)).mode & 0o777).toBe(0o600);
    expect(await stored()).toEqual({ anthropic: { type: "api-key", key: "sk-1" } });
    // No temp files or lock left behind.
    expect(await readdir(join(root, "home"))).toEqual(["auth.json"]);
  });

  test("a corrupt store is an Io error, not an empty store", async () => {
    await writeFile(auth, "{ not json", { mode: 0o600 });
    const error = await run(Effect.flatMap(Credentials, (service) => service.list).pipe(Effect.flip));
    expect(error).toBeInstanceOf(CredentialError);
    expect(error.reason).toBe("Io");
    expect(error.message).toContain(auth);
  });

  test("waits for a live lock and takes over a stale one", async () => {
    const lock = `${auth}.lock`;
    await writeFile(lock, "12345\n", { mode: 0o600 });
    await run(Effect.gen(function* () {
      const service = yield* Credentials;
      const write = yield* Effect.fork(service.set("p", { type: "api-key", key: "k" }));
      yield* Effect.sleep(Duration.millis(150));
      // Still blocked by the fresh lock.
      expect(yield* Fiber.poll(write)).toEqual(Option.none());
      yield* Effect.promise(() => rm(lock));
      yield* Fiber.join(write);
      expect(yield* service.resolve("p")).toEqual(Option.some({ type: "api-key", key: "k" }));

      // A lock older than the stale limit is removed and the write proceeds at once.
      yield* Effect.promise(async () => {
        await writeFile(lock, "12345\n", { mode: 0o600 });
        const old = new Date(Date.now() - 60_000);
        await utimes(lock, old, old);
      });
      yield* service.set("q", { type: "api-key", key: "k2" }).pipe(Effect.timeout(Duration.seconds(2)));
      expect(yield* service.list).toHaveLength(2);
    }));
    expect(await readdir(join(root, "home"))).toEqual(["auth.json"]);
  });

  test("command credentials run the command and cache its output", async () => {
    const counter = join(root, "runs");
    await run(Effect.gen(function* () {
      const service = yield* Credentials;
      yield* service.set("vault", { type: "command", command: `echo run >> "${counter}" && printf '  sk-from-command\\n'` });
      expect(yield* service.resolve("vault")).toEqual(Option.some({ type: "api-key", key: "sk-from-command" }));
      expect(yield* service.resolve("vault")).toEqual(Option.some({ type: "api-key", key: "sk-from-command" }));
      expect((yield* Effect.promise(() => readFile(counter, "utf8"))).trim().split("\n")).toHaveLength(1);

      // Changing the stored command invalidates the cache; a failing command is an Io error with its stderr.
      yield* service.set("vault", { type: "command", command: "echo nope >&2; exit 3" });
      const error = yield* service.resolve("vault").pipe(Effect.flip);
      expect(error).toMatchObject({ provider: "vault", reason: "Io" });
      expect(error.message).toContain("nope");
    }));
  });

  test("refreshes an expiring OAuth credential under the lock through the registered method", async () => {
    const fresh: Credential = { type: "oauth", access: "a2", refresh: "r2", expiresAt: Date.now() + 3_600_000 };
    const refreshes: string[] = [];
    const method: AuthMethod = {
      provider: "acme", id: "device", label: "Device code",
      login: () => Effect.succeed(fresh),
      refresh: (credential) => { refreshes.push(credential.refresh); return Effect.succeed(fresh); },
    };
    await run(Effect.gen(function* () {
      const service = yield* Credentials;
      yield* service.registerMethod(method);
      const valid: Credential = { type: "oauth", access: "a0", refresh: "r0", expiresAt: Date.now() + 3_600_000 };
      yield* service.set("acme", valid);
      expect(yield* service.resolve("acme")).toEqual(Option.some(valid));
      expect(refreshes).toEqual([]);

      yield* service.set("acme", { type: "oauth", access: "a1", refresh: "r1", expiresAt: Date.now() + 60_000 });
      expect(yield* service.resolve("acme")).toEqual(Option.some(fresh));
      expect(refreshes).toEqual(["r1"]);
      expect((yield* Effect.promise(stored)).acme).toEqual(fresh);
      // The stored credential is fresh now; no second refresh.
      expect(yield* service.resolve("acme")).toEqual(Option.some(fresh));
      expect(refreshes).toEqual(["r1"]);
    }));
    expect(await readdir(join(root, "home"))).toEqual(["auth.json"]);
  });

  test("a failed or impossible refresh is RefreshFailed and leaves the store untouched", async () => {
    const expiring: Credential = { type: "oauth", access: "a1", refresh: "r1", expiresAt: Date.now() + 60_000 };
    await run(Effect.gen(function* () {
      const service = yield* Credentials;
      yield* service.set("acme", expiring);
      const noMethod = yield* service.resolve("acme").pipe(Effect.flip);
      expect(noMethod).toMatchObject({ provider: "acme", reason: "RefreshFailed" });

      yield* Effect.scoped(Effect.gen(function* () {
        yield* service.registerMethod({
          provider: "acme", id: "device", label: "Device code",
          login: () => Effect.fail(new CredentialError({ provider: "acme", reason: "LoginFailed", message: "no" })),
          refresh: () => Effect.fail(new CredentialError({ provider: "acme", reason: "Io", message: "network down" })),
        });
        const failed = yield* service.resolve("acme").pipe(Effect.flip);
        expect(failed).toMatchObject({ provider: "acme", reason: "RefreshFailed" });
        expect(failed.message).toContain("network down");
      }));
      // The method registration ended with its scope.
      expect((yield* service.methods).some((entry) => entry.provider === "acme")).toBe(false);
    }));
    expect((await stored()).acme).toEqual(expiring);
  });

  test("login runs a method with the Interaction service and stores the result; api-key is built in", async () => {
    await run(Effect.gen(function* () {
      const service = yield* Credentials;
      expect(yield* service.methods).toEqual([{ provider: "*", id: "api-key", label: "API key" }]);
      yield* service.registerMethod({ provider: "acme", id: "device", label: "Device code", login: (ui) => ui.ask("code").pipe(
        Effect.map((code): Credential => ({ type: "oauth", access: code, refresh: "r", expiresAt: Date.now() + 3_600_000 })),
        Effect.mapError((error) => new CredentialError({ provider: "acme", reason: "LoginFailed", message: error.message })),
      ) });
      expect(yield* service.methods).toEqual([
        { provider: "acme", id: "device", label: "Device code" },
        { provider: "acme", id: "api-key", label: "API key" },
        { provider: "*", id: "api-key", label: "API key" },
      ]);
      expect(yield* service.login("acme", "device")).toMatchObject({ type: "oauth", access: "device-code" });
      expect(yield* service.login("anything", "api-key")).toEqual({ type: "api-key", key: "sk-typed" });
      expect(yield* service.list).toEqual([{ provider: "acme", type: "oauth" }, { provider: "anything", type: "api-key" }]);

      const unknown = yield* service.login("acme", "magic").pipe(Effect.flip);
      expect(unknown).toMatchObject({ reason: "NotFound" });
      // No answer left: the key entry fails as a login failure and nothing is stored.
      const refused = yield* service.login("late", "api-key").pipe(Effect.flip);
      expect(refused).toMatchObject({ provider: "late", reason: "LoginFailed" });
      expect((yield* service.list).map((entry) => entry.provider)).toEqual(["acme", "anything"]);
    }), ["device-code", " sk-typed "]);
  });
});
