import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Chunk, Duration, Effect, Exit, Fiber, Option, Stream } from "effect";
import type { Mailbox, Scope } from "effect";
import { makeCore } from "@basis/core";
import type { Core } from "@basis/core";
import { HostError, Interaction, InteractionError, Message } from "@basis/contracts";
import type { HostEvent } from "@basis/contracts";
import { discoverHost, makeHostClient } from "@basis/client/bun";
import type { HostClientOptions, HostClientService } from "@basis/client/bun";
import transport from "../src/index.ts";
import {
  fakeAgent, fakeCredentials, fakeHostControl, fakeInteraction, fakeLlm, fakePaths, fakeSessions,
} from "./fakes.ts";
import type { ControlHolder } from "./fakes.ts";

interface Host {
  readonly core: Core<any>;
  readonly url: string;
  readonly token: string;
  readonly home: string;
  readonly holder: ControlHolder;
  readonly connect: (transport: HostClientOptions["transport"]) => Effect.Effect<HostClientService, never, Scope.Scope>;
}

/** Mounts the transport on an ephemeral port with fakes behind it; the client finds it through host.json. */
const withHost = <A, E>(body: (host: Host) => Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const home = mkdtempSync(join(tmpdir(), "basis-transport-"));
    yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(home, { recursive: true, force: true })));
    const holder: ControlHolder = { restarted: [] };
    const core = yield* makeCore(
      [transport, fakeAgent, fakeSessions, fakeLlm, fakeCredentials, fakeHostControl(holder), fakeInteraction, fakePaths(home)],
      { configs: { transport: { port: 0 } } },
    );
    holder.core = core;
    const found = yield* discoverHost({ home });
    const connect = (kind: HostClientOptions["transport"]) => makeHostClient({ url: found.url, token: found.token, transport: kind });
    return yield* body({ core, url: found.url, token: found.token, home, holder, connect });
  }).pipe(Effect.timeout(Duration.seconds(15)))));

const user = (text: string) => new Message({ role: "user", parts: [{ type: "text", text }] });

/** Takes events until one satisfies the predicate (inclusive); dies after five seconds. */
const takeUntil = <E>(mailbox: Mailbox.ReadonlyMailbox<HostEvent, E>, done: (event: HostEvent) => boolean) => {
  const loop = (acc: HostEvent[]): Effect.Effect<HostEvent[], E> =>
    Effect.flatMap(Effect.orDie(Effect.mapError(mailbox.take, (e) => Option.getOrThrow(e))), (event) =>
      done(event) ? Effect.succeed([...acc, event]) : loop([...acc, event]));
  return loop([]).pipe(Effect.timeout(Duration.seconds(5)), Effect.orDie);
};

/** The first element is the transport's marker: only after it is the subscription in place on the host. */
/**
 * Every kernel event kind is observed through its own queue, so kinds may
 * interleave; a turn is complete when this multiset of kinds has arrived.
 */
const collectTurn = <E>(mailbox: Mailbox.ReadonlyMailbox<HostEvent, E>) => {
  const expected = ["session-appended", "turn-started", "model", "model", "model", "session-appended", "turn-ended"].sort();
  return takeUntil(mailbox, (() => {
    let seen = 0;
    return () => ++seen === expected.length;
  })()).pipe(Effect.tap((events) => Effect.sync(() => expect(events.map((event) => event.type).sort()).toEqual(expected))));
};

const subscribe = (client: HostClientService) => Effect.gen(function* () {
  const events = yield* client.Host.Events(undefined, { asMailbox: true });
  const [marker] = yield* takeUntil(events, () => true);
  expect(marker).toMatchObject({ type: "notice", level: "info", source: "transport" });
  return events;
});

/** Sessions are created through the client so the resulting `session-changed` proves the subscription is live. */
const openSession = (client: HostClientService, events: Mailbox.ReadonlyMailbox<HostEvent, unknown>) =>
  Effect.gen(function* () {
    const session = yield* client.Session.Create({ cwd: "/work" });
    yield* takeUntil(events, (event) => event.type === "session-changed" && event.sessionId === session.id);
    return session;
  });

const codeOf = (exit: Exit.Exit<unknown, unknown>): string => {
  const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none();
  if (Option.isSome(failure)) {
    if (failure.value instanceof HostError) return failure.value.code;
    if (failure.value instanceof InteractionError) return `${failure.value._tag}.${failure.value.reason}`;
  }
  throw new Error(`Expected a typed failure, got ${String(exit)}`);
};

