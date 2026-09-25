import { describe, expect, test } from "bun:test";
import { Context, Deferred, Duration, Effect, Exit, Layer, Ref, Schedule, Scope, Stream } from "effect";
import { CoreClosed, DeadlineExceeded, definePlugin, makeCore, PluginContext } from "../src/index.ts";
import type { PluginFault } from "../src/index.ts";
import { waitFor } from "./support.ts";

class Db extends Context.Tag("test/Db")<Db, { readonly name: string }>() {}
class Api extends Context.Tag("test/Api")<Api, string>() {}
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect));

/** A provider whose background task fails when the test fires the trigger created for its current activation. */
const flaky = (options: { required: boolean; log: string[]; triggers: Deferred.Deferred<void>[] }) =>
  definePlugin({
    id: "db", provides: [Db],
    layer: Layer.scoped(Db, Effect.gen(function* () {
      options.log.push("db+");
      yield* Effect.addFinalizer(() => Effect.sync(() => { options.log.push("db-"); }));
      const owner = yield* PluginContext;
      const trigger = yield* Deferred.make<void>();
      options.triggers.push(trigger);
      yield* owner.background("poll", Deferred.await(trigger).pipe(Effect.zipRight(Effect.fail("connection lost"))), { required: options.required });
      return { name: "db" };
    })),
  });
const api = (log: string[]) => definePlugin({
  id: "api", requires: [Db], provides: [Api],
  layer: Layer.scoped(Api, Effect.gen(function* () {
    log.push("api+");
    yield* Effect.addFinalizer(() => Effect.sync(() => { log.push("api-"); }));
    return (yield* Db).name + "-api";
  })),
});
const bystander = (log: string[]) => definePlugin({
  id: "bystander", layer: Layer.scopedDiscard(Effect.acquireRelease(Effect.sync(() => { log.push("bystander+"); }), () => Effect.sync(() => { log.push("bystander-"); }))),
});

