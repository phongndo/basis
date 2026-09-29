import { recordDuration, recordName, recordStatus, RECORD_KIND_LABEL } from "@basis/contracts";
import type {
  CommandInfo,
  DirectoryListing,
  GitBranch,
  HostInfo,
  InteractionRequest,
  LedgerRecord,
  ModelInfo,
  PluginStatus,
  ProviderInfo,
  SectionDiff,
  SessionEvent,
  SessionInfo,
  TrajectoryRequest,
  TrajectoryStep,
  TrajectoryTurn,
  Usage,
  WorkspaceStatus,
} from "@basis/contracts";
import type { TurnResult } from "./live.ts";
import type { Discovery } from "@basis/plugin-transport";

/** Human-readable output. `--json` bypasses all of this and prints the contract shapes. */

const pad = (rows: readonly (readonly string[])[]): string => {
  const widths = rows.reduce<number[]>((acc, row) => row.map((cell, i) => Math.max(acc[i] ?? 0, cell.length)), []);
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
};

const time = (ms: number): string => {
  const date = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

const countStates = (plugins: readonly PluginStatus[]): string => {
  const counts = new Map<string, number>();
  for (const plugin of plugins) counts.set(plugin.state, (counts.get(plugin.state) ?? 0) + 1);
  return [...counts].map(([state, count]) => `${count} ${state}`).join(", ");
};

export const formatStatus = (discovery: Discovery, info: HostInfo, plugins: readonly PluginStatus[], running: readonly string[]): string =>
  pad([
    ["host", `${discovery.url} (pid ${discovery.pid}, transport ${info.version})`],
    ["home", info.home],
    ["project", info.cwd],
    ["composition", `${info.composition.id.slice(0, 12)} (${info.composition.plugins.length} plugins)`],
    ["plugins", countStates(plugins) || "none"],
    ["running", running.length ? running.join(", ") : "none"],
  ]);

export const formatPlugins = (plugins: readonly PluginStatus[]): string =>
  pad(
    plugins.map((plugin) => [
      plugin.id,
      plugin.version ?? "",
      plugin.state,
      plugin.fault !== undefined
        ? `${plugin.fault.phase}${plugin.fault.operation === undefined ? "" : ` ${plugin.fault.operation}`}: ${plugin.fault.message}`
        : plugin.haltedBy !== undefined
          ? `halted by ${plugin.haltedBy}`
          : "",
    ]),
  );

export const formatReload = (report: {
  readonly started: readonly string[];
  readonly restarted: readonly string[];
  readonly stopped: readonly string[];
}): string => {
  const parts = [
    report.started.length ? `started ${report.started.join(", ")}` : "",
    report.restarted.length ? `restarted ${report.restarted.join(", ")}` : "",
    report.stopped.length ? `stopped ${report.stopped.join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : "nothing changed";
};

export const formatSessions = (sessions: readonly SessionInfo[], withCwd: boolean): string =>
  pad(sessions.map((session) => [session.id, time(session.updatedAt), session.title ?? "(untitled)", ...(withCwd ? [session.cwd] : [])]));

/** Long tool output is cut to its first lines; `--json` has the full content. */
const MAX_LINES = 12;

const clip = (text: string): string => {
  const lines = text.trimEnd().split("\n");
  return lines.length <= MAX_LINES ? lines.join("\n") : [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more lines`].join("\n");
};

const texts = (content: readonly { readonly type: string; readonly text?: string }[]): string =>
  content.map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`)).join("\n");

const eventLines = (event: SessionEvent): string[] => {
  const data = event.data;
  switch (data.type) {
    case "message": {
      const message = data.message;
      if (message.role === "user") return [`── user`, texts(message.content)];
      if (message.role === "toolResult") return [`── ${message.toolName}${message.isError ? " (error)" : ""}`, clip(texts(message.content))];
      const lines = [`── assistant (${message.provider}/${message.model})`];
      for (const part of message.content) {
        if (part.type === "text") lines.push(part.text);
        else if (part.type === "toolCall") lines.push(`→ ${part.name} ${JSON.stringify(part.arguments)}`);
      }
      if (message.errorMessage !== undefined) lines.push(`error: ${message.errorMessage}`);
      return lines;
    }
    case "attempt":
      return [`── failed model call (${data.message.stopReason})${data.message.errorMessage === undefined ? "" : `: ${data.message.errorMessage}`}`];
    case "compaction":
      return [`── compacted ${data.tokensBefore} tokens (${data.source})`, clip(data.summary)];
    case "turn-end":
      return data.reason === "done" ? [] : [`── turn ended: ${data.reason}${data.error === undefined ? "" : ` — ${data.error}`}`];
    default:
      return [];
  }
};

/** The session header and the current branch as a transcript. Request headers are left to `--json`. */
export const formatSession = (info: SessionInfo, branch: readonly SessionEvent[]): string => {
  const header = pad([
    ["session", `${info.id}${info.title === undefined ? "" : `  ${info.title}`}`],
    ["cwd", info.cwd],
    ["created", time(info.createdAt)],
    ["updated", time(info.updatedAt)],
    ["events", `${info.lastSeq} (${branch.length} on the current branch)`],
  ]);
  const body = branch.flatMap(eventLines);
  return body.length ? `${header}\n\n${body.join("\n")}` : header;
};

const count = (n: number): string => n.toLocaleString("en-US");

const tokens = (n: number): string => (n < 1_000 ? String(n) : n < 100_000 ? `${(n / 1_000).toFixed(1)}k` : `${Math.round(n / 1_000)}k`);

const seconds = (ms: number): string => (ms < 1_000 ? `${Math.max(0, Math.round(ms))}ms` : `${(ms / 1_000).toFixed(1)}s`);

/** Input counts cache reads and writes, as providers bill them. */
const usageText = (usage: Usage): string => {
  const parts = [`↑${tokens(usage.input + usage.cacheRead + usage.cacheWrite)}`, `↓${tokens(usage.output)}`];
  if (usage.cacheRead > 0) parts.push(`cache ${tokens(usage.cacheRead)}`);
  if (usage.cost.total > 0) parts.push(`$${usage.cost.total.toFixed(usage.cost.total < 0.01 ? 4 : 3)}`);
  return parts.join(" ");
};

const shortModel = (ref: string): string => ref.slice(ref.indexOf("/") + 1);

const stepLine = (step: TrajectoryStep): string[] => {
  const request = step.request;
  const response = step.response;
  const timing = response?.timing;
  const calls = step.tools.map((run) => `${run.call.name}${run.result?.isError ? "!" : ""}`);
  return [
    `  ${step.index}`,
    step.stepId,
    request === undefined ? "(no request)" : `${shortModel(request.model)}${request.thinking === undefined ? "" : ` (${request.thinking})`}`,
    request === undefined ? "" : `${request.messages} msg${request.messages === 1 ? "" : "s"}`,
    response === undefined
      ? step.attempts.length
        ? `failed: ${step.attempts.at(-1)!.message.errorMessage ?? step.attempts.at(-1)!.message.stopReason}`
        : "running"
      : usageText(response.message.usage),
    timing?.firstTokenAt === undefined ? "" : `ttft ${seconds(timing.firstTokenAt - timing.startedAt)}`,
    timing === undefined ? "" : seconds(timing.endedAt - timing.startedAt),
    calls.length ? `→ ${calls.join(", ")}` : "",
  ];
};

const firstLine = (text: string, max = 80): string => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** One line per step under a header per turn; `inspect --step` has the detail. */
export const formatTrajectory = (turns: readonly TrajectoryTurn[]): string => {
  if (turns.length === 0) return "No turns on the current branch.";
  return turns
    .map((turn) => {
      const prompt = turn.prompt?.content.map((part) => (part.type === "text" ? part.text : "[image]")).join(" ") ?? "";
      const header = [
        `Turn ${turn.index}`,
        turn.end?.reason ?? "running",
        `${turn.steps.length} step${turn.steps.length === 1 ? "" : "s"}`,
        usageText(turn.usage),
        ...(turn.endedAt === undefined ? [] : [seconds(turn.endedAt - turn.startedAt)]),
      ].join(" · ");
      return [
        header,
        ...(prompt ? [`  "${firstLine(prompt)}"`] : []),
        ...(turn.end?.error === undefined ? [] : [`  error: ${turn.end.error}`]),
        pad(turn.steps.map(stepLine)),
      ].join("\n");
    })
    .join("\n\n");
};

const indent = (text: string, prefix = "    "): string =>
  text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");

/** Everything about one step: the request as sent and who contributed each part, the response, and the tool runs. */
export const formatStep = (turn: TrajectoryTurn, step: TrajectoryStep): string => {
  const lines = [`Turn ${turn.index}, step ${step.index} of ${turn.steps.length} (${step.stepId})`];
  const request = step.request;
  if (request === undefined) {
    lines.push("", "No request was logged for this step.");
  } else {
    const sectionChars = request.sections.reduce((sum, section) => sum + section.chars, 0);
    const toolChars = request.tools.reduce((sum, tool) => sum + tool.chars, 0);
    lines.push(
      "",
      pad([
        ["request", request.eventId],
        ["model", `${request.model}${request.thinking === undefined ? "" : `, thinking ${request.thinking}`}`],
        ["composition", request.composition],
        ["history", `${request.messages} messages`],
      ]),
    );
    lines.push("", `System prompt: ${count(sectionChars)} chars in ${request.sections.length} section${request.sections.length === 1 ? "" : "s"}`);
    for (const section of request.sections) {
      lines.push(`  ${section.id} from ${section.source}, ${count(section.chars)} chars${section.changed ? " (changed)" : ""}`);
      if (section.text) lines.push(indent(clip(section.text)));
    }
    if (request.sections.length > 0 && request.sections.every((section) => section.text === undefined) && request.system !== undefined) {
      lines.push("  (the logged system prompt does not split by the recorded sizes)", indent(clip(request.system)));
    }
    lines.push("", `Tools: ${request.tools.length} (${count(toolChars)} chars)`);
    if (request.tools.length) {
      lines.push(pad(request.tools.map((tool) => [`  ${tool.name}`, `from ${tool.source}`, `${count(tool.chars)} chars`, tool.changed ? "(changed)" : ""])));
    }
    if (request.removed.length) lines.push("", `Removed since the previous request: ${request.removed.join(", ")}`);
  }
  for (const attempt of step.attempts) {
    lines.push(
      "",
      `Failed call (${attempt.message.stopReason}) after ${seconds(attempt.timing.endedAt - attempt.timing.startedAt)}: ${attempt.message.errorMessage ?? ""}`.trimEnd(),
    );
  }
  const response = step.response;
  if (response !== undefined) {
    const timing = response.timing;
    lines.push(
      "",
      [
        `Response: ${response.message.stopReason}`,
        usageText(response.message.usage),
        ...(timing?.firstTokenAt === undefined ? [] : [`ttft ${seconds(timing.firstTokenAt - timing.startedAt)}`]),
        ...(timing === undefined ? [] : [seconds(timing.endedAt - timing.startedAt)]),
      ].join(" · "),
    );
    const text = response.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (text) lines.push(indent(clip(text)));
  }
  if (step.tools.length) {
    lines.push("", "Tool runs:");
    lines.push(
      pad(
        step.tools.map((run) => [
          `  ${run.call.name}`,
          run.result === undefined ? "no result" : run.result.isError ? "error" : "ok",
          run.timing === undefined ? "" : seconds(run.timing.endedAt - run.timing.startedAt),
          firstLine(JSON.stringify(run.call.arguments), 60),
        ]),
      ),
    );
  }
  return lines.join("\n");
};

const NAME_CHARS = 100;

/** The ledger as a table, one row per record: where it is, what it is, how it went, and what it said or did. */
export const formatRecords = (records: readonly LedgerRecord[], running: boolean): string => {
  if (records.length === 0) return "No records match.";
  const rows = records.map((record) => {
    const step = record.kind === "assistant" || record.kind === "tool" ? `${record.turn.index}.${record.step.index}` : `${record.turn.index}`;
    const request = record.kind === "assistant" || record.kind === "system" ? `#${record.requestNumber}` : "";
    const duration = recordDuration(record);
    const usage = record.kind === "assistant" ? record.message.usage : undefined;
    const name = recordName(record).replace(/\s+/g, " ");
    return [
      step,
      request,
      RECORD_KIND_LABEL[record.kind],
      recordStatus(record, running),
      duration === undefined ? "" : seconds(duration),
      usage === undefined ? "" : `${tokens(usage.input + usage.cacheRead + usage.cacheWrite)}/${tokens(usage.output)}`,
      name.length > NAME_CHARS ? `${name.slice(0, NAME_CHARS - 1)}…` : name,
    ];
  });
  return pad([["step", "req", "kind", "status", "time", "tokens", "name"], ...rows]);
};

