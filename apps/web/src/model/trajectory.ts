import type {
  AssistantMessage, TextContent, Timing, ToolSpec, TrajectoryRequest, TrajectoryStep, TrajectoryToolRun, TrajectoryTurn, UserMessage,
} from "@basis/contracts";

/**
 * The Trajectory ledger: one flat, ordered list of records (the system prompt
 * when it is first sent or changes, each user prompt, each model call, each
 * tool run) projected from `trajectory(branch)`, plus the timeline spans they
 * occupy. Pure, so the view only renders.
 */

interface Base {
  /** Stable key: the event id behind the record. */
  readonly id: string;
  readonly turn: TrajectoryTurn;
  /** Starts a turn in the ledger (gets the turn label). */
  readonly turnStart: boolean;
}

export interface SystemRecord extends Base {
  readonly kind: "system";
  readonly request: TrajectoryRequest;
  readonly requestNumber: number;
  /** The previous request's section texts, for the diff; absent on the first request. */
  readonly previous?: ReadonlyMap<string, string>;
}
export interface UserRecord extends Base {
  readonly kind: "user";
  readonly message: UserMessage;
  readonly at: number;
}
export interface AssistantRecord extends Base {
  readonly kind: "assistant";
  readonly step: TrajectoryStep;
  /** 1-based over the session: every model call sent a request. */
  readonly requestNumber: number;
  readonly message: AssistantMessage;
  readonly timing?: Timing;
  /** A failed or cancelled call (an `attempt`), not part of the model's history. */
  readonly failed: boolean;
}
export interface ToolRecord extends Base {
  readonly kind: "tool";
  readonly step: TrajectoryStep;
  readonly run: TrajectoryToolRun;
  readonly spec?: ToolSpec;
}

export type LedgerRecord = SystemRecord | UserRecord | AssistantRecord | ToolRecord;
type Draft = LedgerRecord extends infer R ? R extends LedgerRecord ? Omit<R, "turn" | "turnStart"> : never : never;

export const textOf = (content: readonly { readonly type: string; readonly text?: string }[]): string =>
  content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("\n");

export function ledger(turns: readonly TrajectoryTurn[]): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  let requestNumber = 0;
  let previous: Map<string, string> | undefined;
  for (const turn of turns) {
    let first = true;
    const push = (record: Draft) => {
      records.push({ ...record, turn, turnStart: first } as LedgerRecord);
      first = false;
    };
    if (turn.prompt !== undefined) {
      push({ kind: "user", id: `${turn.turnId}:prompt`, message: turn.prompt, at: turn.startedAt });
    }
    for (const step of turn.steps) {
      const request = step.request;
      if (request !== undefined) {
        requestNumber++;
        const changed = request.sections.some((section) => section.changed) || request.removed.length > 0;
        if (changed) {
          push({ kind: "system", id: `${request.eventId}:system`, request, requestNumber, ...(previous === undefined ? {} : { previous }) });
        }
        previous = new Map(request.sections.map((section) => [section.id, section.text ?? ""]));
      }
      const specs = new Map(request?.tools.flatMap((tool) => (tool.spec === undefined ? [] : [[tool.name, tool.spec] as const])) ?? []);
      for (const attempt of step.attempts) {
        push({ kind: "assistant", id: attempt.eventId, step, requestNumber, message: attempt.message, timing: attempt.timing, failed: true });
      }
      if (step.response !== undefined) {
        const response = step.response;
        push({
          kind: "assistant", id: response.eventId, step, requestNumber, message: response.message, failed: false,
          ...(response.timing === undefined ? {} : { timing: response.timing }),
        });
      }
      for (const run of step.tools) {
        const spec = specs.get(run.call.name);
        push({ kind: "tool", id: run.eventId ?? run.call.id, step, run, ...(spec === undefined ? {} : { spec }) });
      }
    }
  }
  return records;
}

/** The request behind a record, for the request inspector. */
export const requestOf = (record: LedgerRecord): TrajectoryRequest | undefined =>
  record.kind === "system" ? record.request : record.kind === "user" ? undefined : record.step.request;

export type Lane = 0 | 1 | 2;
export interface Span {
  readonly record: LedgerRecord;
  readonly lane: Lane;
  readonly start: number;
  /** Absent while the record is still running. */
  readonly end?: number;
  /** Time to first token, for model spans. */
  readonly ttft?: number;
  readonly error: boolean;
}

