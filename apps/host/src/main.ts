import { Cause, Deferred, Effect, Exit, Option, Stream } from "effect";
import { HostControl } from "@basis/contracts";
import { makeLoader, ReloadError } from "@basis/core";
import type { Diagnostic, Loader, ReloadReport } from "@basis/core";
import { hostPlugin, loadComposition, resolvePaths, watchConfig } from "@basis/plugin-host";
import type { HostControlService } from "@basis/plugin-host";
import { bundled, bundledSource, defaultPluginIds } from "./bundled.ts";

const paths = resolvePaths({ env: process.env, cwd: process.cwd() });

const log = (message: string) => Effect.sync(() => { console.log(`basis host: ${message}`); });
const printDiagnostics = (diagnostics: readonly Diagnostic[]) => Effect.sync(() => {
  for (const diagnostic of diagnostics) {
    const where = diagnostic.pluginId === undefined ? "" : ` [${diagnostic.pluginId}]`;
    console.error(`basis host: ${diagnostic.severity}${where}: ${diagnostic.message}${diagnostic.suggestion === undefined ? "" : `\n  ${diagnostic.suggestion}`}`);
  }
});

/**
 * Read the config files. Warnings are printed here; errors are returned for the
 * caller to print, like planning errors. Without any config file the default
 * composition runs, so a fresh install can chat once a credential exists.
 */
const load = Effect.gen(function* () {
  const loaded = yield* loadComposition(paths);
  yield* printDiagnostics(loaded.diagnostics.filter((diagnostic) => diagnostic.severity === "warning"));
  const errors = loaded.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length) return yield* new ReloadError({ diagnostics: errors });
  if (loaded.files.some((file) => file.found)) return loaded;
  const plugins = { ...loaded.composition.plugins, ...Object.fromEntries(defaultPluginIds.map((id) => [id, {}])) };
  return { ...loaded, composition: { plugins } };
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

const program = Effect.gen(function* () {
  const loaded = yield* load;
  if (!loaded.files.some((file) => file.found)) {
    yield* log(`no config file; running the default composition. Create ${paths.userConfig} (user) or ${paths.projectConfig} (project) to change it.`);
  }

  // The host plugin activates inside makeLoader, so its handle binds to the loader once it exists.
  const ready = yield* Deferred.make<Loader>();
  const handle: HostControlService = {
    plugins: Effect.flatMap(Deferred.await(ready), (loader) => Effect.map(loader.core.inspect, (snapshot) => snapshot.plugins)),
    restart: (pluginId) => Effect.flatMap(Deferred.await(ready), (loader) => loader.core.restart(pluginId)),
    reload: Effect.flatMap(Deferred.await(ready), (loader) => Effect.flatMap(load, (next) => loader.apply(next.composition))),
  };
  const host = hostPlugin({ control: handle, faults: Stream.unwrap(Effect.map(Deferred.await(ready), (loader) => loader.core.faults)) });
  const loader = yield* makeLoader({ source: bundledSource(bundled(host)), composition: loaded.composition });
  yield* Deferred.succeed(ready, loader);
  // Captured once: a reload drains in-flight core.run work, so it must not run inside core.run.
  const control = yield* loader.core.run(HostControl);
  const { plugins } = yield* loader.core.inspect;
  yield* log(`running ${plugins.map((plugin) => plugin.id).join(", ")} (home ${paths.home}, project ${paths.cwd})`);

  yield* Effect.forkScoped(Stream.runForEach(loader.core.faults, (fault) => Effect.sync(() => {
    console.error(`basis host: ${fault.message}\n${Cause.pretty(fault.cause)}`);
  })));
  yield* Effect.forkScoped(Stream.runForEach(watchConfig(paths), (file) => log(`${file} changed; reloading`).pipe(
    Effect.zipRight(control.reload),
    Effect.matchEffect({
      onFailure: (error) => printDiagnostics(error.diagnostics).pipe(Effect.zipRight(log("reload rejected; the running composition is unchanged"))),
      onSuccess: (report) => log(`reloaded: ${describe(report)}`),
    }),
  )));

  yield* untilSignal;
  yield* log("shutting down");
});

const exit = await Effect.runPromiseExit(Effect.scoped(program));
if (Exit.isFailure(exit)) {
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure) && failure.value instanceof ReloadError) {
    await Effect.runPromise(printDiagnostics(failure.value.diagnostics));
    console.error("basis host: cannot start with this composition");
  } else if (!Cause.isInterruptedOnly(exit.cause)) {
    console.error(Cause.pretty(exit.cause));
  }
  process.exit(1);
}
