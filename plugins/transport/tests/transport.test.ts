import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Duration, Effect, Exit, Fiber, Layer, Schedule } from "effect";
import type { Mailbox, Scope } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import type { RpcClientError, RpcGroup } from "@effect/rpc";
import { HostError, HostRpcs, Interaction, InteractionError, Notice } from "@basis/contracts";
import type { HostEvent } from "@basis/contracts";
import { Events, makeCore } from "@basis/core";
import type { Core } from "@basis/core";
import transport, { readDiscovery } from "../src/index.ts";
import { fakeAgent, fakeHostControl, fakeInteraction, fakeLlm, fakePaths, fakeSessions, fakeWorkspace } from "./fakes.ts";
import type { ControlHolder } from "./fakes.ts";

type Client = RpcClient.RpcClient<RpcGroup.Rpcs<typeof HostRpcs>, RpcClientError.RpcClientError>;
type EventBox = Mailbox.ReadonlyMailbox<HostEvent, RpcClientError.RpcClientError>;
type Kind = "websocket" | "http";

interface Host {
  readonly core: Core<any>;
  readonly url: string;
  readonly token: string;
  readonly home: string;
  readonly holder: ControlHolder;
  readonly connect: (kind: Kind, token?: string) => Effect.Effect<Client, never, Scope.Scope>;
}

const connect = (url: string, token: string, kind: Kind): Effect.Effect<Client, never, Scope.Scope> =>
  Effect.gen(function* () {
    const protocol = kind === "websocket"
      ? RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
        Layer.provide(Socket.layerWebSocket(`${url.replace(/^http/, "ws")}/rpc?token=${encodeURIComponent(token)}`)),
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
        Layer.provide(RpcSerialization.layerJson),
      )
      : RpcClient.layerProtocolHttp({ url: `${url}/rpc/http` }).pipe(
        // Without filterStatusOk the client parses a 401 body as NDJSON and waits forever.
        Layer.provide(Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, (client) =>
          client.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(token)), HttpClient.filterStatusOk)))),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(RpcSerialization.layerNdjson),
      );
    const context = yield* Layer.build(protocol);
    return yield* RpcClient.make(HostRpcs).pipe(Effect.provide(context));
  });

/** Mounts the transport on an ephemeral port with fakes behind it; the client finds it through `transport.json`. */
const withHost = <A, E>(
  body: (host: Host) => Effect.Effect<A, E, Scope.Scope>,
  config: Record<string, unknown> = {},
  /** A caller-owned home outlives the host, so tests can inspect it afterwards. */
  owned?: string,
): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const home = owned ?? (yield* Effect.promise(() => mkdtemp(join(tmpdir(), "basis-transport-"))));
    if (owned === undefined) yield* Effect.addFinalizer(() => Effect.promise(() => rm(home, { recursive: true, force: true })));
    const holder: ControlHolder = { restarted: [] };
    const core = yield* makeCore(
      [transport, fakeAgent, fakeSessions, fakeLlm, fakeInteraction, fakeHostControl(holder), fakePaths(home), fakeWorkspace],
      { configs: { transport: { port: 0, interactionGraceMs: 100, ...config } } },
    );
    holder.core = core;
    const found = yield* readDiscovery(home);
    if (found === undefined) return yield* Effect.dieMessage("no discovery file");
    return yield* body({ core, url: found.url, token: found.token, home, holder, connect: (kind, token = found.token) => connect(found.url, token, kind) });
  }).pipe(Effect.timeout(Duration.seconds(20)))));

/** Takes events until one satisfies the predicate (inclusive). */
const waitFor = (events: EventBox, done: (event: HostEvent) => boolean) => {
  const loop = (seen: HostEvent[]): Effect.Effect<HostEvent[]> =>
    Effect.flatMap(Effect.orDie(events.take), (event) => (done(event) ? Effect.succeed([...seen, event]) : loop([...seen, event])));
  return loop([]).pipe(Effect.timeout(Duration.seconds(5)), Effect.orDie);
};

/**
 * The RPC client sends a stream request asynchronously, so a subscription is
 * live only once something published after it arrives. Publishes marker
 * notices until one does.
 */
const subscribe = (host: Host, client: Client) => Effect.gen(function* () {
  const events = yield* client.Host.Events(undefined, { asMailbox: true });
  const marker = randomUUID();
  const ping = host.core.run(Effect.flatMap(Events, (bus) => bus.publish(Notice, { level: "info", message: marker })));
  const pinger = yield* Effect.fork(Effect.repeat(ping, Schedule.spaced(Duration.millis(20))));
  yield* waitFor(events, (event) => event.type === "notice" && event.notice.message === marker);
  yield* Fiber.interrupt(pinger);
  return events;
});

