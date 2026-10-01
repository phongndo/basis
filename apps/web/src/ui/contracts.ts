import { Context } from "effect";
import type { Accessor, Component, JSX } from "solid-js";
import type { ConnectionStatus, Host } from "@lemma/client";
import type {
  AuthType,
  CommandInfo,
  ConfigField,
  ConfigValues,
  CustomProviderSpec,
  ImageContent,
  HostEvent,
  HostInfo,
  InteractionAnswer,
  InteractionRequest,
  LedgerRecord,
  ModelInfo,
  NoticePayload,
  PluginChange,
  PluginStatus,
  PromptContent,
  ProviderInfo,
  ReloadResult,
  SessionEvent,
  SessionInfo,
  SessionMarks,
  TextContent,
  ThinkingLevel,
  TurnOptions,
  UiFile,
  WorkspaceStatus,
} from "@lemma/contracts";
import type { CodeBlock } from "../lib/markdown.ts";
import type { ToolSummary } from "../model/format.ts";
import type { ProjectSettings } from "../model/prefs.ts";
import type { LiveState } from "../model/live.ts";
import type { ToolResultView, TurnView } from "../model/transcript.ts";
import { definePart, defineSlot } from "./slots.ts";
import type { Region, SlotsService } from "./slots.ts";

/*
 * The web app's contracts. Capabilities are services one plugin provides and
 * others require; slots are places any number of plugins contribute to; parts
 * are the replaceable pieces plugins draw with. Every bundled plugin is
 * written against these alone, so any of them can be replaced by a plugin
 * that provides the same capability or fills the same slot. Keys are
 * namespaced `lemma-ui/…`.
 *
 * A few contracts are in the DOM rather than in code, because every plugin's
 * markup takes part in them:
 * - `data-tip` on an element is its tooltip (drawn by the `tooltips` plugin).
 * - `data-theme` (`light`/`dark`) on `<html>` is the resolved theme, and the
 *   `--content` custom property the conversation width; the `appearance`
 *   plugin sets both, and stylesheets and renderers (diagrams) read them.
 * - `aria-expanded` on a button marks a disclosure: the chat keeps it in place
 *   when it opens instead of following new output.
 * - `data-titlebar` on the shell's `.app` means the page fills a desktop
 *   window whose own controls overlay its top-left (`env(titlebar-area-*)`).
 *   The bar atop each column is then the window's title bar: it is 48px tall
 *   and marks itself `app-region: drag`. The shell sets `--titlebar-inset` on
 *   the column under the controls (the sidebar, or the main column when the
 *   sidebar is hidden or a drawer), the room its bar leaves at the left; a
 *   full-screen layer leaves a 48px strip over its own left column.
 */

// ------------------------------------------------------------------ slots

/** The contribution registry every slot lives in. */
export class Slots extends Context.Tag("lemma-ui/Slots")<Slots, SlotsService>() {}

// ------------------------------------------------------------------ host models

export interface ClientService {
  /** The host connection: every RPC as a promise. */
  readonly host: Host;
  readonly status: Accessor<ConnectionStatus>;
  readonly connected: Accessor<boolean>;
  /** `Host.Info`, fetched on every (re)connect. */
  readonly info: Accessor<HostInfo | undefined>;
  /** Every host event as it arrives. Returns the unsubscribe. */
  readonly onEvent: (listener: (event: HostEvent) => void) => () => void;
  /**
   * Runs `sync` now if connected, then after every reconnect: where a model
   * loads what it shows, since events may have been missed in between.
   */
  readonly onConnect: (sync: () => void) => () => void;
}
export class Client extends Context.Tag("lemma-ui/Client")<Client, ClientService>() {}

export interface Toast {
  readonly id: number;
  readonly level: NoticePayload["level"];
  readonly message: string;
  readonly source?: string;
  readonly links?: NoticePayload["links"];
  readonly code?: string;
}

export interface NotifyService {
  readonly toasts: Accessor<readonly Toast[]>;
  /** Shows a message; one with a code or links stays until dismissed. Returns its id. */
  readonly toast: (notice: Omit<Toast, "id">) => number;
  readonly dismiss: (id: number) => void;
  /** Dismisses every toast `drop` is true for. */
  readonly dismissWhere: (drop: (toast: Toast) => boolean) => void;
  /** Shows a failure; `context` says what failed. */
  readonly report: (error: unknown, context?: string) => void;
}
export class Notify extends Context.Tag("lemma-ui/Notify")<Notify, NotifyService>() {}

