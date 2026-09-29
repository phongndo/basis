#!/usr/bin/env node
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Cause, Deferred, Effect, Exit, Option, Stream } from "effect";
import { HostControl } from "@lemma/contracts";
import { Diagnostic, makeLoader, ReloadError } from "@lemma/core";
import type { Composition, Loader, Plugin, PluginSource, ReloadReport } from "@lemma/core";
import {
  catalog,
  compositionInfo,
  HOST_PLUGIN_ID,
  hostPlugin,
  loadComposition,
  projectPluginsDir,
  readConfigText,
  resolveComposition,
  resolvePaths,
  updateConfig,
  watchConfig,
  withReplacements,
} from "@lemma/plugin-host";
import type { HostControlService, KnownPlugin, Resolved } from "@lemma/plugin-host";
import type { ConfigScope } from "@lemma/contracts";
import { readDiscovery } from "@lemma/plugin-transport";
import { bundled, withDefaults } from "./bundled.ts";
import { loadLocalPlugins } from "./local.ts";

const args = new Set(process.argv.slice(2));
// `pnpm start` runs from packages/host; INIT_CWD is where the user invoked it.
const paths = resolvePaths({ env: process.env, cwd: process.env.INIT_CWD ?? process.cwd() });
// Consumed here: tools inherit this environment, and a CLI the agent runs must use its own directory, not ours.
delete process.env.INIT_CWD;
const userPluginsDir = join(paths.home, "plugins");

/** Plugins no config change may turn off, with the reason clients show. Everything they need is locked with them. */
const pinned: Readonly<Record<string, string>> = {
  host: "Reads the config files and loads every other plugin",
  transport: "Serves the web app and the CLI; replace it with another transport plugin instead of turning it off",
};

const log = (message: string) =>
  Effect.sync(() => {
    console.log(`lemma: ${message}`);
  });
const printDiagnostics = (diagnostics: readonly Diagnostic[]) =>
  Effect.sync(() => {
    for (const diagnostic of diagnostics) {
      const where = diagnostic.pluginId === undefined ? "" : ` [${diagnostic.pluginId}]`;
      console.error(`lemma: ${diagnostic.severity}${where}: ${diagnostic.message}${diagnostic.suggestion === undefined ? "" : `\n  ${diagnostic.suggestion}`}`);
    }
  });

/** What one read of the config files and plugin directories produced. */
interface Loaded {
  readonly known: readonly KnownPlugin[];
  /** Every known plugin with its row, as the files and app defaults describe it. */
  readonly composition: Composition;
  /** What the loader runs: `composition` minus plugins whose requirements a disabled plugin leaves unmet. */
  readonly resolved: Resolved;
  readonly enabledIn: Readonly<Record<string, ConfigScope>>;
  readonly trusted: boolean;
}

/** The last load the loader accepted; the catalog and `configure` reason about this. */
let applied!: Loaded;
/** Config file contents this process last wrote (undefined: removed), so the watcher skips its own changes. */
const written = new Map<string, string | undefined>();
const source: PluginSource = {
  resolve: (id) => {
    const plugin = applied.known.find((entry) => entry.plugin.id === id)?.plugin;
    return plugin
      ? Effect.succeed(plugin)
      : Effect.fail(
          new Diagnostic({
            severity: "error",
            pluginId: id,
            message: `No plugin "${id}"`,
            suggestion: `Known plugins: ${applied.known.map((entry) => entry.plugin.id).join(", ")}. Local plugins go in ${userPluginsDir} or, in a trusted project, ${projectPluginsDir(paths)}.`,
          }),
        );
  },
};

/** The plugin a halted one ultimately waits on: the first in its chain that is turned off. */
const rootOf = (resolved: Resolved, id: string): string => {
  let current = id;
  for (let next = resolved.haltedBy.get(current); next !== undefined; next = resolved.haltedBy.get(current)) current = next;
  return current;
};

