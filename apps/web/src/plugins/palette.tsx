import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { Component } from "solid-js";
import { Dynamic, Portal } from "solid-js/web";
import type { CommandInfo, InteractionRequest } from "@lemma/contracts";
import { formatKeys, shortcut } from "../lib/keys.ts";
import { load, save } from "../lib/storage.ts";
import { relativeTime, tildePath } from "../model/format.ts";
import { highlight, parseQuery, rank, remember } from "../model/palette.ts";
import type { PaletteMode, Searchable } from "../model/palette.ts";
import { sessionTitle } from "../model/sessions.ts";
import { ChatIcon, CheckIcon, ChevronIcon, CommandIcon, FolderIcon, GitBranchIcon, KeyIcon, PuzzleIcon, RefreshIcon, Spinner } from "../components/icons.tsx";
import { Actions, Client, Commands, Dialogs, Interactions, Layers, Sessions, Slots, Workspace } from "../ui/contracts.ts";
import type { Action, ClientService, CommandsService, DialogsService, InteractionsService, SessionsService, WorkspaceService } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import type { SlotItem, SlotsService } from "../ui/slots.ts";

const DIALOG = "palette";

interface Deps {
  readonly client: ClientService;
  readonly sessions: SessionsService;
  readonly workspace: WorkspaceService;
  readonly commands: CommandsService;
  readonly interactions: InteractionsService;
  readonly dialogs: DialogsService;
  readonly slots: SlotsService;
}

type Kind = "command" | "session" | "project" | "option";

interface Item extends Searchable {
  readonly kind: Kind;
  /** Shown before the title, as in `Git: Switch branch…`. */
  readonly category?: string | undefined;
  readonly detail?: string | undefined;
  readonly shortcut?: string | undefined;
  readonly current?: boolean | undefined;
  readonly icon?: Component | undefined;
  /** A plugin's command: runs on the host while the palette shows its questions. */
  readonly command?: CommandInfo | undefined;
  /** Asks for more in the palette first (a new session title). */
  readonly ask?: (() => Asking | undefined) | undefined;
  /** Anything else: runs after the palette closes. */
  readonly run?: (() => void) | undefined;
}

/** What the palette asks: a host question, or one of its own (renaming a session). */
type Question =
  | { readonly type: "select"; readonly title: string; readonly options: readonly Item[] }
  | { readonly type: "ask"; readonly title: string; readonly placeholder?: string | undefined; readonly secret?: boolean | undefined }
  | { readonly type: "confirm"; readonly title: string; readonly detail?: string | undefined };

interface Asking {
  readonly id: string;
  readonly question: Question;
  readonly answer: (value: string) => void;
  readonly dismiss: () => void;
}

const RECENT_KEY = "lemma.palette.recent";
const SESSIONS_BROWSED = 8;
const RESULTS = 60;

