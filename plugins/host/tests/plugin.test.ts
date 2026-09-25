import { describe, expect, test } from "bun:test";
import { Deferred, Duration, Effect, Fiber, Layer, Schedule, Stream } from "effect";
import { HostControl, Notice, Paths, PluginsChanged } from "@basis/contracts";
import { definePlugin, Diagnostic, Events, makeLoader, PluginContext } from "@basis/core";
import type { Loader, Plugin, PluginSource } from "@basis/core";
import { hostPlugin, resolvePaths } from "../src/index.ts";
import type { HostControlService } from "../src/index.ts";

const paths = resolvePaths({ env: { HOME: "/home/me" }, cwd: "/work" });

// A required background task that fails produces a real PluginFault.
const flaky = definePlugin({
  id: "flaky",
  layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) =>
    owner.background("work", Effect.fail("boom"), { required: true }))),
});

/** Mirrors apps/host: the plugin activates inside makeLoader, so the handle binds to the loader through a Deferred. */
const start = Effect.gen(function* () {
  const ready = yield* Deferred.make<Loader>();
  const handle: HostControlService = {
    plugins: Effect.flatMap(Deferred.await(ready), (loader) => Effect.map(loader.core.inspect, (snapshot) => snapshot.plugins)),
    restart: (id) => Effect.flatMap(Deferred.await(ready), (loader) => loader.core.restart(id)),
    reload: Effect.flatMap(Deferred.await(ready), (loader) => loader.apply({ plugins: { host: { config: paths } } })),
  };
  const host = hostPlugin({ control: handle, faults: Stream.unwrap(Effect.map(Deferred.await(ready), (loader) => loader.core.faults)) });
  const bundled: Record<string, Plugin> = { host, flaky };
  const source: PluginSource = {
    resolve: (id) => bundled[id] ? Effect.succeed(bundled[id]) : Effect.fail(new Diagnostic({ severity: "error", message: `No plugin "${id}"` })),
  };
  const loader = yield* makeLoader({ source, composition: { plugins: { host: { config: paths } } } });
  yield* Deferred.succeed(ready, loader);
  // Reload drains in-flight core.run work before swapping, so the handle is used outside core.run, as the app does.
  const control = yield* loader.core.run(HostControl);
  const events = yield* loader.core.run(Events);
  return { loader, control, events };
});

describe("host plugin", () => {
  test("provides Paths from config and publishes PluginsChanged after a reload", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { loader, control, events } = yield* start;
      expect(yield* loader.core.run(Paths)).toEqual(paths);
      const changes = yield* Effect.fork(Stream.runCollect(Stream.take(events.stream(PluginsChanged), 1)));
      const report = yield* control.reload;
      expect(report.unchanged).toEqual(["host"]);
      const [published] = [...(yield* Fiber.join(changes))];
      expect(published?.plugins.map((plugin) => [plugin.id, plugin.state])).toEqual([["host", "active"]]);
    })));
  });

  test("publishes PluginsChanged and a Notice when a plugin faults, and after a restart", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { loader, control, events } = yield* start;
      const changes = yield* Effect.fork(Stream.runCollect(Stream.take(events.stream(PluginsChanged), 1)));
      const notices = yield* Effect.fork(Stream.runCollect(Stream.take(events.stream(Notice), 1)));
      // Applied directly, not through HostControl, so the only publication comes from the fault.
      yield* loader.apply({ plugins: { host: { config: paths }, flaky: {} } });
      expect([...(yield* Fiber.join(changes))]).toHaveLength(1);
      const [notice] = [...(yield* Fiber.join(notices))];
      expect(notice).toMatchObject({ level: "error", source: "flaky" });
      expect(notice?.message).toContain("boom");
      // The core fails the plugin on its supervisor fiber, shortly after reporting the fault.
      const flakyState = Effect.map(loader.core.inspect, (snapshot) => snapshot.plugins.find((plugin) => plugin.id === "flaky")?.state);
      yield* Effect.repeat(flakyState, { until: (state) => state === "failed", schedule: Schedule.spaced(Duration.millis(2)) }).pipe(Effect.timeout(Duration.seconds(5)));

      const afterRestart = yield* Effect.fork(Stream.runCollect(Stream.take(events.stream(PluginsChanged), 1)));
      // Activation succeeds and the task fails again afterwards; PluginsChanged is published either way.
      yield* control.restart("flaky");
      expect([...(yield* Fiber.join(afterRestart))]).toHaveLength(1);
    })));
  });
});