const hostError = (exit: Exit.Exit<unknown, unknown>): HostError => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error instanceof HostError) return exit.cause.error;
  throw new Error(`Expected a HostError, got ${String(exit)}`);
};

const interactionError = (exit: Exit.Exit<unknown, unknown>): InteractionError => {
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error instanceof InteractionError) return exit.cause.error;
  throw new Error(`Expected an InteractionError, got ${String(exit)}`);
};

const text = (value: string) => [{ type: "text" as const, text: value }];

describe("transport", () => {
  test("requires the token on /rpc and /api, by header or query", () => withHost((host) => Effect.gen(function* () {
    const get = (path: string, init?: RequestInit) => Effect.promise(() => fetch(`${host.url}${path}`, init));
    expect((yield* get("/api/health")).status).toBe(401);
    expect((yield* get("/api/health?token=nope")).status).toBe(401);
    expect((yield* get("/rpc/http", { method: "POST", body: "" })).status).toBe(401);
    const byHeader = yield* get("/api/health", { headers: { authorization: `Bearer ${host.token}` } });
    expect(byHeader.status).toBe(200);
    expect(yield* Effect.promise(() => byHeader.json())).toEqual({ ok: true, version: "0.1.0" });
    expect((yield* get(`/api/health?token=${encodeURIComponent(host.token)}`)).status).toBe(200);
    // Without staticDir there is no web app, but no token is asked for either.
    expect((yield* get("/")).status).toBe(404);

    const client = yield* host.connect("http", "wrong");
    const exit = yield* Effect.exit(client.Session.List({}));
    expect(Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error._tag).toBe("RpcClientError");

    // The WebSocket upgrade itself is refused; the RPC client would only keep retrying.
    const socket = (token: string) => Effect.async<"open" | "refused">((resume) => {
      const ws = new WebSocket(`${host.url.replace(/^http/, "ws")}/rpc?token=${encodeURIComponent(token)}`);
      ws.onopen = () => { ws.close(); resume(Effect.succeed("open")); };
      ws.onerror = () => resume(Effect.succeed("refused"));
    });
    expect(yield* socket("wrong")).toBe("refused");
    expect(yield* socket(host.token)).toBe("open");
  })));

  test("serves sessions, turns, models, and host control over WebSocket", () => withHost((host) => Effect.gen(function* () {
    const client = yield* host.connect("websocket");
    const events = yield* subscribe(host, client);

    const session = yield* client.Session.Create({});
    expect(session.cwd).toBe("/work");
    yield* waitFor(events, (event) => event.type === "session-changed" && event.info.id === session.id);
    expect((yield* client.Session.List({})).map((info) => info.id)).toEqual([session.id]);
    expect(yield* client.Session.List({ cwd: "/elsewhere" })).toEqual([]);

    yield* client.Agent.Prompt({ sessionId: session.id, content: text("hi") });
    // Kinds are observed independently, so `turn-ended` may overtake the last delta: wait for both.
    let ended = false;
    let streamed = "";
    const turn = yield* waitFor(events, (event) => {
      if (event.type === "turn-ended") ended = true;
      if (event.type === "delta" && event.event.type === "text-delta") streamed += event.event.delta;
      return ended && streamed === "echo: hi";
    });
    expect(turn.some((event) => event.type === "turn-started" && event.sessionId === session.id)).toBe(true);
    expect(yield* client.Agent.Running()).toEqual([]);

    const logged = yield* client.Session.Events({ sessionId: session.id });
    expect(logged.map((event) => (event.data.type === "message" ? event.data.message.role : event.data.type))).toEqual(["user", "assistant"]);
    expect((yield* client.Session.Events({ sessionId: session.id, after: 1 })).map((event) => event.seq)).toEqual([2]);

    const titled = yield* client.Session.SetTitle({ sessionId: session.id, title: "Hello" });
    expect(titled).toMatchObject({ id: session.id, title: "Hello", lastSeq: 3 });
    yield* waitFor(events, (event) => event.type === "session-appended" && event.event.data.type === "title");
    expect((yield* client.Session.Checkout({ sessionId: session.id, eventId: logged[0]!.id })).leaf).toBe(logged[0]!.id);

    const missing = hostError(yield* Effect.exit(client.Session.Get({ sessionId: "missing" })));
    expect(missing).toMatchObject({ code: "NotFound", subject: "missing" });
    expect(hostError(yield* Effect.exit(client.Agent.Prompt({ sessionId: "missing", content: text("x") })))).toMatchObject({ code: "Session", subject: "missing" });

    expect((yield* client.Llm.Models({})).map((model) => model.ref)).toEqual(["fake/echo"]);
    expect(yield* client.Llm.Models({ available: false })).toEqual([]);
    expect((yield* client.Llm.Providers()).map((provider) => provider.id)).toEqual(["fake"]);
    expect(hostError(yield* Effect.exit(client.Llm.Login({ provider: "nope", type: "api_key" })))).toMatchObject({ code: "UnknownProvider" });

    expect(yield* client.Host.Info()).toEqual({
      version: "0.1.0", cwd: "/work", home: host.home, composition: { id: "c0ffee", plugins: [{ id: "transport", version: "0.1.0" }] },
    });
    const plugins = yield* client.Host.Plugins();
    expect(plugins.find((plugin) => plugin.id === "transport")).toEqual({ id: "transport", version: "0.1.0", state: "active" });
    yield* client.Host.RestartPlugin({ pluginId: "llm" });
    expect(host.holder.restarted).toEqual(["llm"]);
    const [changed] = (yield* waitFor(events, (event) => event.type === "plugins-changed")).slice(-1);
    expect(changed?.type === "plugins-changed" && changed.plugins.some((plugin) => plugin.id === "llm")).toBe(true);
    const unknown = hostError(yield* Effect.exit(client.Host.RestartPlugin({ pluginId: "nope" })));
    expect(unknown.code).toBe("ReloadError");
    expect(unknown.subject).toBeUndefined();
    expect(unknown.message).toContain('error [nope]: No plugin "nope" (Check the id)');
    expect(yield* client.Host.Reload()).toEqual({ started: ["x"], restarted: [], stopped: [] });
  })), 30_000);

  test("serves the same surface over streaming HTTP", () => withHost((host) => Effect.gen(function* () {
    const client = yield* host.connect("http");
    const events = yield* subscribe(host, client);
    const session = yield* client.Session.Create({ cwd: "/elsewhere" });
    expect(session.cwd).toBe("/elsewhere");
    yield* client.Agent.Prompt({ sessionId: session.id, content: text("yo") });
    yield* waitFor(events, (event) => event.type === "turn-ended" && event.sessionId === session.id);
    expect((yield* client.Session.Events({ sessionId: session.id })).length).toBe(2);
    expect(hostError(yield* Effect.exit(client.Session.Get({ sessionId: "missing" })))).toMatchObject({ code: "NotFound" });
  })), 30_000);

  test("serves workspace status, branches, and checkout", () => withHost((host) => Effect.gen(function* () {
    const client = yield* host.connect("websocket");
    expect(yield* client.Workspace.Status({ path: "/elsewhere" })).toEqual({ path: "/elsewhere", exists: true });
    expect((yield* client.Workspace.Branches({ path: "/work" })).map((branch) => [branch.name, branch.current])).toEqual([["main", true], ["dev", false]]);
    expect((yield* client.Workspace.Checkout({ path: "/work", branch: "dev" })).git?.branch).toBe("dev");
    expect((yield* client.Workspace.Checkout({ path: "/work", branch: "topic", create: true })).git?.branch).toBe("topic");
    expect(hostError(yield* Effect.exit(client.Workspace.Branches({ path: "/elsewhere" })))).toMatchObject({ code: "NotRepository", subject: "/elsewhere" });
    expect(hostError(yield* Effect.exit(client.Workspace.Checkout({ path: "/work", branch: "nope" })))).toEqual(
      new HostError({ code: "Failed", message: "fatal: invalid reference: nope", subject: "/work" }),
    );
  })), 30_000);

  test("routes interactions to subscribed clients", () => withHost((host) => Effect.gen(function* () {
    const client = yield* host.connect("websocket");
    const events = yield* subscribe(host, client);
    const interaction = yield* host.core.run(Interaction);

    const confirm = yield* Effect.fork(host.core.run(interaction.confirm("Proceed?", "details")));
    const [request] = (yield* waitFor(events, (event) => event.type === "interaction")).slice(-1);
    expect(request).toEqual({ type: "interaction", request: { type: "confirm", id: "i1", title: "Proceed?", detail: "details" } });

    expect(hostError(yield* Effect.exit(client.Interaction.Answer({ id: "i1", answer: { type: "ask", value: "x" } })))).toMatchObject({ code: "Mismatch", subject: "i1" });
    expect(hostError(yield* Effect.exit(client.Interaction.Answer({ id: "zzz", answer: { type: "confirm", value: true } })))).toMatchObject({ code: "NotFound" });
    yield* client.Interaction.Answer({ id: "i1", answer: { type: "confirm", value: true } });
    expect(yield* Fiber.join(confirm)).toBe(true);
    yield* waitFor(events, (event) => event.type === "interaction-closed" && event.id === "i1");
    expect(hostError(yield* Effect.exit(client.Interaction.Answer({ id: "i1", answer: { type: "confirm", value: false } })))).toMatchObject({ code: "NotFound" });

    const ask = yield* Effect.fork(host.core.run(interaction.ask("Name?")));
    yield* waitFor(events, (event) => event.type === "interaction" && event.request.id === "i2");
    yield* client.Interaction.Dismiss({ id: "i2" });
    expect(interactionError(yield* Fiber.await(ask))).toMatchObject({ reason: "Dismissed" });

    // Interrupting the asker withdraws the question from every client.
    const withdrawn = yield* Effect.fork(host.core.run(interaction.confirm("Still?")));
    yield* waitFor(events, (event) => event.type === "interaction" && event.request.id === "i3");
    yield* Fiber.interrupt(withdrawn);
    yield* waitFor(events, (event) => event.type === "interaction-closed" && event.id === "i3");
  })), 30_000);

  test("replays open interactions to a client that subscribes later", () => withHost((host) => Effect.gen(function* () {
    const first = yield* subscribe(host, yield* host.connect("websocket"));
    const interaction = yield* host.core.run(Interaction);
    const select = yield* Effect.fork(host.core.run(interaction.select("Model?", [{ value: "a", label: "A" }, { value: "b", label: "B" }])));
    yield* waitFor(first, (event) => event.type === "interaction");
    const second = yield* host.connect("websocket");
    const secondEvents = yield* second.Host.Events(undefined, { asMailbox: true });
    const [replayed] = yield* waitFor(secondEvents, (event) => event.type === "interaction");
    expect(replayed).toMatchObject({ type: "interaction", request: { type: "select", id: "i1" } });
    expect(hostError(yield* Effect.exit(second.Interaction.Answer({ id: "i1", answer: { type: "select", value: "z" } })))).toMatchObject({ code: "Mismatch" });
    yield* second.Interaction.Answer({ id: "i1", answer: { type: "select", value: "b" } });
    expect(yield* Fiber.join(select)).toBe("b");
  })), 30_000);

  test("a login RPC asks its question through the event stream", () => withHost((host) => Effect.gen(function* () {
    const client = yield* host.connect("websocket");
    const events = yield* subscribe(host, client);
    const login = yield* Effect.fork(client.Llm.Login({ provider: "fake", type: "api_key" }));
    const [asked] = (yield* waitFor(events, (event) => event.type === "interaction")).slice(-1);
    if (asked?.type !== "interaction") throw new Error("expected an interaction");
    yield* client.Interaction.Answer({ id: asked.request.id, answer: { type: "ask", value: "good" } });
    expect(Exit.isSuccess(yield* Fiber.await(login))).toBe(true);
  })), 30_000);

  test("a login outlives a dropped RPC, so a returning client answers its replayed question", () => withHost((host) => Effect.gen(function* () {
    yield* Effect.scoped(Effect.gen(function* () {
      const client = yield* host.connect("websocket");
      const events = yield* subscribe(host, client);
      yield* Effect.fork(client.Llm.Login({ provider: "fake", type: "api_key" }));
      yield* waitFor(events, (event) => event.type === "interaction");
    }));
    // The page reloaded: the old socket is gone, but the question is still open.
    const client = yield* host.connect("websocket");
    const events = yield* client.Host.Events(undefined, { asMailbox: true });
    const [replayed] = yield* waitFor(events, (event) => event.type === "interaction");
    if (replayed?.type !== "interaction") throw new Error("expected an interaction");
    // Retrying joins the login in flight instead of starting another; a different method is refused.
    const retry = yield* Effect.fork(client.Llm.Login({ provider: "fake", type: "api_key" }));
    expect(hostError(yield* Effect.exit(client.Llm.Login({ provider: "fake", type: "oauth" })))).toMatchObject({ code: "Busy", subject: "fake" });
    yield* client.Interaction.Answer({ id: replayed.request.id, answer: { type: "ask", value: "good" } });
    expect(Exit.isSuccess(yield* Fiber.await(retry))).toBe(true);
    yield* waitFor(events, (event) => event.type === "interaction-closed" && event.id === replayed.request.id);
  }), { interactionGraceMs: 5_000 }), 30_000);

  test("keeps a generated token across restarts; a configured token wins", async () => {
    const tokens = await withHost((host) => Effect.gen(function* () {
      yield* host.core.restart("transport");
      const found = yield* readDiscovery(host.home);
      expect(found?.token).toBe(host.token);
      expect(yield* Effect.promise(() => fetch(`${found!.url}/api/health?token=${encodeURIComponent(host.token)}`).then((r) => r.status))).toBe(200);
      return host.token;
    }));
    // A second host start in the same process is the same module instance: still the same generated token.
    expect(await withHost((host) => Effect.succeed(host.token))).toBe(tokens);
    expect(await withHost((host) => Effect.succeed(host.token), { token: "configured" })).toBe("configured");
  }, 30_000);

  test("without subscribers the question falls through to the terminal", () => withHost((host) => Effect.gen(function* () {
    const exit = yield* Effect.exit(host.core.run(Effect.flatMap(Interaction, (interaction) => interaction.confirm("Anyone?"))));
    expect(interactionError(exit)).toMatchObject({ reason: "Unavailable", message: "No answerer is attached" });
  })));

  test("fails Unavailable when every client stays away past the grace period", () => withHost((host) => Effect.gen(function* () {
    const interaction = yield* host.core.run(Interaction);
    const confirm = yield* Effect.scoped(Effect.gen(function* () {
      const events = yield* subscribe(host, yield* host.connect("websocket"));
      const confirm = yield* Effect.fork(host.core.run(interaction.confirm("Still there?")));
      yield* waitFor(events, (event) => event.type === "interaction");
      return confirm;
    }));
    const error = interactionError(yield* Fiber.await(confirm));
    expect(error).toMatchObject({ reason: "Unavailable" });
    expect(error.message).toContain("disconnected");
  })), 30_000);

  test("serves a static web app with SPA fallback and no token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "basis-web-"));
    try {
      await mkdir(join(dir, "assets"));
      await writeFile(join(dir, "index.html"), "<!doctype html><title>basis</title>");
      await writeFile(join(dir, "assets", "app.js"), "console.log(1)");
      await writeFile(join(tmpdir(), "basis-secret.txt"), "secret");
      await withHost((host) => Effect.gen(function* () {
        const get = (path: string) => Effect.promise(async () => {
          const response = await fetch(`${host.url}${path}`);
          return { status: response.status, type: response.headers.get("content-type"), body: await response.text() };
        });
        expect(yield* get("/")).toMatchObject({ status: 200, body: "<!doctype html><title>basis</title>" });
        expect(yield* get("/assets/app.js")).toMatchObject({ status: 200, body: "console.log(1)" });
        expect((yield* get("/assets/app.js")).type).toContain("javascript");
        expect(yield* get("/sessions/s1")).toMatchObject({ status: 200, body: "<!doctype html><title>basis</title>" });
        expect((yield* get("/assets/missing.js")).status).toBe(404);
        expect((yield* get("/%2e%2e/basis-secret.txt")).status).toBe(404);
        expect((yield* get("/..%2fbasis-secret.txt")).status).toBe(404);
      }), { staticDir: dir });
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(join(tmpdir(), "basis-secret.txt"), { force: true });
    }
  });

  test("removes the discovery file and releases the port on shutdown, even with a client attached", async () => {
    const home = await mkdtemp(join(tmpdir(), "basis-transport-"));
    try {
    const started = Date.now();
    const url = await withHost((host) => Effect.gen(function* () {
      yield* subscribe(host, yield* host.connect("websocket"));
      expect(yield* readDiscovery(host.home)).toMatchObject({ url: host.url, token: host.token, pid: process.pid });
      expect((yield* Effect.promise(() => stat(join(host.home, "transport.json")))).mode & 0o777).toBe(0o600);
      return host.url;
    }), {}, home);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(existsSync(join(home, "transport.json"))).toBe(false);
    const port = Number(new URL(url).port);
    await expect(fetch(`${url}/api/health`)).rejects.toThrow();
    await new Promise<void>((resolve, reject) => {
      const server = createServer().once("error", reject).listen(port, "127.0.0.1", () => server.close(() => resolve()));
    });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
