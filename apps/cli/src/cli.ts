import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Data, Effect } from "effect";
import type { RpcClientError } from "@effect/rpc";
import { branchOf, HostError, trajectory } from "@basis/contracts";
import type { TrajectoryStep, TrajectoryTurn } from "@basis/contracts";
import { makeHostRpcHttp } from "@basis/client";
import type { HostRpcClient } from "@basis/client";
import { resolvePaths } from "@basis/plugin-host";
import { readDiscovery } from "@basis/plugin-transport";
import type { Discovery } from "@basis/plugin-transport";
import { formatPlugins, formatReload, formatSession, formatSessions, formatStatus, formatStep, formatTrajectory } from "./format.ts";

export const USAGE = `Usage: basis <command> [--json]

Commands:
  serve                        Run the host in this terminal
  status                       Host, composition, plugin states, running turns
  plugins                      Plugin ids, versions, states, and faults
  plugins restart <id>         Restart one plugin and its dependents
  reload                       Re-read config files and apply them
  session list [--cwd <dir>]   Sessions for a directory (default: the current one)
  session list --all           Sessions for every directory
  session show <id>            Session info and its current branch
  inspect <id>                 Turns and steps: model, history, usage, timing, tools
  inspect <id> --step <step>   One step's request: each system section and tool
                               with the plugin that contributed it, then the
                               response and tool runs. <step> is a step id,
                               <turn>.<step> (e.g. 2.1), or "last"

Options:
  --json      Print the result (or {"error": {...}} on stderr) as JSON
  -h, --help  Show this help

Every command except serve talks to the running host found in
$BASIS_HOME/transport.json (default ~/.basis).

Exit codes: 0 ok, 1 the host refused or failed the request, 2 usage error,
3 no running host or it could not be reached.`;

/** Exit codes a calling script or agent can branch on; `--json` errors also carry a `code`. */
export const ExitCode = { ok: 0, failed: 1, usage: 2, unavailable: 3 } as const;

export class CliError extends Data.TaggedError("CliError")<{
  readonly code: string;
  readonly message: string;
  readonly subject?: string;
  readonly exit: number;
}> {}

