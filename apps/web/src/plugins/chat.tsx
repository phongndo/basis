import { For, Index, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Schema } from "effect";
import type { ImageContent, TextContent } from "@lemma/contracts";
import { diffStats, parseDiff, readDetails } from "../model/details.ts";
import { formatDuration, formatTokens, summarizeToolArgs, summarizePartialArgs, summarizeUsage, truncateLines } from "../model/format.ts";
import { parseDraftArgs } from "../model/live.ts";
import type { DraftBlock, StepDraft } from "../model/live.ts";
import { createProjector, pendingToolCalls } from "../model/transcript.ts";
import type { AssistantItem, AttemptItem, Block, Item, ToolResultView, TurnView } from "../model/transcript.ts";
import { AlertIcon, ChatIcon, CheckIcon, ChevronDownIcon, ChevronIcon, Spinner, XIcon } from "../components/icons.tsx";
import { Markdown } from "../components/markdown.tsx";
import { Client, Sessions, Slots, ToolViews, Views } from "../ui/contracts.ts";
import type { ClientService, SessionsService } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import type { SlotsService } from "../ui/slots.ts";

export const ChatConfig = Schema.Struct({
  expandTools: Schema.optionalWith(Schema.Boolean, { default: () => false }).annotations({
    title: "Open tool calls",
    description: "Show every tool call's arguments and output instead of one quiet line.",
  }),
});

interface Chat {
  readonly client: ClientService;
  readonly sessions: SessionsService;
  readonly slots: SlotsService;
  readonly config: typeof ChatConfig.Type;
  readonly isOpen: (key: string, fallback: boolean) => boolean;
  readonly toggle: (key: string, fallback: boolean) => void;
  readonly pending: () => ReadonlySet<string>;
}

const imageSrc = (image: ImageContent) => `data:${image.mimeType};base64,${image.data}`;

function Images(props: { content: readonly (TextContent | ImageContent)[] }) {
  const images = () => props.content.filter((part): part is ImageContent => part.type === "image");
  return (
    <Show when={images().length > 0}>
      <div class="images">
        <For each={images()}>{(image) => <img src={imageSrc(image)} alt="Attached image" loading="lazy" />}</For>
      </div>
    </Show>
  );
}

function UserView(props: { content: readonly (TextContent | ImageContent)[] }) {
  const text = () =>
    props.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("\n\n");
  return (
    <div class="user-message">
      <Show when={text()}>
        <div class="user-text">{text()}</div>
      </Show>
      <Images content={props.content} />
    </div>
  );
}

function Thinking(props: { chat: Chat; id: string; text: string; redacted?: boolean; live?: boolean }) {
  const { isOpen, toggle } = props.chat;
  const open = () => isOpen(props.id, false);
  const preview = () =>
    props.text
      .trim()
      .split("\n")
      .filter(Boolean)
      .at(props.live ? -1 : 0) ?? "";
  return (
    <div class="thinking" classList={{ open: open(), live: props.live === true }}>
      <button class="thinking-head" aria-expanded={open()} onClick={() => toggle(props.id, false)}>
        <ChevronIcon class="chevron" />
        <span class="thinking-label">{props.live ? "Thinking" : props.redacted ? "Thinking (redacted)" : "Thought"}</span>
        <Show when={!open() && preview()}>
          <span class="thinking-preview">{preview()}</span>
        </Show>
      </button>
      <Show when={open()}>
        <div class="thinking-body">{props.text}</div>
      </Show>
    </div>
  );
}

function Output(props: { id: string; text: string; error?: boolean; lines?: number }) {
  const max = () => props.lines ?? 14;
  const [all, setAll] = createSignal(false);
  const cut = createMemo(() => truncateLines(props.text.replace(/\n+$/, ""), max()));
  return (
    <div class="output" classList={{ error: props.error === true }}>
      <pre>{all() ? props.text.replace(/\n+$/, "") : cut().text}</pre>
      <Show when={cut().hidden > 0}>
        <button class="link-button" onClick={() => setAll(!all())}>
          {all() ? "Show less" : `Show ${cut().hidden} more lines`}
        </button>
      </Show>
    </div>
  );
}