describe("supervision", () => {
  test("an optional background failure is reported and changes nothing", async () => {
    await run(Effect.gen(function* () {
      const log: string[] = [];
      const triggers: Deferred.Deferred<void>[] = [];
      const core = yield* makeCore([flaky({ required: false, log, triggers }), api(log)]);
      const fault = yield* Effect.fork(Stream.runHead(core.faults));
      yield* Effect.sleep(Duration.millis(5));
      yield* Deferred.succeed(triggers[0]!, undefined);
      const seen = yield* fault.await;
      expect(Exit.isSuccess(seen) && seen.value._tag === "Some" && seen.value.value).toMatchObject({ pluginId: "db", phase: "background", operation: "poll" });
      expect((yield* core.inspect).plugins.map((p) => [p.id, p.state])).toEqual([["db", "active"], ["api", "active"]]);
      expect((yield* core.inspect).plugins[0]?.fault?.phase).toBe("background");
      expect(yield* core.run(Api)).toBe("db-api");
    }));
  });

  test("a required background failure stops the plugin and its dependents only, then explicit restart recovers them", async () => {
    await run(Effect.gen(function* () {
      const log: string[] = [];
      const triggers: Deferred.Deferred<void>[] = [];
      const core = yield* makeCore([api(log), flaky({ required: true, log, triggers }), bystander(log)]);
      yield* Deferred.succeed(triggers[0]!, undefined);
      yield* waitFor(core.inspect, (s) => s.plugins.find((p) => p.id === "db")?.state === "failed");
      expect(log).toEqual(["db+", "api+", "bystander+", "api-", "db-"]);
      const snapshot = yield* core.inspect;
      expect(snapshot.plugins.map((p) => [p.id, p.state])).toEqual([["db", "failed"], ["api", "closed"], ["bystander", "active"]]);
      expect(snapshot.plugins.find((p) => p.id === "api")?.haltedBy).toBe("db");
      expect(snapshot.plugins.find((p) => p.id === "db")?.fault).toMatchObject({ phase: "background", operation: "poll" });
      // The failed capability is gone; the rest of the composition still serves.
      expect(yield* core.run(Effect.succeed("still active"))).toBe("still active");
      // Explicit restart brings back the failed plugin and what it halted; the bystander is not touched.
      yield* core.restart("db");
      expect((yield* core.inspect).plugins.map((p) => [p.id, p.state])).toEqual([["db", "active"], ["api", "active"], ["bystander", "active"]]);
      expect(log).toEqual(["db+", "api+", "bystander+", "api-", "db-", "db+", "api+"]);
      expect(yield* core.run(Api)).toBe("db-api");
      // Restarting an active plugin is a no-op; an unknown one is a diagnostic.
      yield* core.restart("db");
      expect(log).toHaveLength(7);
      const unknown = yield* Effect.flip(core.restart("nope"));
      expect(unknown._tag).toBe("ReloadError");
    }));
  });

  test("a restart schedule retries a failed plugin and stops when exhausted", async () => {
    await run(Effect.gen(function* () {
      const log: string[] = [];
      const attempts = yield* Ref.make(0);
      const always = definePlugin({
        id: "db", provides: [Db], restart: Schedule.recurs(2),
        layer: Layer.scoped(Db, Effect.gen(function* () {
          const attempt = yield* Ref.updateAndGet(attempts, (n) => n + 1);
          log.push(`db+${attempt}`);
          const owner = yield* PluginContext;
          yield* owner.background("poll", Effect.fail("down"), { required: true });
          return { name: "db" };
        })),
      });
      const core = yield* makeCore([always]);
      // Two automatic restarts, then the schedule is exhausted and the plugin stays failed.
      yield* waitFor(Ref.get(attempts), (n) => n === 3);
      yield* waitFor(core.inspect, (s) => s.plugins[0]?.state === "failed");
      yield* Effect.sleep(Duration.millis(20));
      expect(log).toEqual(["db+1", "db+2", "db+3"]);
      expect((yield* core.inspect).plugins[0]?.state).toBe("failed");
      // An explicit restart resets the schedule: two more automatic attempts follow it.
      yield* core.restart("db");
      yield* waitFor(Ref.get(attempts), (n) => n === 6);
      yield* waitFor(core.inspect, (s) => s.plugins[0]?.state === "failed");
      yield* Effect.sleep(Duration.millis(20));
      expect(log).toHaveLength(6);
    }));
  });

  test("background work is rejected once the plugin or core has stopped", async () => {
    let context!: Context.Tag.Service<PluginContext>;
    await run(Effect.gen(function* () {
      const plugin = definePlugin({ id: "p", layer: Layer.effectDiscard(Effect.map(PluginContext, (owner) => { context = owner; })) });
      yield* makeCore([plugin]);
    }));
    const error = await Effect.runPromise(Effect.flip(context.background("late", Effect.void)));
    expect(error).toBeInstanceOf(CoreClosed);
  });

  test("activation and disposal deadlines produce attributed faults instead of hangs", async () => {
    const log: string[] = [];
    const stuck = definePlugin({
      id: "stuck", deadlines: { activate: Duration.millis(30) },
      layer: Layer.effectDiscard(Effect.never),
    });
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(makeCore([stuck]))));
    expect(error).toMatchObject({ _tag: "PluginFault", pluginId: "stuck", phase: "activate", deadline: true });
    expect(error._tag === "PluginFault" && error.cause._tag === "Fail" && error.cause.error).toBeInstanceOf(DeadlineExceeded);

    const slowClose = definePlugin({
      id: "slow-close", deadlines: { dispose: Duration.millis(30) },
      layer: Layer.scopedDiscard(Effect.addFinalizer(() => Effect.sync(() => { log.push("closing"); }).pipe(Effect.zipRight(Effect.never)))),
    });
    const started = Date.now();
    const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
      const core = yield* makeCore([slowClose]);
      const faults = yield* Effect.fork(Stream.runHead(core.faults));
      yield* Effect.yieldNow();
      return faults;
    })));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(log).toEqual(["closing"]);
    // Shutdown surfaces the dispose fault to the owner instead of reporting a clean close.
    expect(Exit.isFailure(exit)).toBe(true);
  });
});


