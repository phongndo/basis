import { Cause, Duration, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { HostError } from "@basis/contracts";
import type {
  AuthType,
  CommandInfo,
  CommandResult,
  DirectoryListing,
  GitBranch,
  HostEvent,
  HostInfo,
  InteractionAnswer,
  ModelInfo,
  PluginStatus,
  PromptContent,
  ProviderInfo,
  SessionEvent,
  SessionInfo,
  TurnOptions,
  WorkspaceStatus,
} from "@basis/contracts";
import { makeHostRpc, rpcUrl } from "./rpc.ts";
import type { HostRpcClient } from "./rpc.ts";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

export interface ConnectionStatus {
  readonly state: ConnectionState;
  /** Increments on every successful (re)connect; resync when it changes. */
  readonly generation: number;
  /** Failed attempts since the last successful connect. */
  readonly attempts: number;
  /** Epoch ms of the next attempt while reconnecting. */
  readonly retryAt?: number;
  readonly error?: string;
}

export interface ReloadResult {
  readonly started: readonly string[];
  readonly restarted: readonly string[];
  readonly stopped: readonly string[];
}

/**
 * Promise-returning facade over `HostRpcs`. Methods reject with `HostError`
 * for domain failures and a plain `Error` for transport failures. The web app
 * depends on this interface only, so a fake can stand in for it.
 */
export interface Host {
  readonly session: {
    readonly list: (cwd?: string) => Promise<readonly SessionInfo[]>;
    readonly get: (sessionId: string) => Promise<SessionInfo>;
    readonly create: (cwd?: string) => Promise<SessionInfo>;
    readonly events: (sessionId: string, after?: number) => Promise<readonly SessionEvent[]>;
    readonly checkout: (sessionId: string, eventId: string) => Promise<SessionInfo>;
    readonly setTitle: (sessionId: string, title: string) => Promise<SessionInfo>;
  };
  readonly agent: {
    /** Resolves when the turn ends. */
    readonly prompt: (sessionId: string, content: PromptContent, options?: TurnOptions) => Promise<void>;
    readonly cancel: (sessionId: string) => Promise<void>;
    readonly running: () => Promise<readonly string[]>;
  };
  readonly llm: {
    readonly providers: () => Promise<readonly ProviderInfo[]>;
    readonly models: (available?: boolean) => Promise<readonly ModelInfo[]>;
    readonly login: (provider: string, type: AuthType) => Promise<void>;
    readonly logout: (provider: string) => Promise<void>;
  };
  readonly interaction: {
    readonly answer: (id: string, answer: InteractionAnswer) => Promise<void>;
    readonly dismiss: (id: string) => Promise<void>;
  };
  readonly workspace: {
    readonly status: (path: string) => Promise<WorkspaceStatus>;
    readonly browse: (partialPath: string) => Promise<DirectoryListing>;
    readonly createDirectory: (path: string) => Promise<WorkspaceStatus>;
    readonly createWorktree: (path: string, options: { branch: string; base?: string }) => Promise<WorkspaceStatus>;
    readonly branches: (path: string) => Promise<readonly GitBranch[]>;
    readonly checkout: (path: string, branch: string, options?: { create?: boolean }) => Promise<WorkspaceStatus>;
  };
  readonly commands: {
    readonly list: () => Promise<readonly CommandInfo[]>;
    /** Resolves when the command ends; its questions arrive as `interaction` events. */
    readonly run: (id: string, context?: { cwd?: string; sessionId?: string }) => Promise<CommandResult>;
  };
  readonly host: {
    readonly info: () => Promise<HostInfo>;
    readonly plugins: () => Promise<readonly PluginStatus[]>;
    readonly restartPlugin: (pluginId: string) => Promise<void>;
    readonly reload: () => Promise<ReloadResult>;
  };
  readonly status: () => ConnectionStatus;
  /** Called immediately with the current status, then on every change. */
  readonly onStatus: (listener: (status: ConnectionStatus) => void) => () => void;
  /** Live `Host.Events`. Losable: repair from `Session.Events` (see `SessionLog`). */
  readonly onEvent: (listener: (event: HostEvent) => void) => () => void;
  readonly close: () => Promise<void>;
}

export interface ConnectOptions {
  /** Page or host base URL; `/rpc` is resolved against it. */
  readonly url: string;
  readonly token?: string | undefined;
  /** Delay before reconnect attempt `n` (1-based). Default: 250ms doubling, capped at 5s. */
  readonly backoff?: (attempt: number) => number;
  /** How long a connect probe may take before the attempt counts as failed. Default 8s. */
  readonly probeTimeoutMs?: number;
}

export const defaultBackoff = (attempt: number): number => Math.min(5_000, 250 * 2 ** Math.max(0, attempt - 1));

/** Runs an effect to a promise that rejects with the squashed failure rather than a FiberFailure wrapper. */
export const runPromise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) => (Exit.isSuccess(exit) ? exit.value : Promise.reject(toError(Cause.squash(exit.cause)))));

const toError = (error: unknown): unknown => {
  if (error instanceof HostError || error instanceof Error) return error;
  if (typeof error === "object" && error !== null && "message" in error) return new Error(String(error.message));
  return new Error(String(error));
};