function Diff(props: { diff: string }) {
  const lines = createMemo(() => parseDiff(props.diff));
  return (
    <pre class="diff">
      <For each={lines()}>
        {(line) => (
          <span class={`diff-${line.kind}`}>
            {line.text}
            {"\n"}
          </span>
        )}
      </For>
    </pre>
  );
}

type ToolState = "running" | "queued" | "ok" | "error" | "interrupted";

/** A tool call and its result. `result` absent while the tool runs (or if the turn stopped first). */
function ToolCard(props: {
  chat: Chat;
  id: string;
  name: string;
  args: Record<string, unknown> | undefined;
  partial?: string;
  result?: ToolResultView | undefined;
  state: ToolState;
}) {
  const { client, sessions, slots, isOpen, toggle } = props.chat;
  const context = () => {
    const info = client.info();
    return info === undefined ? {} : { cwd: sessions.active()?.cwd ?? info.cwd, home: info.home };
  };
  /** A plugin's view of this tool, when one fills the slot for it. */
  const custom = () => slots.get(ToolViews, props.name);
  const details = createMemo(() => readDetails(props.result?.details));
  const summary = createMemo(() => custom()?.summary?.(props.args, context()) ?? summarizeToolArgs(props.name, props.args, context()));
  const primary = () => summary().primary ?? (props.partial === undefined ? undefined : summarizePartialArgs(props.name, props.partial));
  const outputText = () =>
    props.result?.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? "";
  const diff = () => details().diff;
  const stats = createMemo(() => {
    const d = diff();
    return d === undefined ? undefined : diffStats(parseDiff(d));
  });
  // Every call starts as one quiet line unless configured otherwise; its status, diffstat, and timing say enough until it is opened.
  const defaultOpen = () => props.chat.config.expandTools;
  const open = () => isOpen(props.id, defaultOpen());
  const argsShown = () => summary().primary === undefined && props.args !== undefined && Object.keys(props.args).length > 0;
  const duration = () => {
    const t = props.result?.timing;
    return t === undefined ? undefined : t.endedAt - t.startedAt;
  };
  return (
    <div class={`tool tool-${props.state}`} classList={{ open: open() }}>
      <button class="tool-head" aria-expanded={open()} onClick={() => toggle(props.id, defaultOpen())}>
        <ChevronIcon class="chevron" />
        <span class="tool-status">
          <Switch>
            <Match when={props.state === "running"}>
              <Spinner />
            </Match>
            <Match when={props.state === "queued"}>
              <span class="dot-muted" />
            </Match>
            <Match when={props.state === "ok"}>
              <CheckIcon />
            </Match>
            <Match when={props.state === "error"}>
              <XIcon />
            </Match>
            <Match when={props.state === "interrupted"}>
              <span class="dot-muted" />
            </Match>
          </Switch>
        </span>
        <span class="tool-name">{props.name || "tool"}</span>
        <Show when={primary()}>
          <span class="tool-primary" classList={{ shell: summary().shell === true || props.name === "bash" }}>
            {primary()}
          </span>
        </Show>
        <Show when={summary().secondary}>
          <span class="tool-secondary">{summary().secondary}</span>
        </Show>
        <span class="tool-meta">
          <Show when={stats()}>
            {(s) => (
              <span class="diffstat">
                <span class="add">+{s().added}</span> <span class="del">−{s().removed}</span>
              </span>
            )}
          </Show>
          <Show when={details().exitCode !== undefined && details().exitCode !== 0}>
            <span class="badge badge-error">exit {details().exitCode}</span>
          </Show>
          <Show when={props.state === "interrupted"}>
            <span class="badge">no result</span>
          </Show>
          <Show when={duration() !== undefined && duration()! >= 1000}>
            <span class="muted">{formatDuration(duration()!)}</span>
          </Show>
        </span>
      </button>
      <Show when={open()}>
        <Show
          when={custom()?.body}
          keyed
          fallback={
            <DefaultBody
              id={props.id}
              args={props.args}
              result={props.result}
              state={props.state}
              argsShown={argsShown()}
              diff={diff()}
              outputText={outputText()}
              details={details()}
            />
          }
        >
          {(body) => <Dynamic component={body} id={props.id} name={props.name} args={props.args} result={props.result} state={props.state} />}
        </Show>
      </Show>
    </div>
  );
}

