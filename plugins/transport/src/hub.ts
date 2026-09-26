import { Context, Deferred, Effect, Queue, Stream } from "effect";
import type { CoreClosed, Event, EventError, PluginContext } from "@basis/core";
import {
  ModelEvent, Notice, PluginsChanged, SessionAppended, SessionChanged, TurnEnded, TurnStarted,
} from "@basis/contracts";
import type { HostEvent } from "@basis/contracts";
import { toPluginStatus } from "./errors.ts";

/** Model deltas outrun slow clients; older ones are dropped and the client resyncs from `Session.Entries`. */
const FEED_BUFFER = 512;

/** First element of every `Host.Events` subscription: everything published after it reaches this subscriber. */
export const SUBSCRIBED: HostEvent = { type: "notice", level: "info", message: "Subscribed to host events", source: "transport" };

interface Subscriber {
  /** Kernel events: bounded, drop-oldest. */
  readonly feed: Queue.Queue<HostEvent>;
  /** Interaction traffic: never dropped, since a hook is waiting on the answer. */
  readonly inbox: Queue.Queue<HostEvent>;
}

/**
 * Fan-out of host events to connected clients. The kernel events are observed
 * once, at activation, and copied into every subscriber's queues; a subscriber
 * therefore receives everything published after its stream's scoped setup ran,
 * with no window in which its own subscriptions are still starting.
 */
export interface Hub {
  /** One subscription per run of the stream; counted while it is consumed. */
  readonly events: Stream.Stream<HostEvent>;
  readonly count: Effect.Effect<number>;
  readonly broadcast: (event: HostEvent) => Effect.Effect<void>;
  /** Resolves when the last subscriber leaves (immediately if none is attached). */
  readonly drained: Effect.Effect<void>;
}

export const makeHub = (owner: Context.Tag.Service<PluginContext>): Effect.Effect<Hub, EventError | CoreClosed> =>
  Effect.gen(function* () {
    const subscribers = new Set<Subscriber>();
    let drained = yield* Deferred.make<void>();
    yield* Deferred.succeed(drained, undefined);

    const feed = (event: HostEvent) =>
      Effect.forEach(subscribers, (subscriber) => Queue.offer(subscriber.feed, event), { discard: true });
    const forward = <P>(event: Event<P>, convert: (payload: P) => HostEvent, buffer = 64) =>
      owner.observe(event, (payload) => feed(convert(payload)), { buffer, overflow: "dropOldest" });

    yield* forward(ModelEvent, (e) => ({ type: "model", sessionId: e.sessionId, turnId: e.turnId, event: e.event }), FEED_BUFFER);
    yield* forward(TurnStarted, (e) => ({ type: "turn-started", sessionId: e.sessionId, turnId: e.turnId }));
    yield* forward(TurnEnded, (e) => ({ type: "turn-ended", sessionId: e.sessionId, turnId: e.turnId, usage: e.usage, reason: e.reason }));
    yield* forward(SessionAppended, (e) => ({ type: "session-appended", sessionId: e.sessionId, entry: e.entry }));
    yield* forward(SessionChanged, (e) => ({ type: "session-changed", sessionId: e.sessionId, info: e.info }));
    yield* forward(Notice, (e) => ({ type: "notice", level: e.level, message: e.message, ...(e.source === undefined ? {} : { source: e.source }) }));
    yield* forward(PluginsChanged, (e) => ({ type: "plugins-changed", plugins: e.plugins.map(toPluginStatus) }));

    const join = Effect.gen(function* () {
      const subscriber: Subscriber = { feed: yield* Queue.sliding<HostEvent>(FEED_BUFFER), inbox: yield* Queue.unbounded<HostEvent>() };
      if (subscribers.size === 0) drained = yield* Deferred.make<void>();
      subscribers.add(subscriber);
      return subscriber;
    });
    const leave = (subscriber: Subscriber) => Effect.gen(function* () {
      subscribers.delete(subscriber);
      yield* Queue.shutdown(subscriber.feed);
      yield* Queue.shutdown(subscriber.inbox);
      if (subscribers.size === 0) yield* Deferred.succeed(drained, undefined);
    });

    // The RPC client sends stream requests asynchronously, so a caller cannot know when
    // its subscription is in place; the marker is emitted only once it is.
    const events: Stream.Stream<HostEvent> = Stream.unwrapScoped(Effect.map(
      Effect.acquireRelease(join, leave),
      (subscriber) => Stream.concat(
        Stream.make(SUBSCRIBED),
        Stream.merge(Stream.fromQueue(subscriber.inbox), Stream.fromQueue(subscriber.feed)),
      ),
    ));

    return {
      events,
      count: Effect.sync(() => subscribers.size),
      broadcast: (event) => Effect.forEach(subscribers, (subscriber) => Queue.offer(subscriber.inbox, event), { discard: true }),
      drained: Effect.suspend(() => Deferred.await(drained)),
    };
  });
