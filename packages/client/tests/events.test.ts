import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Schedule, Stream } from "effect";
import { RpcClientError } from "@effect/rpc";
import type { HostEvent } from "@basis/contracts";
import { hostEvents } from "../src/index.ts";
import type { HostClientService } from "../src/index.ts";

const dropped = new RpcClientError.RpcClientError({ reason: "Protocol", message: "socket closed" });
const event = (message: string): HostEvent => ({ type: "notice", level: "info", message, source: "test" });

/** Each subscription attempt consumes the next scripted stream. */
const scripted = (attempts: Stream.Stream<HostEvent, RpcClientError.RpcClientError>[]): HostClientService => {
  const remaining = [...attempts];
  return { Host: { Events: () => Stream.suspend(() => remaining.shift() ?? Stream.fail(dropped)) } } as unknown as HostClientService;
};

const collect = (client: HostClientService, count: number, backoff = Schedule.recurs(5)) =>
  Effect.runPromise(Stream.runCollect(hostEvents(client, { backoff }).pipe(Stream.take(count))).pipe(Effect.map(Chunk.toReadonlyArray)));

describe("hostEvents", () => {
  test("marks the outage and the recovery around a re-subscription", async () => {
    const client = scripted([
      Stream.concat(Stream.make(event("a")), Stream.fail(dropped)),
      Stream.fail(dropped),
      Stream.make(event("b"), event("c")),
    ]);
    const seen = await collect(client, 5);
    expect(seen.map((e) => e.type === "notice" ? `${e.level}:${e.source}:${e.message.split(";")[0]}` : e.type)).toEqual([
      "info:test:a",
      "warning:client:Connection to the host was lost",
      "info:client:Reconnected to the host",
      "info:test:b",
      "info:test:c",
    ]);
  });

  test("stays quiet while the first connection is still being made", async () => {
    const client = scripted([Stream.fail(dropped), Stream.fail(dropped), Stream.make(event("a"))]);
    expect((await collect(client, 1)).map((e) => e.type === "notice" ? e.message : e.type)).toEqual(["a"]);
  });

  test("resets the backoff after a delivery and gives up when the schedule does", async () => {
    const delivering = (message: string) => Stream.concat(Stream.make(event(message)), Stream.fail(dropped));
    // recurs(2) allows two consecutive failures; a delivery resets the count, so "b" is reached
    // only if the failure that ends "a" plus one more attempt do not exhaust it.
    const client = scripted([
      Stream.fail(dropped), Stream.fail(dropped), delivering("a"),
      Stream.fail(dropped), delivering("b"),
      Stream.fail(dropped), Stream.fail(dropped),
    ]);
    const stream = hostEvents(client, { backoff: Schedule.recurs(2) }).pipe(
      Stream.catchAll((error) => Stream.make(event(`gave up: ${error.message}`))),
    );
    const seen = await Effect.runPromise(Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray)));
    expect(seen.map((e) => e.type === "notice" ? `${e.source}:${e.message.split(";")[0]}` : e.type)).toEqual([
      "test:a",
      "client:Connection to the host was lost", "client:Reconnected to the host", "test:b",
      "client:Connection to the host was lost", "test:gave up: socket closed",
    ]);
  });
});
