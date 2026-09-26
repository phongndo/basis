import { Cause, Effect, Exit, Scope } from "effect";
import { HostError } from "@basis/contracts";
import { makeHostClient } from "@basis/client/browser";
import type { HostClientService } from "@basis/client/browser";

export const DEFAULT_HOST = "http://127.0.0.1:4096";
const SETTINGS_KEY = "basis.host";

export interface HostSettings {
  readonly url: string;
  readonly token: string;
}

/** `?host=&token=` wins over what was saved; a successful connect saves for next time. */
export const readSettings = (): HostSettings | undefined => {
  const query = new URLSearchParams(window.location.search);
  const fromQuery = { url: query.get("host") ?? "", token: query.get("token") ?? "" };
  if (fromQuery.url || fromQuery.token) return { url: fromQuery.url || DEFAULT_HOST, token: fromQuery.token };
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    return saved === null ? undefined : (JSON.parse(saved) as HostSettings);
  } catch {
    return undefined;
  }
};

export const saveSettings = (settings: HostSettings): void => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
export const clearSettings = (): void => localStorage.removeItem(SETTINGS_KEY);

export interface Connection {
  readonly client: HostClientService;
  readonly close: () => Promise<void>;
}

/** Runs an effect to a promise that rejects with the squashed failure rather than a FiberFailure wrapper. */
export const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) => Exit.isSuccess(exit) ? exit.value : Promise.reject(Cause.squash(exit.cause)));

export const describeError = (error: unknown): string => {
  if (error instanceof HostError) return `${error.message} (${error.code})`;
  if (error instanceof Error) return error.message;
  return String(error);
};

/** The socket reconnects by itself; the client lives until `close`. */
export const connect = async (settings: HostSettings): Promise<Connection> => {
  const scope = await run(Scope.make());
  const client = await run(Scope.extend(makeHostClient({ ...settings, transport: "websocket" }), scope));
  return { client, close: () => run(Scope.close(scope, Exit.void)) };
};