export interface LogState {
  readonly loaded: boolean;
  readonly syncing: boolean;
  readonly error?: string;
}

export interface SessionsService {
  readonly list: Accessor<readonly SessionInfo[]>;
  readonly loaded: Accessor<boolean>;
  readonly activeId: Accessor<string | undefined>;
  readonly active: Accessor<SessionInfo | undefined>;
  /** The active session's events on its current branch, oldest first. */
  readonly branch: Accessor<readonly SessionEvent[]>;
  readonly log: Accessor<LogState>;
  /** The active session's streaming drafts. */
  readonly live: Accessor<LiveState>;
  /** Sessions with a turn running. */
  readonly running: Accessor<readonly string[]>;
  /** The active session has a turn running. */
  readonly busy: Accessor<boolean>;
  /** Where a new chat starts, when not in the host's directory. */
  readonly pendingCwd: Accessor<string | undefined>;
  readonly select: (sessionId: string | undefined) => Promise<void>;
  /** Called on every `select`, including of the open session: what "going to a chat" means to other plugins. */
  readonly onSelect: (listener: (sessionId: string | undefined) => void) => () => void;
  /** A new chat, created by its first prompt, in `cwd` or the host's directory. */
  readonly newChat: (cwd?: string) => void;
  /** Sets where the next new thread starts without going to it (no `select`): a default, not a choice. */
  readonly startIn: (cwd: string | undefined) => void;
  readonly rename: (sessionId: string, title: string) => Promise<void>;
  /** Pins or archives it; failures are reported. */
  readonly mark: (sessionId: string, marks: SessionMarks) => Promise<void>;
  /** Deletes it for good, leaving it first if it is open; failures (a running turn) are reported. */
  readonly remove: (sessionId: string) => Promise<void>;
  /** Sends a prompt, creating the session first for a new chat (in `cwd`, else the pending directory). Resolves false when it was refused. */
  readonly send: (content: PromptContent, options?: { readonly turn?: TurnOptions | undefined; readonly cwd?: string | undefined }) => Promise<boolean>;
  readonly cancel: () => void;
  /** Moves the active session's leaf: the next prompt branches from `eventId`. */
  readonly checkout: (eventId: string) => Promise<void>;
}
export class Sessions extends Context.Tag("lemma-ui/Sessions")<Sessions, SessionsService>() {}

export interface ModelsService {
  readonly providers: Accessor<readonly ProviderInfo[]>;
  readonly providersLoaded: Accessor<boolean>;
  /** Models usable now. */
  readonly models: Accessor<readonly ModelInfo[]>;
  readonly modelsLoaded: Accessor<boolean>;
  /** Every known model, usable or not; undefined until `loadAll`. */
  readonly all: Accessor<readonly ModelInfo[] | undefined>;
  readonly loadAll: () => Promise<void>;
  /** Some provider is set up. */
  readonly configured: Accessor<boolean>;
  /** The remembered choice, which may name a model that is not available. */
  readonly preferred: Accessor<string | undefined>;
  readonly selected: Accessor<ModelInfo | undefined>;
  readonly thinking: Accessor<ThinkingLevel | undefined>;
  readonly choose: (ref: string | undefined) => void;
  /** Remembered for the selected model only. */
  readonly chooseThinking: (level: ThinkingLevel) => void;
  readonly favorites: Accessor<readonly string[]>;
  readonly toggleFavorite: (ref: string) => void;
  /** What the next turn should use. */
  readonly turnOptions: () => TurnOptions | undefined;
  /** The provider whose login is running. */
  readonly loggingIn: Accessor<string | undefined>;
  /** Resolves true once the provider is connected. */
  readonly login: (provider: ProviderInfo, type: AuthType) => Promise<boolean>;
  readonly logout: (provider: ProviderInfo) => Promise<void>;
  /** Adds a provider of the user's; resolves with it once the host lists it. Rejects when the host refuses. */
  readonly addCustom: (spec: CustomProviderSpec) => Promise<ProviderInfo>;
  /** Removes a provider `addCustom` added, and its logo; resolves once the host no longer lists it. */
  readonly removeCustom: (provider: ProviderInfo) => Promise<void>;
  /** Sets or clears a custom provider's logo (SVG the caller has checked); resolves once the host lists it. */
  readonly setLogo: (provider: ProviderInfo, svg: string | undefined) => Promise<void>;
  readonly refresh: () => Promise<void>;
}
export class Models extends Context.Tag("lemma-ui/Models")<Models, ModelsService>() {}