const loadRecent = (): string[] => {
  try {
    const parsed: unknown = JSON.parse(load(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
};

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

const hostIcon = (command: CommandInfo): Component => {
  switch (command.category) {
    case "Git":
      return GitBranchIcon;
    case "Host":
      return command.id === "host.reload" ? RefreshIcon : PuzzleIcon;
    case "Providers":
      return KeyIcon;
    default:
      return CommandIcon;
  }
};

const fromInteraction = (request: InteractionRequest): Question => {
  switch (request.type) {
    case "select":
      return {
        type: "select",
        title: request.title,
        options: request.options.map((option) => ({
          key: option.value,
          kind: "option",
          title: option.label,
          detail: option.description,
          keywords: [option.value, ...(option.description === undefined ? [] : [option.description])],
        })),
      };
    case "ask":
      return { type: "ask", title: request.title, placeholder: request.placeholder, secret: request.secret };
    case "confirm":
      return { type: "confirm", title: request.title, detail: request.detail };
  }
};

const CONFIRM: readonly Item[] = [
  { key: "yes", kind: "option", title: "Yes" },
  { key: "no", kind: "option", title: "No" },
];

function Highlighted(props: { text: string; matches: readonly number[] }) {
  const parts = createMemo(() => highlight(props.text, props.matches));
  return <For each={parts()}>{(part) => (part.hit ? <mark>{part.text}</mark> : part.text)}</For>;
}

/**
 * Cmd+K (Ctrl+K on Windows and Linux): search everything the app can do or
 * open. Every plugin's actions, the host's commands, sessions, and projects
 * share one ranked list; `>`, `@`, and `#` narrow it. While open, the palette
 * shows the host's questions in place of the question dialog, so a command
 * that asks (which branch? what name?) continues here.
 */
function Palette(props: { deps: Deps }) {
  const { client, sessions, workspace, commands: hostCommandsService, interactions, dialogs, slots } = props.deps;
  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal("");
  const [active, setActive] = createSignal(0);
  const [running, setRunning] = createSignal<CommandInfo | undefined>();
  const [local, setLocal] = createSignal<Asking | undefined>();
  const [recent, setRecent] = createSignal(loadRecent());
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  const previous = document.activeElement as HTMLElement | null;
  let disposed = false;
  // The host's questions show here while the palette is open.
  onCleanup(interactions.claim());

  const close = () => {
    dialogs.open(undefined);
  };
  const choose = (item: Item) => {
    const next = remember(recent(), item.key);
    setRecent(next);
    save(RECENT_KEY, JSON.stringify(next));
    if (item.command !== undefined) return void execute(item.command);
    if (item.ask !== undefined) return void setLocal(item.ask());
    // Closing puts focus back first, so an item that opens a dialog or focuses the prompt keeps its focus.
    close();
    queueMicrotask(() => item.run?.());
  };
  const execute = async (command: CommandInfo) => {
    setRunning(command);
    setQuery("");
    const ok = await hostCommandsService.run(command);
    // This palette may have closed while the command ran; a palette opened since is not its to close.
    if (disposed || running() !== command) return;
    setRunning(undefined);
    if (ok && dialogs.current() === DIALOG) close();
  };

  // ---------------------------------------------------------------- items

  /** An action that asks for a value first asks here; answering runs it. */
  const askFor = (action: SlotItem<Action>, question: { readonly title: string; readonly placeholder?: string }): Asking => ({
    id: `input:${action.id}`,
    question: { type: "ask", title: question.title, placeholder: question.placeholder },
    answer: (value) => {
      setLocal(undefined);
      close();
      action.run(value);
    },
    dismiss: () => setLocal(undefined),
  });

  const clientCommands = createMemo((): Item[] =>
    slots
      .list(Actions)
      .filter((action) => action.hidden !== true && (action.when?.() ?? true))
      .map((action) => {
        const keys = typeof action.keys === "string" ? action.keys : action.keys?.[0];
        const input = action.input;
        return {
          key: `action:${action.id}`,
          kind: "command",
          category: action.category,
          title: action.title,
          detail: action.detail,
          keywords: action.keywords,
          shortcut: keys === undefined ? undefined : formatKeys(keys),
          icon: action.icon,
          ...(input === undefined ? { run: () => action.run() } : { ask: () => askFor(action, input()) }),
        };
      }),
  );

  const hostCommands = createMemo((): Item[] =>
    hostCommandsService.list().map((command) => ({
      key: `command:${command.id}`,
      kind: "command",
      category: command.category,
      title: command.title,
      detail: command.description,
      keywords: [...(command.keywords ?? []), ...(command.category === undefined ? [] : [command.category]), command.id],
      icon: hostIcon(command),
      command,
    })),
  );

  const commands = createMemo(() => [...clientCommands(), ...hostCommands()]);

  const sessionItems = createMemo((): Item[] =>
    [...sessions.list()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((session) => ({
        key: `session:${session.id}`,
        kind: "session",
        title: sessionTitle(session),
        detail: `${basename(session.cwd)} · ${relativeTime(session.updatedAt)}`,
        keywords: [basename(session.cwd), session.id],
        current: session.id === sessions.activeId(),
        icon: ChatIcon,
        run: () => void sessions.select(session.id),
      })),
  );

  const projects = createMemo((): Item[] => {
    const hostCwd = client.info()?.cwd;
    return workspace.projects().map((path) => ({
      key: `project:${path}`,
      kind: "project",
      title: basename(path),
      detail: tildePath(path, client.info()?.home),
      keywords: [path],
      icon: FolderIcon,
      run: () => sessions.newChat(path === hostCwd ? undefined : path),
    }));
  });

  const pool = (mode: PaletteMode): Item[] =>
    mode === "commands"
      ? commands()
      : mode === "sessions"
        ? sessionItems()
        : mode === "projects"
          ? projects()
          : [...commands(), ...sessionItems(), ...projects()];

  // ---------------------------------------------------------------- questions

  // Host questions take precedence: a running command is waiting on them.
  const asking = createMemo((): Asking | undefined => {
    const request = interactions.open()[0];
    if (request === undefined) return local();
    return {
      id: request.id,
      question: fromInteraction(request),
      answer: (value) =>
        interactions.answer(
          request.id,
          request.type === "confirm"
            ? { type: "confirm", value: value === "yes" }
            : request.type === "ask"
              ? { type: "ask", value }
              : { type: "select", value },
        ),
      dismiss: () => interactions.dismiss(request.id),
    };
  });

  // A new question starts with an empty field and the first option.
  createEffect(
    on(
      () => asking()?.id,
      () => {
        setFilter("");
        setActive(0);
        queueMicrotask(() => input?.focus());
      },
    ),
  );

  // ---------------------------------------------------------------- rows

  type Row =
    | { readonly type: "heading"; readonly label: string }
    | { readonly type: "item"; readonly item: Item; readonly matches: readonly number[]; readonly index: number };

  const rows = createMemo((): Row[] => {
    const current = asking();
    if (current !== undefined) {
      const question = current.question;
      if (question.type === "ask") return [];
      const options = question.type === "confirm" ? CONFIRM : question.options;
      return rank(options, filter()).map((ranked, index) => ({ type: "item", item: ranked.item, matches: ranked.matches, index }));
    }
    if (running() !== undefined) return [];
    const { mode, text } = parseQuery(query());
    let index = 0;
    const item = (entry: { item: Item; matches: readonly number[] }): Row => ({ type: "item", ...entry, index: index++ });
    if (text.trim() !== "") return rank(pool(mode), text, recent()).slice(0, RESULTS).map(item);
    if (mode !== "all") return pool(mode).map((entry) => item({ item: entry, matches: [] }));
    // Browsing: recent choices, then every command, the latest sessions, and projects.
    const all = pool("all");
    const byKey = new Map(all.map((entry) => [entry.key, entry]));
    const recentItems = recent()
      .map((key) => byKey.get(key))
      .filter((entry): entry is Item => entry !== undefined)
      .slice(0, 5);
    const shown = new Set(recentItems.map((entry) => entry.key));
    // Commands lead without a heading; the others are named so the switch from actions to places is visible.
    const section = (label: string | undefined, items: readonly Item[]): Row[] =>
      items.length === 0
        ? []
        : [...(label === undefined ? [] : [{ type: "heading" as const, label }]), ...items.map((entry) => item({ item: entry, matches: [] }))];
    return [
      ...section("Recent", recentItems),
      ...section(
        undefined,
        commands().filter((entry) => !shown.has(entry.key)),
      ),
      ...section(
        "Sessions",
        sessionItems()
          .filter((entry) => !shown.has(entry.key))
          .slice(0, SESSIONS_BROWSED),
      ),
      ...section(
        "Projects",
        projects().filter((entry) => !shown.has(entry.key)),
      ),
    ];
  });

  const items = createMemo(() => rows().filter((row): row is Extract<Row, { type: "item" }> => row.type === "item"));

  createEffect(on([query, filter], () => setActive(0), { defer: true }));
  createEffect(
    on(active, (index) => {
      list?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
    }),
  );

  // ---------------------------------------------------------------- keys

  const move = (by: number) => {
    const count = items().length;
    if (count > 0) setActive((index) => (index + by + count) % count);
  };

  const submit = () => {
    const current = asking();
    if (current !== undefined) {
      if (current.question.type === "ask") {
        if (filter().trim() !== "") current.answer(filter());
        return;
      }
      const picked = items()[active()];
      if (picked !== undefined) current.answer(picked.item.key);
      return;
    }
    const picked = items()[active()]?.item;
    if (picked === undefined) return;
    choose(picked);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey;
    if (event.key === "ArrowDown" || (ctrlOnly && event.key === "n")) {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp" || (ctrlOnly && event.key === "p")) {
      event.preventDefault();
      move(-1);
    } else if (event.key === "PageDown") {
      event.preventDefault();
      move(Math.min(8, items().length - 1 - active()));
    } else if (event.key === "PageUp") {
      event.preventDefault();
      move(-Math.min(8, active()));
    } else if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const current = asking();
      // Dismissing a command's question cancels the command; the palette stays for the next thing.
      if (current !== undefined) current.dismiss();
      else if (running() === undefined && query() !== "") setQuery("");
      else close();
    } else if (event.key === "Backspace" && local() !== undefined && filter() === "") {
      event.preventDefault();
      setLocal(undefined);
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  };

  onMount(() => queueMicrotask(() => input.focus()));
  onCleanup(() => {
    disposed = true;
    previous?.focus?.();
  });

  // ---------------------------------------------------------------- view

  const value = () => (asking() === undefined ? query() : filter());
  const setValue = (next: string) => (asking() === undefined ? setQuery(next) : setFilter(next));
  const placeholder = () => {
    const question = asking()?.question;
    if (question?.type === "ask") return question.placeholder ?? "Type an answer";
    if (question !== undefined) return "Filter";
    if (running() !== undefined) return `Running ${running()!.title.replace(/…$/, "")}…`;
    return "Search commands, sessions, and projects";
  };
  const heading = () => {
    const question = asking()?.question;
    const command = running()?.title.replace(/…$/, "");
    if (question === undefined) return command;
    return command === undefined ? question.title : `${command} › ${question.title}`;
  };
  const secret = () => {
    const question = asking()?.question;
    return question?.type === "ask" && question.secret === true;
  };
  const confirmDetail = () => {
    const question = asking()?.question;
    return question?.type === "confirm" ? question.detail : undefined;
  };
  const activeId = () => (items()[active()] === undefined ? undefined : `palette-row-${active()}`);

  return (
    <Portal>
      <div
        class="backdrop palette-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
          <Show when={heading()}>
            <div class="palette-heading">{heading()}</div>
          </Show>
          <div class="palette-input palette-input-text">
            <Show when={running() !== undefined && asking() === undefined} fallback={<ChevronIcon />}>
              <Spinner />
            </Show>
            <input
              ref={input}
              type={secret() ? "password" : "text"}
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={activeId()}
              aria-label={asking()?.question.title ?? "Search commands, sessions, and projects"}
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              placeholder={placeholder()}
              // Read-only, not disabled, while a command runs: a disabled field drops focus, and with it Esc and typing once the command ends.
              readOnly={asking() === undefined && running() !== undefined}
              value={value()}
              onInput={(event) => setValue(event.currentTarget.value)}
            />
          </div>
          <Show when={confirmDetail()}>{(detail) => <p class="palette-question-detail">{detail()}</p>}</Show>
          <Show when={rows().length > 0}>
            <div ref={list} id="palette-list" class="palette-list" role="listbox" aria-label="Results">
              <For each={rows()}>
                {(row) =>
                  row.type === "heading" ? (
                    <div class="palette-section" role="presentation">
                      {row.label}
                    </div>
                  ) : (
                    <div
                      id={`palette-row-${row.index}`}
                      class="palette-row"
                      role="option"
                      data-index={row.index}
                      data-active={String(row.index === active())}
                      aria-selected={row.index === active()}
                      onPointerMove={() => setActive(row.index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setActive(row.index);
                        submit();
                      }}
                    >
                      <Show when={row.item.icon}>{(icon) => <Dynamic component={icon()} />}</Show>
                      <span class="palette-name">
                        <Show when={row.item.category}>
                          <span class="palette-category">{row.item.category}: </span>
                        </Show>
                        <Highlighted text={row.item.title} matches={row.matches} />
                      </span>
                      <span class="palette-hint">{row.item.detail}</span>
                      <Show when={row.item.shortcut}>
                        <kbd class="palette-kbd">{row.item.shortcut}</kbd>
                      </Show>
                      <Show when={row.item.current}>
                        <span class="palette-current" aria-label="current">
                          <CheckIcon />
                        </span>
                      </Show>
                    </div>
                  )
                }
              </For>
            </div>
          </Show>
          <Show when={rows().length === 0 && asking() === undefined && running() === undefined}>
            <div class="palette-empty">Nothing matches “{parseQuery(query()).text.trim()}”</div>
          </Show>
          <footer class="palette-foot">
            <Show
              when={asking() === undefined}
              fallback={
                <>
                  <span>
                    <kbd>↵</kbd> {asking()?.question.type === "ask" ? "submit" : "choose"}
                  </span>
                  <span>
                    <kbd>esc</kbd> {local() === undefined ? "cancel" : "back"}
                  </span>
                </>
              }
            >
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd> move
              </span>
              <span>
                <kbd>↵</kbd> run
              </span>
              <span>
                <kbd>&gt;</kbd> commands <kbd>@</kbd> sessions <kbd>#</kbd> projects
              </span>
              <span class="palette-foot-end">
                <kbd>{shortcut("mod", "K")}</kbd> close
              </span>
            </Show>
          </footer>
        </div>
      </div>
    </Portal>
  );
}

/** Search and run everything: plugins' actions, the host's commands, sessions, projects. */
export default defineUiPlugin({
  id: "palette",
  requires: {
    client: Client,
    sessions: Sessions,
    workspace: Workspace,
    commands: Commands,
    interactions: Interactions,
    dialogs: Dialogs,
    slots: Slots,
  },
  setup: (deps, plugin) => {
    const { dialogs, interactions, slots } = deps;
    plugin.onCleanup(
      slots.add(Layers, {
        id: DIALOG,
        component: () => (
          <Show when={dialogs.current() === DIALOG}>
            <Palette deps={deps} />
          </Show>
        ),
      }),
    );
    plugin.onCleanup(
      slots.add(Actions, {
        id: "palette.open",
        title: "Command palette",
        icon: CommandIcon,
        hidden: true,
        keys: "mod+k",
        // Opens over any other dialog; a question the host asks keeps the screen until answered.
        global: true,
        when: () => dialogs.current() === DIALOG || interactions.open().length === 0,
        run: () => dialogs.open(dialogs.current() === DIALOG ? undefined : DIALOG),
      }),
    );
  },
});