function DefaultBody(props: {
  id: string;
  args: Record<string, unknown> | undefined;
  result?: ToolResultView | undefined;
  state: ToolState;
  argsShown: boolean;
  diff: string | undefined;
  outputText: string;
  details: ReturnType<typeof readDetails>;
}) {
  const argsShown = () => props.argsShown;
  const diff = () => props.diff;
  const outputText = () => props.outputText;
  const details = () => props.details;
  return (
    <div class="tool-body">
      <Show when={argsShown()}>
        <pre class="tool-args">{JSON.stringify(props.args, null, 2)}</pre>
      </Show>
      <Show when={diff()}>{(d) => <Diff diff={d()} />}</Show>
      <Show when={outputText() && !(diff() !== undefined && props.state === "ok")}>
        <Output id={props.id} text={outputText()} error={props.state === "error"} />
      </Show>
      <Show when={props.result}>{(result) => <Images content={result().content} />}</Show>
      <Show when={details().truncated}>
        <p class="muted small">Output truncated{details().fullOutputPath ? ` — full output in ${details().fullOutputPath}` : ""}</p>
      </Show>
      <Show when={props.state === "ok" && !outputText() && diff() === undefined && !props.result?.content.some((part) => part.type === "image")}>
        <p class="muted small">No output</p>
      </Show>
    </div>
  );
}

function Blocks(props: { chat: Chat; blocks: readonly Block[]; turnEnded: boolean }) {
  return (
    <For each={props.blocks}>
      {(block) => (
        <Switch>
          <Match when={block.kind === "text" && block}>{(b) => <Markdown text={b().text} />}</Match>
          <Match when={block.kind === "thinking" && block}>
            {(b) => (
              <Show when={b().text.trim() || b().redacted}>
                <Thinking chat={props.chat} id={b().key} text={b().text} redacted={b().redacted} />
              </Show>
            )}
          </Match>
          <Match when={block.kind === "tool" && block}>
            {(b) => {
              const toolState = (): ToolState => {
                const result = b().result;
                if (result !== undefined) return result.isError ? "error" : "ok";
                return props.turnEnded || !props.chat.sessions.busy() ? "interrupted" : "running";
              };
              return <ToolCard chat={props.chat} id={b().call.id} name={b().call.name} args={b().call.arguments} result={b().result} state={toolState()} />;
            }}
          </Match>
        </Switch>
      )}
    </For>
  );
}

function StopNote(props: { item: AssistantItem }) {
  return (
    <Switch>
      <Match when={props.item.message.stopReason === "error"}>
        <div class="callout callout-error">
          <AlertIcon />
          <span>{props.item.message.errorMessage ?? "The model request failed."}</span>
        </div>
      </Match>
      <Match when={props.item.message.stopReason === "aborted"}>
        <p class="note">Stopped</p>
      </Match>
      <Match when={props.item.message.stopReason === "length"}>
        <p class="note">Output hit the model's token limit</p>
      </Match>
    </Switch>
  );
}

function Attempt(props: { chat: Chat; item: AttemptItem }) {
  const { isOpen, toggle } = props.chat;
  const open = () => isOpen(props.item.id, false);
  const hasContent = () => props.item.blocks.some((block) => block.kind !== "text" || block.text.trim() !== "");
  const label = () => (props.item.message.stopReason === "aborted" ? "Attempt cancelled" : "Attempt failed");
  return (
    <div class="attempt" classList={{ open: open() }}>
      <button class="attempt-head" aria-expanded={open()} disabled={!hasContent()} onClick={() => toggle(props.item.id, false)}>
        <AlertIcon />
        <span class="attempt-label">{label()}</span>
        <span class="attempt-error">{props.item.message.errorMessage ?? ""}</span>
        <span class="muted">{formatDuration(props.item.timing.endedAt - props.item.timing.startedAt)}</span>
      </button>
      <Show when={open() && hasContent()}>
        <div class="attempt-body">
          <Blocks chat={props.chat} blocks={props.item.blocks} turnEnded={true} />
        </div>
      </Show>
    </div>
  );
}