/** Every system section in full, headed by the plugin that contributed it. */
export const formatSystem = (request: TrajectoryRequest): string => {
  const blocks = request.sections.map((section) =>
    [
      `── ${section.id} from ${section.source}, ${count(section.chars)} chars${section.changed ? " (changed)" : ""}`,
      section.text ?? "(not recoverable from the log)",
    ].join("\n"),
  );
  if (request.sections.every((section) => section.text === undefined) && request.system !== undefined) {
    blocks.push(["── whole prompt (the logged prompt does not split by the recorded sizes)", request.system].join("\n"));
  }
  return blocks.join("\n\n");
};

/** Every tool definition, headed by the plugin that contributed it. */
export const formatTools = (request: TrajectoryRequest): string =>
  request.tools
    .map((tool) =>
      [
        `── ${tool.name} from ${tool.source}, ${count(tool.chars)} chars${tool.changed ? " (changed)" : ""}`,
        ...(tool.spec === undefined ? [] : [tool.spec.description, JSON.stringify(tool.spec.parameters, null, 2)]),
      ].join("\n"),
    )
    .join("\n\n") || "No tools.";

/** Section-by-section changes to the system prompt, as unified-style lines. */
export const formatDiff = (diff: readonly SectionDiff[], first: boolean): string => {
  if (first) return "This is the first request; everything in it is new. Use --system to read it.";
  if (diff.length === 0) return "The system prompt is unchanged from the request before.";
  return diff
    .map((section) =>
      [
        `── ${section.id} from ${section.source} (${section.status})`,
        ...section.lines.map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "} ${line.text}`),
      ].join("\n"),
    )
    .join("\n\n");
};