export interface WorktreeDraft {
  readonly enabled: boolean;
  /** The branch a new worktree starts from; the current one when unset. */
  readonly base?: string;
}

export interface WorkspaceService {
  readonly api: Host["workspace"];
  /** The host's directory, then projects by the recency of their sessions, then ones added by hand. */
  readonly projects: Accessor<readonly string[]>;
  /** Added by hand (remembered), so they are offered before they have sessions. */
  readonly added: Accessor<readonly string[]>;
  readonly add: (path: string) => void;
  /** Stops listing a project, the host's directory included, until a thread starts in it or it is added again. */
  readonly remove: (path: string) => void;
  /** A project's settings (remembered in this browser); fields absent follow the defaults. */
  readonly projectSettings: (cwd: string) => ProjectSettings;
  /** Changes some of them; an undefined field, or a blank name, returns to the default. */
  readonly configureProject: (cwd: string, patch: { readonly [K in keyof ProjectSettings]?: ProjectSettings[K] | undefined }) => void;
  /** What to call a project: its name setting, else its folder's name. */
  readonly projectName: (cwd: string) => string;
  /** Where threads with no project run: a folder of the host's own (`<home>/scratch`), never listed among `projects`. */
  readonly standaloneDir: Accessor<string | undefined>;
  readonly isStandalone: (cwd: string | undefined) => boolean;
  /** Starts a thread with no project, making its folder on the host first if needed. */
  readonly newStandalone: () => Promise<void>;
  /** Starts a new chat in the folder at `input` (`~` allowed) once the host confirms it exists. */
  readonly open: (input: string) => Promise<boolean>;
  /** Where the composer works: the active session's directory, else the new chat's, else the host's. */
  readonly workingDir: Accessor<string | undefined>;
  /** The working directory's status, kept fresh while connected. */
  readonly status: Accessor<WorkspaceStatus | undefined>;
  readonly setStatus: (status: WorkspaceStatus) => void;
  readonly refresh: () => Promise<void>;
  /** For a new thread in a git repository: whether it starts in a fresh worktree (the project's setting, else the remembered global one), and from which branch. */
  readonly worktree: Accessor<WorktreeDraft>;
  readonly setWorktree: (enabled: boolean) => void;
  readonly setWorktreeBase: (base: string | undefined) => void;
  /** Where a new chat's session goes: a fresh worktree named from `text` when one is chosen, else undefined. Throws when git refuses. */
  readonly newChatDir: (text: string) => Promise<string | undefined>;
}
export class Workspace extends Context.Tag("lemma-ui/Workspace")<Workspace, WorkspaceService>() {}

/** Plugins and the changes the Plugins page makes. Changes reject when refused; whoever asked reports it. */
export interface PluginsService {
  readonly list: Accessor<readonly PluginStatus[]>;
  readonly refresh: () => Promise<void>;
  readonly restart: (plugin: PluginStatus, options?: { force?: boolean }) => Promise<void>;
  /** Writes `enabled` where it is set now (the user file unless the project file decides). */
  readonly setEnabled: (plugin: PluginStatus, enabled: boolean) => Promise<ReloadResult>;
  /** Sets config fields (null unsets one) in the file that sets the plugin's config. */
  readonly setConfig: (plugin: PluginStatus, values: Readonly<Record<string, unknown>>) => Promise<ReloadResult>;
}
export interface HostPluginsService extends PluginsService {
  readonly reload: () => Promise<ReloadResult>;
  /** Adds or removes items of a list config key by their `id`, in the file that sets the plugin's config, without reading the list. */
  readonly edit: (plugin: PluginStatus, change: Pick<PluginChange, "add" | "remove">) => Promise<ReloadResult>;
}
/** The host's plugins. */
export class HostPlugins extends Context.Tag("lemma-ui/HostPlugins")<HostPlugins, HostPluginsService>() {}