describe("transport", () => {
  test("rejects requests without the token and answers /health with it", () => withHost((host) => Effect.gen(function* () {
    const anonymous = yield* Effect.promise(() => fetch(`${host.url}/health`));
    expect(anonymous.status).toBe(401);
    const wrongQuery = yield* Effect.promise(() => fetch(`${host.url}/health?token=nope`));
    expect(wrongQuery.status).toBe(401);
    const authorized = yield* Effect.promise(() => fetch(`${host.url}/health`, { headers: { authorization: `Bearer ${host.token}` } }));
    expect(authorized.status).toBe(200);
    expect(yield* Effect.promise(() => authorized.json())).toEqual({ ok: true, version: "0.1.0" });

    for (const transport of ["websocket", "http"] as const) {
      const client = yield* makeHostClient({ url: host.url, token: "wrong", transport });
      const exit = yield* Effect.exit(client.Session.List({}).pipe(Effect.timeout(Duration.seconds(5))));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("RpcClientError");
    }
  })));

  test("serves sessions, turns, and host control over websocket", () => withHost((host) => Effect.gen(function* () {
    const client = yield* host.connect("websocket");
    const events = yield* subscribe(client);
    const session = yield* openSession(client, events);
    expect((yield* client.Session.List({})).map((info) => info.id)).toEqual([session.id]);
    expect((yield* client.Session.List({ cwd: "/elsewhere" })).length).toBe(0);
    expect(Chunk.toReadonlyArray(yield* Stream.runCollect(client.Session.Entries({ sessionId: session.id })))).toEqual([]);

    yield* client.Agent.Prompt({ sessionId: session.id, message: user("hi") });
    const seen = yield* collectTurn(events);
    const deltas = seen.flatMap((event) => event.type === "model" && event.event.type === "text-delta" ? [event.event.text] : []);
    expect(deltas.join("")).toBe("echo: hi");
    expect(yield* client.Agent.Busy({ sessionId: session.id })).toBe(false);

    const entries = Chunk.toReadonlyArray(yield* Stream.runCollect(client.Session.Entries({ sessionId: session.id })));
    expect(entries.map((entry) => entry.payload.type === "message" ? entry.payload.message.role : entry.payload.type)).toEqual(["user", "assistant"]);
    expect(entries[1]?.parent).toBe(entries[0]?.id);
    expect((yield* client.Session.Context({ sessionId: session.id })).length).toBe(2);
    expect((yield* client.Session.SetTitle({ sessionId: session.id, title: "Hello" })).title).toBe("Hello");

    const missing = yield* Effect.exit(client.Session.Get({ sessionId: "missing" }));
    expect(codeOf(missing)).toBe("SessionError.NotFound");
    const preview = yield* Effect.exit(client.Agent.Preview({ sessionId: session.id }));
    expect(codeOf(preview)).toBe("Unsupported");

    expect((yield* client.Llm.Models()).map((model) => model.id)).toEqual(["fake/echo"]);
    expect(yield* client.Credentials.List()).toEqual([{ provider: "fake", type: "api-key" }]);

    const plugins = yield* client.Host.Plugins();
    expect(plugins.find((plugin) => plugin.id === "transport")).toMatchObject({ state: "active", version: "0.1.0" });
    yield* client.Host.RestartPlugin({ pluginId: "credentials" });
    expect(host.holder.restarted).toEqual(["credentials"]);
    const changed = yield* takeUntil(events, (event) => event.type === "plugins-changed");
    expect(changed.at(-1)).toMatchObject({ type: "plugins-changed" });
    const unknown = yield* Effect.exit(client.Host.RestartPlugin({ pluginId: "nope" }));
    expect(codeOf(unknown)).toBe("ReloadError");
    expect(yield* client.Host.Reload()).toEqual({ started: [], restarted: [], stopped: [] });
  })), { timeout: 20000 });

  test("serves the same surface over streaming http", () => withHost((host) => Effect.gen(function* () {
    const client = yield* host.connect("http");
    const events = yield* subscribe(client);
    const session = yield* openSession(client, events);
    expect((yield* client.Session.List({})).map((info) => info.id)).toEqual([session.id]);
    yield* client.Session.Append({ sessionId: session.id, payload: { type: "title", title: "t" } });
    yield* takeUntil(events, (event) => event.type === "session-appended" && event.entry.payload.type === "title");
    const entries = Chunk.toReadonlyArray(yield* Stream.runCollect(client.Session.Entries({ sessionId: session.id })));
    expect(entries.map((entry) => entry.payload.type)).toEqual(["title"]);

    yield* client.Agent.Prompt({ sessionId: session.id, message: user("yo") });
    const seen = yield* collectTurn(events);
    expect(seen.some((event) => event.type === "model" && event.event.type === "finish")).toBe(true);
    expect(codeOf(yield* Effect.exit(client.Session.Get({ sessionId: "missing" })))).toBe("SessionError.NotFound");
  })), { timeout: 20000 });

  test("routes interactions to connected clients", () => withHost((host) => Effect.gen(function* () {
    const client = yield* host.connect("websocket");
    const events = yield* subscribe(client);
    yield* openSession(client, events);
    const interaction = yield* host.core.run(Interaction);

    const confirm = yield* Effect.fork(host.core.run(interaction.confirm("Proceed?", "details")));
    const [request] = yield* takeUntil(events, (event) => event.type === "interaction");
    if (request?.type !== "interaction") throw new Error("expected interaction");
    expect(request.request).toEqual({ type: "confirm", id: "i1", title: "Proceed?", detail: "details" });

    expect(codeOf(yield* Effect.exit(client.Interaction.Answer({ id: "i1", answer: { type: "ask", value: "x" } })))).toBe("Interaction.Mismatch");
    expect(codeOf(yield* Effect.exit(client.Interaction.Answer({ id: "zzz", answer: { type: "confirm", value: true } })))).toBe("Interaction.Unknown");
    yield* client.Interaction.Answer({ id: "i1", answer: { type: "confirm", value: true } });
    expect(yield* Fiber.join(confirm)).toBe(true);
    yield* takeUntil(events, (event) => event.type === "interaction-closed" && event.id === "i1");
    expect(codeOf(yield* Effect.exit(client.Interaction.Answer({ id: "i1", answer: { type: "confirm", value: false } })))).toBe("Interaction.Unknown");

    const ask = yield* Effect.fork(host.core.run(interaction.ask("Name?")));
    yield* takeUntil(events, (event) => event.type === "interaction" && event.request.id === "i2");
    yield* client.Interaction.Dismiss({ id: "i2" });
    expect(codeOf(yield* Fiber.await(ask))).toBe("InteractionError.Dismissed");
  })), { timeout: 20000 });

  test("falls through to the next answerer without subscribers", () => withHost((host) => Effect.gen(function* () {
    const exit = yield* Effect.exit(host.core.run(Effect.flatMap(Interaction, (interaction) => interaction.confirm("Anyone?"))));
    expect(codeOf(exit)).toBe("InteractionError.Unavailable");
    expect(String(exit)).toContain("No answerer is attached");
  })));

  test("fails Unavailable when the last subscriber disconnects", () => withHost((host) => Effect.gen(function* () {
    const interaction = yield* host.core.run(Interaction);
    // The client scope closes while the question is open, taking the only subscriber with it.
    const confirm = yield* Effect.scoped(Effect.gen(function* () {
      const client = yield* host.connect("websocket");
      const events = yield* subscribe(client);
      const confirm = yield* Effect.fork(host.core.run(interaction.confirm("Still there?")));
      yield* takeUntil(events, (event) => event.type === "interaction");
      return confirm;
    }));
    const exit = yield* Fiber.await(confirm);
    expect(codeOf(exit)).toBe("InteractionError.Unavailable");
    expect(String(exit)).toContain("disconnected");
  })), { timeout: 20000 });

  test("releases the port and the discovery file on shutdown", async () => {
    const { url, home } = await withHost((host) => Effect.gen(function* () {
      const client = yield* host.connect("websocket");
      yield* subscribe(client);
      expect(existsSync(join(host.home, "host.json"))).toBe(true);
      return { url: host.url, home: host.home };
    }));
    expect(existsSync(join(home, "host.json"))).toBe(false);
    const port = Number(new URL(url).port);
    await expect(fetch(`${url}/health`)).rejects.toThrow();
    const rebound = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
    expect(rebound.port).toBe(port);
    rebound.stop(true);
  });
});