export const formatModels = (models: readonly ModelInfo[]): string =>
  models.length === 0
    ? "No models. Log in to a provider (basis providers, basis login <provider>), or use --all."
    : pad([
        ["model", "name", "context", "thinking", "input", "$/M in/out"],
        ...models.map((model) => [
          model.ref,
          model.name,
          tokens(model.contextWindow),
          model.reasoning ? model.thinkingLevels.join(",") : "no",
          model.input.join(","),
          model.cost.input === 0 && model.cost.output === 0 ? "" : `${model.cost.input}/${model.cost.output}`,
        ]),
      ]);

export const formatProviders = (providers: readonly ProviderInfo[]): string =>
  pad([
    ["provider", "name", "configured", "from", "login"],
    ...providers.map((provider) => [
      provider.id,
      provider.name,
      provider.configured ? "yes" : "no",
      provider.source ?? "",
      provider.auth.map((auth) => auth.type).join(", "),
    ]),
  ]);

export const formatCommands = (commands: readonly CommandInfo[]): string =>
  commands.length === 0
    ? "No commands."
    : pad([["command", "title", "category", "from"], ...commands.map((command) => [command.id, command.title, command.category ?? "", command.source])]);

export const formatQuestions = (questions: readonly InteractionRequest[]): string =>
  questions.length === 0
    ? "No open questions."
    : questions
        .map((question) =>
          [
            `${question.id}  ${question.type}  ${question.title}`,
            ...(question.type === "select"
              ? question.options.map((option, i) => `    ${i + 1}. ${option.value}${option.label === option.value ? "" : ` (${option.label})`}`)
              : []),
            ...(question.type === "confirm" && question.detail !== undefined ? [`    ${question.detail}`] : []),
          ].join("\n"),
        )
        .join("\n");