function ItemView(props: { chat: Chat; item: Item; turnEnded: boolean }): JSX.Element {
  return (
    <Switch>
      <Match when={props.item.kind === "user" && props.item}>{(item) => <UserView content={item().content} />}</Match>
      <Match when={props.item.kind === "assistant" && props.item}>
        {(item) => (
          <div class="assistant">
            <Blocks chat={props.chat} blocks={item().blocks} turnEnded={props.turnEnded} />
            <StopNote item={item()} />
          </div>
        )}
      </Match>
      <Match when={props.item.kind === "attempt" && props.item}>{(item) => <Attempt chat={props.chat} item={item()} />}</Match>
      <Match when={props.item.kind === "compaction" && props.item}>
        {(item) => (
          <div class="divider" data-tip={item().summary}>
            <span>Context compacted · {formatTokens(item().tokensBefore)} tokens summarized</span>
          </div>
        )}
      </Match>
      <Match when={props.item.kind === "orphan-result" && props.item}>
        {(item) => (
          <ToolCard
            chat={props.chat}
            id={item().id}
            name={item().message.toolName}
            args={undefined}
            result={{ eventId: item().id, content: item().message.content, isError: item().message.isError }}
            state={item().message.isError ? "error" : "ok"}
          />
        )}
      </Match>
    </Switch>
  );
}

function TurnFooter(props: { turn: TurnView }) {
  const usage = createMemo(() => summarizeUsage(props.turn.usage));
  const duration = () => (props.turn.endedAt === undefined ? undefined : props.turn.endedAt - props.turn.startedAt);
  const model = () => props.turn.models.map((ref) => ref.slice(ref.indexOf("/") + 1)).join(", ");
  const reason = () => props.turn.end?.reason;
  return (
    <footer class="turn-footer" data-tip={usage().title}>
      <Show when={reason() === "cancelled"}>
        <span class="badge">cancelled</span>
      </Show>
      <Show when={reason() === "max-steps"}>
        <span class="badge badge-warn">step limit</span>
      </Show>
      <Show when={reason() === "error"}>
        <span class="badge badge-error">error</span>
      </Show>
      <Show when={model()}>
        <span>{model()}</span>
      </Show>
      <Show when={props.turn.usage.totalTokens > 0}>
        <span>
          ↑{usage().input} ↓{usage().output}
        </span>
        <Show when={usage().cache}>
          <span>cache {usage().cache}</span>
        </Show>
      </Show>
      <Show when={usage().cost}>
        <span>{usage().cost}</span>
      </Show>
      <Show when={duration() !== undefined}>
        <span>{formatDuration(duration()!)}</span>
      </Show>
    </footer>
  );
}

function Turn(props: { chat: Chat; turn: TurnView }) {
  const ended = () => props.turn.end !== undefined;
  return (
    <section class="turn">
      <For each={props.turn.items}>{(item) => <ItemView chat={props.chat} item={item} turnEnded={ended()} />}</For>
      <Show when={props.turn.end?.reason === "error" && props.turn.end.error}>
        <div class="callout callout-error">
          <AlertIcon />
          <span>{props.turn.end!.error}</span>
        </div>
      </Show>
      <Show when={ended()}>
        <TurnFooter turn={props.turn} />
      </Show>
    </section>
  );
}

function DraftBlockView(props: { chat: Chat; block: DraftBlock; stepId: string; index: number }) {
  return (
    <Switch>
      <Match when={props.block.kind === "text" && props.block}>{(b) => <Markdown text={b().text} class="streaming" />}</Match>
      <Match when={props.block.kind === "thinking" && props.block}>
        {(b) => <Thinking chat={props.chat} id={`${props.stepId}:${props.index}`} text={b().text} live />}
      </Match>
      <Match when={props.block.kind === "tool" && props.block}>
        {(b) => (
          <ToolCard
            chat={props.chat}
            id={b().id || `${props.stepId}:${props.index}`}
            name={b().name}
            args={parseDraftArgs(b())}
            partial={b().args}
            state="queued"
          />
        )}
      </Match>
    </Switch>
  );
}

function Draft(props: { chat: Chat; draft: StepDraft }) {
  return (
    <div class="assistant draft" aria-live="polite" aria-busy="true">
      <Index each={props.draft.blocks}>
        {(block, index) => <Show when={block()}>{(b) => <DraftBlockView chat={props.chat} block={b()} stepId={props.draft.stepId} index={index} />}</Show>}
      </Index>
      <Show when={props.draft.error}>
        <div class="callout callout-error">
          <AlertIcon />
          <span>{props.draft.error}</span>
        </div>
      </Show>
    </div>
  );
}

