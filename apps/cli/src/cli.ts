import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import {
  branchOf,
  HostError,
  LEDGER_SORTS,
  ledger,
  parseLedgerFilter,
  promptDiff,
  rebuildRequest,
  recordStart,
  recordsBetween,
  recordSummary,
  sortRecords,
  trajectory,
} from "@basis/contracts";
import type { LedgerSort, TrajectoryStep, TrajectoryTurn } from "@basis/contracts";
import { makeHostRpc, makeHostRpcHttp, rpcUrl } from "@basis/client";
import { resolvePaths } from "@basis/plugin-host";
import { readDiscovery } from "@basis/plugin-transport";
import { CliError, ExitCode, usage } from "./command.ts";
import type { Command, Failure, Io, Options, QuestionPolicy } from "./command.ts";
import {
  formatDiff,
  formatPlugins,
  formatRecords,
  formatReload,
  formatSession,
  formatSessions,
  formatStatus,
  formatStep,
  formatSystem,
  formatTools,
  formatTrajectory,
} from "./format.ts";
import {
  answerCommand,
  cancelCommand,
  dismissCommand,
  doCommand,
  eventsCommand,
  loginCommand,
  logoutCommand,
  modelsCommand,
  providersCommand,
  listCommandsCommand,
  questionsCommand,
  runCommand,
} from "./live.ts";
import { workspaceCommand } from "./workspace.ts";

export { CliError, ExitCode } from "./command.ts";
export type { Io } from "./command.ts";

export const USAGE = `Usage: basis <command> [options] [--json]

Everything the web app can do, from a shell. Every command except serve talks
to the running host found in $BASIS_HOME/transport.json (default ~/.basis).

Host
  serve                          Run the host in this terminal
  status                         Host, composition, plugin states, running turns
  plugins                        Plugin ids, versions, states, and faults
  plugins restart <id>           Restart one plugin and its dependents
  reload                         Re-read config files and apply them
  events [--session <id>]        Follow everything the host publishes (NDJSON with --json)

Sessions and turns
  session list [--cwd <dir>]     Sessions for a directory (default: the current one); --all for every one
  session show <id>              Session info and its current branch as a transcript
  session new [--cwd <dir>]      Create a session (default: the current directory)
  session title <id> <title>     Rename a session
  session checkout <id> <event>  Move the session's leaf: the next prompt branches from that event
  run <id|new> <prompt…>         Send a prompt and wait for the turn to end
    --model <provider/model>     Model for this turn (see basis models)
    --thinking <level>           off, minimal, low, medium, high, xhigh, max
    --image <file>               Attach an image (repeatable)
    --follow                     Stream the turn: text, tool calls, results (NDJSON with --json)
    --cwd <dir>                  Directory for a new session
  cancel <id>                    Cancel the session's running turn

Commands (what the web app's command palette runs; plugins add them)
  do                             List commands: id, title, category, and the plugin that added it
  do <command>                   Run one in the current directory (or --cwd); --session <id> for its session
                                 Its questions are answered like a login's (see --questions, --answer)

Questions the host asks (logins, tools that confirm)
  questions                      Open questions, with their ids
  answer <question> <value>      Answer one: yes/no, text, or an option (value, label, or number)
  dismiss <question>             Dismiss one
    While run --follow, login, do, or events --questions … is attached:
    --questions ask|ignore|dismiss   ask at the terminal (default when there is one), leave them
                                     to another client such as the web app (default otherwise), or dismiss
    --answer <value>               Answer the next question with this (repeatable, in order)

Providers and models
  providers                      Providers, whether they are configured, and how to log in
  login <provider> [--method api_key|oauth]
  logout <provider>
  models [--all]                 Models you can use now (--all: every known model)

Workspace (the project directory; --path defaults to the current one)
  workspace status [path]        Whether it exists, git branch, head, changes, upstream
  workspace branches [path]      Local branches by recency, then remote-only ones
  workspace checkout <branch> [--create] [--path <dir>]
  workspace worktree <branch> [--base <ref>] [--path <dir>]
                                 A linked worktree on a new branch, as the web app's "new worktree"
  workspace mkdir <path>         Create a directory
  workspace browse [partial]     Complete a directory path, as the add-project dialog does

Inspect (the web app's Trajectory view)
  inspect <id>                   Turns and steps: model, history, usage, timing, tools
  inspect <id> --records         Every record (prompt, system change, model call, tool run) as a table
    --filter <query>             is:error, is:running, kind:model, tool:bash, turn:2, req:5, text,
                                 and -term to exclude (implies --records)
    --sort <column> [--desc]     time, name, status, type, tokens, or duration
    --range <from>..<to>         Only records active in that span, as offsets from the first
                                 record (90s, 1m30s, 500ms; either side may be empty)
  inspect <id> --request <r>     One request: each system section and tool with the plugin that
                                 contributed it, then the response and tool runs. <r> is a request
                                 number (5), <turn>.<step> (2.1), a step id, or "last"
    --system                     ...only the system prompt, section by section
    --tools                      ...only the tool definitions
    --diff                       ...how its system prompt differs from the request before
    --rebuilt                    ...the exact request sent to the model, as JSON
  inspect <id> --step <step>     Same as --request

Options
  --json      Print results as JSON (errors as {"error": {...}} on stderr)
  -h, --help  Show this help

Exit codes: 0 ok, 1 the host refused or failed the request (or the turn failed),
2 usage error, 3 no running host or it could not be reached.`;

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** `90s`, `1m30s`, `500ms`, `2m`, or bare seconds, in milliseconds. */
export const parseOffset = (text: string): number | undefined => {
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let total = 0;
  const rest = text.replace(/(\d+(?:\.\d+)?)(ms|s|m|h)/g, (_, value: string, unit: string) => {
    total += Number(value) * units[unit]!;
    return "";
  });
  return rest === "" && text !== "" ? total : undefined;
};