export const describeError = (error: unknown): string => {
  if (error instanceof HostError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
};

/**
 * Opens the connection and keeps a `Host.Events` subscription alive with
 * backoff. Each (re)connect is confirmed with `Host.Info` before the status
 * turns `connected`, so `generation` changes only when calls can succeed.
 */
export const connect = async (options: ConnectOptions): Promise<Host> => {
  const scope = await runPromise(Scope.make());
  const rpc: HostRpcClient = await runPromise(Scope.extend(makeHostRpc(rpcUrl(options.url, options.token)), scope));
  const backoff = options.backoff ?? defaultBackoff;
  const probeTimeout = Duration.millis(options.probeTimeoutMs ?? 8_000);

  let status: ConnectionStatus = { state: "connecting", generation: 0, attempts: 0 };
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  const eventListeners = new Set<(event: HostEvent) => void>();
  const setStatus = (next: ConnectionStatus) => {
    status = next;
    for (const listener of statusListeners) listener(next);
  };
  const emit = (event: HostEvent) => {
    for (const listener of eventListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Host event listener failed", error);
      }
    }
  };

  const attempt = Effect.gen(function* () {
    // Subscribe first so nothing published after the probe is missed.
    const events = yield* rpc.Host.Events().pipe(
      Stream.runForEach((event) => Effect.sync(() => emit(event))),
      Effect.fork,
    );
    const probe = yield* rpc.Host.Info().pipe(Effect.timeoutFail({ duration: probeTimeout, onTimeout: () => new Error("Timed out") }), Effect.either);
    if (probe._tag === "Left") {
      yield* Fiber.interrupt(events);
      return describeError(toError(probe.left));
    }
    setStatus({ state: "connected", generation: status.generation + 1, attempts: 0 });
    const exit = yield* Fiber.await(events);
    return Exit.isFailure(exit) ? describeError(toError(Cause.squash(exit.cause))) : "Event stream ended";
  });

  const loop = Effect.gen(function* () {
    for (;;) {
      const error = yield* attempt;
      const attempts = status.attempts + 1;
      const delay = backoff(attempts);
      setStatus({
        state: status.generation === 0 ? "connecting" : "reconnecting",
        generation: status.generation,
        attempts,
        retryAt: Date.now() + delay,
        error,
      });
      yield* Effect.sleep(Duration.millis(delay));
    }
  });
  const fiber = Effect.runFork(loop);

  const call = <A, E>(effect: Effect.Effect<A, E>) => runPromise(effect);
  const unit = <E>(effect: Effect.Effect<unknown, E>) => runPromise(Effect.asVoid(effect));

  return {
    session: {
      list: (cwd) => call(rpc.Session.List(cwd === undefined ? {} : { cwd })),
      get: (sessionId) => call(rpc.Session.Get({ sessionId })),
      create: (cwd) => call(rpc.Session.Create(cwd === undefined ? {} : { cwd })),
      events: (sessionId, after) => call(rpc.Session.Events(after === undefined ? { sessionId } : { sessionId, after })),
      checkout: (sessionId, eventId) => call(rpc.Session.Checkout({ sessionId, eventId })),
      setTitle: (sessionId, title) => call(rpc.Session.SetTitle({ sessionId, title })),
    },
    agent: {
      prompt: (sessionId, content, turn) => unit(rpc.Agent.Prompt(turn === undefined ? { sessionId, content } : { sessionId, content, options: turn })),
      cancel: (sessionId) => unit(rpc.Agent.Cancel({ sessionId })),
      running: () => call(rpc.Agent.Running()),
    },
    llm: {
      providers: () => call(rpc.Llm.Providers()),
      models: (available) => call(rpc.Llm.Models(available === undefined ? {} : { available })),
      login: (provider, type) => unit(rpc.Llm.Login({ provider, type })),
      logout: (provider) => unit(rpc.Llm.Logout({ provider })),
    },
    interaction: {
      answer: (id, answer) => unit(rpc.Interaction.Answer({ id, answer })),
      dismiss: (id) => unit(rpc.Interaction.Dismiss({ id })),
    },
    workspace: {
      status: (path) => call(rpc.Workspace.Status({ path })),
      browse: (partialPath) => call(rpc.Workspace.Browse({ partialPath })),
      createDirectory: (path) => call(rpc.Workspace.CreateDirectory({ path })),
      createWorktree: (path, options) =>
        call(
          rpc.Workspace.CreateWorktree(options.base === undefined ? { path, branch: options.branch } : { path, branch: options.branch, base: options.base }),
        ),
      branches: (path) => call(rpc.Workspace.Branches({ path })),
      checkout: (path, branch, options) =>
        call(rpc.Workspace.Checkout(options?.create === undefined ? { path, branch } : { path, branch, create: options.create })),
    },
    commands: {
      list: () => call(rpc.Command.List()),
      run: (id, context) =>
        call(
          rpc.Command.Run({
            id,
            ...(context?.cwd === undefined ? {} : { cwd: context.cwd }),
            ...(context?.sessionId === undefined ? {} : { sessionId: context.sessionId }),
          }),
        ),
    },
    host: {
      info: () => call(rpc.Host.Info()),
      plugins: () => call(rpc.Host.Plugins()),
      restartPlugin: (pluginId) => unit(rpc.Host.RestartPlugin({ pluginId })),
      reload: () => call(rpc.Host.Reload()),
    },
    status: () => status,
    onStatus: (listener) => {
      statusListeners.add(listener);
      listener(status);
      return () => {
        statusListeners.delete(listener);
      };
    },
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    close: async () => {
      await runPromise(Fiber.interrupt(fiber));
      await runPromise(Scope.close(scope, Exit.void));
      setStatus({ ...status, state: "closed" });
      statusListeners.clear();
      eventListeners.clear();
    },
  };
};
