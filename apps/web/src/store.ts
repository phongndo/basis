import { batch, createMemo, createRoot, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { SessionLog, describeError, startPrompt } from "@basis/client";
import type { ConnectionStatus, Host } from "@basis/client";
import { HostError, branchOf, trajectory as projectTrajectory } from "@basis/contracts";
import type {
  AuthType,
  CommandInfo,
  HostEvent,
  HostInfo,
  InteractionAnswer,
  InteractionRequest,
  ModelInfo,
  NoticePayload,
  PluginStatus,
  PromptContent,
  ProviderInfo,
  SessionEvent,
  SessionInfo,
  ThinkingLevel,
  TurnOptions,
  WorkspaceStatus,
} from "@basis/contracts";
import { load, save } from "./lib/storage.ts";
import { applyDelta, emptyLive, endTurn, reconcileLive, settleStep } from "./model/live.ts";
import type { LiveState } from "./model/live.ts";
import { branchSlug } from "./model/format.ts";
import { DEFAULT_THINKING, clampThinking, resolveModel } from "./model/prefs.ts";
import { resolveLeaf, trackTurn, upsertSession } from "./model/sessions.ts";
import { createProjector, pendingToolCalls } from "./model/transcript.ts";

/**
 * Application state and the actions that change it. Components read `state`
 * and the derived accessors and call actions; all host traffic goes through
 * here. Pure logic lives in `model/`.
 */

export interface Toast {
  readonly id: number;
  readonly level: NoticePayload["level"];
  readonly message: string;
  readonly source?: string;
  readonly links?: NoticePayload["links"];
  readonly code?: string;
}

export type Dialog = "palette" | "models" | "add-project" | "events" | undefined;
/** Sections of the settings view, which covers the app while open; dialogs can open over it. */
export type SettingsSection = "general" | "appearance" | "providers" | "plugins" | "projects";
export type Theme = "system" | "light" | "dark";
/** How wide the conversation runs. */
export type ContentWidth = "default" | "wide" | "full";
/** Main-area views of a session, over the same log. The choice carries over when switching sessions. */
export type SessionViewKind = "chat" | "trajectory";

interface State {
  status: ConnectionStatus;
  info: HostInfo | undefined;
  sessions: readonly SessionInfo[];
  sessionsLoaded: boolean;
  activeId: string | undefined;
  view: SessionViewKind;
  running: readonly string[];
  providers: readonly ProviderInfo[];
  providersLoaded: boolean;
  models: readonly ModelInfo[];
  modelsLoaded: boolean;
  /** Preferred model ref, and the thinking level chosen for each model (remembered). */
  model: string | undefined;
  thinkingByModel: Readonly<Record<string, ThinkingLevel>>;
  /** Project directories added by hand, so they are offered before they have sessions. */
  projects: readonly string[];
  plugins: readonly PluginStatus[];
  /** What plugins offer to run (the palette's host commands, `basis do`). */
  commands: readonly CommandInfo[];
  interactions: readonly InteractionRequest[];
  toasts: readonly Toast[];
  dialog: Dialog;
  settings: SettingsSection | undefined;
  theme: Theme;
  contentWidth: ContentWidth;
  /** Provider id whose login is running. */
  loggingIn: string | undefined;
  /** First run with nothing configured: the providers settings opened by themselves and closes once one is set up. */
  welcome: boolean;
}

const MODEL_KEY = "basis.model";
const THINKING_KEY = "basis.thinkingByModel";
const PROJECTS_KEY = "basis.projects";
const THEME_KEY = "basis.theme";
const WIDTH_KEY = "basis.contentWidth";

const loadJson = <A>(key: string, fallback: A): A => {
  try {
    return JSON.parse(load(key) ?? "") as A;
  } catch {
    return fallback;
  }
};

export const [state, setState] = createStore<State>({
  status: { state: "connecting", generation: 0, attempts: 0 },
  info: undefined,
  sessions: [],
  sessionsLoaded: false,
  activeId: undefined,
  view: "chat",
  running: [],
  providers: [],
  providersLoaded: false,
  models: [],
  modelsLoaded: false,
  model: load(MODEL_KEY),
  thinkingByModel: loadJson(THINKING_KEY, {}),
  projects: loadJson(PROJECTS_KEY, []),
  plugins: [],
  commands: [],
  interactions: [],
  toasts: [],
  dialog: undefined,
  settings: undefined,
  theme: (load(THEME_KEY) as Theme | undefined) ?? "system",
  contentWidth: (load(WIDTH_KEY) as ContentWidth | undefined) ?? "default",
  loggingIn: undefined,
  welcome: false,
});

// Event arrays and streaming drafts change often and are replaced wholesale, so they live in signals, not the store.
const [events, setEvents] = createSignal<readonly SessionEvent[]>([], { equals: false });
const [logState, setLogState] = createSignal<{ loaded: boolean; syncing: boolean; error?: string }>({ loaded: false, syncing: false });
const [live, setLive] = createSignal<Readonly<Record<string, LiveState>>>({});

let host: Host | undefined;
let log: SessionLog | undefined;
let stopLog: (() => void) | undefined;
let toastSeq = 0;
let lastGeneration = 0;

const derived = createRoot(() => {
  let projector = createProjector();
  let projectedFor: string | undefined;
  const active = createMemo(() => state.sessions.find((session) => session.id === state.activeId));
  const leaf = createMemo(() => resolveLeaf(events(), active()?.leaf, active()?.lastSeq));
  const branch = createMemo(() => branchOf(events(), leaf()));
  const transcript = createMemo(() => {
    if (projectedFor !== state.activeId) {
      projector = createProjector();
      projectedFor = state.activeId;
    }
    return projector(branch());
  });
  const pending = createMemo(() => pendingToolCalls(transcript()));
  // Computed only while the Trajectory view is open.
  const trajectory = createMemo(() => (state.view === "trajectory" ? projectTrajectory(branch()) : []));
  const selectedModel = createMemo(() => resolveModel(state.models, state.model));
  const thinking = createMemo(() => {
    const model = selectedModel();
    return model === undefined ? undefined : clampThinking(model, state.thinkingByModel[model.ref] ?? DEFAULT_THINKING);
  });
  const activeLive = createMemo(() => (state.activeId === undefined ? undefined : live()[state.activeId]) ?? emptyLive);
  const busy = createMemo(() => state.activeId !== undefined && state.running.includes(state.activeId));
  const configured = createMemo(() => state.providers.some((provider) => provider.configured));
  return { active, branch, transcript, pending, trajectory, selectedModel, thinking, activeLive, busy, configured };
});

export const activeSession = derived.active;
export const transcript = derived.transcript;
export const activeBranch = derived.branch;
export const trajectory = derived.trajectory;
export const pendingCalls = derived.pending;
export const selectedModel = derived.selectedModel;
export const effectiveThinking = derived.thinking;
export const activeLive = derived.activeLive;
export const isBusy = derived.busy;
export const hasConfiguredProvider = derived.configured;
export const sessionLog = logState;
export const connected = () => state.status.state === "connected";

// ---------------------------------------------------------------------------
// Toasts

export const toast = (notice: Omit<Toast, "id">): number => {
  const id = ++toastSeq;
  setState("toasts", (toasts) => [...toasts.slice(-5), { ...notice, id }]);
  // A code or link is something to act on; it stays until dismissed or its login ends.
  if (notice.code === undefined && (notice.links === undefined || notice.links.length === 0)) {
    setTimeout(() => dismissToast(id), notice.level === "error" ? 12_000 : notice.level === "warning" ? 8_000 : 5_000);
  }
  return id;
};

export const dismissToast = (id: number): void => setState("toasts", (toasts) => toasts.filter((toast) => toast.id !== id));

export const reportError = (error: unknown, context?: string): void => {
  toast({ level: "error", message: context === undefined ? describeError(error) : `${context}: ${describeError(error)}` });
};

const client = (): Host => {
  if (host === undefined) throw new Error("Not connected to the host");
  return host;
};

// ---------------------------------------------------------------------------
// Connection

/** Attaches the app to a host connection (real or mock). Call once at startup. */
export const attach = (next: Host): void => {
  host = next;
  next.onStatus((status) => {
    setState("status", status);
    // Interactions may close while no connection can report it; the next subscription replays the ones still open.
    if (status.state === "reconnecting") setState("interactions", []);
    if (status.state === "connected" && status.generation !== lastGeneration) {
      lastGeneration = status.generation;
      void resync(status.generation === 1);
    }
  });
  next.onEvent(onEvent);
};

const resync = async (first: boolean): Promise<void> => {
  const h = client();
  const tasks: Promise<unknown>[] = [
    h.host.info().then((info) => setState("info", info)),
    refreshSessions(),
    refreshPlugins(),
    h.commands.list().then((commands) => setState("commands", commands)),
    h.agent.running().then((running) => setState("running", running)),
    refreshProviders(),
  ];
  if (log !== undefined) tasks.push(log.sync());
  const results = await Promise.allSettled(tasks);
  const failed = results.find((result) => result.status === "rejected");
  if (failed !== undefined) reportError((failed as PromiseRejectedResult).reason, "Sync failed");
  if (first) {
    const fromHash = decodeURIComponent(window.location.hash.replace(/^#\/?/, ""));
    if (fromHash !== "" && state.sessions.some((session) => session.id === fromHash)) void selectSession(fromHash);
    if (state.providersLoaded && !hasConfiguredProvider()) setState({ welcome: true, settings: "providers" });
  }
};

export const refreshSessions = async (): Promise<void> => {
  const sessions = await client().session.list();
  setState({ sessions, sessionsLoaded: true });
};

export const refreshPlugins = async (): Promise<void> => {
  setState("plugins", await client().host.plugins());
};

/** Every model the host knows, usable or not (`basis models --all`); loaded when the providers settings ask. */
const [allModelsSignal, setAllModels] = createSignal<readonly ModelInfo[] | undefined>();
export const allModels = allModelsSignal;
export const loadAllModels = async (): Promise<void> => {
  try {
    setAllModels(await client().llm.models());
  } catch (error) {
    reportError(error, "Could not list models");
  }
};

export const refreshProviders = async (): Promise<void> => {
  const [providers, models] = await Promise.all([client().llm.providers(), client().llm.models(true)]);
  setState({ providers, providersLoaded: true, models, modelsLoaded: true });
};

// ---------------------------------------------------------------------------
// Host events

const updateLive = (sessionId: string, update: (state: LiveState) => LiveState): void => {
  const current = live()[sessionId] ?? emptyLive;
  const next = update(current);
  if (next !== current) setLive({ ...live(), [sessionId]: next });
};

/** The last ended turn per session, so a late `turn-started` cannot mark it running again (see `trackTurn`). */
let endedTurns: Readonly<Record<string, string>> = {};

/** The most recent host events, newest last, for the event log (`basis events`). */
export interface LoggedEvent {
  readonly seq: number;
  readonly at: number;
  readonly event: HostEvent;
}
const EVENT_LOG = 500;
let eventSeq = 0;
const [eventLogSignal, setEventLog] = createSignal<readonly LoggedEvent[]>([]);
export const eventLog = eventLogSignal;
export const clearEventLog = (): void => {
  setEventLog([]);
};

export const onEvent = (event: HostEvent): void => {
  setEventLog((log) => [...(log.length >= EVENT_LOG ? log.slice(log.length - EVENT_LOG + 1) : log), { seq: ++eventSeq, at: Date.now(), event }]);
  switch (event.type) {
    case "session-appended": {
      if (log !== undefined && log.sessionId === event.sessionId) log.apply(event.event);
      const data = event.event.data;
      if ((data.type === "message" && data.message.role === "assistant" && data.stepId !== undefined) || data.type === "attempt") {
        updateLive(event.sessionId, (s) => settleStep(s, data.stepId!));
      }
      return;
    }
    case "session-changed":
      setState("sessions", (sessions) => upsertSession(sessions, event.info));
      if (log !== undefined && log.sessionId === event.info.id) log.noteLastSeq(event.info.lastSeq);
      return;
    case "delta":
      updateLive(event.sessionId, (s) => applyDelta(s, event.turnId, event.stepId, event.event));
      return;
    case "turn-started": {
      const next = trackTurn({ running: state.running, ended: endedTurns }, event);
      setState("running", next.running);
      return;
    }
    case "turn-ended": {
      const next = trackTurn({ running: state.running, ended: endedTurns }, event);
      endedTurns = next.ended;
      setState("running", next.running);
      updateLive(event.sessionId, (s) => endTurn(s, event.turnId));
      return;
    }
    case "interaction":
      setState("interactions", (open) => [...open.filter((request) => request.id !== event.request.id), event.request]);
      return;
    case "interaction-closed":
      setState("interactions", (open) => open.filter((request) => request.id !== event.id));
      return;
    case "notice":
      toast({
        level: event.notice.level,
        message: event.notice.message,
        ...(event.notice.source === undefined ? {} : { source: event.notice.source }),
        ...(event.notice.links === undefined ? {} : { links: event.notice.links }),
        ...(event.notice.code === undefined ? {} : { code: event.notice.code }),
      });
      // A login may finish after this client reloaded and lost its own call.
      if (event.notice.source === "llm") void refreshProviders().catch(() => {});
      return;
    case "plugins-changed":
      setState("plugins", event.plugins);
      // Provider plugins may have come or gone.
      void refreshProviders().catch(() => {});
      return;
    case "commands-changed":
      setState("commands", event.commands);
      return;
  }
};

// ---------------------------------------------------------------------------
// Sessions

export const selectSession = async (sessionId: string | undefined): Promise<void> => {
  // Going to a chat leaves the settings view.
  openSettings(undefined);
  if (sessionId === state.activeId && (sessionId === undefined || log !== undefined)) return;
  stopLog?.();
  log?.close();
  log = undefined;
  stopLog = undefined;
  batch(() => {
    setState({ activeId: sessionId, ...(sessionId === undefined ? { view: "chat" as const } : {}) });
    setEvents([]);
    setLogState({ loaded: sessionId === undefined, syncing: false });
  });
  history.replaceState(history.state, "", sessionId === undefined ? `${location.pathname}${location.search}` : `#${encodeURIComponent(sessionId)}`);
  if (sessionId === undefined || host === undefined) return;
  const h = host;
  const next = new SessionLog({ sessionId, fetch: (after) => h.session.events(sessionId, after) });
  log = next;
  stopLog = next.subscribe((snapshot) =>
    batch(() => {
      setEvents(snapshot.events);
      updateLive(sessionId, (current) => reconcileLive(current, snapshot.events));
      setLogState({ loaded: snapshot.loaded, syncing: snapshot.syncing, ...(snapshot.error === undefined ? {} : { error: snapshot.error }) });
    }),
  );
  await next.sync().catch((error) => reportError(error, "Could not load the session"));
};

/** Starts a new chat without creating a session; the first prompt creates it (in `cwd` or the host's cwd). */
const [pendingCwd, setPendingCwd] = createSignal<string | undefined>();
export const newChat = (cwd?: string): void => {
  setPendingCwd(cwd);
  void selectSession(undefined);
};
export const pendingChatCwd = pendingCwd;

/** The working directory's status, kept fresh by the workspace bar. */
const [workspace, setWorkspace] = createSignal<WorkspaceStatus | undefined>();
export const workspaceStatus = workspace;
export const setWorkspaceStatus = setWorkspace;

const WORKTREE_KEY = "basis.newWorktree";
/**
 * For a new chat in a git repository: start it in a fresh worktree branched
 * from `base` (the current branch when unset). Whether to is remembered.
 */
const [worktreeDraft, setWorktreeDraft] = createSignal<{ readonly enabled: boolean; readonly base?: string }>({ enabled: load(WORKTREE_KEY) === "1" });
export const worktreeDraftState = worktreeDraft;
export const setNewWorktree = (enabled: boolean): void => {
  save(WORKTREE_KEY, enabled ? "1" : undefined);
  setWorktreeDraft({ enabled });
};
export const setWorktreeBase = (base: string | undefined): void => {
  setWorktreeDraft((draft) => (base === undefined ? { enabled: draft.enabled } : { enabled: draft.enabled, base }));
};

/** The directory the composer works in: the active session's, else the new chat's. */
export const workingDir = (): string | undefined => activeSession()?.cwd ?? pendingCwd() ?? state.info?.cwd;

export const workspaceApi = (): Host["workspace"] => client().workspace;

/** Starts a new chat in the folder at `input` (`~` allowed) after checking it exists on the host. */
export const openProject = async (input: string): Promise<boolean> => {
  if (input.trim() === "") return false;
  try {
    const status = await client().workspace.status(input.trim());
    if (!status.exists) {
      toast({ level: "error", message: `No folder at ${status.path} on the host` });
      return false;
    }
    addProject(status.path);
    newChat(status.path === state.info?.cwd ? undefined : status.path);
    return true;
  } catch (error) {
    reportError(error, "Could not open the folder");
    return false;
  }
};

export const renameSession = async (sessionId: string, title: string): Promise<void> => {
  const trimmed = title.trim();
  if (trimmed === "") return;
  try {
    const info = await client().session.setTitle(sessionId, trimmed);
    setState("sessions", (sessions) => upsertSession(sessions, info));
  } catch (error) {
    reportError(error, "Rename failed");
  }
};

// ---------------------------------------------------------------------------
// Prompting

export const turnOptions = (): TurnOptions | undefined => {
  const model = selectedModel();
  if (model === undefined) return undefined;
  const thinking = effectiveThinking();
  return { model: model.ref, ...(thinking === undefined ? {} : { thinking }) };
};

/** Sends a prompt, creating the session first when the chat is new. Resolves once the prompt is accepted or fails. */
export const send = async (content: PromptContent): Promise<boolean> => {
  const h = client();
  let sessionId = state.activeId;
  try {
    if (sessionId === undefined) {
      let cwd = pendingCwd();
      const status = workspace();
      const draft = worktreeDraft();
      if (draft.enabled && status?.git !== undefined && status.path === workingDir()) {
        const text = content.find((part) => part.type === "text")?.text ?? "";
        const created = await h.workspace.createWorktree(status.path, { branch: branchSlug(text), ...(draft.base === undefined ? {} : { base: draft.base }) });
        cwd = created.path;
        setWorktreeBase(undefined);
      }
      const info = await h.session.create(cwd);
      setPendingCwd(undefined);
      setState("sessions", (sessions) => upsertSession(sessions, info));
      await selectSession(info.id);
      sessionId = info.id;
    }
  } catch (error) {
    reportError(error, "Could not create a session");
    return false;
  }
  const id = sessionId;
  if (!state.running.includes(id)) setState("running", (running) => [...running, id]);
  const prompt = startPrompt(h, id, content, turnOptions());
  void prompt.done
    .catch(() => {})
    .finally(() => {
      // turn-ended normally clears this; the prompt settling is the fallback when the event was lost.
      setState("running", (running) => running.filter((running) => running !== id));
      void log?.sync().catch(() => {});
    });
  // A refused prompt returns false so the composer keeps the text; failures after that are only reported.
  const accepted = await prompt.accepted.then(
    () => true,
    (error: unknown) => {
      reportError(error, "Prompt was not sent");
      return false;
    },
  );
  if (accepted) void prompt.done.catch((error) => reportError(error));
  return accepted;
};

export const cancel = (): void => {
  const sessionId = state.activeId;
  if (sessionId !== undefined)
    client()
      .agent.cancel(sessionId)
      .catch((error) => reportError(error, "Cancel failed"));
};

export const chooseModel = (ref: string | undefined): void => {
  save(MODEL_KEY, ref);
  setState("model", ref);
};

/** Remembers `level` for the selected model only; other models keep their own. */
export const chooseThinking = (level: ThinkingLevel): void => {
  const model = selectedModel();
  if (model === undefined) return;
  setState("thinkingByModel", (current) => ({ ...current, [model.ref]: level }));
  save(THINKING_KEY, JSON.stringify(state.thinkingByModel));
};

const FAVORITES_KEY = "basis.favoriteModels";
const [favorites, setFavorites] = createSignal<readonly string[]>(loadJson(FAVORITES_KEY, []));
export const favoriteModels = favorites;
export const toggleFavorite = (ref: string): void => {
  setFavorites((current) => (current.includes(ref) ? current.filter((item) => item !== ref) : [...current, ref]));
  save(FAVORITES_KEY, JSON.stringify(favorites()));
};

export const addProject = (path: string): void => {
  if (state.projects.includes(path)) return;
  setState("projects", (projects) => [...projects, path]);
  save(PROJECTS_KEY, JSON.stringify(state.projects));
};

/** Stops offering a project added by hand; one with sessions stays listed through them. */
export const removeProject = (path: string): void => {
  setState("projects", (projects) => projects.filter((project) => project !== path));
  save(PROJECTS_KEY, JSON.stringify(state.projects));
};

// ---------------------------------------------------------------------------
// Providers, interactions, plugins

export const login = async (provider: ProviderInfo, type: AuthType): Promise<void> => {
  if (state.loggingIn !== undefined) return;
  setState("loggingIn", provider.id);
  const before = toastSeq;
  try {
    // The host announces success as a notice, which also refreshes providers.
    await client().llm.login(provider.id, type);
    await refreshProviders();
    if (state.welcome && hasConfiguredProvider()) setState({ welcome: false, settings: undefined });
  } catch (error) {
    reportError(error, `Login to ${provider.name} failed`);
  } finally {
    // Device codes and login links from this attempt are no longer useful.
    setState(
      produce((s) => {
        s.loggingIn = undefined;
        s.toasts = s.toasts.filter((toast) => toast.id <= before || (toast.code === undefined && toast.links === undefined));
      }),
    );
  }
};

export const logout = async (provider: ProviderInfo): Promise<void> => {
  try {
    await client().llm.logout(provider.id);
    toast({ level: "info", message: `Logged out of ${provider.name}` });
    await refreshProviders();
  } catch (error) {
    reportError(error, "Logout failed");
  }
};

export const answerInteraction = (id: string, answer: InteractionAnswer): void => {
  setState("interactions", (open) => open.filter((request) => request.id !== id));
  client()
    .interaction.answer(id, answer)
    .catch((error) => reportError(error));
};

export const dismissInteraction = (id: string): void => {
  setState("interactions", (open) => open.filter((request) => request.id !== id));
  client()
    .interaction.dismiss(id)
    .catch((error) => reportError(error));
};

export const restartPlugin = async (pluginId: string): Promise<void> => {
  try {
    await client().host.restartPlugin(pluginId);
    toast({ level: "info", message: `Restarted ${pluginId}` });
    await refreshPlugins();
  } catch (error) {
    reportError(error, `Restart of ${pluginId} failed`);
  }
};

export const reloadConfig = async (): Promise<void> => {
  try {
    const result = await client().host.reload();
    const parts = [
      result.started.length > 0 ? `started ${result.started.join(", ")}` : "",
      result.restarted.length > 0 ? `restarted ${result.restarted.join(", ")}` : "",
      result.stopped.length > 0 ? `stopped ${result.stopped.join(", ")}` : "",
    ].filter(Boolean);
    toast({ level: "info", message: parts.length > 0 ? `Config reloaded: ${parts.join("; ")}` : "Config reloaded; nothing changed" });
    await refreshPlugins();
  } catch (error) {
    reportError(error, "Reload failed");
  }
};

/** Bumped after every command run, so views of host state it may have changed (the workspace bar) refresh. */
const [commandRuns, setCommandRuns] = createSignal(0);
export const commandsRun = commandRuns;

/**
 * Runs a plugin's command in the working directory and reports how it went.
 * Its questions arrive as interactions. Resolves true when it succeeded;
 * dismissing one of its questions cancels it quietly.
 */
export const runCommand = async (command: CommandInfo): Promise<boolean> => {
  const cwd = workingDir();
  try {
    const result = await client().commands.run(command.id, {
      ...(cwd === undefined ? {} : { cwd }),
      ...(state.activeId === undefined ? {} : { sessionId: state.activeId }),
    });
    toast({ level: "info", message: result.message ?? `${command.title.replace(/…$/, "")}: done` });
    return true;
  } catch (error) {
    if (!(error instanceof HostError && error.code === "Cancelled")) reportError(error, command.title.replace(/…$/, ""));
    return false;
  } finally {
    setCommandRuns((runs) => runs + 1);
  }
};

export const setView = (view: SessionViewKind): void => {
  setState("view", view);
};

/** Moves the active session's leaf to `eventId`: the next prompt branches from there (`basis session checkout`). */
export const checkoutSession = async (eventId: string): Promise<void> => {
  const sessionId = state.activeId;
  if (sessionId === undefined) return;
  try {
    const info = await client().session.checkout(sessionId, eventId);
    setState("sessions", (sessions) => upsertSession(sessions, info));
    toast({ level: "info", message: "The next prompt continues from the chosen event, on a new branch." });
  } catch (error) {
    reportError(error, "Could not branch the session");
  }
};

export const openDialog = (dialog: Dialog): void => {
  setState({ dialog });
};

export const openSettings = (section: SettingsSection | undefined): void => {
  setState({ settings: section, ...(section === undefined ? { welcome: false } : {}) });
};

// ---------------------------------------------------------------------------
// Appearance

const CONTENT_WIDTHS: Record<ContentWidth, string | undefined> = { default: undefined, wide: "1040px", full: "none" };
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const applyAppearance = (): void => {
  const root = document.documentElement;
  root.dataset.theme = state.theme === "system" ? (darkQuery.matches ? "dark" : "light") : state.theme;
  const width = CONTENT_WIDTHS[state.contentWidth];
  if (width === undefined) root.style.removeProperty("--content");
  else root.style.setProperty("--content", width);
};
applyAppearance();
darkQuery.addEventListener("change", applyAppearance);

export const setTheme = (theme: Theme): void => {
  save(THEME_KEY, theme === "system" ? undefined : theme);
  setState("theme", theme);
  applyAppearance();
};

export const setContentWidth = (width: ContentWidth): void => {
  save(WIDTH_KEY, width === "default" ? undefined : width);
  setState("contentWidth", width);
  applyAppearance();
};