/** The chat transcript for the active session. */
function Transcript(props: { chat: Chat; turns: readonly TurnView[] }) {
  const { sessions, pending } = props.chat;
  const drafts = () => sessions.live().drafts;
  const working = () => sessions.busy() && drafts().every((draft) => draft.finished) && pending().size === 0;
  return (
    <div class="transcript">
      <Index each={props.turns}>{(turn) => <Turn chat={props.chat} turn={turn()} />}</Index>
      <Index each={drafts()}>{(draft) => <Draft chat={props.chat} draft={draft()} />}</Index>
      <Show when={working()}>
        <div class="working">
          <span class="pulse" />
          Working
        </div>
      </Show>
    </div>
  );
}

function ChatView(props: { chat: Chat; turns: () => readonly TurnView[] }) {
  const sessions = props.chat.sessions;
  let scroller!: HTMLDivElement;
  let content!: HTMLDivElement;
  const [stuck, setStuck] = createSignal(true);
  const toBottom = (smooth = false) => scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  const onScroll = () => setStuck(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80);

  onMount(() => {
    // Follow new output while the reader is at the bottom; leave them alone once they scroll up.
    const observer = new ResizeObserver(() => {
      if (stuck()) toBottom();
    });
    observer.observe(content);
    onCleanup(() => observer.disconnect());
  });
  createEffect(
    on(sessions.activeId, () => {
      setStuck(true);
      queueMicrotask(() => toBottom());
    }),
  );

  const empty = () => props.turns().length === 0;
  return (
    <div class="scroller" ref={scroller} onScroll={onScroll}>
      <div class="content" ref={content}>
        <Switch>
          <Match when={sessions.activeId() !== undefined && !sessions.log().loaded}>
            <div class="loading">
              <Spinner /> Loading session…
            </div>
          </Match>
          <Match when={empty() && !sessions.busy()}>
            <div class="empty-state">
              <h2>{sessions.activeId() === undefined ? "What are we working on?" : "This session is empty"}</h2>
              <p class="muted">The agent can read, edit, and run commands in the project below.</p>
            </div>
          </Match>
        </Switch>
        <Transcript chat={props.chat} turns={props.turns()} />
        <Show when={sessions.log().error}>
          <div class="callout callout-error">Could not load the full session: {sessions.log().error}</div>
        </Show>
      </div>
      <Show when={!stuck()}>
        <button
          class="jump"
          aria-label="Jump to latest"
          onClick={() => {
            setStuck(true);
            toBottom(true);
          }}
        >
          <ChevronDownIcon />
        </button>
      </Show>
    </div>
  );
}

/**
 * The session as a conversation, projected from its log. Tool calls render
 * through the `chat.tools` slot when a plugin fills it for that tool.
 */
export default defineUiPlugin({
  id: "chat",
  config: ChatConfig,
  requires: { client: Client, sessions: Sessions, slots: Slots },
  setup: ({ client, sessions, slots }, plugin) => {
    // Expanded/collapsed choices survive re-renders and session switches while the plugin runs.
    const [expanded, setExpanded] = createSignal<ReadonlyMap<string, boolean>>(new Map());
    let projector = createProjector();
    let projectedFor: string | undefined;
    const transcript = createMemo(() => {
      if (projectedFor !== sessions.activeId()) {
        projector = createProjector();
        projectedFor = sessions.activeId();
      }
      return projector(sessions.branch());
    });
    const pending = createMemo(() => pendingToolCalls(transcript()));
    const chat: Chat = {
      client,
      sessions,
      slots,
      config: plugin.config,
      isOpen: (key, fallback) => expanded().get(key) ?? fallback,
      toggle: (key, fallback) => setExpanded((map) => new Map(map).set(key, !(map.get(key) ?? fallback))),
      pending,
    };
    plugin.onCleanup(
      slots.add(Views, {
        id: "chat",
        title: "Chat",
        icon: ChatIcon,
        composer: true,
        component: () => <ChatView chat={chat} turns={() => transcript().turns} />,
      }),
    );
  },
});
