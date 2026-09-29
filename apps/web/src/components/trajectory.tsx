import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { rebuildRequest } from "@basis/contracts";
import type { Timing, TrajectoryRequest } from "@basis/contracts";
import { formatDuration, formatTokens } from "../model/format.ts";
import { ledger, lineDiff, requestOf, searchText, spans, textOf } from "../model/trajectory.ts";
import type { AssistantRecord, LedgerRecord, Span, SystemRecord, ToolRecord, UserRecord } from "../model/trajectory.ts";
import { activeBranch, isBusy, reportError, state, trajectory } from "../store.ts";
import { CopyIcon, SearchIcon, XIcon } from "./icons.tsx";
import { Markdown } from "./markdown.tsx";

/**
 * The Trajectory view, after DeepSeek Harness's: a toolbar, a three-lane
 * timing overview (input, model, tools), a ledger with one row per record,
 * and an event-details panel with tabs for the selected record or request.
 * Everything is projected from the session log (`trajectory` → `ledger`).
 */

// ------------------------------------------------------------------ state

type Selection = { readonly type: "record"; readonly id: string } | { readonly type: "request"; readonly eventId: string };

const [selection, setSelection] = createSignal<Selection>();
const [tab, setTab] = createSignal<string>();
const [equalDurations, setEqualDurations] = createSignal(false);
const [collapseTurns, setCollapseTurns] = createSignal(false);
const [collapseCalls, setCollapseCalls] = createSignal(false);
const [query, setQuery] = createSignal("");
/** A time range dragged on the timeline; rows outside it fade. */
const [range, setRange] = createSignal<{ readonly from: number; readonly to: number }>();

const select = (next: Selection | undefined, initialTab?: string) => {
  setSelection(next);
  setTab(initialTab);
};

// ------------------------------------------------------------------ helpers

