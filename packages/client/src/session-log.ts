import type { SessionEvent } from "@basis/contracts";

/**
 * Merges `incoming` into `events` (both in any order), dropping duplicate
 * `seq`s. Returns events sorted by `seq`. Events are immutable, so a known
 * `seq` keeps its existing instance.
 */
export const mergeEvents = (events: readonly SessionEvent[], incoming: readonly SessionEvent[]): SessionEvent[] => {
  const bySeq = new Map<number, SessionEvent>();
  for (const event of incoming) bySeq.set(event.seq, event);
  for (const event of events) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
};

/**
 * Splits sorted events into the contiguous run that follows `after` and the
 * rest (which sit beyond a gap). `seq` is 1-based, so a complete log starts
 * after 0.
 */
export const splitContiguous = (sorted: readonly SessionEvent[], after: number): { readonly contiguous: SessionEvent[]; readonly ahead: SessionEvent[] } => {
  const contiguous: SessionEvent[] = [];
  let next = after + 1;
  let i = 0;
  for (; i < sorted.length; i++) {
    const seq = sorted[i]!.seq;
    if (seq < next) continue;
    if (seq !== next) break;
    contiguous.push(sorted[i]!);
    next++;
  }
  return { contiguous, ahead: sorted.slice(i).filter((event) => event.seq >= next) };
};

export interface SessionLogSnapshot {
  /** Contiguous events from `seq` 1, in file order. */
  readonly events: readonly SessionEvent[];
  readonly lastSeq: number;
  readonly loaded: boolean;
  /** A fetch is running (initial load or gap repair). */
  readonly syncing: boolean;
  readonly error?: string;
}

export interface SessionLogOptions {
  readonly sessionId: string;
  /** `Session.Events` for this session. */
  readonly fetch: (after: number | undefined) => Promise<readonly SessionEvent[]>;
}

/**
 * A per-session ordered event array fed by `session-appended` notifications.
 * Notifications are losable, so the log only exposes a gap-free prefix: an
 * event beyond a gap is held back and the gap is repaired with
 * `Session.Events({after})`. Call `sync()` after a reconnect and `noteLastSeq`
 * when a `session-changed` reports a newer `lastSeq`. Fetches are single-flight.
 */
export class SessionLog {
  readonly sessionId: string;
  readonly #fetch: SessionLogOptions["fetch"];
  #events: SessionEvent[] = [];
  #ahead: SessionEvent[] = [];
  #loaded = false;
  /** The highest `lastSeq` a `session-changed` has reported. */
  #advertised = 0;
  #error: string | undefined;
  #running: Promise<void> | undefined;
  #again = false;
  #closed = false;
  #snapshot: SessionLogSnapshot = { events: [], lastSeq: 0, loaded: false, syncing: false };
  readonly #listeners = new Set<(snapshot: SessionLogSnapshot) => void>();

  constructor(options: SessionLogOptions) {
    this.sessionId = options.sessionId;
    this.#fetch = options.fetch;
  }

  get snapshot(): SessionLogSnapshot {
    return this.#snapshot;
  }
  get events(): readonly SessionEvent[] {
    return this.#events;
  }
  get lastSeq(): number {
    return this.#events.at(-1)?.seq ?? 0;
  }

  subscribe(listener: (snapshot: SessionLogSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Applies a `session-appended` event. Starts a repair when it lands beyond a gap. */
  apply(event: SessionEvent): void {
    if (this.#closed || event.seq <= this.lastSeq) return;
    this.#absorb([event]);
    if (this.#loaded && this.#ahead.length > 0) void this.sync().catch(() => {});
  }

  /** A `session-changed` says the file has `lastSeq` events; fetch if we are behind. */
  noteLastSeq(lastSeq: number): void {
    this.#advertised = Math.max(this.#advertised, lastSeq);
    if (this.#loaded && lastSeq > this.lastSeq && this.#ahead.at(-1)?.seq !== lastSeq) void this.sync().catch(() => {});
  }

  /** Fetches everything after the last contiguous event (the whole log on first call). */
  sync(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#running !== undefined) {
      this.#again = true;
      return this.#running;
    }
    const run = async () => {
      try {
        do {
          this.#again = false;
          const after = this.#loaded ? this.lastSeq : undefined;
          const fetched = await this.#fetch(after);
          if (this.#closed) return;
          this.#loaded = true;
          this.#error = undefined;
          this.#absorb(fetched);
          // Notifications seen during the initial load could not start a repair; do it now.
          if (after === undefined && (this.#ahead.length > 0 || this.#advertised > this.lastSeq)) this.#again = true;
        } while (this.#again);
      } catch (error) {
        this.#error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.#running = undefined;
        this.#publish();
      }
    };
    this.#running = run();
    this.#publish();
    return this.#running;
  }

  close(): void {
    this.#closed = true;
    this.#listeners.clear();
  }

  #absorb(incoming: readonly SessionEvent[]): void {
    const before = this.lastSeq;
    const { contiguous, ahead } = splitContiguous(mergeEvents(this.#ahead, incoming), before);
    this.#ahead = ahead;
    if (contiguous.length > 0) this.#events = [...this.#events, ...contiguous];
    this.#publish();
  }

  #publish(): void {
    const snapshot: SessionLogSnapshot = {
      events: this.#events,
      lastSeq: this.lastSeq,
      loaded: this.#loaded,
      syncing: this.#running !== undefined,
      ...(this.#error === undefined ? {} : { error: this.#error }),
    };
    const s = this.#snapshot;
    if (s.events === snapshot.events && s.loaded === snapshot.loaded && s.syncing === snapshot.syncing && s.error === snapshot.error) return;
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}