export interface UiPluginsService extends PluginsService {
  /** Files loaded from `~/.lemma/ui` and a trusted project's `.lemma/ui`. */
  readonly files: Accessor<readonly UiFile[]>;
  /** What went wrong loading UI files or planning the composition; each names its file or plugin. */
  readonly problems: Accessor<readonly string[]>;
  /** Opened with `?safe`: `ui` rows and UI files are ignored. */
  readonly safe: boolean;
}
/** The web app's own plugins, which this page runs. */
export class UiPlugins extends Context.Tag("lemma-ui/UiPlugins")<UiPlugins, UiPluginsService>() {}

export interface CommandsService {
  /** What host plugins offer to run (`lemma do`). */
  readonly list: Accessor<readonly CommandInfo[]>;
  /** Runs one in the working directory and reports how it went; resolves true when it succeeded. */
  readonly run: (command: CommandInfo) => Promise<boolean>;
}
export class Commands extends Context.Tag("lemma-ui/Commands")<Commands, CommandsService>() {}

export interface InteractionsService {
  /** Questions the host is waiting on, oldest first. */
  readonly open: Accessor<readonly InteractionRequest[]>;
  readonly answer: (id: string, answer: InteractionAnswer) => void;
  readonly dismiss: (id: string) => void;
  /**
   * Shows questions somewhere else: all of them (the palette does while open)
   * or those `which` picks (the Providers page, its logins' questions). The
   * question dialog leaves them alone until released.
   */
  readonly claim: (which?: (request: InteractionRequest) => boolean) => () => void;
  /** Some view shows this question itself. */
  readonly claimed: (request: InteractionRequest) => boolean;
}
export class Interactions extends Context.Tag("lemma-ui/Interactions")<Interactions, InteractionsService>() {}

// ------------------------------------------------------------------ screen state

export interface DialogsService {
  /** The open dialog's id; one at a time. Dialog plugins show themselves when theirs is current. */
  readonly current: Accessor<string | undefined>;
  readonly open: (id: string | undefined) => void;
}
export class Dialogs extends Context.Tag("lemma-ui/Dialogs")<Dialogs, DialogsService>() {}

export interface SettingsService {
  /** The open section's id; undefined while settings are closed. */
  readonly section: Accessor<string | undefined>;
  readonly open: (section: string | undefined) => void;
}
export class Settings extends Context.Tag("lemma-ui/Settings")<Settings, SettingsService>() {}

export interface LayoutService {
  readonly toggleSidebar: () => void;
  /** On a narrow screen the sidebar is a drawer; picking something in it closes it. */
  readonly closeDrawer: () => void;
}
export class Layout extends Context.Tag("lemma-ui/Layout")<Layout, LayoutService>() {}

// ------------------------------------------------------------------ regions

export type { Region } from "./slots.ts";

/** What the page renders. Empty: a blank page. */
export const Root = defineSlot<Region>("root");
/** Mounted over the whole app in order: dialogs, the palette, settings, toasts, tooltips. Each shows itself when it should. */
export const Layers = defineSlot<Region>("layers");
export const SidebarRegion = defineSlot<Region<{ readonly onPick: () => void }>>("sidebar");
export const MainRegion = defineSlot<Region>("main");
/** Buttons in the sidebar's head beside its search: add project and new chat are its defaults. `onPick` closes the drawer on narrow screens. */
export const SidebarActions = defineSlot<Region<{ readonly onPick: () => void }>>("sidebar.actions");
/** Items at the foot of the sidebar: the settings button, the connection badge. `onPick` closes the drawer on narrow screens. */
export const SidebarFooter = defineSlot<Region<{ readonly onPick: () => void }>>("sidebar.footer");

/** An item in a menu about one thing: a session, a project. */
export interface MenuAction<Subject, Control = undefined> {
  readonly label: (subject: Subject) => string;
  readonly icon?: Component;
  /** Shown in red: it destroys something. */
  readonly danger?: boolean;
  /** When it returns text, the first pick shows that and only a second pick runs the action. */
  readonly confirm?: (subject: Subject) => string | undefined;
  readonly when?: (subject: Subject) => boolean;
  /** Starts a group: a separator comes before it. */
  readonly section?: boolean;
  readonly run: (subject: Subject, control: Control) => void;
}