const clock = (ms: number) => {
  const date = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}`;
};
const firstLine = (text: string) => text.trim().split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
const json = (value: unknown) => JSON.stringify(value, null, 2);
const inputTokens = (usage: { input: number; cacheRead: number; cacheWrite: number }) => usage.input + usage.cacheRead + usage.cacheWrite;
const thinkingOf = (record: AssistantRecord) =>
  record.message.content.flatMap((part) => (part.type === "thinking" ? [part.thinking] : [])).join("\n\n");
const callsOf = (record: AssistantRecord) => record.message.content.flatMap((part) => (part.type === "toolCall" ? [part.name] : []));

const KIND_LABEL = { system: "SYSTEM", user: "USER", assistant: "ASSISTANT", tool: "TOOL" } as const;

const copy = async (text: string) => {
  try { await navigator.clipboard.writeText(text); } catch (error) { reportError(error, "Could not copy"); }
};

/** Current time while a turn runs, so running spans grow. */
const useNow = (active: () => boolean) => {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!active()) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    onCleanup(() => clearInterval(timer));
  });
  return now;
};

// ------------------------------------------------------------------ toolbar

function Toolbar() {
  return (
    <div class="trj-toolbar" role="toolbar" aria-label="Trajectory toolbar">
      <button class="trj-tool" aria-pressed={!equalDurations()} onClick={() => setEqualDurations(!equalDurations())}
        data-tip={equalDurations() ? "Use actual duration" : "Give every record equal width"}>Duration</button>
      <button class="trj-tool" aria-pressed={collapseTurns()} onClick={() => setCollapseTurns(!collapseTurns())}
        data-tip={collapseTurns() ? "Expand turns" : "Collapse turns"}>Turns</button>
      <button class="trj-tool" aria-pressed={collapseCalls()} onClick={() => setCollapseCalls(!collapseCalls())}
        data-tip={collapseCalls() ? "Show tool calls" : "Collapse calls"}>Calls</button>
      <Show when={range()}>
        {(r) => (
          <button class="trj-tool trj-range" onClick={() => setRange(undefined)} data-tip="Clear the timeline selection">
            {formatDuration(r().to - r().from)} selected <XIcon />
          </button>
        )}
      </Show>
      <label class="trj-search">
        <SearchIcon />
        <input type="search" placeholder="Search" aria-label="Search trajectory" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
      </label>
    </div>
  );
}

// ------------------------------------------------------------------ timeline

const PAD = 6;

function Timeline(props: { spans: readonly Span[]; now: number; matches: (record: LedgerRecord) => boolean }) {
  let track!: HTMLDivElement;
  const [width, setWidth] = createSignal(600);
  const [hover, setHover] = createSignal<{ span: Span; x: number }>();
  const [drag, setDrag] = createSignal<{ from: number; to: number }>();
  const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(entry.contentRect.width); });
  onCleanup(() => observer.disconnect());

  // Actual time within each turn; the idle time between turns (the user reading, typing, or away) collapses
  // into a fixed gap, so one long pause does not squash every turn. Equal: every span gets the same slot.
  const GAP = 10;
  const segments = createMemo(() => {
    const byTurn = new Map<string, { from: number; to: number }>();
    for (const span of props.spans) {
      const key = span.record.turn.turnId;
      const end = span.end ?? props.now;
      const current = byTurn.get(key);
      byTurn.set(key, current === undefined ? { from: span.start, to: end } : { from: Math.min(current.from, span.start), to: Math.max(current.to, end) });
    }
    const list = [...byTurn.values()].sort((a, b) => a.from - b.from);
    let active = 0;
    return list.map((segment) => {
      const out = { ...segment, before: active, index: 0 };
      active += Math.max(1, segment.to - segment.from);
      return out;
    }).map((segment, index) => ({ ...segment, index }));
  });
  const totalActive = () => { const last = segments().at(-1); return last === undefined ? 1 : last.before + Math.max(1, last.to - last.from); };
  const usable = () => width() - PAD * 2 - GAP * Math.max(0, segments().length - 1);
  const x = (at: number) => {
    const list = segments();
    const segment = list.filter((candidate) => candidate.from <= at).at(-1) ?? list[0];
    if (segment === undefined) return PAD;
    const within = Math.min(Math.max(at - segment.from, 0), Math.max(1, segment.to - segment.from));
    return PAD + segment.index * GAP + ((segment.before + within) / totalActive()) * usable();
  };
  const order = createMemo(() => new Map(props.spans.map((span, index) => [span, index])));
  const geometry = (span: Span) => {
    if (equalDurations()) {
      const slot = (width() - PAD * 2) / Math.max(1, props.spans.length);
      return { left: PAD + slot * order().get(span)!, width: Math.max(2, Math.min(8, slot - 1)) };
    }
    const left = x(span.start);
    return { left, width: Math.max(2, x(span.end ?? props.now) - left - 1) };
  };
  const timeAt = (clientX: number) => {
    const px = clientX - track.getBoundingClientRect().left;
    const list = segments();
    for (const segment of list) {
      const left = x(segment.from);
      const right = x(segment.to);
      if (px <= right || segment === list.at(-1)) {
        if (px <= left) return segment.from;
        return segment.from + ((px - left) / Math.max(1, right - left)) * (segment.to - segment.from);
      }
    }
    return 0;
  };
  const boundaries = () => segments().slice(1).map((segment) => x(segment.from) - GAP / 2);

  const onPointerDown = (event: PointerEvent) => {
    if (event.button === 2) { setRange(undefined); return; }
    if (event.button !== 0 || equalDurations()) return;
    const start = timeAt(event.clientX);
    setDrag({ from: start, to: start });
    track.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    const current = drag();
    if (current !== undefined) setDrag({ from: current.from, to: timeAt(event.clientX) });
  };
  const onPointerUp = () => {
    const current = drag();
    setDrag(undefined);
    if (current === undefined) return;
    const from = Math.min(current.from, current.to);
    const to = Math.max(current.from, current.to);
    // A click (no real drag) clears; a drag selects.
    if (x(to) - x(from) < 4) setRange(undefined); else setRange({ from, to });
  };
  const shown = () => (equalDurations() ? undefined : drag() ?? range());

  const tip = (span: Span): string[] => {
    const record = span.record;
    const title = record.kind === "tool" ? record.run.call.name : record.kind === "assistant" ? `Request #${record.requestNumber}` : KIND_LABEL[record.kind];
    const lines = [title, `${clock(span.start)} · ${span.end === undefined ? "running" : formatDuration(span.end - span.start)}`];
    if (span.ttft !== undefined && span.end !== undefined) lines.push(`TTFT ${formatDuration(span.ttft)} · decoding ${formatDuration(span.end - span.start - span.ttft)}`);
    return lines;
  };

  return (
    <div class="trj-timeline" role="region" aria-label="Trajectory timeline">
      <div class="trj-lane-labels" aria-hidden="true"><span>Input</span><span>Model</span><span>Tools</span></div>
      <div class="trj-track" ref={(el) => { track = el; observer.observe(el); }} data-panning={drag() !== undefined}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onContextMenu={(event) => event.preventDefault()}>
        <Show when={!equalDurations()}>
          <For each={boundaries()}>{(left) => <div class="trj-turn-boundary" style={{ left: `${left}px` }} />}</For>
        </Show>
        <For each={props.spans}>
          {(span) => {
            const g = () => geometry(span);
            const ttft = () => (span.ttft === undefined || span.end === undefined || span.end <= span.start ? undefined : Math.min(100, (span.ttft / (span.end - span.start)) * 100));
            const current = () => { const s = selection(); return s?.type === "record" && s.id === span.record.id; };
            const outside = () => { const r = range(); return r !== undefined && ((span.end ?? props.now) < r.from || span.start > r.to); };
            return (
              <div
                class="trj-span" data-kind={span.record.kind} data-error={span.error} data-current={current()}
                data-dim={outside() || !props.matches(span.record)} data-running={span.end === undefined}
                classList={{ "has-ttft": ttft() !== undefined && !equalDurations() }}
                style={{ left: `${g().left}px`, width: `${g().width}px`, top: `${7 + span.lane * 14}px`, "--ttft": `${ttft() ?? 0}%` }}
                onPointerEnter={(event) => setHover({ span, x: event.clientX - track.getBoundingClientRect().left })}
                onPointerLeave={() => setHover(undefined)}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => { select({ type: "record", id: span.record.id }); document.getElementById(`trj-row-${span.record.id}`)?.scrollIntoView({ block: "nearest" }); }}
              />
            );
          }}
        </For>
        <Show when={shown()}>
          {(r) => <div class="trj-selection" data-dragging={drag() !== undefined} style={{ left: `${x(Math.min(r().from, r().to))}px`, width: `${Math.abs(x(r().to) - x(r().from))}px` }} />}
        </Show>
        <Show when={hover()}>
          {(h) => (
            <div class="trj-tip" role="tooltip" style={{ left: `${Math.min(Math.max(h().x, 80), width() - 80)}px` }}>
              <For each={tip(h().span)}>{(line, index) => (index() === 0 ? <strong>{line}</strong> : <span>{line}</span>)}</For>
            </div>
          )}
        </Show>
        <Show when={props.spans.length === 0}><div class="trj-empty-track">No timing yet</div></Show>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ ledger