/** Read config files and local plugins into the next composition. Warnings print here; errors fail. */
const load = (host: Plugin): Effect.Effect<Loaded, ReloadError> =>
  Effect.gen(function* () {
    const loaded = yield* loadComposition(paths);
    // Project plugins run only in a project the user config trusts; see `loadComposition`.
    const local = yield* loadLocalPlugins(loaded.trusted ? [userPluginsDir, projectPluginsDir(paths)] : [userPluginsDir]);
    const diagnostics = [...local.diagnostics, ...loaded.diagnostics];
    // A local plugin with a bundled id takes the bundled one's place, in its position; later directories win.
    const byId = new Map<string, KnownPlugin>();
    for (const plugin of bundled(host)) byId.set(plugin.id, { plugin, source: "bundled" });
    for (const { plugin, dir } of local.plugins) {
      const previous = byId.get(plugin.id);
      const shadows = previous?.source === "bundled" || previous?.shadows === true;
      byId.set(plugin.id, { plugin, source: dir === userPluginsDir ? "user" : "project", ...(shadows ? { shadows } : {}) });
    }
    const known = [...byId.values()];
    const composition = withDefaults([...byId.keys()], loaded.composition);
    const resolved = resolveComposition(known, composition);
    for (const [id, by] of resolved.haltedBy) {
      const root = rootOf(resolved, id);
      const chain = root === by ? `"${by}"` : `"${by}", which needs "${root}"`;
      const reason = pinned[id];
      diagnostics.push(
        reason === undefined
          ? new Diagnostic({
              severity: "warning",
              pluginId: id,
              message: `"${id}" is not loaded: it needs ${chain}, and "${root}" is turned off`,
              suggestion: `Turn "${root}" on to load "${id}"`,
            })
          : new Diagnostic({
              severity: "error",
              pluginId: root,
              message: `Turning off "${root}" would stop "${id}", which cannot be turned off: ${reason}`,
              suggestion: `Turn "${root}" back on`,
            }),
      );
    }
    for (const [id, reason] of Object.entries(pinned)) {
      if (composition.plugins[id]?.enabled === false) {
        diagnostics.push(
          new Diagnostic({ severity: "error", pluginId: id, message: `"${id}" cannot be turned off: ${reason}`, suggestion: `Remove its "enabled" row` }),
        );
      }
    }
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length) return yield* new ReloadError({ diagnostics: errors });
    // Only for a composition that will run: a rejected one's warnings describe nothing that happens.
    yield* printDiagnostics(diagnostics.filter((diagnostic) => diagnostic.severity === "warning"));
    return { known, composition, resolved, enabledIn: loaded.enabledIn, trusted: loaded.trusted };
  });