export interface Io {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Directory the user invoked the command from. */
  readonly cwd: string;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

interface Options {
  readonly json: boolean;
  readonly all: boolean;
  readonly cwd?: string | undefined;
  readonly step?: string | undefined;
}

interface Connection {
  readonly discovery: Discovery;
  readonly rpc: HostRpcClient;
}

/** `json` is printed with `--json`, `text` otherwise. */
interface Output {
  readonly json: unknown;
  readonly text: string;
}

type Command = (connection: Connection) => Effect.Effect<Output, HostError | RpcClientError.RpcClientError | CliError>;

const usage = (message: string) => new CliError({ code: "Usage", message: `${message}\nRun \`basis --help\` for usage.`, exit: ExitCode.usage });

const route = (positionals: readonly string[], options: Options, io: Io): Command | CliError => {
  const [command, sub, arg, ...rest] = positionals;
  const extra = (count: number) => positionals.length > count ? usage(`Unexpected argument "${positionals[count]}"`) : undefined;
  switch (command) {
    case "status":
      return extra(1) ?? (({ discovery, rpc }) =>
        Effect.all([rpc.Host.Info(), rpc.Host.Plugins(), rpc.Agent.Running()], { concurrency: "unbounded" }).pipe(
          Effect.map(([info, plugins, running]) => ({
            json: { url: discovery.url, pid: discovery.pid, startedAt: discovery.startedAt, info, plugins, running },
            text: formatStatus(discovery, info, plugins, running),
          })),
        ));
    case "plugins":
      if (sub === undefined || sub === "list") {
        return extra(sub === undefined ? 1 : 2) ?? (({ rpc }) =>
          Effect.map(rpc.Host.Plugins(), (plugins) => ({ json: plugins, text: formatPlugins(plugins) })));
      }
      if (sub === "restart") {
        if (arg === undefined) return usage("plugins restart needs a plugin id");
        return extra(3) ?? (({ rpc }) =>
          Effect.as(rpc.Host.RestartPlugin({ pluginId: arg }), { json: { restarted: arg }, text: `restarted ${arg}` }));
      }
      return usage(`Unknown plugins command "${sub}"`);
    case "reload":
      return extra(1) ?? (({ rpc }) => Effect.map(rpc.Host.Reload(), (report) => ({ json: report, text: formatReload(report) })));
    case "session":
      if (sub === "list") {
        if (options.all && options.cwd !== undefined) return usage("Use either --all or --cwd");
        const cwd = options.all ? undefined : resolve(io.cwd, options.cwd ?? ".");
        return extra(2) ?? (({ rpc }) => Effect.map(rpc.Session.List(cwd === undefined ? {} : { cwd }), (sessions) => ({
          json: sessions,
          text: sessions.length ? formatSessions(sessions, cwd === undefined) : `No sessions${cwd === undefined ? "" : ` in ${cwd}`}.`,
        })));
      }
      if (sub === "show") {
        if (arg === undefined) return usage("session show needs a session id");
        if (rest.length) return usage(`Unexpected argument "${rest[0]}"`);
        return ({ rpc }) => Effect.gen(function* () {
          const [info, events] = yield* Effect.all([rpc.Session.Get({ sessionId: arg }), rpc.Session.Events({ sessionId: arg })], { concurrency: "unbounded" });
          const branch = branchOf(events, info.leaf);
          return { json: { info, branch }, text: formatSession(info, branch) };
        });
      }
      return usage(sub === undefined ? "session needs a command: list or show" : `Unknown session command "${sub}"`);
    case "inspect": {
      if (sub === undefined) return usage("inspect needs a session id");
      const selector = options.step;
      return extra(2) ?? (({ rpc }) => Effect.gen(function* () {
        const [info, events] = yield* Effect.all([rpc.Session.Get({ sessionId: sub }), rpc.Session.Events({ sessionId: sub })], { concurrency: "unbounded" });
        const turns = trajectory(branchOf(events, info.leaf));
        if (selector === undefined) return { json: { info, turns }, text: formatTrajectory(turns) };
        const found = findStep(turns, selector);
        if (found === undefined) {
          return yield* new CliError({ code: "NotFound", message: `No step "${selector}" on the current branch of ${sub}`, subject: selector, exit: ExitCode.failed });
        }
        return { json: { info, turn: found.turn.index, step: found.step }, text: formatStep(found.turn, found.step) };
      }));
    }
    case undefined:
      return usage("No command given");
    default:
      return usage(`Unknown command "${command}"`);
  }
};

/** A step by id, by `<turn>.<step>` (1-based), or the last step that sent a request. */
const findStep = (turns: readonly TrajectoryTurn[], selector: string): { turn: TrajectoryTurn; step: TrajectoryStep } | undefined => {
  const all = turns.flatMap((turn) => turn.steps.map((step) => ({ turn, step })));
  if (selector === "last") return all.filter(({ step }) => step.request !== undefined).at(-1);
  const position = /^(\d+)\.(\d+)$/.exec(selector);
  if (position !== null) {
    const turn = turns[Number(position[1]) - 1];
    const step = turn?.steps[Number(position[2]) - 1];
    return turn === undefined || step === undefined ? undefined : { turn, step };
  }
  return all.find(({ step }) => step.stepId === selector);
};

/** The running host for this `BASIS_HOME`, over one-shot HTTP calls (no event subscription, so it never answers questions). */
const connect = (io: Io) => Effect.gen(function* () {
  const paths = resolvePaths({ env: io.env, cwd: io.cwd });
  const discovery = yield* readDiscovery(paths.home);
  if (discovery === undefined) {
    return yield* new CliError({
      code: "NoHost",
      message: `No running Basis host for ${paths.home}. Start one with \`basis serve\`.`,
      exit: ExitCode.unavailable,
    });
  }
  return { discovery, rpc: yield* makeHostRpcHttp(discovery.url, discovery.token) };
});

const toCliError = (error: HostError | RpcClientError.RpcClientError | CliError): CliError => {
  if (error instanceof CliError) return error;
  if (error instanceof HostError) {
    return new CliError({ code: error.code, message: error.message, ...(error.subject === undefined ? {} : { subject: error.subject }), exit: ExitCode.failed });
  }
  // `filterStatusOk` turns a rejected token into a failed send; the response status says which it was.
  const status = (error.cause as { readonly response?: { readonly status?: unknown } } | undefined)?.response?.status;
  if (status === 401) {
    return new CliError({ code: "Unauthorized", message: "The host rejected the token in transport.json", exit: ExitCode.unavailable });
  }
  return new CliError({ code: "Unreachable", message: `Cannot reach the host: ${error.message}`, exit: ExitCode.unavailable });
};

const report = (io: Io, json: boolean, error: CliError): number => {
  if (json) {
    io.err(JSON.stringify({ error: { code: error.code, message: error.message, ...(error.subject === undefined ? {} : { subject: error.subject }) } }));
  } else {
    io.err(`basis: ${error.message}`);
  }
  return error.exit;
};

/** Runs one command (anything but `serve`) and returns the exit code. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const wantsJson = argv.includes("--json");
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        all: { type: "boolean", default: false },
        cwd: { type: "string" },
        step: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    return report(io, wantsJson, usage(error instanceof Error ? error.message : String(error)));
  }
  const { positionals, values } = parsed;
  if (values.help) {
    io.out(USAGE);
    return ExitCode.ok;
  }
  const options: Options = { json: values.json, all: values.all, cwd: values.cwd, step: values.step };
  const command = route(positionals, options, io);
  if (command instanceof CliError) return report(io, options.json, command);

  const result = await Effect.runPromise(Effect.scoped(Effect.flatMap(connect(io), command)).pipe(Effect.either));
  if (result._tag === "Left") return report(io, options.json, toCliError(result.left));
  io.out(options.json ? JSON.stringify(result.right.json, null, 2) : result.right.text);
  return ExitCode.ok;
}