/** What a session's menu item can do to its row. */
export interface SessionRowControl {
  /** Edits the title in place. */
  readonly rename: () => void;
}
/** An item in a session's menu in the sidebar (its row's ⋯ button, or a right-click). Rename, pin, archive, and delete are the sidebar's defaults. */
export type SessionAction = MenuAction<SessionInfo, SessionRowControl>;
export const SessionActions = defineSlot<SessionAction>("session.actions");
/** An item in a project's menu in the sidebar, by the project's directory. New thread and copy path are the sidebar's defaults; project settings and delete, the projects page's. */
export type ProjectAction = MenuAction<string>;
export const ProjectActions = defineSlot<ProjectAction>("project.actions");

export interface SessionView {
  readonly title: string;
  readonly icon: Component;
  readonly component: Component;
  /** The composer shows under it. */
  readonly composer?: boolean;
}
/** The main area's views of a session over the same log: chat, trajectory. The first is where a new chat opens. */
export const Views = defineSlot<SessionView>("views");

export const ComposerRegion = defineSlot<Region>("composer");

/** What a composer button can do to the prompt being written. */
export interface ComposerActionProps {
  /** Attaches images (other files are refused with a notice). */
  readonly addFiles: (files: Iterable<File>) => Promise<void>;
  /** Inserts text at the cursor. */
  readonly insert: (text: string) => void;
}
/** Buttons beside send: attaching images is the default one. */
export const ComposerActions = defineSlot<Region<ComposerActionProps>>("composer.actions");

/** An item in the session's header bar, at its start (after the sidebar toggle) or its end. */
export interface SessionHeaderItem extends Region {
  readonly side: "start" | "end";
}
/** The session's header: the sidebar toggle, title, running chip, and view tabs are its default items. */
export const SessionHeader = defineSlot<SessionHeaderItem>("session.header");
/** Above the composer box: the connection notice, the provider callout. */
export const ComposerNotices = defineSlot<Region>("composer.notices");
/** The composer's toolbar, left of its buttons: the model and reasoning pickers. */
export const ComposerControls = defineSlot<Region>("composer.controls");
/** Under the composer: the workspace bar. */
export const ComposerFooter = defineSlot<Region>("composer.footer");

/** An item in the workspace bar under the composer, at its start or end. The project, mode, and branch pickers are its defaults. */
export interface WorkspaceBarItem extends Region {
  readonly side: "start" | "end";
}
export const WorkspaceBarItems = defineSlot<WorkspaceBarItem>("workspace-bar.items");

export interface ToolBodyProps {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown> | undefined;
  readonly result: ToolResultView | undefined;
  readonly state: "running" | "queued" | "ok" | "error" | "interrupted";
  /** The last lines a running tool printed, until its result arrives. */
  readonly output?: string | undefined;
}
/** How the chat shows calls to one tool; the item's id is the tool's name. Either part falls back to the chat's own. */
export interface ToolView {
  readonly summary?: (args: Record<string, unknown> | undefined, context: { readonly cwd?: string; readonly home?: string }) => ToolSummary;
  readonly body?: Component<ToolBodyProps>;
}
export const ToolViews = defineSlot<ToolView>("chat.tools");

/** An inspector tab in the trajectory view, for the records `when` picks. */
export interface TrajectoryTab {
  readonly label: string;
  readonly when: (record: LedgerRecord) => boolean;
  readonly component: Component<{ readonly record: LedgerRecord }>;
}
/** Tabs added after the trajectory view's own for a selected record. A tool's `ToolViews` body is one already. */
export const TrajectoryTabs = defineSlot<TrajectoryTab>("trajectory.tabs");

/** An item in a trajectory record's context menu, after the view's own. */
export interface TrajectoryAction {
  readonly label: string;
  readonly when?: (record: LedgerRecord) => boolean;
  readonly run: (record: LedgerRecord) => void;
}
export const TrajectoryActions = defineSlot<TrajectoryAction>("trajectory.actions");

/**
 * Renders fenced code blocks in markdown: highlighting, diagrams. The first
 * item by `order` whose `match` holds renders a block; without one, or until
 * it fills `target`, the block shows as plain code, which stays one click
 * away for a `preview`.
 */