const route = (positionals: readonly string[], options: Options, io: Io): Command | CliError => {
  const [command, sub, arg, ...rest] = positionals;
  const extra = (count: number) => (positionals.length > count ? usage(`Unexpected argument "${positionals[count]}"`) : undefined);
  switch (command) {
    case "status":
      return (
        extra(1) ??
        (({ discovery, rpc }) =>
          Effect.all([rpc.Host.Info(), rpc.Host.Plugins(), rpc.Agent.Running()], { concurrency: "unbounded" }).pipe(
            Effect.map(([info, plugins, running]) => ({
              json: { url: discovery.url, pid: discovery.pid, startedAt: discovery.startedAt, info, plugins, running },
              text: formatStatus(discovery, info, plugins, running),
            })),
          ))
      );
    case "plugins":
      if (sub === undefined || sub === "list") {
        return (
          extra(sub === undefined ? 1 : 2) ?? (({ rpc }) => Effect.map(rpc.Host.Plugins(), (plugins) => ({ json: plugins, text: formatPlugins(plugins) })))
        );
      }
      if (sub === "restart") {
        if (arg === undefined) return usage("plugins restart needs a plugin id");
        return extra(3) ?? (({ rpc }) => Effect.as(rpc.Host.RestartPlugin({ pluginId: arg }), { json: { restarted: arg }, text: `restarted ${arg}` }));
      }
      return usage(`Unknown plugins command "${sub}"`);
    case "reload":
      return extra(1) ?? (({ rpc }) => Effect.map(rpc.Host.Reload(), (report) => ({ json: report, text: formatReload(report) })));
    case "events":
      return extra(1) ?? eventsCommand;
    case "session":
      return sessionCommand(sub, arg, rest, options, io);
    case "run": {
      if (sub === undefined || (positionals.length < 3 && options.images.length === 0)) return usage("run needs a session id (or new) and a prompt");
      if (options.thinking !== undefined && !THINKING.has(options.thinking)) return usage(`--thinking must be one of ${[...THINKING].join(", ")}`);
      return runCommand(sub, positionals.slice(2));
    }
    case "cancel":
      if (sub === undefined) return usage("cancel needs a session id");
      return extra(2) ?? cancelCommand(sub);
    case "do":
      if (sub === undefined) return listCommandsCommand;
      return extra(2) ?? doCommand(sub);
    case "questions":
      return extra(1) ?? questionsCommand;
    case "answer":
      if (sub === undefined || arg === undefined) return usage("answer needs a question id and a value");
      return answerCommand(sub, positionals.slice(2));
    case "dismiss":
      if (sub === undefined) return usage("dismiss needs a question id");
      return extra(2) ?? dismissCommand(sub);
    case "providers":
      return extra(1) ?? providersCommand;
    case "models":
      return extra(1) ?? modelsCommand;
    case "login":
      if (sub === undefined) return usage("login needs a provider id (see basis providers)");
      return extra(2) ?? loginCommand(sub);
    case "logout":
      if (sub === undefined) return usage("logout needs a provider id");
      return extra(2) ?? logoutCommand(sub);
    case "workspace":
      return workspaceCommand(sub, positionals.slice(2), io, options);
    case "inspect":
      if (sub === undefined) return usage("inspect needs a session id");
      return extra(2) ?? inspectCommand(sub, options);
    case undefined:
      return usage("No command given");
    default:
      return usage(`Unknown command "${command}"`);
  }
};