/** Where each record sits in time: lane 0 input, 1 model, 2 tools. System prompts have no duration and no span. */
export function spans(records: readonly LedgerRecord[]): Span[] {
  const out: Span[] = [];
  for (const record of records) {
    if (record.kind === "user") out.push({ record, lane: 0, start: record.at, end: record.at, error: false });
    if (record.kind === "assistant") {
      const timing = record.timing;
      const start = timing?.startedAt ?? record.step.request?.at ?? record.step.startedAt;
      out.push({
        record, lane: 1, start, ...(timing === undefined ? {} : { end: timing.endedAt }),
        ...(timing?.firstTokenAt === undefined ? {} : { ttft: timing.firstTokenAt - timing.startedAt }),
        error: record.failed,
      });
    }
    if (record.kind === "tool" && record.run.timing !== undefined) {
      out.push({ record, lane: 2, start: record.run.timing.startedAt, end: record.run.timing.endedAt, error: record.run.result?.isError === true });
    }
  }
  return out;
}

/** Lines of `before` and `after` marked kept, removed, or added (longest common subsequence). */
export function lineDiff(before: string, after: string): { readonly kind: "same" | "del" | "add"; readonly text: string }[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: { kind: "same" | "del" | "add"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ kind: "same", text: a[i]! }); i++; j++; }
    else if (i < a.length && (j >= b.length || table[i + 1]![j]! >= table[i]![j + 1]!)) { out.push({ kind: "del", text: a[i]! }); i++; }
    else { out.push({ kind: "add", text: b[j]! }); j++; }
  }
  return out;
}

/** Record text the search box matches against. */
export const searchText = (record: LedgerRecord): string => {
  switch (record.kind) {
    case "system": return record.request.sections.map((section) => `${section.id} ${section.source} ${section.text ?? ""}`).join(" ");
    case "user": return textOf(record.message.content);
    case "assistant": return textOf(record.message.content as readonly { type: string; text?: string }[]) + (record.message.errorMessage ?? "");
    case "tool": return `${record.run.call.name} ${JSON.stringify(record.run.call.arguments)} ${record.run.result === undefined ? "" : textOf(record.run.result.content)}`;
  }
};

export const KIND_TEXT = { system: "system", user: "user", assistant: "model", tool: "tool" } as const;

export const isError = (record: LedgerRecord) => (record.kind === "assistant" && record.failed) || (record.kind === "tool" && record.run.result?.isError === true);
export const durationOf = (record: LedgerRecord): number | undefined => {
  if (record.kind === "assistant") return record.timing === undefined ? undefined : record.timing.endedAt - record.timing.startedAt;
  if (record.kind === "tool") return record.run.timing === undefined ? undefined : record.run.timing.endedAt - record.run.timing.startedAt;
  return undefined;
};
/**
 * The filter box, after DevTools': space-separated terms that must all hold.
 * `is:error`, `is:running`, `kind:tool` (user, model, tool, system),
 * `tool:bash`, `turn:2`, `req:5`, plain text, and `-term` to negate any of them.
 */
export const parseFilter = (input: string) => {
  const terms = input.trim().split(/\s+/).filter(Boolean).map((raw) => {
    const negate = raw.startsWith("-") && raw.length > 1;
    const term = (negate ? raw.slice(1) : raw).toLowerCase();
    const [key, value] = term.includes(":") ? [term.slice(0, term.indexOf(":")), term.slice(term.indexOf(":") + 1)] : ["", term];
    const test = (record: LedgerRecord): boolean => {
      switch (key) {
        case "is": return value === "error" ? isError(record) : value === "running" ? durationOf(record) === undefined && (record.kind === "tool" || record.kind === "assistant") : false;
        case "kind": case "type": return KIND_TEXT[record.kind].startsWith(value) || record.kind.startsWith(value);
        case "tool": return record.kind === "tool" && record.run.call.name.toLowerCase().includes(value);
        case "turn": return String(record.turn.index) === value;
        case "req": return record.kind !== "user" && String(record.kind === "system" ? record.requestNumber : record.kind === "assistant" ? record.requestNumber : "") === value;
        default: return searchText(record).toLowerCase().includes(term);
      }
    };
    return { negate, test };
  });
  return (record: LedgerRecord) => terms.every((term) => term.test(record) !== term.negate);
};