function KindTag(props: { kind: LedgerRecord["kind"] | "request"; error?: boolean }) {
  return <span class="trj-kind" data-kind={props.kind} data-error={props.error === true}>{props.kind === "request" ? "REQUEST" : KIND_LABEL[props.kind]}</span>;
}

function RowContent(props: { record: LedgerRecord }): JSX.Element {
  return (
    <Switch>
      <Match when={props.record.kind === "system" && (props.record as SystemRecord)}>
        {(record) => {
          const changed = () => [...record().request.sections.filter((s) => s.changed).map((s) => s.id), ...record().request.removed];
          return <span class="trj-text trj-muted">{record().previous === undefined ? "Initial System Prompt" : `System prompt changed · ${changed().join(", ")}`}</span>;
        }}
      </Match>
      <Match when={props.record.kind === "user" && (props.record as UserRecord)}>
        {(record) => <span class="trj-text">{firstLine(textOf(record().message.content)) || "[image]"}</span>}
      </Match>
      <Match when={props.record.kind === "assistant" && (props.record as AssistantRecord)}>
        {(record) => {
          const text = () => firstLine(textOf(record().message.content));
          const thinking = () => firstLine(thinkingOf(record()));
          return (
            <Switch fallback={<span class="trj-text trj-muted">{callsOf(record()).length ? `→ ${callsOf(record()).join(", ")}` : "(no output)"}</span>}>
              <Match when={record().failed}><span class="trj-text trj-error">{record().message.errorMessage ?? `Model call ${record().message.stopReason}`}</span></Match>
              <Match when={text()}><span class="trj-text">{text()}</span></Match>
              <Match when={thinking()}><span class="trj-text trj-muted">{thinking()}</span></Match>
            </Switch>
          );
        }}
      </Match>
      <Match when={props.record.kind === "tool" && (props.record as ToolRecord)}>
        {(record) => {
          const run = () => record().run;
          const result = () => (run().result === undefined ? undefined : firstLine(textOf(run().result!.content)));
          return (
            <span class="trj-tool-row">
              <span class="trj-call"><span class="trj-call-name">{run().call.name}</span><span class="trj-call-args">{JSON.stringify(run().call.arguments)}</span></span>
              <span class="trj-result" classList={{ "trj-error": run().result?.isError === true }}>
                <span class="trj-arrow">→</span>
                <span class="trj-text">{run().result === undefined ? (isBusy() ? "running…" : "no result") : result() || "(no output)"}</span>
              </span>
            </span>
          );
        }}
      </Match>
    </Switch>
  );
}

