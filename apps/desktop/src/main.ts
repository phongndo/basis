import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, shell, utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import { Effect } from "effect";
import { appUrl, DEEP_LINK_SCHEME, deepLinkPath } from "@lemma/contracts";
import { resolvePaths } from "@lemma/plugin-host";
import { readDiscovery } from "@lemma/plugin-transport";
import type { Discovery } from "@lemma/plugin-transport";

// The desktop app is the web app in a window: it shows what the host's transport serves, so the two never differ.
// It attaches to a running host like the CLI does and starts one only when none runs, since the sessions store
// has a single writer. A host it started stops when it quits.
const hostMain = fileURLToPath(import.meta.resolve("@lemma/host"));
// `pnpm start` runs from apps/desktop; INIT_CWD is where the user invoked it, and the host takes it as the project.
const project = process.env.INIT_CWD ?? homedir();
const paths = resolvePaths({ env: process.env, cwd: project });
/** Development: the page comes from the web app's dev server (`pnpm dev`), which proxies to the host, so edits hot-reload. */
const webUrl = process.env.LEMMA_WEB_URL;
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

let host: UtilityProcess | undefined;
/** The host serving the page, once known. */
let served: { readonly url: string; readonly token: string } | undefined;
/** A deep link that arrived before there was a window to show it in. */
let pending: string | undefined;
const pageAt = (path = "/") => (served === undefined ? undefined : appUrl(webUrl ?? served.url, path, served.token));

const startHost = async (): Promise<Discovery> => {
  const child = utilityProcess.fork(hostMain, ["--no-open"], {
    cwd: project,
    env: { ...process.env, INIT_CWD: project },
    execArgv: ["--conditions=source"],
    stdio: "inherit",
    serviceName: "lemma host",
  });
  host = child;
  let exited: number | undefined;
  child.once("exit", (code) => {
    exited = code;
    if (host === child) host = undefined;
  });
  // The transport writes transport.json once it listens; the entry is ours when it names our process.
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new Error(`The host exited with code ${exited} before it started listening; its output is in the terminal.`);
    const entry = await Effect.runPromise(readDiscovery(paths.home));
    if (entry !== undefined && entry.pid === child.pid) return entry;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`The host did not start listening within ${STARTUP_TIMEOUT_MS / 1000}s.`);
};

const stopHost = () =>
  new Promise<void>((resolve) => {
    const child = host;
    if (child === undefined) return resolve();
    const timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    // SIGTERM: the host shuts down its plugins and removes transport.json.
    child.kill();
  });

const openWindow = (url: string) => {
  const origin = new URL(url).origin;
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    title: "lemma",
    show: false,
    // No native title bar: the controls overlay the page, which reads where (Window Controls Overlay) and makes
    // its own 48px top bars the title bar; centered in one at y 17.
    titleBarStyle: "hidden",
    titleBarOverlay: true,
    trafficLightPosition: { x: 17, y: 17 },
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.once("ready-to-show", () => window.show());
  // Links leave for the system browser, as they would leave the app's tab.
  const external = (target: string) => {
    if (/^https?:|^mailto:/.test(target)) void shell.openExternal(target);
  };
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    external(target);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin === origin) return;
    event.preventDefault();
    external(target);
  });
  void window.loadURL(url);
};

/**
 * Shows a deep link's address (`lemma://threads/<id>` is `/threads/<id>`):
 * in the open window, where the page's router takes it like an address typed
 * into it, else in a new window, or once the page is known.
 */
const openLink = (path: string) => {
  const [window] = BrowserWindow.getAllWindows();
  if (window === undefined) {
    const url = pageAt(path);
    if (url === undefined) pending = path;
    else openWindow(url);
    return;
  }
  // A new history entry and a popstate, as an edited address would make: no reload, and back returns.
  void window.webContents.executeJavaScript(`history.pushState(null, "", ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent("popstate"));`);
  if (window.isMinimized()) window.restore();
  window.focus();
};
const linkIn = (argv: readonly string[]) => argv.map(deepLinkPath).find((path) => path !== undefined);

const fail = (error: unknown) => {
  dialog.showErrorBox("Lemma could not start", error instanceof Error ? error.message : String(error));
  app.exit(1);
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName("Lemma");
  // `lemma://` links open here. Run from source, the app is Electron with this script as its argument, but only Windows
  // registers those: macOS registers Electron itself, so there a link reaches the app while it runs and not otherwise.
  if (process.defaultApp) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [resolve(process.argv[1] ?? ".")]);
  else app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  pending = linkIn(process.argv);
  // macOS hands links over as an event (also the one that launched the app); elsewhere they arrive as arguments.
  app.on("open-url", (event, link) => {
    event.preventDefault();
    const path = deepLinkPath(link);
    if (path !== undefined) openLink(path);
  });
  app.on("second-instance", (_event, argv) => {
    const link = linkIn(argv);
    if (link !== undefined) return openLink(link);
    const [window] = BrowserWindow.getAllWindows();
    if (window === undefined) {
      const url = pageAt();
      if (url !== undefined) openWindow(url);
      return;
    }
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app
    .whenReady()
    .then(async () => {
      const entry = (await Effect.runPromise(readDiscovery(paths.home))) ?? (await startHost());
      served = { url: entry.url, token: entry.token };
      openWindow(pageAt(pending)!);
      pending = undefined;
    })
    .catch(fail);

  // macOS keeps an app running with no windows; the Dock icon opens a new one.
  app.on("activate", () => {
    const url = pageAt();
    if (url !== undefined && BrowserWindow.getAllWindows().length === 0) openWindow(url);
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  let stopping = false;
  app.on("before-quit", (event) => {
    if (host === undefined || stopping) return;
    stopping = true;
    event.preventDefault();
    void stopHost().then(() => app.quit());
  });
}