/** The reply (unless it was streamed) and a one-line summary of how the turn ended. */
export const formatTurnResult = (turn: TurnResult, withText: boolean): string => {
  const summary = [
    `turn ${turn.reason}`,
    `${turn.steps} step${turn.steps === 1 ? "" : "s"}`,
    `${turn.toolCalls} tool call${turn.toolCalls === 1 ? "" : "s"}`,
    ...(turn.usage === undefined ? [] : [usageText(turn.usage)]),
    ...(turn.duration === undefined ? [] : [seconds(turn.duration)]),
    `session ${turn.session}`,
  ].join(" · ");
  return [...(withText && turn.text ? [turn.text.trimEnd(), ""] : []), `── ${summary}`, ...(turn.error === undefined ? [] : [`error: ${turn.error}`])].join(
    "\n",
  );
};

export const formatWorkspace = (status: WorkspaceStatus): string => {
  if (!status.exists) return `${status.path}: does not exist`;
  const git = status.git;
  if (git === undefined) return `${status.path}: not a git repository`;
  return pad([
    ["path", status.path],
    ["branch", git.branch ?? `(detached at ${git.head ?? "?"})`],
    ["head", git.head ?? "(no commits)"],
    ["changes", String(git.changes)],
    ...(git.upstream === undefined ? [] : [["upstream", `${git.upstream} (ahead ${git.ahead}, behind ${git.behind})`]]),
    ...(git.worktreeOf === undefined ? [] : [["worktree of", git.worktreeOf]]),
  ]);
};

export const formatBranches = (branches: readonly GitBranch[]): string =>
  branches.length === 0
    ? "No branches."
    : pad(
        branches.map((branch) => [
          branch.current ? "*" : " ",
          branch.name,
          branch.remote ? "remote" : "",
          time(branch.updatedAt),
          branch.worktree === undefined ? "" : `in ${branch.worktree}`,
        ]),
      );

export const formatListing = (listing: DirectoryListing): string =>
  [listing.parent, ...listing.entries.map((entry) => `  ${entry.name}/${entry.git ? "  (git)" : ""}`), ...(listing.truncated ? ["  …"] : [])].join("\n");