type Row = { readonly type: "record"; readonly record: LedgerRecord } | { readonly type: "turn"; readonly records: LedgerRecord[] };

function Ledger(props: { records: readonly LedgerRecord[]; matches: (record: LedgerRecord) => boolean; now: number }) {
  const spansById = createMemo(() => new Map(spans(props.records).map((span) => [span.record.id, span])));
  const inRange = (record: LedgerRecord) => {
    const r = range();
    if (r === undefined) return true;
    const span = spansById().get(record.id);
    return span !== undefined && (span.end ?? props.now) >= r.from && span.start <= r.to;
  };
  const rows = createMemo(() => {
    const out: Row[] = [];
    for (const record of props.records) {
      if (collapseCalls() && record.kind === "tool") continue;
      if (collapseTurns()) {
        const last = out.at(-1);
        if (last?.type === "turn" && last.records[0]!.turn === record.turn) last.records.push(record);
        else out.push({ type: "turn", records: [record] });
        continue;
      }
      out.push({ type: "record", record });
    }
    return out;
  });
  const selectedId = () => { const s = selection(); return s?.type === "record" ? s.id : undefined; };
  const selectedRequest = () => { const s = selection(); return s?.type === "request" ? s.eventId : undefined; };

  return (
    <table class="trj-table">
      <colgroup><col class="trj-col-event" /><col /></colgroup>
      <tbody>
        <For each={rows()}>
          {(row) => (
            <Switch>
              <Match when={row.type === "turn" && row}>
                {(summary) => {
                  const turn = () => summary().records[0]!.turn;
                  const prompt = () => (turn().prompt === undefined ? "" : firstLine(textOf(turn().prompt!.content)));
                  const tools = () => turn().steps.reduce((sum, step) => sum + step.tools.length, 0);
                  return (
                    <tr class="trj-collapsed" data-turn-start="true" onClick={() => setCollapseTurns(false)}>
                      <td class="trj-event"><span class="trj-turn-label">Turn {turn().index}</span><span class="trj-turn-rail" /></td>
                      <td class="trj-content">
                        <span class="trj-text"><span class="trj-ellipsis">…</span>{prompt()} <span class="trj-muted">· {turn().steps.length} requests · {tools()} calls{turn().endedAt === undefined ? "" : ` · ${formatDuration(turn().endedAt! - turn().startedAt)}`}</span></span>
                      </td>
                    </tr>
                  );
                }}
              </Match>
              <Match when={row.type === "record" && row.record}>
                {(record) => {
                  const r = record();
                  const assistant = r.kind === "assistant" && !r.failed ? r : undefined;
                  const error = (r.kind === "assistant" && r.failed) || (r.kind === "tool" && r.run.result?.isError === true);
                  return (
                    <tr
                      id={`trj-row-${r.id}`} tabindex="0" data-kind={r.kind} data-turn-start={r.turnStart} data-error={error}
                      data-selected={selectedId() === r.id} data-dim={!inRange(r) || !props.matches(r)}
                      onClick={() => select({ type: "record", id: r.id })}
                      onKeyDown={(event) => { if (event.key === "Enter") select({ type: "record", id: r.id }); }}
                    >
                      <td class="trj-event">
                        <Show when={r.turnStart}><span class="trj-turn-label">Turn {r.turn.index}</span></Show>
                        <span class="trj-turn-rail" />
                        <Show when={selectedId() === r.id}><span class="trj-selection-rail" /></Show>
                        <Show when={assistant?.step.request}>
                          {(request) => (
                            <button class="trj-request" data-label={`Request #${assistant!.requestNumber}`} aria-label={`Request #${assistant!.requestNumber}`}
                              data-active={selectedRequest() === request().eventId}
                              onClick={(event) => { event.stopPropagation(); select({ type: "request", eventId: request().eventId }); }} />
                          )}
                        </Show>
                        <KindTag kind={r.kind} error={error} />
                      </td>
                      <td class="trj-content"><RowContent record={r} /></td>
                    </tr>
                  );
                }}
              </Match>
            </Switch>
          )}
        </For>
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------------ details

function Section(props: { title: string; children: JSX.Element; aside?: JSX.Element }) {
  return (
    <section class="trj-section">
      <h4><span>{props.title}</span><Show when={props.aside}><span class="trj-section-aside">{props.aside}</span></Show></h4>
      {props.children}
    </section>
  );
}

function Facts(props: { rows: readonly (readonly [string, JSX.Element | string | undefined])[] }) {
  return (
    <dl class="trj-facts">
      <For each={props.rows.filter(([, value]) => value !== undefined && value !== "")}>{([key, value]) => <><dt>{key}</dt><dd>{value}</dd></>}</For>
    </dl>
  );
}

function Pre(props: { text: string; error?: boolean }) {
  return (
    <div class="trj-pre-wrap">
      <button class="trj-copy" aria-label="Copy" data-tip="Copy" onClick={() => void copy(props.text)}><CopyIcon /></button>
      <pre class="trj-pre" classList={{ "trj-error": props.error === true }}>{props.text}</pre>
    </div>
  );
}

function Meta(props: { source: string; chars: number; changed: boolean }) {
  return <><span class="trj-source">{props.source}</span>{props.chars.toLocaleString()} chars<Show when={props.changed}><span class="trj-changed">changed</span></Show></>;
}

function SystemPrompt(props: { request: TrajectoryRequest }) {
  const unsplit = () => props.request.sections.length > 0 && props.request.sections.every((section) => section.text === undefined);
  return (
    <>
      <For each={props.request.sections}>
        {(section) => (
          <Section title={section.id} aside={<Meta source={section.source} chars={section.chars} changed={section.changed} />}>
            <Show when={section.text !== undefined}><Pre text={section.text!} /></Show>
          </Section>
        )}
      </For>
      <Show when={unsplit() && props.request.system}>{(system) => <Section title="Whole prompt"><Pre text={system()} /></Section>}</Show>
    </>
  );
}

function ToolsList(props: { request: TrajectoryRequest }) {
  return (
    <For each={props.request.tools}>
      {(tool) => (
        <Section title={tool.name} aside={<Meta source={tool.source} chars={tool.chars} changed={tool.changed} />}>
          <Show when={tool.spec}>{(spec) => <><p class="trj-desc">{spec().description}</p><Pre text={json(spec().parameters)} /></>}</Show>
        </Section>
      )}
    </For>
  );
}

function Diff(props: { record: SystemRecord }) {
  return (
    <>
      <For each={props.record.request.sections.filter((section) => section.changed)}>
        {(section) => (
          <Section title={section.id} aside={<span class="trj-source">{section.source}</span>}>
            <pre class="trj-pre trj-diff">
              <For each={lineDiff(props.record.previous?.get(section.id) ?? "", section.text ?? "")}>
                {(line) => <span class={`trj-diff-${line.kind}`}>{line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}{line.text}{"\n"}</span>}
              </For>
            </pre>
          </Section>
        )}
      </For>
      <Show when={props.record.request.removed.length > 0}><p class="trj-desc">Removed: {props.record.request.removed.join(", ")}</p></Show>
    </>
  );
}

/** Where a request's prompt came from, by contributing plugin. */
function Sources(props: { request: TrajectoryRequest }) {
  const rows = createMemo(() => {
    const bySource = new Map<string, { chars: number; parts: string[] }>();
    const parts = [
      ...props.request.sections.map((section) => ({ source: section.source, chars: section.chars, label: section.id })),
      ...props.request.tools.map((tool) => ({ source: tool.source, chars: tool.chars, label: tool.name })),
    ];
    for (const part of parts) {
      const entry = bySource.get(part.source) ?? { chars: 0, parts: [] };
      entry.chars += part.chars;
      entry.parts.push(part.label);
      bySource.set(part.source, entry);
    }
    return [...bySource].sort((a, b) => b[1].chars - a[1].chars);
  });
  const max = () => Math.max(1, ...rows().map(([, entry]) => entry.chars));
  return (
    <div class="trj-sources">
      <For each={rows()}>
        {([source, entry]) => (
          <div class="trj-source-row">
            <span class="trj-source-name">{source}</span>
            <span class="trj-source-bar"><i style={{ width: `${(entry.chars / max()) * 100}%` }} /></span>
            <span class="trj-source-chars">{entry.chars.toLocaleString()}</span>
            <span class="trj-source-parts">{entry.parts.join(", ")}</span>
          </div>
        )}
      </For>
    </div>
  );
}

interface Tab { readonly id: string; readonly label: string; readonly render: () => JSX.Element }

function TimingFacts(props: { timing: Timing; output?: number | undefined }) {
  const t = () => props.timing;
  const decoding = () => (t().firstTokenAt === undefined ? undefined : t().endedAt - t().firstTokenAt!);
  return (
    <Facts rows={[
      ["Started", clock(t().startedAt)],
      ["First token", t().firstTokenAt === undefined ? undefined : `${clock(t().firstTokenAt!)} · TTFT ${formatDuration(t().firstTokenAt! - t().startedAt)}`],
      ["Ended", clock(t().endedAt)],
      ["Duration", formatDuration(t().endedAt - t().startedAt)],
      ["Decoding", decoding() === undefined ? undefined : formatDuration(decoding()!)],
      ["Throughput", decoding() !== undefined && decoding()! > 0 && props.output ? `${(props.output / (decoding()! / 1000)).toFixed(1)} tokens/s` : undefined],
    ]} />
  );
}

function requestTabs(request: TrajectoryRequest, assistant: AssistantRecord | undefined, system: SystemRecord | undefined): Tab[] {
  const usage = assistant?.message.usage;
  const timing = assistant?.timing;
  return [
    {
      id: "summary", label: "Summary", render: () => (
        <>
          <Facts rows={[
            ["Model", request.model],
            ["Thinking", request.thinking],
            ["History", `${request.messages} message${request.messages === 1 ? "" : "s"}`],
            ["Composition", <span class="trj-mono" data-tip={request.composition}>{request.composition.slice(0, 16)}</span>],
            ["Event", <span class="trj-mono">{request.eventId}</span>],
          ]} />
          <Section title="Prompt by source" aside={`${request.sections.length} sections · ${request.tools.length} tools`}><Sources request={request} /></Section>
          <button class="trj-link" onClick={() => {
            const rebuilt = rebuildRequest(activeBranch(), request.eventId);
            if (rebuilt !== undefined) void copy(json(rebuilt));
          }}><CopyIcon /> Copy exact request</button>
        </>
      ),
    },
    { id: "system", label: "System Prompt", render: () => <SystemPrompt request={request} /> },
    { id: "tools", label: "Tools", render: () => <ToolsList request={request} /> },
    ...(system?.previous === undefined ? [] : [{ id: "diff", label: "Diff", render: () => <Diff record={system} /> }]),
    ...(usage === undefined ? [] : [{
      id: "usage", label: "Usage", render: () => (
        <Facts rows={[
          ["Input", `${inputTokens(usage).toLocaleString()} tokens`],
          ["Cache read", usage.cacheRead.toLocaleString()],
          ["Cache write", usage.cacheWrite.toLocaleString()],
          ["Uncached", usage.input.toLocaleString()],
          ["Output", usage.output.toLocaleString()],
          ["Reasoning", usage.reasoning?.toLocaleString()],
          ["Cost", usage.cost.total > 0 ? `$${usage.cost.total.toFixed(4)}` : undefined],
        ]} />
      ),
    }]),
    ...(timing === undefined ? [] : [{ id: "timing", label: "Timing", render: () => <TimingFacts timing={timing} output={usage?.output} /> }]),
  ];
}

function recordTabs(record: LedgerRecord, system: SystemRecord | undefined): Tab[] {
  switch (record.kind) {
    case "system":
      return [
        { id: "system", label: "System Prompt", render: () => <SystemPrompt request={record.request} /> },
        ...(record.previous === undefined ? [] : [{ id: "diff", label: "Diff", render: () => <Diff record={record} /> }]),
        { id: "tools", label: "Tools", render: () => <ToolsList request={record.request} /> },
        { id: "sources", label: "Sources", render: () => <Sources request={record.request} /> },
      ];
    case "user":
      return [
        { id: "summary", label: "Summary", render: () => <><Facts rows={[["Turn", String(record.turn.index)], ["Sent", clock(record.at)]]} /><Pre text={textOf(record.message.content)} /></> },
        { id: "raw", label: "Raw", render: () => <Pre text={json(record.message)} /> },
      ];
    case "assistant": {
      const message = record.message;
      const thinking = thinkingOf(record);
      const text = textOf(message.content);
      return [
        {
          id: "summary", label: "Summary", render: () => (
            <>
              <Facts rows={[
                ["Request", `#${record.requestNumber}`],
                ["Model", `${message.provider}/${message.model}`],
                ["Stop", message.stopReason],
                ["Error", message.errorMessage],
                ["Tokens", `${formatTokens(inputTokens(message.usage))} in · ${formatTokens(message.usage.output)} out`],
                ["Duration", record.timing === undefined ? undefined : formatDuration(record.timing.endedAt - record.timing.startedAt)],
                ["TTFT", record.timing?.firstTokenAt === undefined ? undefined : formatDuration(record.timing.firstTokenAt - record.timing.startedAt)],
                ["Tool calls", callsOf(record).join(", ")],
              ]} />
              <Show when={record.step.request}>
                {(request) => <button class="trj-link" onClick={() => select({ type: "request", eventId: request().eventId })}>Open request #{record.requestNumber} →</button>}
              </Show>
            </>
          ),
        },
        {
          id: "preview", label: "Preview", render: () => (
            <>
              <Show when={thinking}><details class="trj-thinking"><summary>Thinking</summary><div class="trj-quote">{thinking}</div></details></Show>
              <Show when={text} fallback={<p class="trj-desc">No text output.</p>}><div class="trj-md"><Markdown text={text} /></div></Show>
            </>
          ),
        },
        { id: "raw", label: "Raw", render: () => <Pre text={json(message)} /> },
        ...(record.timing === undefined ? [] : [{ id: "timing", label: "Timing", render: () => <TimingFacts timing={record.timing!} output={message.usage.output} /> }]),
      ];
    }
    case "tool": {
      const run = record.run;
      const result = run.result === undefined ? undefined : textOf(run.result.content);
      const timing = run.timing;
      return [
        {
          id: "summary", label: "Summary", render: () => (
            <>
              <Facts rows={[
                ["Tool", run.call.name],
                ["Status", run.result === undefined ? "no result" : run.result.isError ? "error" : "ok"],
                ["Duration", timing === undefined ? undefined : formatDuration(timing.endedAt - timing.startedAt)],
                ["Call id", <span class="trj-mono">{run.call.id}</span>],
              ]} />
              <Section title="Payload"><Pre text={json(run.call.arguments)} /></Section>
              <Show when={result !== undefined}><Section title="Result"><Pre text={result!} error={run.result?.isError === true} /></Section></Show>
            </>
          ),
        },
        { id: "payload", label: "Payload", render: () => <Pre text={json(run.call.arguments)} /> },
        ...(result === undefined ? [] : [{ id: "result", label: "Result", render: () => <Pre text={result} error={run.result?.isError === true} /> }]),
        ...(record.spec === undefined ? [] : [{ id: "schema", label: "Schema", render: () => <><p class="trj-desc">{record.spec!.description}</p><Pre text={json(record.spec!.parameters)} /></> }]),
        ...(timing === undefined ? [] : [{
          id: "timing", label: "Timing", render: () => <Facts rows={[["Started", clock(timing.startedAt)], ["Ended", clock(timing.endedAt)], ["Duration", formatDuration(timing.endedAt - timing.startedAt)]]} />,
        }]),
      ];
    }
  }
}

function Tabs(props: { tabs: readonly Tab[] }) {
  const active = () => props.tabs.find((candidate) => candidate.id === tab()) ?? props.tabs[0];
  return (
    <>
      <div class="trj-tabs" role="tablist" aria-label="Event details">
        <For each={props.tabs}>
          {(candidate) => <button role="tab" class="trj-tab" aria-selected={active()?.id === candidate.id} onClick={() => setTab(candidate.id)}>{candidate.label}</button>}
        </For>
      </div>
      <div class="trj-detail-body" role="tabpanel">{active()?.render()}</div>
    </>
  );
}

function Details(props: { records: readonly LedgerRecord[] }) {
  const systemFor = (eventId: string | undefined) =>
    eventId === undefined ? undefined : props.records.find((record): record is SystemRecord => record.kind === "system" && record.request.eventId === eventId);
  const view = createMemo(() => {
    const s = selection();
    if (s === undefined) return undefined;
    if (s.type === "record") {
      const record = props.records.find((candidate) => candidate.id === s.id);
      if (record === undefined) return undefined;
      const where = record.kind === "user" ? `Turn ${record.turn.index}`
        : record.kind === "system" ? `Request #${record.requestNumber}`
        : `Turn ${record.turn.index} · Step ${record.step.index}`;
      return {
        kind: record.kind as LedgerRecord["kind"] | "request",
        name: record.kind === "tool" ? record.run.call.name : "",
        where,
        tabs: recordTabs(record, systemFor(requestOf(record)?.eventId)),
      };
    }
    const assistant = props.records.find((record): record is AssistantRecord => record.kind === "assistant" && !record.failed && record.step.request?.eventId === s.eventId);
    const request = assistant?.step.request ?? systemFor(s.eventId)?.request;
    if (request === undefined) return undefined;
    return {
      kind: "request" as const,
      name: assistant === undefined ? "" : `#${assistant.requestNumber}`,
      where: assistant === undefined ? "" : `Turn ${assistant.turn.index} · Step ${assistant.step.index}`,
      tabs: requestTabs(request, assistant, systemFor(s.eventId)),
    };
  });
  return (
    <Show when={view()}>
      {(v) => (
        <aside class="trj-details" aria-label="Event details">
          <header class="trj-details-head">
            <span class="trj-details-title">
              <KindTag kind={v().kind} />
              <Show when={v().name}><span class="trj-mono">{v().name}</span></Show>
              <span class="trj-details-where">{v().where}</span>
            </span>
            <button class="trj-close" aria-label="Close details" onClick={() => select(undefined)}><XIcon /></button>
          </header>
          <Tabs tabs={v().tabs} />
        </aside>
      )}
    </Show>
  );
}

// ------------------------------------------------------------------ view

export function Trajectory(): JSX.Element {
  const records = createMemo(() => ledger(trajectory()));
  const now = useNow(isBusy);
  const allSpans = createMemo(() => spans(records()));
  const needle = () => query().trim().toLowerCase();
  const matches = (record: LedgerRecord) => needle() === "" || searchText(record).toLowerCase().includes(needle());
  createEffect(on(() => state.activeId, () => { select(undefined); setRange(undefined); setQuery(""); }));

  return (
    <div class="trj">
      <div class="trj-pane">
        <Toolbar />
        <Timeline spans={allSpans()} now={now()} matches={matches} />
        <div class="trj-scroll">
          <Show when={records().length > 0} fallback={<p class="trj-empty">{state.activeId === undefined ? "Start a chat to see its trajectory." : "No records on this branch yet."}</p>}>
            <Ledger records={records()} matches={matches} now={now()} />
          </Show>
        </div>
      </div>
      <Details records={records()} />
    </div>
  );
}
