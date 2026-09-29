import { Context } from "effect";
import type { Accessor, Component, JSX } from "solid-js";
import type { ConnectionStatus, Host } from "@lemma/client";
import type {
  AuthType,
  CommandInfo,
  HostEvent,
  HostInfo,
  InteractionAnswer,
  InteractionRequest,
  ModelInfo,
  NoticePayload,
  PluginChange,
  PluginStatus,
  PromptContent,
  ProviderInfo,
  ReloadResult,
  SessionEvent,
  SessionInfo,
  ThinkingLevel,
  TurnOptions,
  UiFile,
  WorkspaceStatus,
} from "@lemma/contracts";
import type { ToolSummary } from "../model/format.ts";
import type { LiveState } from "../model/live.ts";
import type { ToolResultView } from "../model/transcript.ts";
import { defineSlot } from "./slots.ts";
import type { SlotsService } from "./slots.ts";

/*
 * The web app's contracts. Capabilities are services one plugin provides and
 * others require; slots are places any number of plugins contribute to. Every
 * bundled plugin is written against these alone, so any of them can be
 * replaced by a plugin that provides the same capability or fills the same
 * slot. Keys are namespaced `lemma-ui/…`.
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
  readonly rename: (sessionId: string, title: string) => Promise<void>;
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
  /** Stops offering a project added by hand; one with sessions stays listed through them. */
  readonly remove: (path: string) => void;
  /** Starts a new chat in the folder at `input` (`~` allowed) once the host confirms it exists. */
  readonly open: (input: string) => Promise<boolean>;
  /** Where the composer works: the active session's directory, else the new chat's, else the host's. */
  readonly workingDir: Accessor<string | undefined>;
  /** The working directory's status, kept fresh while connected. */
  readonly status: Accessor<WorkspaceStatus | undefined>;
  readonly setStatus: (status: WorkspaceStatus) => void;
  readonly refresh: () => Promise<void>;
  /** For a new chat in a git repository: whether it starts in a fresh worktree (remembered), and from which branch. */
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

/** A region filled by one component: the first item wins. */
export interface Region<P extends Record<string, any> = {}> {
  readonly component: Component<P>;
}

/** What the page renders. Empty: a blank page. */
export const Root = defineSlot<Region>("root");
/** Mounted over the whole app in order: dialogs, the palette, settings, toasts, tooltips. Each shows itself when it should. */
export const Layers = defineSlot<Region>("layers");
export const SidebarRegion = defineSlot<Region<{ readonly onPick: () => void }>>("sidebar");
export const MainRegion = defineSlot<Region>("main");
/** Items at the foot of the sidebar: the settings button, the connection badge. `onPick` closes the drawer on narrow screens. */
export const SidebarFooter = defineSlot<Region<{ readonly onPick: () => void }>>("sidebar.footer");

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
/** Above the composer box: the connection notice, the provider callout. */
export const ComposerNotices = defineSlot<Region>("composer.notices");
/** The composer's toolbar, left of its buttons: the model and reasoning pickers. */
export const ComposerControls = defineSlot<Region>("composer.controls");
/** Under the composer: the workspace bar. */
export const ComposerFooter = defineSlot<Region>("composer.footer");

export interface ToolBodyProps {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown> | undefined;
  readonly result: ToolResultView | undefined;
  readonly state: "running" | "queued" | "ok" | "error" | "interrupted";
}
/** How the chat shows calls to one tool; the item's id is the tool's name. Either part falls back to the chat's own. */
export interface ToolView {
  readonly summary?: (args: Record<string, unknown> | undefined, context: { readonly cwd?: string; readonly home?: string }) => ToolSummary;
  readonly body?: Component<ToolBodyProps>;
}
export const ToolViews = defineSlot<ToolView>("chat.tools");

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
  /** Asks for a value in the palette first (the question is read when asked); `run` receives it. */
  readonly input?: () => { readonly title: string; readonly placeholder?: string };
  readonly run: (value?: string) => void;
}
export const Actions = defineSlot<Action>("actions");