const describe = (report: ReloadReport): string => {
  const parts = [
    report.started.length ? `started ${report.started.join(", ")}` : "",
    report.restarted.length ? `restarted ${report.restarted.join(", ")}` : "",
    report.stopped.length ? `stopped ${report.stopped.join(", ")}` : "",
    report.interrupted ? `interrupted ${report.interrupted} in-flight task(s)` : "",
    report.faults.length ? `${report.faults.length} dispose fault(s)` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : "nothing changed";
};

const untilSignal = Effect.async<void>((resume) => {
  const done = () => resume(Effect.void);
  process.once("SIGINT", done);
  process.once("SIGTERM", done);
  return Effect.sync(() => {
    process.off("SIGINT", done);
    process.off("SIGTERM", done);
  });
});

const openBrowser = (url: string) =>
  Effect.sync(() => {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(command, [url], { detached: true, stdio: "ignore" })
      .on("error", () => {})
      .unref();
  });

const rejected = (diagnostic: Diagnostic) => new ReloadError({ diagnostics: [diagnostic] });

const program = Effect.gen(function* () {
  // The host plugin activates inside makeLoader, so its handle binds to the loader once it exists.
  const ready = yield* Deferred.make<Loader>();
  const reloading = yield* Effect.makeSemaphore(1);
  const withLoader = <A, E>(f: (loader: Loader) => Effect.Effect<A, E>) => Effect.flatMap(Deferred.await(ready), f);
  let host: Plugin;
  // The source resolves ids against the load being applied, so the next set is visible before the loader accepts it.
  const apply = (loader: Loader, next: Loaded) =>
    Effect.gen(function* () {
      const previous = applied;
      applied = next;
      return yield* loader.apply(next.resolved.composition).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            applied = previous;
          }),
        ),
      );
    });
  // One change at a time, reading and applying together: the watcher, `Host.Reload`, and `Host.Configure` can
  // race, and a reload that read the files earlier must not apply after one that read them later.
  const reload = withLoader((loader) => reloading.withPermits(1)(Effect.flatMap(load(host), (next) => apply(loader, next))));
  const handle: HostControlService = {
    plugins: withLoader((loader) => Effect.map(loader.core.inspect, (snapshot) => catalog({ ...applied, snapshots: snapshot.plugins, pinned }))),
    composition: withLoader((loader) =>
      Effect.gen(function* () {
        const composition = yield* loader.composition;
        const { plugins } = yield* loader.core.inspect;
        return compositionInfo(composition, plugins);
      }),
    ),
    restart: (pluginId, options) =>
      withLoader((loader) =>
        Effect.gen(function* () {
          // Replacing a plugin the transport needs restarts the transport too, dropping the client that asked; refuse rather than surprise.
          if (options?.force) {
            const entry = catalog({ ...applied, snapshots: (yield* loader.core.inspect).plugins, pinned }).find((candidate) => candidate.id === pluginId);
            if (entry?.locked !== undefined && entry.state === "active") {
              return yield* rejected(
                new Diagnostic({
                  severity: "error",
                  pluginId,
                  message: `"${pluginId}" cannot be restarted while running: ${entry.locked}`,
                  suggestion: "Change its config and reload, or restart the host",
                }),
              );
            }
          }
          return yield* loader.core.restart(pluginId, options);
        }),
      ),
    reload,
    configure: (requested, options) =>
      withLoader((loader) =>
        reloading.withPermits(1)(
          Effect.gen(function* () {
            const scope = options?.scope ?? "user";
            if (scope === "project" && !applied.trusted) {
              return yield* rejected(
                new Diagnostic({
                  severity: "error",
                  message: `${paths.projectConfig} is not read because ${paths.cwd} is not a trusted project`,
                  suggestion: `Add "${paths.cwd}" to "trustedProjects" in ${paths.userConfig}, or change the user config instead`,
                }),
              );
            }
            // Checked here so the answer is immediate and the file is never touched: the load would refuse these too.
            const entries = catalog({ ...applied, snapshots: (yield* loader.core.inspect).plugins, pinned });
            for (const [id, row] of Object.entries(requested)) {
              if (id === HOST_PLUGIN_ID) {
                return yield* rejected(
                  new Diagnostic({
                    severity: "error",
                    pluginId: id,
                    message: `The "${id}" row is fixed: ${pinned[id]}`,
                    suggestion: "Configure another plugin",
                  }),
                );
              }
              // Resolving an unknown id yields the source's diagnostic, which lists the known plugins.
              const entry = entries.find((candidate) => candidate.id === id) ?? (yield* Effect.mapError(source.resolve(id), rejected), undefined);
              if (row.enabled === false && entry?.locked !== undefined) {
                return yield* rejected(new Diagnostic({ severity: "error", pluginId: id, message: `"${id}" cannot be turned off: ${entry.locked}` }));
              }
            }
            // Turning on a provider turns off the one it replaces; a pinned plugin cannot be replaced that way.
            const rows = withReplacements(applied.known, applied.composition, requested);
            for (const id of Object.keys(rows)) {
              if (requested[id] === undefined && pinned[id] !== undefined) {
                const replacer = Object.keys(requested).find((candidate) => requested[candidate]?.enabled === true) ?? "?";
                return yield* rejected(
                  new Diagnostic({
                    severity: "error",
                    pluginId: replacer,
                    message: `"${replacer}" provides what "${id}" provides, and "${id}" cannot be turned off: ${pinned[id]}`,
                  }),
                );
              }
            }
            const path = scope === "user" ? paths.userConfig : paths.projectConfig;
            const update = yield* updateConfig(path, rows, scope).pipe(Effect.mapError(rejected));
            written.set(path, update.text);
            // The written rows are read back like any other change; if the host rejects them, the file is put back.
            return yield* Effect.flatMap(load(host), (next) => apply(loader, next)).pipe(
              Effect.tapError(() => update.restore.pipe(Effect.tap(() => Effect.sync(() => written.set(path, update.previous))))),
            );
          }),
        ),
      ),
  };
  host = hostPlugin({ control: handle, faults: Stream.unwrap(withLoader((loader) => Effect.succeed(loader.core.faults))) });

  applied = yield* load(host);
  const loader = yield* makeLoader({ source, composition: applied.resolved.composition });
  yield* Deferred.succeed(ready, loader);
  // Captured once: a reload drains in-flight core.run work, so it must not run inside core.run.
  const control = yield* loader.core.run(HostControl);
  const { plugins } = yield* loader.core.inspect;
  yield* log(`running ${plugins.map((plugin) => plugin.id).join(", ")}`);
  yield* log(`home ${paths.home}, project ${paths.cwd}`);

  yield* Effect.forkScoped(
    Stream.runForEach(loader.core.faults, (fault) =>
      Effect.sync(() => {
        console.error(`lemma: ${fault.message}\n${Cause.pretty(fault.cause)}`);
      }),
    ),
  );
  yield* Effect.forkScoped(
    Stream.runForEach(watchConfig(paths), (file) =>
      Effect.gen(function* () {
        // A change this process wrote (a configure, or its undo) is already applied.
        const content = yield* readConfigText(file).pipe(Effect.orElseSucceed(() => undefined));
        if (written.has(file) && written.get(file) === content) {
          written.delete(file);
          return;
        }
        yield* log(`${file} changed; reloading`).pipe(
          Effect.zipRight(control.reload),
          Effect.matchEffect({
            onFailure: (error) => printDiagnostics(error.diagnostics).pipe(Effect.zipRight(log("reload rejected; the running composition is unchanged"))),
            onSuccess: (report) => log(`reloaded: ${describe(report)}`),
          }),
        );
      }),
    ),
  );

  const discovery = yield* readDiscovery(paths.home);
  if (discovery !== undefined) {
    const url = `${discovery.url}/?token=${encodeURIComponent(discovery.token)}`;
    yield* log(`open ${url}`);
    if (!args.has("--no-open")) yield* openBrowser(url);
  }

  yield* untilSignal;
  yield* log("shutting down");
});

const exit = await Effect.runPromiseExit(Effect.scoped(program));
if (Exit.isFailure(exit)) {
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure) && failure.value instanceof ReloadError) {
    await Effect.runPromise(printDiagnostics(failure.value.diagnostics));
    console.error("lemma: cannot start with this composition");
  } else if (!Cause.isInterruptedOnly(exit.cause)) {
    console.error(Cause.pretty(exit.cause));
  }
  process.exit(1);
}
