import { Effect, Schedule, Stream } from "effect";
import type { RpcClientError } from "@effect/rpc";
import type { HostEvent } from "@basis/contracts";
import type { HostClientService } from "./client.ts";

export interface HostEventsOptions {
  /** Delay between reconnection attempts. Default: exponential from 250ms, capped at 5s, forever. */
  readonly backoff?: Schedule.Schedule<unknown, RpcClientError.RpcClientError>;
}

const defaultBackoff = Schedule.exponential("250 millis").pipe(Schedule.union(Schedule.spaced("5 seconds")));

const notice = (level: "info" | "warning", message: string): HostEvent => ({ type: "notice", level, message, source: "client" });
const LOST = notice("warning", "Connection to the host was lost; reconnecting");
const RECONNECTED = notice("info", "Reconnected to the host; resync sessions from Session.Entries");

/**
 * `Host.Events` that survives the connection. A subscription that fails after
 * delivering anything ends with a synthetic warning notice; the stream is then
 * re-subscribed under the backoff, and the first event of the new subscription
 * is preceded by a synthetic info notice. Events published during the outage
 * are lost, as events always may be; resync from `Session.Entries` when the
 * info notice arrives. Fails only when the backoff schedule gives up.
 */
export const hostEvents = (
  client: HostClientService,
  options: HostEventsOptions = {},
): Stream.Stream<HostEvent, RpcClientError.RpcClientError> =>
  Stream.unwrap(Effect.sync(() => {
    // Per run: whether the current subscription has delivered, and whether a delivered one was lost.
    let delivered = false;
    let outage = false;
    const subscription = Stream.suspend(() => client.Host.Events()).pipe(
      Stream.mapConcat((event) => {
        const events = !delivered && outage ? [RECONNECTED, event] : [event];
        delivered = true;
        outage = false;
        return events;
      }),
      Stream.catchAll((error) => {
        const events = delivered ? [LOST] : [];
        outage = outage || delivered;
        delivered = false;
        return Stream.concat(Stream.fromIterable(events), Stream.fail(error));
      }),
    );
    return Stream.retry(subscription, options.backoff ?? defaultBackoff);
  }));