const sessionCommand = (sub: string | undefined, arg: string | undefined, rest: readonly string[], options: Options, io: Io): Command | CliError => {
  switch (sub) {
    case "list": {
      if (arg !== undefined) return usage(`Unexpected argument "${arg}"`);
      if (options.all && options.cwd !== undefined) return usage("Use either --all or --cwd");
      const cwd = options.all ? undefined : resolve(io.cwd, options.cwd ?? ".");
      return ({ rpc }) =>
        Effect.map(rpc.Session.List(cwd === undefined ? {} : { cwd }), (sessions) => ({
          json: sessions,
          text: sessions.length ? formatSessions(sessions, cwd === undefined) : `No sessions${cwd === undefined ? "" : ` in ${cwd}`}.`,
        }));
    }
    case "show":
      if (arg === undefined) return usage("session show needs a session id");
      if (rest.length) return usage(`Unexpected argument "${rest[0]}"`);
      return ({ rpc }) =>
        Effect.gen(function* () {
          const [info, events] = yield* Effect.all([rpc.Session.Get({ sessionId: arg }), rpc.Session.Events({ sessionId: arg })], { concurrency: "unbounded" });
          const branch = branchOf(events, info.leaf);
          return { json: { info, branch }, text: formatSession(info, branch) };
        });
    case "new":
      if (arg !== undefined) return usage(`Unexpected argument "${arg}"`);
      return ({ rpc }) => Effect.map(rpc.Session.Create({ cwd: resolve(io.cwd, options.cwd ?? ".") }), (info) => ({ json: info, text: info.id }));
    case "title": {
      const title = rest.join(" ").trim();
      if (arg === undefined || title === "") return usage("session title needs a session id and a title");
      return ({ rpc }) => Effect.map(rpc.Session.SetTitle({ sessionId: arg, title }), (info) => ({ json: info, text: `${info.id}  ${info.title ?? ""}` }));
    }
    case "checkout": {
      const eventId = rest[0];
      if (arg === undefined || eventId === undefined) return usage("session checkout needs a session id and an event id");
      if (rest.length > 1) return usage(`Unexpected argument "${rest[1]}"`);
      return ({ rpc }) =>
        Effect.map(rpc.Session.Checkout({ sessionId: arg, eventId }), (info) => ({
          json: info,
          text: `${info.id} now continues from ${eventId}; the next prompt starts a new branch there`,
        }));
    }
    default:
      return usage(sub === undefined ? "session needs a command: list, show, new, title, or checkout" : `Unknown session command "${sub}"`);
  }
};