export interface CodeBlockRenderer {
  /** Takes blocks in this fence language (lowercased; "" for none). */
  readonly match: (lang: string) => boolean;
  /**
   * Fills `target` (an empty element) for the block, now or when the promise
   * resolves; leaving it empty keeps the plain code. Called again whenever the
   * block's code grows, so a renderer that needs the whole block waits for
   * `complete`. A throw or rejection keeps the plain code and says why.
   */
  readonly render: (block: CodeBlock, target: HTMLElement) => void | Promise<void>;
  /** What it renders is not the code (a diagram): the block offers the source beside it. */
  readonly preview?: boolean;
}
export const CodeBlocks = defineSlot<CodeBlockRenderer>("markdown.code");

// ------------------------------------------------------------------ settings

export interface SettingsSection {
  readonly title: string;
  readonly icon: Component;
  /** Shown above the section's groups while browsing it, not in search results. */
  readonly intro?: Component;
  /** Buttons beside the title. */
  readonly actions?: Component;
  /** Shown while browsing a section with no entries. */
  readonly empty?: Component;
  /** Something needing attention, shown in the nav and on the sidebar's settings button. */
  readonly badge?: Accessor<string | undefined>;
  /** Shown instead of the section's groups while browsing it, full width; its groups then only answer searches. */
  readonly body?: Component;
}
export const SettingsSections = defineSlot<SettingsSection>("settings.sections");

export interface SettingsEntry {
  /** Everything a search should match. */
  readonly text: string;
  readonly view: () => JSX.Element;
}
/** Entries in a section; groups with the same title merge, in order. */
export interface SettingsGroup {
  readonly section: string;
  readonly title?: string;
  readonly entries: Accessor<readonly SettingsEntry[]>;
}
export const SettingsGroups = defineSlot<SettingsGroup>("settings.groups");

/** A tab in the Plugins page's inspector, for the plugin selected there: Overview, Wiring, Settings, and Faults are its defaults. */
export interface PluginTab {
  /** Its label for this plugin, with a count, say; undefined leaves the tab out. */
  readonly label: (plugin: PluginStatus, kind: "host" | "web") => string | undefined;
  readonly component: Component<{ readonly plugin: PluginStatus; readonly kind: "host" | "web" }>;
}
export const PluginTabs = defineSlot<PluginTab>("plugins.tabs");

// ------------------------------------------------------------------ actions

/**
 * Something the user can do: listed in the command palette and, with `keys`,
 * bound to a shortcut. Keys are `mod+k`, `mod+shift+o`, `escape`, `/`; `mod`
 * is ⌘ on macOS and Ctrl elsewhere. When several match, the first in order
 * whose `when` holds runs.
 */
export interface Action {
  readonly title: string;
  /** Shown before the title, as in `Git: Switch branch…`. */
  readonly category?: string;
  readonly detail?: string;
  readonly keywords?: readonly string[];
  readonly icon?: Component;
  readonly keys?: string | readonly string[];
  /** Offered at all, in the palette and by its keys. */
  readonly when?: () => boolean;
  /** Its keys work while a dialog or question is open. */
  readonly global?: boolean;
  /** Its keys work in a text field; keys with `mod` always do. */
  readonly whileTyping?: boolean;
  /** Not listed in the palette. */
  readonly hidden?: boolean;
  /**
   * Asks for a value in the palette first (the question is read when asked); `run` receives it.
   * Pressing its keys does the same: the keymap runs `ActionIds.palette` with this action's id.
   */
  readonly input?: () => { readonly title: string; readonly placeholder?: string };
  readonly run: (value?: string) => void;
}
export const Actions = defineSlot<Action>("actions");

/** Something the palette lists and runs. */
export interface PaletteItem {
  /** Stable across sessions, for remembering recent choices; prefix it with your source's id. */
  readonly key: string;
  readonly title: string;
  /** Shown before the title, as in `Git: Switch branch…`. */
  readonly category?: string | undefined;
  readonly detail?: string | undefined;
  /** Matched too, more weakly than the title. */
  readonly keywords?: readonly string[] | undefined;
  readonly shortcut?: string | undefined;
  readonly icon?: Component | undefined;
  /** Marked as the current one (the open session). */
  readonly current?: boolean | undefined;
  /** Asks for a value in the palette first; `run` receives it. */
  readonly input?: (() => { readonly title: string; readonly placeholder?: string }) | undefined;
  /**
   * `run` works with the palette open, which shows the questions it asks,
   * until its promise settles; the palette then closes unless it resolved
   * false. Otherwise the palette closes first.
   */
  readonly keepOpen?: boolean | undefined;
  readonly run: (value?: string) => unknown;
}

