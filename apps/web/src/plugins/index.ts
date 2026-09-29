import type { Plugin } from "@lemma/core";
import addProject from "./add-project.tsx";
import appearance from "./appearance.tsx";
import chat from "./chat.tsx";
import commands from "./commands.ts";
import composer from "./composer.tsx";
import connection from "./connection.tsx";
import dialogs from "./dialogs.ts";
import eventLog from "./event-log.tsx";
import hostPlugins from "./host-plugins.ts";
import interactionDialog from "./interaction-dialog.tsx";
import interactions from "./interactions.ts";
import keymap from "./keymap.ts";
import modelPicker from "./model-picker.tsx";
import models from "./models.ts";
import palette from "./palette.tsx";
import pluginsPage from "./plugins-page.tsx";
import projectsPage from "./projects-page.tsx";
import providers from "./providers.tsx";
import sessionView from "./session-view.tsx";
import sessions from "./sessions.ts";
import settings from "./settings.tsx";
import shell from "./shell.tsx";
import sidebar from "./sidebar.tsx";
import slots from "./slots.ts";
import toasts from "./toasts.tsx";
import tooltips from "./tooltips.tsx";
import trajectory from "./trajectory.tsx";
import workspaceBar from "./workspace-bar.tsx";
import workspace from "./workspace.ts";

/**
 * The web app as shipped, every part a plugin: models of host state first,
 * then the frame and what fills it. Each can be turned off (`ui` rows, the
 * Plugins page, `lemma ui disable`) or replaced by a plugin from a UI file.
 * The boot adds `client` (the connection) and `app` (runs this list).
 */
export const bundled: readonly Plugin[] = [
  slots,
  toasts,
  sessions,
  models,
  workspace,
  hostPlugins,
  commands,
  interactions,
  dialogs,
  keymap,
  appearance,
  shell,
  sidebar,
  sessionView,
  chat,
  trajectory,
  composer,
  modelPicker,
  workspaceBar,
  connection,
  palette,
  settings,
  providers,
  pluginsPage,
  projectsPage,
  addProject,
  eventLog,
  interactionDialog,
  tooltips,
];