const inspectCommand = (sessionId: string, options: Options): Command | CliError => {
  const selector = options.step;
  const listing = options.records || options.filter !== undefined || options.sort !== undefined || options.range !== undefined;
  if (options.view !== undefined && selector === undefined) return usage(`--${options.view} needs --request`);
  if (selector !== undefined && listing) return usage("Use either --request or --records/--filter/--sort/--range");
  if (options.sort !== undefined && !(LEDGER_SORTS as readonly string[]).includes(options.sort))
    return usage(`--sort must be one of ${LEDGER_SORTS.join(", ")}`);
  let range: { from: number | undefined; to: number | undefined } | undefined;
  if (options.range !== undefined) {
    const [from, to, ...more] = options.range.split("..");
    const start = from === undefined || from === "" ? undefined : parseOffset(from);
    const end = to === undefined || to === "" ? undefined : parseOffset(to);
    if (to === undefined || more.length > 0 || (from !== "" && start === undefined) || (to !== "" && end === undefined)) {
      return usage("--range looks like 30s..1m30s (either side may be empty)");
    }
    range = { from: start, to: end };
  }
  return ({ rpc }) =>
    Effect.gen(function* () {
      const [info, events] = yield* Effect.all([rpc.Session.Get({ sessionId }), rpc.Session.Events({ sessionId })], { concurrency: "unbounded" });
      const branch = branchOf(events, info.leaf);
      const turns = trajectory(branch);
      if (listing) {
        const running = turns.at(-1)?.end === undefined;
        let records = ledger(turns).filter(parseLedgerFilter(options.filter ?? ""));
        if (range !== undefined && records.length > 0) {
          const origin = Math.min(...ledger(turns).map(recordStart));
          records = recordsBetween(records, origin + (range.from ?? 0), range.to === undefined ? Infinity : origin + range.to);
        }
        records = sortRecords(records, (options.sort ?? "time") as LedgerSort, options.desc, running);
        return { json: records.map((record) => recordSummary(record, running)), text: formatRecords(records, running) };
      }
      if (selector === undefined) return { json: { info, turns }, text: formatTrajectory(turns) };
      const found = findStep(turns, selector);
      if (found === undefined) {
        return yield* new CliError({
          code: "NotFound",
          message: `No request "${selector}" on the current branch of ${sessionId}`,
          subject: selector,
          exit: ExitCode.failed,
        });
      }
      const request = found.step.request;
      if (options.view !== undefined && request === undefined) {
        return yield* new CliError({
          code: "NotFound",
          message: `Step ${found.turn.index}.${found.step.index} logged no request`,
          subject: selector,
          exit: ExitCode.failed,
        });
      }
      switch (options.view) {
        case "system":
          return { json: request!.sections, text: formatSystem(request!) };
        case "tools":
          return { json: request!.tools, text: formatTools(request!) };
        case "diff": {
          const requests = turns.flatMap((turn) => turn.steps.flatMap((step) => (step.request === undefined ? [] : [step.request])));
          const previous = requests[requests.indexOf(request!) - 1];
          const diff = promptDiff(previous, request!);
          return { json: { previous: previous?.eventId, sections: diff }, text: formatDiff(diff, previous === undefined) };
        }
        case "rebuilt": {
          const rebuilt = rebuildRequest(branch, request!.eventId, sessionId);
          return { json: rebuilt, text: JSON.stringify(rebuilt, null, 2) };
        }
        case undefined:
          return { json: { info, turn: found.turn.index, step: found.step }, text: formatStep(found.turn, found.step) };
      }
    });
};

/** A step by request number, by `<turn>.<step>` (1-based), by step id, or the last step that sent a request. */
const findStep = (turns: readonly TrajectoryTurn[], selector: string): { turn: TrajectoryTurn; step: TrajectoryStep } | undefined => {
  const all = turns.flatMap((turn) => turn.steps.map((step) => ({ turn, step })));
  const requests = all.filter(({ step }) => step.request !== undefined);
  if (selector === "last") return requests.at(-1);
  if (/^\d+$/.test(selector)) return requests[Number(selector) - 1];
  const position = /^(\d+)\.(\d+)$/.exec(selector);
  if (position !== null) {
    const turn = turns[Number(position[1]) - 1];
    const step = turn?.steps[Number(position[2]) - 1];
    return turn === undefined || step === undefined ? undefined : { turn, step };
  }
  return all.find(({ step }) => step.stepId === selector);
};

