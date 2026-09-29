#!/usr/bin/env node
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Cause, Deferred, Effect, Exit, Option, Stream } from "effect";
import { HostControl } from "@basis/contracts";
import { Diagnostic, makeLoader, ReloadError } from "@basis/core";
import type { Loader, Plugin, PluginSource, ReloadReport } from "@basis/core";
import { compositionInfo, hostPlugin, loadComposition, projectPluginsDir, resolvePaths, watchConfig } from "@basis/plugin-host";
import type { HostControlService } from "@basis/plugin-host";
import { readDiscovery } from "@basis/plugin-transport";
import { bundled, withDefaults } from "./bundled.ts";
import { loadLocalPlugins } from "./local.ts";

const args = new Set(process.argv.slice(2));
// `pnpm start` runs from apps/host; INIT_CWD is where the user invoked it.
const paths = resolvePaths({ env: process.env, cwd: process.env.INIT_CWD ?? process.cwd() });
const userPluginsDir = join(paths.home, "plugins");

const log = (message: string) => Effect.sync(() => { console.log(`basis: ${message}`); });
const printDiagnostics = (diagnostics: readonly Diagnostic[]) => Effect.sync(() => {
  for (const diagnostic of diagnostics) {
    const where = diagnostic.pluginId === undefined ? "" : ` [${diagnostic.pluginId}]`;
    console.error(`basis: ${diagnostic.severity}${where}: ${diagnostic.message}${diagnostic.suggestion === undefined ? "" : `\n  ${diagnostic.suggestion}`}`);
  }
});

/** Definitions by id, rebuilt on every load. Local plugins shadow bundled ones with the same id. */
let definitions = new Map<string, Plugin>();
const source: PluginSource = {
  resolve: (id) => {
    const plugin = definitions.get(id);
    return plugin ? Effect.succeed(plugin) : Effect.fail(new Diagnostic({
      severity: "error", pluginId: id,
      message: `No plugin "${id}"`,
      suggestion: `Known plugins: ${[...definitions.keys()].join(", ")}. Local plugins go in ${userPluginsDir} or, in a trusted project, ${projectPluginsDir(paths)}.`,
    }));
  },
};

/** Read config files and local plugins into the next composition. Warnings print here; errors fail. */
const load = (host: Plugin) => Effect.gen(function* () {
  const loaded = yield* loadComposition(paths);
  // Project plugins run only in a project the user config trusts; see `loadComposition`.
  const local = yield* loadLocalPlugins(loaded.trusted ? [userPluginsDir, projectPluginsDir(paths)] : [userPluginsDir]);
  const diagnostics = [...local.diagnostics, ...loaded.diagnostics];
  yield* printDiagnostics(diagnostics.filter((diagnostic) => diagnostic.severity === "warning"));
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length) return yield* new ReloadError({ diagnostics: errors });
  definitions = new Map([...bundled(host), ...local.plugins].map((plugin) => [plugin.id, plugin]));
  return withDefaults([...definitions.keys()], loaded.composition);
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
  return Effect.sync(() => { process.off("SIGINT", done); process.off("SIGTERM", done); });
});

const openBrowser = (url: string) => Effect.sync(() => {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(command, [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
});

const program = Effect.gen(function* () {
  // The host plugin activates inside makeLoader, so its handle binds to the loader once it exists.
  const ready = yield* Deferred.make<Loader>();
  const withLoader = <A, E>(f: (loader: Loader) => Effect.Effect<A, E>) => Effect.flatMap(Deferred.await(ready), f);
  let host: Plugin;
  const handle: HostControlService = {
    plugins: withLoader((loader) => Effect.map(loader.core.inspect, (snapshot) => snapshot.plugins)),
    composition: withLoader((loader) => Effect.gen(function* () {
      const composition = yield* loader.composition;
      const { plugins } = yield* loader.core.inspect;
      return compositionInfo(composition, plugins);
    })),
    restart: (pluginId) => withLoader((loader) => loader.core.restart(pluginId)),
    reload: withLoader((loader) => Effect.flatMap(load(host), (next) => loader.apply(next))),
  };
  host = hostPlugin({ control: handle, faults: Stream.unwrap(withLoader((loader) => Effect.succeed(loader.core.faults))) });

  const composition = yield* load(host);
  const loader = yield* makeLoader({ source, composition });
  yield* Deferred.succeed(ready, loader);
  // Captured once: a reload drains in-flight core.run work, so it must not run inside core.run.
  const control = yield* loader.core.run(HostControl);
  const { plugins } = yield* loader.core.inspect;
  yield* log(`running ${plugins.map((plugin) => plugin.id).join(", ")}`);
  yield* log(`home ${paths.home}, project ${paths.cwd}`);

  yield* Effect.forkScoped(Stream.runForEach(loader.core.faults, (fault) => Effect.sync(() => {
    console.error(`basis: ${fault.message}\n${Cause.pretty(fault.cause)}`);
  })));
  yield* Effect.forkScoped(Stream.runForEach(watchConfig(paths), (file) => log(`${file} changed; reloading`).pipe(
    Effect.zipRight(control.reload),
    Effect.matchEffect({
      onFailure: (error) => printDiagnostics(error.diagnostics).pipe(Effect.zipRight(log("reload rejected; the running composition is unchanged"))),
      onSuccess: (report) => log(`reloaded: ${describe(report)}`),
    }),
  )));

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
    console.error("basis: cannot start with this composition");
  } else if (!Cause.isInterruptedOnly(exit.cause)) {
    console.error(Cause.pretty(exit.cause));
  }
  process.exit(1);
}