/** Where the palette's items come from: its commands, sessions, and projects are sources, and a plugin adds its own. */
export interface PaletteSource {
  /** What it holds, for the palette's hints: `commands`, `sessions`. */
  readonly label: string;
  /** Its heading while browsing; without one its items lead. */
  readonly heading?: string;
  /** Typed first, searches only this source: `>`, `@`, `#`. */
  readonly prefix?: string;
  /** While browsing, at most this many of its items. */
  readonly browse?: number;
  readonly items: () => readonly PaletteItem[];
}
export const PaletteSources = defineSlot<PaletteSource>("palette.sources");

/**
 * Actions plugins run on each other by id (`slots.get(Actions, id)?.run()`),
 * so a plugin that replaces one keeps its id and what calls it keeps working.
 */
export const ActionIds = {
  /** Run with an action's id, opens asking for that action's value. */
  palette: "palette.open",
  addProject: "add-project.open",
  providers: "providers.open",
  focusComposer: "composer.focus",
  eventLog: "event-log.open",
} as const;

/** Settings sections other plugins add groups to; a Settings replacement provides them. */
export const SectionIds = { general: "general" } as const;

// ------------------------------------------------------------------ parts

/*
 * Parts: the pieces plugins draw with, and the pieces of the big views. Each
 * is a region slot (see `definePart`): wherever a plugin uses one, the first
 * item by order renders, so any plugin or UI file replaces a part everywhere
 * by adding an item with a lower order than the default (`DEFAULT_PART_ORDER`).
 * The `kit` plugin supplies the shared parts; a view supplies its own.
 * Plugins draw these through `ui/parts.tsx`, never by importing a component.
 */

export interface MarkdownProps {
  readonly text: string;
  readonly class?: string;
  /** Still arriving: a code block whose fence has not closed is incomplete. */
  readonly streaming?: boolean;
}
/** Model text as sanitized markdown; fenced code renders through `CodeBlocks`. */
export const MarkdownPart = definePart<MarkdownProps>("markdown");

export interface DialogProps {
  readonly title?: JSX.Element;
  readonly label?: string;
  readonly onClose?: (() => void) | undefined;
  readonly children: JSX.Element;
  readonly footer?: JSX.Element;
  readonly class?: string;
  readonly labelledBy?: string;
}
/** A modal: backdrop, Escape to close, focus kept inside. */
export const DialogPart = definePart<DialogProps>("dialog");

export type Placement = "top-start" | "top-end" | "bottom-start" | "bottom-end";
export interface PopoverProps {
  readonly label: string;
  readonly trigger: JSX.Element;
  readonly triggerClass?: string;
  readonly placement?: Placement;
  readonly disabled?: boolean;
  /** Tooltip for the trigger; defaults to `label`. */
  readonly tip?: string;
  readonly menuClass?: string;
  readonly onOpen?: () => void;
  /** Receives a handle for opening the menu from elsewhere (a shortcut, say). */
  readonly controller?: (handle: { readonly open: () => void }) => void;
  readonly children: (close: () => void) => JSX.Element;
}
/** A button that opens a menu of `menuitem`/`option` elements. */
export const PopoverPart = definePart<PopoverProps>("popover");

export interface ToggleProps {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}
export const TogglePart = definePart<ToggleProps>("toggle");

export interface SettingRowProps {
  readonly title: string;
  readonly description?: string | undefined;
  readonly children: JSX.Element;
}
export const SettingRowPart = definePart<SettingRowProps>("setting-row");

export interface SegmentedProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
}
/** One of a few options, side by side. */
export const SegmentedPart = definePart<SegmentedProps>("segmented");

export interface ConfigFormProps {
  readonly fields: readonly ConfigField[];
  readonly config: ConfigValues | undefined;
  /** Where the fields are written, for the note under the form. */
  readonly file: string;
  readonly disabled?: boolean;
  readonly onSave: (values: Readonly<Record<string, unknown>>) => Promise<void>;
}
/** A plugin's settings, projected from its config Schema. */
export const ConfigFormPart = definePart<ConfigFormProps>("config-form");