/**
 * The running host for this `BASIS_HOME`: one-shot HTTP calls for most
 * commands, and a WebSocket (opened only when a command follows events) for
 * streaming and questions, as the web app uses.
 */
const connect = (io: Io) =>
  Effect.gen(function* () {
    const paths = resolvePaths({ env: io.env, cwd: io.cwd });
    const discovery = yield* readDiscovery(paths.home);
    if (discovery === undefined) {
      return yield* new CliError({
        code: "NoHost",
        message: `No running Basis host for ${paths.home}. Start one with \`basis serve\`.`,
        exit: ExitCode.unavailable,
      });
    }
    const rpc = yield* makeHostRpcHttp(discovery.url, discovery.token);
    const live = yield* Effect.cached(makeHostRpc(rpcUrl(discovery.url, discovery.token)));
    return { discovery, rpc, live };
  });

const toCliError = (error: Failure): CliError => {
  if (error instanceof CliError) return error;
  if (error instanceof HostError) {
    return new CliError({
      code: error.code,
      message: error.message,
      ...(error.subject === undefined ? {} : { subject: error.subject }),
      exit: ExitCode.failed,
    });
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

const QUESTION_POLICIES = new Set(["ask", "ignore", "dismiss"]);

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
        request: { type: "string" },
        filter: { type: "string" },
        records: { type: "boolean", default: false },
        system: { type: "boolean", default: false },
        tools: { type: "boolean", default: false },
        diff: { type: "boolean", default: false },
        rebuilt: { type: "boolean", default: false },
        sort: { type: "string" },
        desc: { type: "boolean", default: false },
        range: { type: "string" },
        model: { type: "string" },
        thinking: { type: "string" },
        image: { type: "string", multiple: true, default: [] },
        follow: { type: "boolean", short: "f", default: false },
        questions: { type: "string" },
        answer: { type: "string", multiple: true, default: [] },
        method: { type: "string" },
        create: { type: "boolean", default: false },
        base: { type: "string" },
        path: { type: "string" },
        session: { type: "string" },
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
  const views = (["system", "tools", "diff", "rebuilt"] as const).filter((view) => values[view]);
  if (views.length > 1) return report(io, values.json, usage(`Use one of ${views.map((view) => `--${view}`).join(", ")}`));
  if (values.request !== undefined && values.step !== undefined) return report(io, values.json, usage("Use either --request or --step"));
  if (values.questions !== undefined && !QUESTION_POLICIES.has(values.questions))
    return report(io, values.json, usage("--questions must be ask, ignore, or dismiss"));
  const options: Options = {
    json: values.json,
    all: values.all,
    cwd: values.cwd,
    step: values.request ?? values.step,
    filter: values.filter,
    records: values.records,
    view: views[0],
    sort: values.sort,
    desc: values.desc,
    range: values.range,
    model: values.model,
    thinking: values.thinking,
    images: values.image,
    follow: values.follow,
    questions: values.questions as QuestionPolicy | undefined,
    answers: values.answer,
    method: values.method,
    create: values.create,
    base: values.base,
    path: values.path,
    session: values.session,
  };
  const command = route(positionals, options, io);
  if (command instanceof CliError) return report(io, options.json, command);

  const result = await Effect.runPromise(Effect.scoped(Effect.flatMap(connect(io), (connection) => command(connection, io, options))).pipe(Effect.either));
  if (result._tag === "Left") return report(io, options.json, toCliError(result.left));
  const output = result.right;
  if (output === undefined) return ExitCode.ok;
  io.out(options.json ? JSON.stringify(output.json, null, output.compact ? undefined : 2) : output.text);
  return output.exit ?? ExitCode.ok;
}