export interface ProviderLogoProps {
  readonly id: string;
  readonly name: string;
  readonly custom?: string | undefined;
}
export const ProviderLogoPart = definePart<ProviderLogoProps>("provider-logo");

export type IconName =
  | "plus"
  | "stop"
  | "send"
  | "chevron"
  | "chevron-down"
  | "check"
  | "x"
  | "key"
  | "puzzle"
  | "copy"
  | "code"
  | "image"
  | "alert"
  | "sidebar"
  | "menu"
  | "log"
  | "refresh"
  | "external"
  | "folder"
  | "folder-open"
  | "filter"
  | "search"
  | "folder-plus"
  | "pen-square"
  | "gear"
  | "git-branch"
  | "worktree"
  | "laptop"
  | "star"
  | "more"
  | "pin"
  | "archive"
  | "trash"
  | "pencil"
  | "brain"
  | "chat"
  | "trajectory"
  | "command"
  | "sliders"
  | "palette"
  | "arrow-left"
  | "spinner";
export interface IconProps {
  readonly name: IconName;
  readonly class?: string;
  /** For icons with a filled state (star). */
  readonly filled?: boolean;
}
/** Every icon, by name: one part, so a set replaces them all and can fall back to the defaults (`api.defaults.Icon`). */
export const IconPart = definePart<IconProps>("icon");

// ------------------------------------------------------------------ chat parts

export interface ChatUserProps {
  readonly content: readonly (TextContent | ImageContent)[];
}
/** A prompt in the transcript. */
export const ChatUserPart = definePart<ChatUserProps>("chat.user");

export interface ChatThinkingProps {
  readonly text: string;
  readonly redacted?: boolean | undefined;
  /** Still streaming. */
  readonly live?: boolean | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
}
/** A thought, collapsed to one line until opened. */
export const ChatThinkingPart = definePart<ChatThinkingProps>("chat.thinking");

export interface ChatToolProps extends ToolBodyProps {
  /** Arguments as streamed so far, before they parse. */
  readonly partial?: string | undefined;
  /** How long it has been running, in ms. */
  readonly elapsed?: number | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
}
/** A tool call and its result. Its body defaults to the tool's `ToolViews` item, then the chat's own. */
export const ChatToolPart = definePart<ChatToolProps>("chat.tool");

export interface ChatWorkProps {
  /** Steps folded: a finished turn's work, or a running turn's earlier steps (`live`). */
  readonly steps: number;
  readonly tools: number;
  readonly failed: number;
  readonly duration?: number | undefined;
  readonly live?: boolean | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
  /** The folded steps, rendered by the chat. */
  readonly children: JSX.Element;
}
export const ChatWorkPart = definePart<ChatWorkProps>("chat.work");

export interface ChatWorkingProps {
  /** When the running turn started, if known. */
  readonly startedAt?: number | undefined;
  /** The time, ticking each second. */
  readonly now: number;
}
/** Shown while the model is thinking between steps. */
export const ChatWorkingPart = definePart<ChatWorkingProps>("chat.working");

export interface ChatTurnFooterProps {
  readonly turn: TurnView;
  /** The answer's markdown source; empty when the turn ended in a tool call. */
  readonly answer: string;
}
/** Under a finished turn: model, tokens, cost, time, copy. */
export const ChatTurnFooterPart = definePart<ChatTurnFooterProps>("chat.turn-footer");

// ------------------------------------------------------------------ sidebar parts

export interface SidebarRowProps {
  readonly session: SessionInfo;
  /** The open session. */
  readonly active: boolean;
  /** A turn is running in it. */
  readonly running: boolean;
  /** The time, ticking once a minute, for relative times. */
  readonly now: number;
  readonly select: () => void;
  readonly rename: (title: string) => void;
  /** Its menu: the `SessionActions` that apply to it, in order. */
  readonly actions: readonly SessionAction[];
}
/** A session in the sidebar's list. Arrow keys move between elements marked `data-session-row`. */
export const SidebarRowPart = definePart<SidebarRowProps>("sidebar.row");

export interface ProviderRowProps {
  readonly provider: ProviderInfo;
  /** Starts a login by this method; the Providers page answers its questions. */
  readonly login: (type: AuthType) => void;
}
/** A provider on the Providers page: its logo, status, models, and login or logout. */
export const ProviderRowPart = definePart<ProviderRowProps>("providers.row");
